// Pure logic behind TaskList: the effective filter (search / "Show closed" / "Show archived"),
// what an empty list hides, grouping (natural orders as in SPEC §8.1), the fields a group
// implies for quick-add, and range selection. No React — unit-tested in taskListModel.test.ts.

import {
  DUE_BUCKET_LABELS,
  DUE_BUCKETS,
  isClosedCategory,
  LIMITS,
  PRIORITY_META,
  STATUS_CATEGORIES,
  STATUS_CATEGORY_META,
  type Priority,
  type StatusCategory,
} from '@shared/constants';
import { dueBucket, dueBucketDropDate, type ISODate, type WeekStart } from '@shared/dates';
import type { TaskCreateInput, TaskFilter, TaskSort, TaskSortField } from '@shared/schemas';
import type { EpicDTO, MilestoneDTO, ProjectDTO, StatusDTO, TaskDTO } from '@shared/types';

export type TaskListGroupBy = 'none' | 'status' | 'statusCategory' | 'priority' | 'project' | 'milestone' | 'epic' | 'due';

export const NO_GROUP_KEY = 'none';

export const GROUP_BY_LABELS: Record<TaskListGroupBy, string> = {
  none: 'No grouping',
  status: 'Status',
  statusCategory: 'Status category',
  priority: 'Priority',
  project: 'Project',
  milestone: 'Milestone',
  epic: 'Epic',
  due: 'Due date',
};

export const GROUP_BY_OPTIONS: readonly TaskListGroupBy[] = [
  'none', 'status', 'statusCategory', 'priority', 'project', 'milestone', 'epic', 'due',
];

export const SORT_FIELD_LABELS: Record<TaskSortField, string> = {
  manual: 'Manual',
  priority: 'Priority',
  dueDate: 'Due date',
  startDate: 'Start date',
  createdAt: 'Created',
  updatedAt: 'Updated',
  title: 'Title',
  number: 'Number',
  estimate: 'Estimate',
  status: 'Status',
};

export const DEFAULT_TASK_LIST_SORT: TaskSort = { field: 'manual', dir: 'asc' };

/** The bootstrap lookups subset the list logic needs (structurally compatible with Lookups). */
export interface TaskListLookups {
  /** By position. */
  statuses: readonly StatusDTO[];
  statusById: ReadonlyMap<number, StatusDTO>;
  /** By position. */
  projects: readonly ProjectDTO[];
  projectById: ReadonlyMap<number, ProjectDTO>;
  /** By project position, then position. */
  milestones: readonly MilestoneDTO[];
  milestoneById: ReadonlyMap<number, MilestoneDTO>;
  /** By project position, then position. */
  epics: readonly EpicDTO[];
  epicById: ReadonlyMap<number, EpicDTO>;
}

export interface GroupContext {
  lookups: TaskListLookups;
  today: ISODate;
  weekStartsOn: WeekStart;
}

// ---------------------------------------------------------------------------
// Filter
// ---------------------------------------------------------------------------

/** "Show closed" starts on only when the filter asks for closed tasks exclusively. */
export function initialShowClosed(filter: TaskFilter): boolean {
  const cats = filter.statusCategories ?? [];
  return cats.length > 0 && cats.every((c) => isClosedCategory(c));
}

/** "Show archived" starts on only when the filter itself asks for archived tasks. */
export function initialShowArchived(filter: TaskFilter): boolean {
  return filter.archived === 'include' || filter.archived === 'only';
}

/** The list's view toggles on top of its filter. */
export interface TaskListView {
  /** The toolbar is shown: its search and "Show closed" apply. */
  enabled: boolean;
  search: string;
  showClosed: boolean;
  /**
   * "Show archived" (off = archived tasks hidden, on = listed too; an 'only' filter stays
   * 'only'). Applies with or without a toolbar: toolbar-less lists turn it on from their
   * empty state. Omitted: the filter's own `archived` mode.
   */
  showArchived?: boolean;
}

function withArchived(out: TaskFilter, filter: TaskFilter, show: boolean): TaskFilter {
  // The default ('exclude') is left out, so the query (and its cache key) stays as before.
  if (show) out.archived = filter.archived === 'only' ? 'only' : 'include';
  else delete out.archived;
  return out;
}

/**
 * The filter actually queried: the caller's filter, plus the toolbar's search (ANDed with
 * any search of the filter), "Show closed" (off = closedWithinDays 0, on = no limit) and
 * "Show archived" (filter.archived 'include'). Without a toolbar the caller's filter is used
 * unchanged, except for "Show archived" when it differs from the filter's own mode.
 */
