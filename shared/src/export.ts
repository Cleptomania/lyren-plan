// Validation schema for the JSON export/import format, version 1 (ExportDTO in ./types.ts), and the row
// schemas that archive v2 (./archive.ts, design §8.2) shares with it, parameterized by its user references.
// Shapes only; referential integrity is checked by the server (SPEC §5.10).
// Timestamps are normalized to toISOString() form because SQL compares them as strings.

import { z } from 'zod';
import {
  EPIC_STATUSES,
  ESTIMATE_UNITS,
  LIMITS,
  MILESTONE_STATUSES,
  PROJECT_STATUSES,
  STATUS_CATEGORIES,
} from './constants';
import { isoDateSchema, prioritySchema, weekStartSchema } from './schemas';
import type { ActivityData } from './types';

/** A timestamp of an export or archive, normalized to toISOString() form. */
export const exportTimestampSchema = z.iso.datetime({ offset: true }).transform((v) => new Date(v).toISOString());
const ts = exportTimestampSchema;
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/).transform((v) => v.toLowerCase());
const nullableDate = isoDateSchema.nullable();
const text = (max: number) => z.string().max(max);
const MAX_ROWS = 1_000_000;

/**
 * Upper bound for imported ids, task numbers, task counters and positions. Rows are inserted
 * with their original ids and the tables use AUTOINCREMENT, so an id near 2^53 would push the
 * next generated id past what node:sqlite can return as a JS number (every later read of that
 * table fails). 2^40 leaves ~9·10^15 inserts of headroom and is far above any real data.
 */
export const IMPORT_INT_MAX = 2 ** 40;
/** An id of an exported row: a positive integer up to IMPORT_INT_MAX. */
export const exportIdSchema = z.number().int().positive().max(IMPORT_INT_MAX);
const id = exportIdSchema;
const position = z.number().int().min(-IMPORT_INT_MAX).max(IMPORT_INT_MAX);

// ---- Activity data (SPEC §5.8 ActivityData) -------------------------------------------
// Activity `data` is rendered by the web app, which relies on these shapes; unknown extra keys
// are kept (and ignored by the renderer).

const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/** FieldChange (shared/src/types.ts). */
export const fieldChangeSchema = z.looseObject({
  field: z.string().max(100),
  from: scalar.optional(),
  to: scalar.optional(),
  fromLabel: z.string().nullable().optional(),
  toLabel: z.string().nullable().optional(),
  added: z.array(z.string()).optional(),
  removed: z.array(z.string()).optional(),
});

const activityDataShape = {
  changes: z.array(fieldChangeSchema).max(1000).optional(),
  title: z.string().optional(),
  name: z.string().optional(),
  key: z.string().optional(),
  ref: z.string().optional(),
  duplicatedFrom: z.string().optional(),
  fromProjectId: z.number().optional(),
  toProjectId: z.number().optional(),
  fromProjectName: z.string().optional(),
  toProjectName: z.string().optional(),
  fromRef: z.string().optional(),
  toRef: z.string().optional(),
  excerpt: z.string().optional(),
  minutes: z.number().nullable().optional(),
  date: z.string().optional(),
  note: z.string().optional(),
};

/** ActivityData (shared/src/types.ts): the known keys must have their documented types. */
export const activityDataSchema = z.looseObject(activityDataShape);

/**
 * The JSON text an imported activity entry's `data` may have at most (UTF-16 units, so at most 768 KB of UTF-8).
 * What the app writes is a few hundred characters; the bound keeps every imported row far from a Durable
 * Object's 2 MB per row and string (design Appendix D 62).
 */
export const ACTIVITY_DATA_MAX_CHARS = 256 * 1024;

/**
 * Best-effort repair of stored activity data for reading and exporting: keeps every key that
 * conforms to ActivityData and drops the rest (malformed `changes` entries are dropped one by
 * one). Non-objects become `{}`.
 */
