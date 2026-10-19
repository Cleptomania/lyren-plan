// Bounded validation (design Appendix D 44): findsProblem never refuses what zod accepts, finds a problem of a list
// or record before zod would describe its items, and reaches every list and record of the shared schemas.

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as archive from './archive';
import { archiveRowSchemas } from './archive';
import * as board from './board';
import { boardCreateInput, customColumnSchema, dropPatchSchema, groupPrefsSchema } from './board';
import { DESCRIBED_VALUES, findsProblem, parseBounded } from './bounded';
import * as email from './email';
import * as exportFile from './export';
import { exportRowSchemas } from './export';
import * as schemas from './schemas';
import { rankPositionSchema, taskBulkUpdateInput, taskQueryInput, taskUpdateInput } from './schemas';

const ids = z.object({ ids: z.array(z.number().int().positive()).max(10) });

describe('parseBounded', () => {
  it('describes a small invalid value, and refuses a large one without describing it', () => {
    const small = parseBounded(ids, { ids: Array(30).fill('x') });
    expect(small?.success).toBe(false);
    expect(small?.error?.issues).toHaveLength(31); // every item, and the length
    // Items of the wrong type, and items that fail a check, which zod's validate() would not stop at.
    expect(parseBounded(ids, { ids: Array(DESCRIBED_VALUES + 1).fill('x') })).toBeNull();
    expect(parseBounded(ids, { ids: Array(DESCRIBED_VALUES + 1).fill(0) })).toBeNull();
    // Nested members count too.
    const extra = Array.from({ length: DESCRIBED_VALUES }, () => ({ a: 1 }));
    expect(parseBounded(ids, { ids: ['x'], extra })).toBeNull();
  });

  it('parses a large valid value as usual', () => {
    const many = z.object({ ids: z.array(z.number()) });
    const value = { ids: Array.from({ length: DESCRIBED_VALUES * 2 }, (_, i) => i) };
    expect(parseBounded(many, value)).toEqual({ success: true, data: value });
  });

  it('describes a large value whose only problems are checks of whole objects', () => {
    // 50 drop patches that each set both due dates, which dropPatchSchema's refine refuses: 50 issues, no more.
    const onDrop = { due: 'today', dueDate: '2026-10-18' };
    const custom = Array.from({ length: 50 }, (_, i) => ({ id: `c${i}`, name: 'C', match: { ids: Array(200).fill(1) }, onDrop }));
    const value = { name: 'B', config: { columns: { groupBy: 'custom', custom } } };
    const result = parseBounded(boardCreateInput, value);
    expect(result?.success).toBe(false);
    expect(result?.error?.issues).toHaveLength(50);
  });
});