export function effectiveTaskFilter(filter: TaskFilter, view: TaskListView): TaskFilter {
  const showArchived = view.showArchived ?? initialShowArchived(filter);
  const archivedChanged = view.showArchived !== undefined && showArchived !== initialShowArchived(filter);
  if (!view.enabled) return archivedChanged ? withArchived({ ...filter }, filter, showArchived) : filter;
  const out: TaskFilter = { ...filter };
  const search = [filter.search?.trim(), view.search.trim()].filter(Boolean).join(' ');
  if (search) out.search = search;
  else delete out.search;
  if (view.showClosed) delete out.closedWithinDays;
  else out.closedWithinDays = 0;
  return archivedChanged ? withArchived(out, filter, showArchived) : out;
}

// ---------------------------------------------------------------------------
// Hidden tasks (empty states)
// ---------------------------------------------------------------------------

/** Which of the list's toggles currently hide tasks. */
function hidingToggles(filter: TaskFilter, view: TaskListView): { closed: boolean; archived: boolean } {
  return {
    closed: view.enabled && !view.showClosed,
    archived: !(view.showArchived ?? initialShowArchived(filter)),
  };
}

/**
 * Count queries for an empty list, to tell "nothing here" from "everything here is hidden":
 * `all` is the list's filter (search included) with every toggle on; `archived` its archived
 * share, needed only when both "Show closed" and "Show archived" are off. Null when no toggle
 * hides anything.
 */
export function hiddenTaskProbes(filter: TaskFilter, view: TaskListView): { all: TaskFilter; archived: TaskFilter | null } | null {
  const hiding = hidingToggles(filter, view);
  if (!hiding.closed && !hiding.archived) return null;
  const all = effectiveTaskFilter(filter, { ...view, showClosed: true, showArchived: true });
  return { all, archived: hiding.closed && hiding.archived ? { ...all, archived: 'only' } : null };
}

/** Tasks an empty list hides: `closed` (not archived) behind "Show closed", `archived` behind "Show archived". */
export interface HiddenTasks {
  closed: number;
  archived: number;
}

/** Split the probe totals (see hiddenTaskProbes) by the toggle that hides them. */
export function hiddenTaskCounts(
  filter: TaskFilter,
  view: TaskListView,
  totals: { all: number; archived: number | null },
): HiddenTasks {
  const hiding = hidingToggles(filter, view);
  if (hiding.closed && hiding.archived) {
    const archived = Math.min(totals.archived ?? 0, totals.all);
    return { closed: totals.all - archived, archived };
  }
  if (hiding.archived) return { closed: 0, archived: totals.all };
  if (hiding.closed) return { closed: totals.all, archived: 0 };
  return { closed: 0, archived: 0 };
}

/** Title and explanation of an empty list whose tasks are all hidden (null when none are). */
export function hiddenTasksMessage(hidden: HiddenTasks, search: string): { title: string; body: string } | null {
  const { closed, archived } = hidden;
  if (closed === 0 && archived === 0) return null;
  const n = closed + archived;
  const what =
    closed > 0 && archived > 0
      ? `${closed} closed and ${archived} archived tasks`
      : closed > 0
        ? `${closed} closed ${closed === 1 ? 'task' : 'tasks'}`
        : `${archived} archived ${archived === 1 ? 'task' : 'tasks'}`;
  if (search) return { title: `No tasks match “${search}”`, body: `${what} ${n === 1 ? 'matches but is' : 'match but are'} hidden.` };
  const title =
    closed > 0 && archived > 0
      ? 'All tasks here are closed or archived'
      : closed > 0
        ? 'All tasks here are closed'
        : 'All tasks here are archived';
  return { title, body: `${what} ${n === 1 ? 'is' : 'are'} hidden.` };
}

/** Selected tasks split for the bulk Archive / Unarchive actions (each acts only on tasks it changes). */
export function archiveTargets(tasks: readonly Pick<TaskDTO, 'id' | 'archivedAt'>[]): { archive: number[]; unarchive: number[] } {
  const archive: number[] = [];
  const unarchive: number[] = [];
  for (const t of tasks) (t.archivedAt === null ? archive : unarchive).push(t.id);
  return { archive, unarchive };
}

/**
 * The filter sent to POST /tasks/query. The API caps `search` at LIMITS.searchMax; a longer one
 * (the filter's search plus the toolbar's) keeps the distinct whole tokens that fit. That query
 * is broader, and TaskList re-applies the full filter to the result, so the list still shows
 * exactly the tasks matching every token.
 */