export function sanitizeActivityData(value: unknown): ActivityData {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  if (activityDataSchema.safeParse(value).success) return value as ActivityData;
  const shape: Record<string, z.ZodType> = activityDataShape;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (key === 'changes') {
      if (Array.isArray(v)) out.changes = v.filter((c) => fieldChangeSchema.safeParse(c).success).slice(0, 1000);
    } else if (!Object.hasOwn(shape, key) || shape[key]!.safeParse(v).success) {
      out[key] = v;
    }
  }
  return out as ActivityData;
}

/** The fields of an export besides its tables. */
const exportHeader = {
  format: z.literal('lyren-plan-export'),
  formatVersion: z.literal(1),
  exportedAt: ts,
  appVersion: z.string().max(50),
  settings: z.object({
    weekStartsOn: weekStartSchema,
    estimateUnit: z.enum(ESTIMATE_UNITS),
    defaultBoardId: id.nullable(),
    homePage: z.enum(['dashboard', 'default_board']),
  }),
};

/**
 * One row of each table of an export, whose user references (`createdBy`, `authorId`, `actorId`) are
 * `userRef`s or null. The server checks a file's rows one at a time with these (server/src/space/archive/
 * validate.ts, design Appendix D 44): zod describes every failing row of a list, so a large file of bad rows
 * would make millions of issues. v1 references are ids; archive v2's are ids of its `users` (./archive.ts).
 */
export function exportRowSchemasFor<U extends z.ZodType<number, number>>(userRef: U) {
  return {
    statuses: z.object({
      id,
      name: z.string().trim().min(1).max(LIMITS.statusNameMax),
      category: z.enum(STATUS_CATEGORIES),
      color,
      position,
    }),
    tags: z.object({
      id,
      name: z.string().trim().min(1).max(LIMITS.tagNameMax),
      color,
      createdAt: ts,
    }),
    projects: z.object({
      id,
      key: z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/),
      name: z.string().trim().min(1).max(LIMITS.nameMax),
      description: text(LIMITS.descriptionMax),
      color,
      status: z.enum(PROJECT_STATUSES),
      position,
      taskCounter: z.number().int().min(0).max(IMPORT_INT_MAX),
      createdAt: ts,
      updatedAt: ts,
    }),
    milestones: z.object({
      id,
      projectId: id,
      name: z.string().trim().min(1).max(LIMITS.nameMax),
      description: text(LIMITS.descriptionMax),
      status: z.enum(MILESTONE_STATUSES),
      startDate: nullableDate,
      dueDate: nullableDate,
      position,
      completedAt: ts.nullable(),
      createdAt: ts,
      updatedAt: ts,
    }),
    epics: z.object({
      id,
      projectId: id,
      milestoneId: id.nullable(),
      name: z.string().trim().min(1).max(LIMITS.nameMax),
      description: text(LIMITS.descriptionMax),
      color,
      status: z.enum(EPIC_STATUSES),
      startDate: nullableDate,
      dueDate: nullableDate,
      position,
      completedAt: ts.nullable(),
      createdAt: ts,
      updatedAt: ts,
    }),
    tasks: z.object({
      id,
      projectId: id,
      number: z.number().int().positive().max(IMPORT_INT_MAX),
      epicId: id.nullable(),
      statusId: id,
      priority: prioritySchema,
      title: z.string().trim().min(1).max(LIMITS.titleMax),
      description: text(LIMITS.descriptionMax),
      startDate: nullableDate,
      dueDate: nullableDate,
      estimate: z.number().min(0).max(100_000).nullable(),
      /**
       * Ranks are re-generated on import (order preserved), so any string is accepted. The cap
       * only bounds memory: the server keeps ranks short (see server/src/services/rank.ts).
       */
      rank: z.string().max(10_000),
      completedAt: ts.nullable(),
      archivedAt: ts.nullable(),
      createdBy: userRef.nullable(),
      createdAt: ts,
      updatedAt: ts,
      /** The API puts no cap on a task's tag count, so neither does the export (beyond the tag count). */
      tagIds: z.array(id).max(100_000),
    }),
    comments: z.object({
      id,
      taskId: id,
      body: z.string().min(1).max(LIMITS.commentMax),
      authorId: userRef.nullable(),
      createdAt: ts,
      updatedAt: ts,
      editedAt: ts.nullable(),
    }),
    worklogs: z.object({
      id,
      taskId: id,
      date: isoDateSchema,
      minutes: z.number().int().min(0).max(LIMITS.worklogMinutesMax).nullable(),
      note: text(LIMITS.worklogNoteMax),
      authorId: userRef.nullable(),
      createdAt: ts,
      updatedAt: ts,
    }),
    activity: z.object({
      id,
      action: z.string().max(50),
      entityType: z.string().max(30),
      entityId: id.nullable(),
      projectId: id.nullable(),
      taskId: id.nullable(),
      data: activityDataSchema.refine((data) => JSON.stringify(data).length <= ACTIVITY_DATA_MAX_CHARS, {
        message: `Too big: expected at most ${ACTIVITY_DATA_MAX_CHARS} characters as JSON`,
      }),
      actorId: userRef.nullable(),
      createdAt: ts,
    }),
    boards: z.object({
      id,
      projectId: id.nullable().default(null),
      name: z.string().trim().min(1).max(LIMITS.boardNameMax),
      description: text(2000),
      /** Parsed leniently by the server (parseBoardConfigLenient). */
      config: z.unknown(),
      position,
      createdAt: ts,
      updatedAt: ts,
    }),
  };
}