describe('findsProblem', () => {
  it('stops at the first item of a list that fails a check, and checks a list’s length before its items', () => {
    let visited = 0;
    const counted = z.number().refine((n) => (visited++, n > 0));
    expect(findsProblem(z.array(counted), [1, 2, 0, 3, 0])).toBe(true);
    expect(visited).toBe(3);
    visited = 0;
    expect(findsProblem(z.array(counted).max(3), [1, 2, 3, 4])).toBe(true);
    expect(findsProblem(z.array(counted).min(2), [1])).toBe(true);
    expect(findsProblem(z.array(counted).length(2), [1, 2])).toBe(false);
    expect(visited).toBe(2);
  });

  it('opens records: keys, values, numeric keys and loose records', () => {
    const limits = groupPrefsSchema.shape.wipLimits;
    expect(findsProblem(limits, { a: 1, b: 0 })).toBe(true);
    expect(findsProblem(limits, { ['k'.repeat(81)]: 1 })).toBe(true);
    expect(findsProblem(limits, { a: 1, b: 2 })).toBe(false);
    const numbered = z.record(z.literal([1, 2]), z.number());
    expect(findsProblem(numbered, { 1: 5 })).toBe(false);
    expect(findsProblem(numbered, { 3: 5 })).toBe(true);
    expect(findsProblem(z.looseRecord(z.string().max(1), z.number()), { long: 'x', a: 1 })).toBe(false);
  });

  it('opens objects, unions and the wrappers', () => {
    expect(findsProblem(z.strictObject({ a: z.number() }), { a: 1, b: 2 })).toBe(true);
    expect(findsProblem(z.looseObject({ a: z.number() }), { a: 1, b: 2 })).toBe(false);
    expect(findsProblem(z.object({ a: z.number() }), {})).toBe(true);
    expect(findsProblem(rankPositionSchema, 'top')).toBe(false);
    expect(findsProblem(rankPositionSchema, { afterId: 0 })).toBe(true);
    expect(findsProblem(taskUpdateInput, { epicId: null, position: { rank: 'a' } })).toBe(false);
    expect(findsProblem(taskQueryInput, { filter: { epicIds: [null, 0] } })).toBe(true);
    expect(findsProblem(taskQueryInput, [])).toBe(true);
  });

  it('leaves the checks of whole objects to the parse', () => {
    const both = { due: 'today', dueDate: '2026-10-18' };
    expect(findsProblem(dropPatchSchema, both)).toBe(false);
    expect(dropPatchSchema.safeParse(both).success).toBe(false);
  });

  it('never finds a problem in a value zod accepts', () => {
    // Valid values of the schemas with the most lists, changed at random places to values of every kind: whenever
    // the walk finds a problem, zod refuses the value too.
    const TS = '2026-10-18T00:00:00.000Z';
    const column = { id: 'c1', name: 'C', match: { tagIds: [1, null], epicIds: [null] }, onDrop: { addTagIds: [1] } };
    const samples: Array<[z.ZodType, unknown]> = [
      [
        boardCreateInput,
        {
          name: 'B',
          config: {
            columns: { groupBy: 'custom', custom: [column] },
            swimlanes: { prefs: { tag: { order: ['1'], wipLimits: { 1: 3 } } } },
          },
        },
      ],
      [
        taskQueryInput,
        {
          filter: { projectIds: [1, 2], statusCategories: ['started'], due: ['overdue'], closedWithinDays: 0 },
          sort: { field: 'manual', dir: 'asc' },
          limit: 5,
        },
      ],
      [taskBulkUpdateInput, { ids: [1, 2], patch: { addTagIds: [3], dueDate: null } }],
      [taskUpdateInput, { tagIds: [1], position: { afterId: 1, beforeId: null } }],
      [customColumnSchema, { id: 'c1', name: 'C', color: '#000000', match: {}, onDrop: null }],
      [
        exportRowSchemas.tasks,
        {
          ...{ id: 1, projectId: 1, number: 1, epicId: null, statusId: 1, priority: 0, title: 'T', description: '' },
          ...{ startDate: null, dueDate: null, estimate: null, rank: 'a', completedAt: null, archivedAt: null },
          ...{ createdBy: null, createdAt: TS, updatedAt: TS, tagIds: [1, 2] },
        },
      ],
      [
        exportRowSchemas.activity,
        {
          ...{ id: 1, action: 'task.updated', entityType: 'task', entityId: 1, projectId: 1, taskId: 1 },
          ...{ data: { changes: [{ field: 'title', from: 'a', to: 'b', added: ['x'] }] }, actorId: null, createdAt: TS },
        },
      ],
    ];
    const replacements: unknown[] = [
      ...[0, -1, 1, 1.5, 2 ** 60, '', 'x', 'k'.repeat(81), '2026-13-01', null, true],
      ...[[], [0], [1], {}, { a: 1 }, undefined],
    ];
    let seed = 1;
    const random = (n: number) => ((seed = (seed * 16807) % 2147483647), seed % n);
    /** Every path to a value inside `v`. */
    const pathsOf = (v: unknown, path: PropertyKey[] = []): PropertyKey[][] =>
      typeof v === 'object' && v !== null
        ? [path, ...Object.entries(v).flatMap(([k, item]) => pathsOf(item, [...path, Array.isArray(v) ? Number(k) : k]))]
        : [path];
    const replaced = (v: unknown, path: PropertyKey[], value: unknown): unknown => {
      if (path.length === 0) return value;
      const copy: any = Array.isArray(v) ? [...v] : { ...(v as object) };
      const [head, ...rest] = path;
      copy[head as any] = replaced(copy[head as any], rest, value);
      if (value === undefined && rest.length === 0) delete copy[head as any];
      return copy;
    };
    let found = 0;
    for (const [schema, valid] of samples) {
      expect(findsProblem(schema, valid)).toBe(false);
      const all = pathsOf(valid);
      for (let i = 0; i < 400; i++) {
        let value = valid;
        for (let changes = 1 + random(3); changes > 0; changes--) {
          value = replaced(value, all[random(all.length)]!, replacements[random(replacements.length)]);
        }
        if (findsProblem(schema, value)) {
          found++;
          expect(schema.safeParse(value).success, JSON.stringify(value)).toBe(false);
        }
      }
    }
    expect(found).toBeGreaterThan(1000);
  });
});

