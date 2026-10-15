// Zod schemas for every API input. The server validates requests with these and
// the web client reuses them for form validation, so they are the API contract.
//
// zod v4 notes (important):
//  - Input schemas deliberately contain NO .default() values. Servers apply
//    defaults explicitly. (In zod 4, defaults inside .optional()/.partial() are
//    still applied, which would make PATCH requests overwrite fields.)
//  - Use .prefault() (not .default()) when a nested object default must itself
//    be parsed through the schema (see board.ts).

import { z } from 'zod';
import {
  DUE_PRESETS,
  EPIC_STATUSES,
  ESTIMATE_UNITS,
  LIMITS,
  MILESTONE_STATUSES,
  PROJECT_STATUSES,
  STATUS_CATEGORIES,
} from './constants';
import { isValidISODate } from './dates';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const idSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
/** For ids that arrive as strings (route params, query strings). */
export const idParamSchema = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const isoDateSchema = z.string().refine(isValidISODate, 'Expected a date in YYYY-MM-DD format');
export const colorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Expected a color like #3b82f6')
  .transform((v) => v.toLowerCase());
export const prioritySchema = z.literal([0, 1, 2, 3, 4]);
export const statusCategorySchema = z.enum(STATUS_CATEGORIES);
export const weekStartSchema = z.literal([0, 1]);

const nameSchema = z.string().trim().min(1, 'Required').max(LIMITS.nameMax);
const descriptionSchema = z.string().max(LIMITS.descriptionMax);
const estimateSchema = z.number().min(0).max(100_000);

export const projectKeySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(
    new RegExp(`^[A-Z][A-Z0-9]{${LIMITS.projectKeyMin - 1},${LIMITS.projectKeyMax - 1}}$`),
    `Key must be ${LIMITS.projectKeyMin}-${LIMITS.projectKeyMax} letters/digits and start with a letter`,
  );

// ---------------------------------------------------------------------------
// Auth & account
// ---------------------------------------------------------------------------

export const usernameSchema = z
  .string()
  .trim()
  .min(LIMITS.usernameMin)
  .max(LIMITS.usernameMax)
  .regex(/^[a-zA-Z0-9_.-]+$/, 'Use letters, numbers, dots, dashes or underscores');
export const passwordSchema = z.string().min(LIMITS.passwordMin, `At least ${LIMITS.passwordMin} characters`).max(LIMITS.passwordMax);
export const displayNameSchema = z.string().trim().min(1, 'Required').max(LIMITS.displayNameMax);

export const setupInput = z.object({
  username: usernameSchema,
  password: passwordSchema,
  displayName: displayNameSchema,
  createSampleData: z.boolean().optional(),
  /** First-run setup code printed in the server log (required unless the server disables it). */
  setupCode: z.string().max(200).optional(),
  /** The client's local date; sample data is dated relative to it (default: server UTC date). */
  today: isoDateSchema.optional(),
});
export type SetupInput = z.infer<typeof setupInput>;

export const loginInput = z.object({
  username: z.string().trim().min(1, 'Required').max(LIMITS.usernameMax),
  password: z.string().min(1, 'Required').max(LIMITS.passwordMax),
});
export type LoginInput = z.infer<typeof loginInput>;

export const updateMeInput = z.object({ displayName: displayNameSchema });
export type UpdateMeInput = z.infer<typeof updateMeInput>;

export const changePasswordInput = z.object({
  currentPassword: z.string().min(1, 'Required').max(LIMITS.passwordMax),
  newPassword: passwordSchema,
});
export type ChangePasswordInput = z.infer<typeof changePasswordInput>;

// ---------------------------------------------------------------------------
// Generic
// ---------------------------------------------------------------------------

/** Full ordered list of ids in a scope (e.g. all milestones of one project). */
export const reorderInput = z.object({ ids: z.array(idSchema).min(1).max(10_000) });
export type ReorderInput = z.infer<typeof reorderInput>;

// ---------------------------------------------------------------------------
// Projects / milestones / epics
// ---------------------------------------------------------------------------

export const projectCreateInput = z.object({
  name: nameSchema,
  key: projectKeySchema.optional(),
  description: descriptionSchema.optional(),
  color: colorSchema.optional(),
  status: z.enum(PROJECT_STATUSES).optional(),
});
export type ProjectCreateInput = z.input<typeof projectCreateInput>;

export const projectUpdateInput = z.object({
  name: nameSchema.optional(),
  key: projectKeySchema.optional(),
  description: descriptionSchema.optional(),
  color: colorSchema.optional(),
  status: z.enum(PROJECT_STATUSES).optional(),
});
export type ProjectUpdateInput = z.input<typeof projectUpdateInput>;

