// Board configuration: a saved, fully configurable view over tasks.
//
// boardConfigSchema.parse(anything-partial) always yields a complete config,
// so stored configs stay forward compatible when fields are added. Nested
// objects use .prefault({}) so their inner defaults are applied (zod 4).
// Read stored/untrusted configs with parseBoardConfigLenient().

import { z } from 'zod';
import { findsProblem, parseBounded } from './bounded';
import { LIMITS } from './constants';
import { addDays, endOfWeek, type ISODate, type WeekStart } from './dates';
import { matchesTaskFilter, type FilterContext } from './filter';
import {
  idSchema,
  isoDateSchema,
  prioritySchema,
  taskFilterSchema,
  taskSortSchema,
  type TaskFilter,
  type TaskUpdateInput,
} from './schemas';
import type { TaskDTO } from './types';

/** Fields a board can group COLUMNS by. 'custom' uses user-defined columns. */
export const COLUMN_GROUP_FIELDS = [
  'status', 'statusCategory', 'priority', 'project', 'milestone', 'epic', 'tag', 'due', 'custom',
] as const;
export type ColumnGroupField = (typeof COLUMN_GROUP_FIELDS)[number];

/** Fields a board can group SWIMLANES (rows) by. 'custom' uses user-defined lanes. */
export const SWIMLANE_GROUP_FIELDS = [
  'none', 'status', 'statusCategory', 'priority', 'project', 'milestone', 'epic', 'tag', 'due', 'custom',
] as const;
export type SwimlaneGroupField = (typeof SWIMLANE_GROUP_FIELDS)[number];

export const GROUP_FIELD_LABELS: Record<ColumnGroupField | SwimlaneGroupField, string> = {
  none: 'None',
  status: 'Status',
  statusCategory: 'Status category',
  priority: 'Priority',
  project: 'Project',
  milestone: 'Milestone',
  epic: 'Epic',
  tag: 'Tag',
  due: 'Due date',
  custom: 'Custom',
};

export const NONE_GROUP_KEY = 'none';
export const OTHER_GROUP_KEY = '__other';

// ---------------------------------------------------------------------------
// Drop patches
// ---------------------------------------------------------------------------

/**
 * Patch applied to a task when it is dropped into a custom column/lane.
 * Convert to a TaskUpdateInput with resolveDropPatch() (resolves `due` relative to today).
 */
export const dropPatchSchema = z
  .object({
    statusId: idSchema.optional(),
    priority: prioritySchema.optional(),
    projectId: idSchema.optional(),
    epicId: idSchema.nullable().optional(),
    addTagIds: z.array(idSchema).max(100).optional(),
    removeTagIds: z.array(idSchema).max(100).optional(),
    /** Relative due date; mutually exclusive with dueDate. */
    due: z.enum(['today', 'tomorrow', 'next_week', 'clear']).optional(),
    dueDate: isoDateSchema.optional(),
    archived: z.boolean().optional(),
  })
  .refine((p) => !(p.due !== undefined && p.dueDate !== undefined), {
    message: 'Use either a relative or a fixed due date',
    path: ['dueDate'],
  })
  .refine((p) => !(p.addTagIds ?? []).some((id) => (p.removeTagIds ?? []).includes(id)), {
    message: 'A tag cannot be both added and removed',
    path: ['removeTagIds'],
  });
export type DropPatch = z.infer<typeof dropPatchSchema>;

/**
 * DropPatch -> TaskUpdateInput. `dueDate` wins over `due`; next_week = first day of next week.
 */