export function serverTaskFilter(filter: TaskFilter): TaskFilter {
  const search = filter.search;
  if (search === undefined || search.length <= LIMITS.searchMax) return filter;
  const seen = new Set<string>();
  let fitted = '';
  for (const token of search.trim().split(/\s+/)) {
    const key = token.toLowerCase();
    if (!token || seen.has(key)) continue;
    seen.add(key);
    const next = fitted ? `${fitted} ${token}` : token;
    if (next.length <= LIMITS.searchMax) fitted = next;
  }
  // Only reachable with a single token over the limit: its prefix still matches a superset.
  if (!fitted) fitted = search.trim().slice(0, LIMITS.searchMax);
  return { ...filter, search: fitted };
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

export interface TaskGroup {
  /** Group key as in shared/board.ts (status id, category, priority, id or 'none', due bucket). */
  key: string;
  tasks: TaskDTO[];
}

/** The group key of a task (every field here has exactly one key per task). */
export function taskGroupKey(task: TaskDTO, groupBy: Exclude<TaskListGroupBy, 'none'>, ctx: GroupContext): string {
  switch (groupBy) {
    case 'status':
      return String(task.statusId);
    case 'statusCategory':
      return ctx.lookups.statusById.get(task.statusId)?.category ?? NO_GROUP_KEY;
    case 'priority':
      return String(task.priority);
    case 'project':
      return String(task.projectId);
    case 'milestone':
      return task.milestoneId === null ? NO_GROUP_KEY : String(task.milestoneId);
    case 'epic':
      return task.epicId === null ? NO_GROUP_KEY : String(task.epicId);
    case 'due': {
      const category = ctx.lookups.statusById.get(task.statusId)?.category;
      return dueBucket(task.dueDate, ctx.today, ctx.weekStartsOn, category ? isClosedCategory(category) : false);
    }
  }
}

/** Natural order of the keys of a field (SPEC §8.1), without 'none'. */
export function naturalGroupOrder(groupBy: Exclude<TaskListGroupBy, 'none'>, lookups: TaskListLookups): string[] {
  switch (groupBy) {
    case 'status':
      return lookups.statuses.map((s) => String(s.id));
    case 'statusCategory':
      return [...STATUS_CATEGORIES];
    case 'priority':
      return ['4', '3', '2', '1', '0'];
    case 'project':
      return lookups.projects.map((p) => String(p.id));
    case 'milestone':
      return lookups.milestones.map((m) => String(m.id));
    case 'epic':
      return lookups.epics.map((e) => String(e.id));
    case 'due':
      return [...DUE_BUCKETS];
  }
}

/**
 * Split tasks (already sorted) into groups in the field's natural order. Only groups with
 * tasks are returned; keys unknown to the lookups (stale data) follow the known ones and
 * 'none' ("No epic", …) comes last. Task order inside a group is preserved.
 */
export function groupTasks(tasks: readonly TaskDTO[], groupBy: TaskListGroupBy, ctx: GroupContext): TaskGroup[] {
  if (groupBy === 'none') return tasks.length > 0 ? [{ key: NO_GROUP_KEY, tasks: [...tasks] }] : [];
  const byKey = new Map<string, TaskDTO[]>();
  for (const task of tasks) {
    const key = taskGroupKey(task, groupBy, ctx);
    const list = byKey.get(key);
    if (list) list.push(task);
    else byKey.set(key, [task]);
  }
  const groups: TaskGroup[] = [];
  for (const key of naturalGroupOrder(groupBy, ctx.lookups)) {
    const list = byKey.get(key);
    if (list && key !== NO_GROUP_KEY) {
      groups.push({ key, tasks: list });
      byKey.delete(key);
    }
  }
  const none = byKey.get(NO_GROUP_KEY);
  byKey.delete(NO_GROUP_KEY);
  for (const [key, list] of byKey) groups.push({ key, tasks: list });
  if (none) groups.push({ key: NO_GROUP_KEY, tasks: none });
  return groups;
}

/** Heading text of a group. */
export function groupLabel(groupBy: TaskListGroupBy, key: string, lookups: TaskListLookups): string {
  const id = Number(key);
  switch (groupBy) {
    case 'none':
      return 'Tasks';
    case 'status':
      return lookups.statusById.get(id)?.name ?? 'Unknown status';
    case 'statusCategory':
      return key in STATUS_CATEGORY_META ? STATUS_CATEGORY_META[key as StatusCategory].label : 'Unknown';
    case 'priority':
      return key in PRIORITY_META ? PRIORITY_META[id as Priority].label : 'Unknown priority';
    case 'project':
      return lookups.projectById.get(id)?.name ?? 'Unknown project';
    case 'milestone':
      return key === NO_GROUP_KEY ? 'No milestone' : (lookups.milestoneById.get(id)?.name ?? 'Unknown milestone');
    case 'epic':
      return key === NO_GROUP_KEY ? 'No epic' : (lookups.epicById.get(id)?.name ?? 'Unknown epic');
    case 'due':
      return key in DUE_BUCKET_LABELS ? DUE_BUCKET_LABELS[key as keyof typeof DUE_BUCKET_LABELS] : key;
  }
}

/** Grouping choices that make sense for a filter (no "Project" on a one-project list, …). */
export function groupByChoices(filter: TaskFilter): TaskListGroupBy[] {
  const oneProject = (filter.projectIds?.length ?? 0) === 1;
  const oneEpic = (filter.epicIds?.length ?? 0) === 1 && filter.epicIds?.[0] !== null;
  return GROUP_BY_OPTIONS.filter((g) => {
    if (g === 'project') return !oneProject;
    if (g === 'epic' || g === 'milestone') return !oneEpic;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Quick add
// ---------------------------------------------------------------------------

/**
 * Fields a task created inside a group gets so that it lands in that group, or null when
 * the group cannot be targeted (a milestone comes from an epic; past / overdue / later due
 * buckets have no single date).
 */
export function groupCreatePatch(groupBy: TaskListGroupBy, key: string, ctx: GroupContext): Partial<TaskCreateInput> | null {
  const id = Number(key);
  switch (groupBy) {
    case 'none':
      return {};
    case 'status':
      return ctx.lookups.statusById.has(id) ? { statusId: id } : null;
    case 'statusCategory': {
      const first = ctx.lookups.statuses.find((s) => s.category === key);
      return first ? { statusId: first.id } : null;
    }
    case 'priority':
      return key in PRIORITY_META ? { priority: id as Priority } : null;
    case 'project':
      return ctx.lookups.projectById.has(id) ? { projectId: id } : null;
    case 'milestone':
      return key === NO_GROUP_KEY ? { epicId: null } : null;
    case 'epic': {
      if (key === NO_GROUP_KEY) return { epicId: null };
      const epic = ctx.lookups.epicById.get(id);
      return epic ? { epicId: epic.id, projectId: epic.projectId } : null;
    }
    case 'due': {
      const date = dueBucketDropDate(key as (typeof DUE_BUCKETS)[number], ctx.today, ctx.weekStartsOn);
      return date === undefined ? null : { dueDate: date };
    }
  }
}

/**
 * Create defaults for an "Add task" row: the list's createDefaults overlaid with the group's
 * fields; the project falls back to the epic's project or the filter's single project. An
 * epic that does not belong to the resulting project is dropped.
 */
export function quickAddDefaults(
  createDefaults: Partial<TaskCreateInput>,
  groupPatch: Partial<TaskCreateInput>,
  filter: TaskFilter,
  lookups: Pick<TaskListLookups, 'epicById' | 'projectById'>,
): Partial<TaskCreateInput> {
  const merged: Partial<TaskCreateInput> = { ...createDefaults, ...groupPatch };
  const epic = merged.epicId !== undefined && merged.epicId !== null ? lookups.epicById.get(merged.epicId) : undefined;
  if (merged.projectId === undefined) {
    merged.projectId = epic?.projectId ?? (filter.projectIds?.length === 1 ? filter.projectIds[0] : undefined);
  }
  if (merged.projectId !== undefined && !lookups.projectById.has(merged.projectId)) delete merged.projectId;
  if (merged.epicId !== undefined && merged.epicId !== null && (!epic || epic.projectId !== merged.projectId)) delete merged.epicId;
  return merged;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * Selection after toggling `target` to `value`. With `range` (shift-click) and an anchor that
 * is still visible, every task between anchor and target (in `order`) gets `value`.
 */
export function applySelection(
  selected: ReadonlySet<number>,
  order: readonly number[],
  anchor: number | null,
  target: number,
  value: boolean,
  range: boolean,
): Set<number> {
  const next = new Set(selected);
  let ids = [target];
  if (range && anchor !== null) {
    const a = order.indexOf(anchor);
    const b = order.indexOf(target);
    if (a >= 0 && b >= 0) ids = order.slice(Math.min(a, b), Math.max(a, b) + 1);
  }
  for (const id of ids) {
    if (value) next.add(id);
    else next.delete(id);
  }
  return next;
}

/** Drop selected ids that are no longer listed. Returns the same set when nothing changed. */
export function pruneSelection(selected: ReadonlySet<number>, visible: ReadonlySet<number>): ReadonlySet<number> {
  for (const id of selected) {
    if (!visible.has(id)) return new Set([...selected].filter((x) => visible.has(x)));
  }
  return selected;
}

/** The single project all given tasks belong to, or null when they span several (or none). */
export function commonProjectId(tasks: readonly Pick<TaskDTO, 'projectId'>[]): number | null {
  const first = tasks[0]?.projectId;
  if (first === undefined) return null;
  return tasks.every((t) => t.projectId === first) ? first : null;
}