/** The rows of a v1 export, whose user references are ids (every one becomes the importer, design §8.6). */
export const exportRowSchemas = exportRowSchemasFor(id);

export type ExportTable = keyof typeof exportRowSchemas;

/** The tables of an export, in the order the file lists them (and the server checks them). */
export const EXPORT_TABLES = Object.keys(exportRowSchemas) as ExportTable[];

/** The most rows each table may hold. */
const EXPORT_MAX_ROWS: Record<ExportTable, number> = {
  statuses: 1000,
  tags: 100_000,
  projects: 100_000,
  milestones: MAX_ROWS,
  epics: MAX_ROWS,
  tasks: MAX_ROWS,
  comments: MAX_ROWS,
  worklogs: MAX_ROWS,
  activity: MAX_ROWS * 5,
  boards: 10_000,
};

/** A table's list of `row`s: at most its row cap, and at least one status. */
export function exportTableList<T extends z.ZodType>(table: ExportTable, row: T) {
  const list = z.array(row).max(EXPORT_MAX_ROWS[table]);
  return table === 'statuses' ? list.min(1, 'An export must contain at least one status') : list;
}

export const exportSchema = z.object({
  ...exportHeader,
  statuses: exportTableList('statuses', exportRowSchemas.statuses),
  tags: exportTableList('tags', exportRowSchemas.tags),
  projects: exportTableList('projects', exportRowSchemas.projects),
  milestones: exportTableList('milestones', exportRowSchemas.milestones),
  epics: exportTableList('epics', exportRowSchemas.epics),
  tasks: exportTableList('tasks', exportRowSchemas.tasks),
  comments: exportTableList('comments', exportRowSchemas.comments),
  worklogs: exportTableList('worklogs', exportRowSchemas.worklogs),
  activity: exportTableList('activity', exportRowSchemas.activity),
  boards: exportTableList('boards', exportRowSchemas.boards),
});

/** An export with its rows left unchecked: the header, and each table a list within its row caps. */
export const exportFrameSchema = z.object({
  ...exportHeader,
  ...(Object.fromEntries(EXPORT_TABLES.map((table) => [table, exportTableList(table, z.unknown())])) as Record<
    ExportTable,
    z.ZodArray<z.ZodUnknown>
  >),
});

export type ExportInput = z.input<typeof exportSchema>;
export type ExportParsed = z.output<typeof exportSchema>;