export function resolveDropPatch(p: DropPatch, today: ISODate, weekStartsOn: WeekStart): TaskUpdateInput {
  const out: TaskUpdateInput = {};
  if (p.statusId !== undefined) out.statusId = p.statusId;
  if (p.priority !== undefined) out.priority = p.priority;
  if (p.projectId !== undefined) out.projectId = p.projectId;
  if (p.epicId !== undefined) out.epicId = p.epicId;
  if (p.addTagIds?.length) out.addTagIds = [...new Set(p.addTagIds)];
  if (p.removeTagIds?.length) out.removeTagIds = [...new Set(p.removeTagIds)];
  if (p.archived !== undefined) out.archived = p.archived;
  if (p.dueDate !== undefined) out.dueDate = p.dueDate;
  else if (p.due === 'clear') out.dueDate = null;
  else if (p.due === 'today') out.dueDate = today;
  else if (p.due === 'tomorrow') out.dueDate = addDays(today, 1);
  else if (p.due === 'next_week') out.dueDate = addDays(endOfWeek(today, weekStartsOn), 1);
  return out;
}

// ---------------------------------------------------------------------------
// Custom columns / lanes
// ---------------------------------------------------------------------------

/**
 * A user-defined column (or lane). A task is placed in the FIRST custom group whose
 * `match` it satisfies (array order); others go to '__other' when showUnmatched.
 * `match` only narrows the board's result set: archive defaults do NOT apply to it
 * (see matchesCustomColumn). `onDrop` null = not a drop target; {} = reorder only.
 * Generate ids with newCustomColumnId() (crypto.randomUUID needs HTTPS).
 */
export const customColumnSchema = z.object({
  id: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,40}$/)
    .refine((id) => id !== OTHER_GROUP_KEY && id !== NONE_GROUP_KEY, 'Reserved id'),
  name: z.string().trim().min(1).max(60),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .default(null),
  match: taskFilterSchema.default({}),
  onDrop: dropPatchSchema.nullable().default(null),
});
export type CustomColumn = z.infer<typeof customColumnSchema>;

export function newCustomColumnId(): string {
  return `c${Math.random().toString(36).slice(2, 10)}`;
}

/** First-match-wins custom grouping ignores the archive defaults of TaskFilter. */
export function matchesCustomColumn(task: TaskDTO, col: Pick<CustomColumn, 'match'>, ctx: FilterContext): boolean {
  return matchesTaskFilter(task, { archived: 'include', includeArchivedProjects: true, ...col.match }, ctx);
}

/** Group key of a task under custom grouping: the first matching column id, else '__other'. */
export function customGroupKey(task: TaskDTO, cols: readonly CustomColumn[], ctx: FilterContext): string {
  return cols.find((c) => matchesCustomColumn(task, c, ctx))?.id ?? OTHER_GROUP_KEY;
}

// ---------------------------------------------------------------------------
// Axis (columns / swimlanes) configuration
// ---------------------------------------------------------------------------

const groupKeyList = z.array(z.string().max(80)).max(1000);

/**
 * Per-field display preferences of an axis. Stored per groupBy field so switching
 * grouping never applies one field's keys to another (keys are not namespaced).
 */
export const groupPrefsSchema = z.object({
  /** Group keys in display order; groups not listed follow in natural order. Ignored for 'custom'. */
  order: groupKeyList.default([]),
  /** Group keys that are never shown. */
  hidden: groupKeyList.default([]),
  /** Group keys rendered collapsed. */
  collapsed: groupKeyList.default([]),
  /** Soft WIP limit per group key (columns only; lanes ignore it). */
  wipLimits: z.record(z.string().max(80), z.number().int().positive()).default({}),
});
export type GroupPrefs = z.infer<typeof groupPrefsSchema>;

const customListSchema = z
  .array(customColumnSchema)
  .max(LIMITS.customColumnsMax)
  .default([])
  .transform((cols) => {
    const seen = new Set<string>();
    return cols.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
  });