export const milestoneCreateInput = z.object({
  projectId: idSchema,
  name: nameSchema,
  description: descriptionSchema.optional(),
  status: z.enum(MILESTONE_STATUSES).optional(),
  startDate: isoDateSchema.nullable().optional(),
  dueDate: isoDateSchema.nullable().optional(),
});
export type MilestoneCreateInput = z.input<typeof milestoneCreateInput>;

export const milestoneUpdateInput = z.object({
  name: nameSchema.optional(),
  description: descriptionSchema.optional(),
  status: z.enum(MILESTONE_STATUSES).optional(),
  startDate: isoDateSchema.nullable().optional(),
  dueDate: isoDateSchema.nullable().optional(),
});
export type MilestoneUpdateInput = z.input<typeof milestoneUpdateInput>;

export const epicCreateInput = z.object({
  projectId: idSchema,
  milestoneId: idSchema.nullable().optional(),
  name: nameSchema,
  description: descriptionSchema.optional(),
  color: colorSchema.optional(),
  status: z.enum(EPIC_STATUSES).optional(),
  startDate: isoDateSchema.nullable().optional(),
  dueDate: isoDateSchema.nullable().optional(),
});
export type EpicCreateInput = z.input<typeof epicCreateInput>;

export const epicUpdateInput = z.object({
  milestoneId: idSchema.nullable().optional(),
  name: nameSchema.optional(),
  description: descriptionSchema.optional(),
  color: colorSchema.optional(),
  status: z.enum(EPIC_STATUSES).optional(),
  startDate: isoDateSchema.nullable().optional(),
  dueDate: isoDateSchema.nullable().optional(),
});
export type EpicUpdateInput = z.input<typeof epicUpdateInput>;

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

/**
 * Manual ordering, always in ASCENDING-RANK terms: `afterId` = the neighbour with the
 * lower rank, `beforeId` = the neighbour with the higher rank. (In a view sorted
 * manual/desc, pass the card visually BELOW as afterId and the one ABOVE as beforeId.)
 * The server places the task directly after `afterId` in the GLOBAL rank order (or
 * directly before `beforeId` when only that is given); both null/omitted = no-op.
 * 'top' / 'bottom' place it globally first / last. See SPEC §5.5.
 */
const neighbourPositionShape = {
  afterId: idSchema.nullable().optional(),
  beforeId: idSchema.nullable().optional(),
};
export const rankPositionSchema = z.union([z.literal('top'), z.literal('bottom'), z.object(neighbourPositionShape)]);
export type RankPosition = z.infer<typeof rankPositionSchema>;

/**
 * Task updates also take `{ rank }`: put the task back at a rank it had before (the Undo of a
 * move). The server keeps that exact rank when no other task holds it, else places the task
 * directly after the one that does. See SPEC §5.5.
 */
export const rankRestoreSchema = z.object({
  rank: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[0-9A-Za-z]+$/, 'Not a rank'),
});
// Strict neighbours here, so a malformed `rank` is a 400 rather than a silent no-op `{}`.
export const taskPositionSchema = z.union([
  z.literal('top'),
  z.literal('bottom'),
  rankRestoreSchema,
  z.strictObject(neighbourPositionShape),
]);
export type TaskPosition = z.infer<typeof taskPositionSchema>;

const tagIdsSchema = z.array(idSchema).max(100);

export const taskCreateInput = z.object({
  projectId: idSchema,
  epicId: idSchema.nullable().optional(),
  statusId: idSchema.optional(),
  title: z.string().trim().min(1, 'Required').max(LIMITS.titleMax),
  description: descriptionSchema.optional(),
  priority: prioritySchema.optional(),
  startDate: isoDateSchema.nullable().optional(),
  dueDate: isoDateSchema.nullable().optional(),
  estimate: estimateSchema.nullable().optional(),
  tagIds: tagIdsSchema.optional(),
  position: rankPositionSchema.optional(),
});
export type TaskCreateInput = z.input<typeof taskCreateInput>;