describe('every list and record of the shared schemas lies on the walk', () => {
  /** The kinds findsProblem opens itself; it hands any other to validate() whole. */
  const WALKED = new Set(['optional', 'default', 'prefault', 'nullable', 'pipe', 'union', 'array', 'object', 'record']);
  const isSchema = (v: unknown): v is z.core.$ZodType =>
    typeof v === 'object' && v !== null && '_zod' in v && typeof (v as z.core.$ZodType)._zod.def?.type === 'string';

  /** The schemas inside `schema`, with their names: its def's schemas, lists of schemas and shape (not its checks). */
  function children(schema: z.core.$ZodType): Array<[string, z.core.$ZodType]> {
    const out: Array<[string, z.core.$ZodType]> = [];
    for (const [key, v] of Object.entries(schema._zod.def)) {
      if (key === 'checks') continue;
      if (isSchema(v)) out.push([key, v]);
      else if (Array.isArray(v)) v.forEach((item, i) => isSchema(item) && out.push([`${key}.${i}`, item]));
      else if (key === 'shape') for (const [name, item] of Object.entries(v as object)) if (isSchema(item)) out.push([name, item]);
    }
    return out;
  }

  /** Lists and records of `schema` that a walk does not open, under the kind that hides them. */
  function* hidden(schema: z.core.$ZodType, path: string, under: string | null = null): Generator<string> {
    const { type } = schema._zod.def;
    if (under !== null && (type === 'array' || type === 'record')) yield `${path}: a ${type} under a ${under}`;
    for (const [key, child] of children(schema)) {
      const opened = WALKED.has(type) && !(type === 'pipe' && key === 'out');
      yield* hidden(child, `${path}.${key}`, under ?? (opened ? null : type === 'pipe' ? 'pipe output' : type));
    }
  }

  const modules: Record<string, unknown> = {
    ...schemas,
    ...board,
    ...email,
    ...exportFile,
    ...exportRowSchemas,
    ...archive,
    ...Object.fromEntries(Object.entries(archiveRowSchemas).map(([table, schema]) => [`archive.${table}`, schema])),
  };
  const exported = Object.entries(modules).filter((entry): entry is [string, z.core.$ZodType] => isSchema(entry[1]));

  it('finds the lists it should, and those a walk would miss', () => {
    expect(exported.length).toBeGreaterThan(50);
    expect([...hidden(z.tuple([z.array(z.number())]), 't')]).toEqual(['t.items.0: a array under a tuple']);
    expect([...hidden(z.string().transform((v) => [v]).pipe(z.array(z.string())), 'p')]).toEqual(['p.out: a array under a pipe output']);
    expect([...hidden(boardCreateInput, 'b')]).toEqual([]);
  });

  it.each(exported)('%s', (_name, schema) => {
    expect([...hidden(schema, _name)]).toEqual([]);
  });
});