export const columnsConfigSchema = z.object({
  groupBy: z.enum(COLUMN_GROUP_FIELDS).default('status'),
  prefs: z.partialRecord(z.enum(COLUMN_GROUP_FIELDS), groupPrefsSchema).default({}),
  /** Show groups that currently have no tasks (enumerable fields only). */
  showEmpty: z.boolean().default(true),
  /** Show the "No epic / No milestone / No tag" group (key 'none'). */
  showNone: z.boolean().default(true),
  /** Used when groupBy === 'custom'. Array order is display order. */
  custom: customListSchema,
  /** Custom mode: show the "Other" group (key '__other') for unmatched tasks. */
  showUnmatched: z.boolean().default(true),
});

export const swimlanesConfigSchema = z.object({
  groupBy: z.enum(SWIMLANE_GROUP_FIELDS).default('none'),
  prefs: z.partialRecord(z.enum(SWIMLANE_GROUP_FIELDS), groupPrefsSchema).default({}),
  showEmpty: z.boolean().default(false),
  showNone: z.boolean().default(true),
  custom: customListSchema,
  showUnmatched: z.boolean().default(true),
});

export type ColumnsConfig = z.infer<typeof columnsConfigSchema>;
export type SwimlanesConfig = z.infer<typeof swimlanesConfigSchema>;

export const CARD_FIELDS = [
  'ref', 'project', 'milestone', 'epic', 'status', 'tags', 'priority', 'dueDate', 'startDate',
  'estimate', 'commentCount', 'worklog', 'description',
] as const;
export type CardField = (typeof CARD_FIELDS)[number];

export const CARD_FIELD_LABELS: Record<CardField, string> = {
  ref: 'Task key',
  project: 'Project',
  milestone: 'Milestone',
  epic: 'Epic',
  status: 'Status',
  tags: 'Tags',
  priority: 'Priority',
  dueDate: 'Due date',
  startDate: 'Start date',
  estimate: 'Estimate',
  commentCount: 'Comment count',
  worklog: 'Time logged',
  description: 'Description preview',
};

export const CARD_COLOR_BY = ['none', 'project', 'milestone', 'epic', 'priority', 'status', 'tag'] as const;
export type CardColorBy = (typeof CARD_COLOR_BY)[number];

export const cardConfigSchema = z.object({
  density: z.enum(['compact', 'comfortable']).default('comfortable'),
  /** Colored left edge on cards ('tag' = first tag by name). */
  colorBy: z.enum(CARD_COLOR_BY).default('none'),
  fields: z
    .object({
      ref: z.boolean().default(true),
      project: z.boolean().default(true),
      milestone: z.boolean().default(false),
      epic: z.boolean().default(true),
      status: z.boolean().default(false),
      tags: z.boolean().default(true),
      priority: z.boolean().default(true),
      dueDate: z.boolean().default(true),
      startDate: z.boolean().default(false),
      estimate: z.boolean().default(false),
      commentCount: z.boolean().default(true),
      worklog: z.boolean().default(false),
      description: z.boolean().default(false),
    })
    .prefault({}),
});
export type CardConfig = z.infer<typeof cardConfigSchema>;

const DEFAULT_FILTER: TaskFilter = { closedWithinDays: 14 };
const DEFAULT_SORT = { field: 'manual', dir: 'asc' } as const;

const boardConfigObject = z.object({
  version: z.literal(1).default(1),
  layout: z.enum(['kanban', 'list']).default('kanban'),
  filter: taskFilterSchema.default(DEFAULT_FILTER),
  sort: taskSortSchema.default(DEFAULT_SORT),
  columns: columnsConfigSchema.prefault({}),
  swimlanes: swimlanesConfigSchema.prefault({}),
  card: cardConfigSchema.prefault({}),
});

type RawBoardConfig = z.infer<typeof boardConfigObject>;

/**
 * Normalize combinations that cannot work: swimlanes grouped by the same field as
 * columns (or status × statusCategory) fall back to no swimlanes.
 */