export const taskUpdateInput = z.object({
  projectId: idSchema.optional(),
  epicId: idSchema.nullable().optional(),
  statusId: idSchema.optional(),
  title: z.string().trim().min(1, 'Required').max(LIMITS.titleMax).optional(),
  description: descriptionSchema.optional(),
  priority: prioritySchema.optional(),
  startDate: isoDateSchema.nullable().optional(),
  dueDate: isoDateSchema.nullable().optional(),
  estimate: estimateSchema.nullable().optional(),
  /** Replaces the full tag set. Mutually exclusive with addTagIds/removeTagIds. */
  tagIds: tagIdsSchema.optional(),
  addTagIds: tagIdsSchema.optional(),
  removeTagIds: tagIdsSchema.optional(),
  archived: z.boolean().optional(),
  position: taskPositionSchema.optional(),
});
export type TaskUpdateInput = z.input<typeof taskUpdateInput>;

export const taskBulkPatchSchema = z.object({
  statusId: idSchema.optional(),
  priority: prioritySchema.optional(),
  epicId: idSchema.nullable().optional(),
  dueDate: isoDateSchema.nullable().optional(),
  addTagIds: tagIdsSchema.optional(),
  removeTagIds: tagIdsSchema.optional(),
  archived: z.boolean().optional(),
});
export const taskBulkUpdateInput = z.object({
  ids: z.array(idSchema).min(1).max(LIMITS.bulkMax),
  patch: taskBulkPatchSchema,
});
export type TaskBulkUpdateInput = z.input<typeof taskBulkUpdateInput>;

export const taskBulkDeleteInput = z.object({ ids: z.array(idSchema).min(1).max(LIMITS.bulkMax) });
export type TaskBulkDeleteInput = z.input<typeof taskBulkDeleteInput>;

// ---------------------------------------------------------------------------
// Task filter & sort (used by /api/tasks/query and stored inside board configs)
// ---------------------------------------------------------------------------

/**
 * All present criteria are ANDed. Within an array criterion values are ORed.
 * An omitted or EMPTY array means "no constraint". `null` inside milestoneIds /
 * epicIds / tagIds means "has none". See SPEC.md §Filter semantics and
 * matchesTaskFilter() in ./filter.ts (the reference implementation).
 */
export const taskFilterSchema = z.object({
  /** Only these tasks (e.g. the palette refreshing its Recent list). */
  ids: z.array(idSchema).max(1000).optional(),
  projectIds: z.array(idSchema).max(1000).optional(),
  milestoneIds: z.array(idSchema.nullable()).max(1000).optional(),
  epicIds: z.array(idSchema.nullable()).max(1000).optional(),
  statusIds: z.array(idSchema).max(200).optional(),
  statusCategories: z.array(statusCategorySchema).optional(),
  priorities: z.array(prioritySchema).optional(),
  tagIds: z.array(idSchema.nullable()).max(500).optional(),
  tagMode: z.enum(['any', 'all']).optional(),
  excludeTagIds: z.array(idSchema).max(500).optional(),
  due: z.array(z.enum(DUE_PRESETS)).optional(),
  dueFrom: isoDateSchema.optional(),
  dueTo: isoDateSchema.optional(),
  search: z.string().max(LIMITS.searchMax).optional(),
  archived: z.enum(['exclude', 'include', 'only']).optional(),
  /** When set, closed tasks are only included if completedAt is within the last N days (0 = hide all closed). */
  closedWithinDays: z.number().int().min(0).max(3650).nullable().optional(),
  /** Tasks of projects whose status is 'archived' are excluded unless this is true or projectIds lists them. */
  includeArchivedProjects: z.boolean().optional(),
});
export type TaskFilter = z.infer<typeof taskFilterSchema>;

export const TASK_SORT_FIELDS = [
  'manual', 'priority', 'dueDate', 'startDate', 'createdAt', 'updatedAt', 'title', 'number', 'estimate', 'status',
] as const;
export type TaskSortField = (typeof TASK_SORT_FIELDS)[number];

export const taskSortSchema = z.object({
  field: z.enum(TASK_SORT_FIELDS),
  dir: z.enum(['asc', 'desc']),
});
export type TaskSort = z.infer<typeof taskSortSchema>;

export const taskQueryInput = z.object({
  filter: taskFilterSchema.optional(),
  sort: taskSortSchema.optional(),
  limit: z.number().int().min(1).max(LIMITS.queryLimitMax).optional(),
  offset: z.number().int().min(0).optional(),
  /** Client's local date, used to resolve due presets. Defaults to the server's UTC date. */
  today: isoDateSchema.optional(),
  /** Defaults to the stored settings.weekStartsOn. */
  weekStartsOn: weekStartSchema.optional(),
});
export type TaskQueryInput = z.input<typeof taskQueryInput>;

// ---------------------------------------------------------------------------
// Comments, work logs, activity
// ---------------------------------------------------------------------------