function normalizeBoardConfig(cfg: RawBoardConfig): RawBoardConfig {
  const c = cfg.columns.groupBy;
  const l = cfg.swimlanes.groupBy;
  const clash =
    (l === c && l !== 'custom') ||
    (c === 'status' && l === 'statusCategory') ||
    (c === 'statusCategory' && l === 'status');
  return clash ? { ...cfg, swimlanes: { ...cfg.swimlanes, groupBy: 'none' } } : cfg;
}

export const boardConfigSchema = boardConfigObject.transform(normalizeBoardConfig);
/** Fully-populated board configuration (after parsing). */
export type BoardConfig = z.output<typeof boardConfigSchema>;
/** Any partial config accepted by the API (missing fields get defaults). */
export type BoardConfigInput = z.input<typeof boardConfigSchema>;

/** A complete default config (status columns, all projects, hide tasks closed > 14 days ago). */
export function defaultBoardConfig(overrides: BoardConfigInput = {}): BoardConfig {
  return boardConfigSchema.parse(overrides);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * schema.safeParse(value), or null when a walk of the value finds a part that fails it (findsProblem), for the
 * parts of a config that may be large and are being read because something in them failed. The lenient reading
 * only asks whether a part passes, so a failing part is refused at its first problem rather than described: a
 * parse describes every problem, however small the value (a custom list of 200 empty columns makes 600 issues,
 * each time it is tried). A valid part is walked and then parsed.
 */
const tryParse = <S extends z.ZodType>(schema: S, value: unknown): z.ZodSafeParseResult<z.output<S>> | null =>
  findsProblem(schema, value) ? null : schema.safeParse(value);

/**
 * Custom columns the lenient reading of one import may try to repair, shared by all its boards (Appendix D 62):
 * repairing a column takes several parses, and an import holds up to 10,000 boards. Once spent, an axis whose
 * custom list needs repairs gets its defaults. A real config needs a repair only when an older version wrote it,
 * and holds at most LIMITS.customColumnsMax columns per axis.
 */
export const IMPORT_REPAIR_COLUMNS = 5_000;

/** What the lenient readings of one import have left to spend on repairs (parseBoardConfigLenient's budget). */
export interface RepairBudget {
  columns: number;
}

/**
 * Best-effort repair of a stored drop patch: resolve the two cross-field conflicts the
 * schema rejects (a tag both added and removed: adding wins; relative and fixed due date:
 * the fixed date wins, as in resolveDropPatch) and drop individually invalid fields.
 * Returns null (not a drop target) when nothing usable is left of a non-object.
 */
function repairDropPatch(value: unknown): DropPatch | null {
  const direct = parseBounded(dropPatchSchema.nullable(), value ?? null);
  if (direct?.success) return direct.data;
  if (!isRecord(value)) return null;
  const shape: Record<string, z.ZodType> = dropPatchSchema.shape;
  const kept: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (k in shape && parseBounded(shape[k]!, v)?.success) kept[k] = v;
  }
  if (Array.isArray(kept.addTagIds) && Array.isArray(kept.removeTagIds)) {
    const add = kept.addTagIds as number[];
    kept.removeTagIds = (kept.removeTagIds as number[]).filter((id) => !add.includes(id));
    if ((kept.removeTagIds as number[]).length === 0) delete kept.removeTagIds;
  }
  if (kept.due !== undefined && kept.dueDate !== undefined) delete kept.due;
  const retry = parseBounded(dropPatchSchema, kept);
  return retry?.success ? retry.data : null;
}

/** Keep a custom column whose only problems are repairable (drop patch, color); else null. */
function repairCustomColumn(value: unknown): CustomColumn | null {
  const direct = parseBounded(customColumnSchema, value);
  if (direct?.success) return direct.data;
  if (!isRecord(value)) return null;
  const color = parseBounded(customColumnSchema.shape.color, value.color);
  const retry = parseBounded(customColumnSchema, {
    ...value,
    color: color?.success ? color.data : null,
    onDrop: repairDropPatch(value.onDrop),
  });
  return retry?.success ? retry.data : null;
}

/**
 * The most custom columns a repair looks at. A longer list is no config the app wrote (an axis keeps at most
 * LIMITS.customColumnsMax), so the axis gets its defaults without a repair attempt per entry.
 */
const CUSTOM_REPAIR_MAX = 4 * LIMITS.customColumnsMax;

/** The columns of `list` that are valid or repairable, up to one more than an axis may have. */
function repairCustomColumns(list: unknown[]): CustomColumn[] {
  const kept: CustomColumn[] = [];
  for (const value of list) {
    const column = repairCustomColumn(value);
    // One column too many fails the axis's retry below, as any more would: the axis gets its defaults.
    if (column !== null && kept.push(column) > LIMITS.customColumnsMax) break;
  }
  return kept;
}

function lenientAxis<S extends typeof columnsConfigSchema | typeof swimlanesConfigSchema>(
  schema: S,
  value: unknown,
  groupFields: readonly string[],
  budget: RepairBudget | undefined,
): z.output<S> {
  const direct = tryParse(schema, value ?? {});
  if (direct?.success) return direct.data as z.output<S>;
  if (!isRecord(value)) return schema.parse({}) as z.output<S>;
  // Repair or drop individually invalid pieces, keep the rest. Only the keys the axis has are looked at, and
  // only its own group fields in prefs, so the work does not grow with what else an imported config holds.
  const cleaned: Record<string, unknown> = {};
  for (const k of Object.keys(schema.shape)) {
    if (!Object.hasOwn(value, k)) continue;
    const v = value[k];
    if (k === 'custom' && Array.isArray(v)) {
      if (v.length > CUSTOM_REPAIR_MAX || (budget !== undefined && v.length > budget.columns)) return schema.parse({}) as z.output<S>;
      if (budget !== undefined) budget.columns -= v.length;
      cleaned.custom = repairCustomColumns(v);
    } else if (k === 'prefs' && isRecord(v)) {
      const valid = groupFields.filter((f) => Object.hasOwn(v, f) && tryParse(groupPrefsSchema, v[f])?.success);
      cleaned.prefs = Object.fromEntries(valid.map((f) => [f, v[f]]));
    } else {
      const probe = tryParse(schema, { [k]: v });
      if (probe?.success) cleaned[k] = v;
    }
  }
  const retry = parseBounded(schema, cleaned);
  return (retry?.success ? retry.data : schema.parse({})) as z.output<S>;
}

/**
 * Parse a stored/untrusted config without throwing. Invalid sections fall back to
 * their defaults individually (and invalid custom columns are dropped), so one bad
 * field never wipes the whole configuration. Every part is parsed with parseBounded
 * or tryParse, since an imported config can be as large as the file. An import
 * passes its RepairBudget, which bounds the repairs of all its boards together.
 */
export function parseBoardConfigLenient(value: unknown, budget?: RepairBudget): BoardConfig {
  // A stored config is valid but for what an older version wrote, and parseBounded parses a small valid one at
  // once; an imported one may be anything, and tryParse refuses most invalid ones at their first problem.
  const full = budget === undefined ? parseBounded(boardConfigSchema, value ?? {}) : tryParse(boardConfigSchema, value ?? {});
  if (full?.success) return full.data;
  const v = isRecord(value) ? value : {};
  const pick = <T>(schema: z.ZodType<T>, input: unknown, fallback: T): T => {
    const r = tryParse(schema, input);
    return r?.success ? r.data : fallback;
  };
  return normalizeBoardConfig({
    version: 1,
    layout: pick(z.enum(['kanban', 'list']), v.layout, 'kanban'),
    filter: pick(taskFilterSchema, v.filter, DEFAULT_FILTER),
    sort: pick(taskSortSchema, v.sort, { ...DEFAULT_SORT }),
    columns: lenientAxis(columnsConfigSchema, v.columns, COLUMN_GROUP_FIELDS, budget),
    swimlanes: lenientAxis(swimlanesConfigSchema, v.swimlanes, SWIMLANE_GROUP_FIELDS, budget),
    card: pick(cardConfigSchema, v.card, cardConfigSchema.parse({})),
  });
}