export const commentCreateInput = z.object({
  body: z.string().trim().min(1, 'Required').max(LIMITS.commentMax),
});
export type CommentCreateInput = z.input<typeof commentCreateInput>;
export const commentUpdateInput = commentCreateInput;
export type CommentUpdateInput = CommentCreateInput;

export const worklogCreateInput = z
  .object({
    date: isoDateSchema,
    minutes: z.number().int().min(0).max(LIMITS.worklogMinutesMax).nullable().optional(),
    note: z.string().trim().max(LIMITS.worklogNoteMax).optional(),
  })
  .refine((v) => (v.minutes ?? 0) > 0 || (v.note ?? '').length > 0, {
    message: 'Enter time spent or a note',
    path: ['note'],
  });
export type WorklogCreateInput = z.input<typeof worklogCreateInput>;

export const worklogUpdateInput = z.object({
  date: isoDateSchema.optional(),
  minutes: z.number().int().min(0).max(LIMITS.worklogMinutesMax).nullable().optional(),
  note: z.string().trim().max(LIMITS.worklogNoteMax).optional(),
});
export type WorklogUpdateInput = z.input<typeof worklogUpdateInput>;

export const activityQueryInput = z.object({
  projectId: idParamSchema.optional(),
  taskId: idParamSchema.optional(),
  /** Cursor: return entries with id < before. */
  before: idParamSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export type ActivityQueryInput = z.infer<typeof activityQueryInput>;

/** GET /api/worklogs — work-log report across tasks. Dates inclusive. */
export const worklogReportQuery = z.object({
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  projectId: idParamSchema.optional(),
  /** Client's local date; when from/to are omitted the range is [today-29, today]. */
  today: isoDateSchema.optional(),
});
export type WorklogReportQuery = z.infer<typeof worklogReportQuery>;

// ---------------------------------------------------------------------------
// Tags & statuses
// ---------------------------------------------------------------------------

export const tagCreateInput = z.object({
  name: z.string().trim().min(1, 'Required').max(LIMITS.tagNameMax),
  color: colorSchema.optional(),
});
export type TagCreateInput = z.input<typeof tagCreateInput>;

export const tagUpdateInput = z.object({
  name: z.string().trim().min(1, 'Required').max(LIMITS.tagNameMax).optional(),
  color: colorSchema.optional(),
});
export type TagUpdateInput = z.input<typeof tagUpdateInput>;

/** POST /api/tags/:id/merge — move every task tagged :id to targetId, then delete :id. */
export const tagMergeInput = z.object({ targetId: idSchema });
export type TagMergeInput = z.input<typeof tagMergeInput>;

export const statusCreateInput = z.object({
  name: z.string().trim().min(1, 'Required').max(LIMITS.statusNameMax),
  category: statusCategorySchema,
  color: colorSchema.optional(),
});
export type StatusCreateInput = z.input<typeof statusCreateInput>;

export const statusUpdateInput = z.object({
  name: z.string().trim().min(1, 'Required').max(LIMITS.statusNameMax).optional(),
  category: statusCategorySchema.optional(),
  color: colorSchema.optional(),
});
export type StatusUpdateInput = z.input<typeof statusUpdateInput>;

/** DELETE /api/statuses/:id?reassignTo=<id> — required when tasks use the status. */
export const statusDeleteQuery = z.object({ reassignTo: idParamSchema.optional() });

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const settingsSchema = z.object({
  weekStartsOn: weekStartSchema,
  estimateUnit: z.enum(ESTIMATE_UNITS),
  defaultBoardId: idSchema.nullable(),
  homePage: z.enum(['dashboard', 'default_board']),
});
export type Settings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  weekStartsOn: 1,
  estimateUnit: 'points',
  defaultBoardId: null,
  homePage: 'dashboard',
};

export const settingsUpdateInput = z.object({
  weekStartsOn: weekStartSchema.optional(),
  estimateUnit: z.enum(ESTIMATE_UNITS).optional(),
  defaultBoardId: idSchema.nullable().optional(),
  homePage: z.enum(['dashboard', 'default_board']).optional(),
});
export type SettingsUpdateInput = z.input<typeof settingsUpdateInput>;

// ---------------------------------------------------------------------------
// Search & dashboard
// ---------------------------------------------------------------------------

export const searchQueryInput = z.object({
  q: z.string().trim().min(1).max(LIMITS.searchMax),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});
export type SearchQueryInput = z.infer<typeof searchQueryInput>;

export const dashboardQueryInput = z.object({
  today: isoDateSchema.optional(),
});