/** Display prefs for the axis' current groupBy (defaults when none stored). */
export function activePrefs(axis: { groupBy: string; prefs: Partial<Record<string, GroupPrefs>> }): GroupPrefs {
  return axis.prefs[axis.groupBy] ?? groupPrefsSchema.parse({});
}

/** Immutably update the prefs of the current groupBy of one axis. */
export function updateActivePrefs(cfg: BoardConfig, axis: 'columns' | 'swimlanes', patch: Partial<GroupPrefs>): BoardConfig {
  const a = cfg[axis];
  const next: GroupPrefs = { ...activePrefs(a), ...patch };
  return { ...cfg, [axis]: { ...a, prefs: { ...a.prefs, [a.groupBy]: next } } } as BoardConfig;
}

// ---------------------------------------------------------------------------
// Board create / update inputs
// ---------------------------------------------------------------------------

export const boardCreateInput = z.object({
  name: z.string().trim().min(1, 'Required').max(LIMITS.boardNameMax),
  description: z.string().max(2000).optional(),
  /**
   * Make this a project board (shown on that project's Board tab). Immutable.
   * The server forces config.filter.projectIds = [projectId] for project boards.
   */
  projectId: idSchema.nullable().optional(),
  config: boardConfigSchema.optional(),
});
export type BoardCreateInput = z.input<typeof boardCreateInput>;

export const boardUpdateInput = z.object({
  name: z.string().trim().min(1, 'Required').max(LIMITS.boardNameMax).optional(),
  description: z.string().max(2000).optional(),
  /** Replaces the whole config (send the complete BoardConfig). */
  config: boardConfigSchema.optional(),
});
export type BoardUpdateInput = z.input<typeof boardUpdateInput>;

// ---------------------------------------------------------------------------
// Keeping stored ids valid
// ---------------------------------------------------------------------------

export type BoardRefKind = 'status' | 'tag' | 'project' | 'milestone' | 'epic';

const FILTER_KEY: Record<BoardRefKind, 'statusIds' | 'tagIds' | 'projectIds' | 'milestoneIds' | 'epicIds'> = {
  status: 'statusIds',
  tag: 'tagIds',
  project: 'projectIds',
  milestone: 'milestoneIds',
  epic: 'epicIds',
};

function remapFilter(f: TaskFilter, kind: BoardRefKind, fromId: number, toId: number | null): TaskFilter {
  // Deletions leave filter ids in place (they match nothing, the UI shows "deleted");
  // merges/reassignments replace them.
  if (toId === null) return f;
  const key = FILTER_KEY[kind];
  const out: TaskFilter = { ...f };
  const arr = f[key] as Array<number | null> | undefined;
  if (arr?.includes(fromId)) {
    (out as Record<string, unknown>)[key] = [...new Set(arr.map((id) => (id === fromId ? toId : id)))];
  }
  if (kind === 'tag' && f.excludeTagIds?.includes(fromId)) {
    out.excludeTagIds = [...new Set(f.excludeTagIds.map((id) => (id === fromId ? toId : id)))];
  }
  return out;
}

function remapDrop(p: DropPatch | null, kind: BoardRefKind, fromId: number, toId: number | null): DropPatch | null {
  if (!p) return p;
  const out: DropPatch = { ...p };
  const swap = (id: number | undefined) => (id === fromId ? (toId ?? undefined) : id);
  if (kind === 'status') out.statusId = swap(p.statusId);
  if (kind === 'project') out.projectId = swap(p.projectId);
  if (kind === 'epic' && p.epicId === fromId) {
    if (toId === null) delete out.epicId;
    else out.epicId = toId;
  }
  if (kind === 'tag') {
    const fix = (ids: number[] | undefined) =>
      ids && [...new Set(ids.flatMap((id) => (id === fromId ? (toId === null ? [] : [toId]) : [id])))];
    out.addTagIds = fix(p.addTagIds);
    out.removeTagIds = fix(p.removeTagIds);
    // A merge can make one id both added and removed (add A + remove B, merge A -> B), which
    // dropPatchSchema rejects. Adding wins: the column still applies the (merged) tag it adds.
    if (toId !== null && out.addTagIds && out.removeTagIds) {
      const add = out.addTagIds;
      const remove = out.removeTagIds.filter((id) => !add.includes(id));
      if (remove.length !== out.removeTagIds.length) out.removeTagIds = remove.length ? remove : undefined;
    }
  }
  for (const k of Object.keys(out) as Array<keyof DropPatch>) if (out[k] === undefined) delete out[k];
  return out;
}

/**
 * Drop the removed group's display prefs (order, hidden, collapsed, WIP limit). On a merge or
 * reassignment the target group keeps its OWN prefs: the source's are never carried over (hiding
 * "Cancelled" and then deleting it into "Done" must not hide Done on every board).
 */
function remapPrefs(prefs: GroupPrefs | undefined, fromKey: string): GroupPrefs | undefined {
  if (!prefs) return prefs;
  const list = (l: string[]) => l.filter((k) => k !== fromKey);
  const wip = { ...prefs.wipLimits };
  delete wip[fromKey];
  return { order: list(prefs.order), hidden: list(prefs.hidden), collapsed: list(prefs.collapsed), wipLimits: wip };
}

/**
 * Rewrite references to an entity after it was merged into another (toId) or deleted (null):
 * filters and custom-column matches (merge only) and drop patches are remapped; the removed
 * group's prefs (order/hidden/collapsed/WIP) are dropped and the target keeps its own.
 * The result always satisfies boardConfigSchema. Returns the same object when nothing changed.
 */
export function remapBoardConfigIds(
  cfg: BoardConfig,
  kind: BoardRefKind,
  fromId: number,
  toId: number | null,
): BoardConfig {
  const fromKey = String(fromId);
  const remapAxis = <A extends ColumnsConfig | SwimlanesConfig>(axis: A): A => ({
    ...axis,
    prefs: { ...axis.prefs, [kind]: remapPrefs(axis.prefs[kind as keyof typeof axis.prefs], fromKey) },
    custom: axis.custom.map((col) => ({
      ...col,
      match: remapFilter(col.match, kind, fromId, toId),
      onDrop: remapDrop(col.onDrop, kind, fromId, toId),
    })),
  });
  const next: BoardConfig = {
    ...cfg,
    filter: remapFilter(cfg.filter, kind, fromId, toId),
    columns: remapAxis(cfg.columns),
    swimlanes: remapAxis(cfg.swimlanes),
  };
  for (const axis of [next.columns, next.swimlanes]) {
    if (axis.prefs[kind as keyof typeof axis.prefs] === undefined) delete axis.prefs[kind as keyof typeof axis.prefs];
  }
  return JSON.stringify(next) === JSON.stringify(cfg) ? cfg : next;
}

// ---------------------------------------------------------------------------
// Group keys
// ---------------------------------------------------------------------------
// Every group (column or swimlane) has a string key:
//   status          -> String(statusId)
//   statusCategory  -> category name, e.g. 'started'
//   priority        -> '0'..'4'
//   project         -> String(projectId)
//   milestone       -> String(milestoneId) | 'none'
//   epic            -> String(epicId) | 'none'
//   tag             -> String(tagId) | 'none'   (a task with N tags appears in N groups)
//   due             -> a DueBucket, e.g. 'overdue' (closed tasks with past dates: 'past')
//   custom          -> CustomColumn.id | '__other'
// See SPEC.md §8 for enumeration order, visibility and drop rules.
