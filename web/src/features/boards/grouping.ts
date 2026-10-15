// Pure board logic (SPEC §8): derive the visible task list, enumerate column / swimlane groups,
// place tasks into lane × column cells, WIP state, drop patches for drag & drop and the "Move
// to …" menus, manual-order positions and quick-add defaults. No React, no DOM — unit-tested
// in grouping.test.ts.

import {
  customGroupKey,
  NONE_GROUP_KEY,
  OTHER_GROUP_KEY,
  resolveDropPatch,
  type BoardConfig,
  type ColumnGroupField,
  type CustomColumn,
  type GroupPrefs,
  type SwimlaneGroupField,
} from '@shared/board';
import {
  DUE_BUCKET_LABELS,
  DUE_BUCKETS,
  isClosedCategory,
  PRIORITY_META,
  PRIORITY_VALUES,
  STATUS_CATEGORIES,
  STATUS_CATEGORY_META,
  type DueBucket,
  type Priority,
  type StatusCategory,
} from '@shared/constants';
import { dueBucket, dueBucketDropDate } from '@shared/dates';
import { compareTasks, matchesTaskFilter, type FilterContext, type SortContext } from '@shared/filter';
import type { RankPosition, TaskCreateInput, TaskFilter, TaskSort, TaskUpdateInput } from '@shared/schemas';
import type { EpicDTO, MilestoneDTO, ProjectDTO, StatusDTO, TagDTO, TaskDTO } from '@shared/types';

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/** The bootstrap lists the board needs (a subset of `Lookups`, ordered as there). */
export interface BoardLookups {
  /** By position. */
  statuses: readonly StatusDTO[];
  /** By position (archived included). */
  projects: readonly ProjectDTO[];
  /** By project position, then own position. */
  milestones: readonly MilestoneDTO[];
  /** By project position, then own position. */
  epics: readonly EpicDTO[];
  /** By name. */
  tags: readonly TagDTO[];
  statusById: ReadonlyMap<number, StatusDTO>;
  projectById: ReadonlyMap<number, ProjectDTO>;
  milestoneById: ReadonlyMap<number, MilestoneDTO>;
  epicById: ReadonlyMap<number, EpicDTO>;
  tagById: ReadonlyMap<number, TagDTO>;
}

export interface BoardContext {
  lookups: BoardLookups;
  /** Filter context (today, weekStartsOn, status categories, project statuses). */
  fctx: FilterContext;
}

/** A group field of either axis (swimlanes may also be 'none'). */
export type GroupField = ColumnGroupField | SwimlaneGroupField;

/** The parts of a columns / swimlanes config the grouping uses. */
export interface AxisConfig {
  groupBy: GroupField;
  prefs: Partial<Record<string, GroupPrefs>>;
  showEmpty: boolean;
  showNone: boolean;
  custom: readonly CustomColumn[];
  showUnmatched: boolean;
}

/** Lane key used when the board has no swimlanes. */
export const NO_LANE = '__all';

export interface CellRef {
  lane: string;
  col: string;
}

export const cellKey = (lane: string, col: string): string => `${lane}|${col}`;

/** dnd-kit id of a card: `${laneKey}|${colKey}|${taskId}` (SPEC §8.2). Keys never contain '|'. */
export const cardDndId = (lane: string, col: string, taskId: number): string => `${lane}|${col}|${taskId}`;

export function parseCardDndId(id: string): (CellRef & { taskId: number }) | null {
  const parts = id.split('|');
  if (parts.length !== 3) return null;
  const taskId = Number(parts[2]);
  if (!Number.isInteger(taskId) || taskId <= 0) return null;
  return { lane: parts[0]!, col: parts[1]!, taskId };
}

// ---------------------------------------------------------------------------
// Data flow: filter + sort the cached query result (SPEC §8 "Data flow")
// ---------------------------------------------------------------------------

/**
 * The board's task list: tasks matching the effective filter (and an optional extra,
 * client-only filter) in `sort` order. Equals the server order when nothing is pending and
 * makes optimistic edits move cards immediately.
 */
export function deriveBoardTasks(
  tasks: readonly TaskDTO[],
  filter: TaskFilter,
  sort: TaskSort,
  fctx: FilterContext,
  sctx: SortContext,
  extra?: TaskFilter | null,
): TaskDTO[] {
  return tasks
    .filter((t) => matchesTaskFilter(t, filter, fctx) && (!extra || matchesTaskFilter(t, extra, fctx)))
    .sort((a, b) => compareTasks(a, b, sort, sctx));
}

// ---------------------------------------------------------------------------
// Group descriptions
// ---------------------------------------------------------------------------

export interface GroupInfo {
  key: string;
  label: string;
  /** Secondary text (e.g. the project key of an epic when several projects are in scope). */
  hint?: string;
  /** Entity color (status, priority, project, epic, tag, custom column), else null. */
  color: string | null;
  /** The custom column / lane definition (custom grouping only). */
  custom?: CustomColumn;
}

export interface BoardGroup extends GroupInfo {
  /** Listed in prefs.hidden. */
  hidden: boolean;
  /** Listed in prefs.collapsed. */
  collapsed: boolean;
  /** Present in the tasks but not enumerated by the scope (stale data); appended so tasks never disappear. */
  stale: boolean;
  /** Distinct tasks in the group (all lanes / columns). */
  count: number;
  /** Rendered (SPEC §8.1 visibility rules). */
  visible: boolean;
}

const NONE_LABELS: Partial<Record<GroupField, string>> = {
  milestone: 'No milestone',
  epic: 'No epic',
  tag: 'No tags',
};

/** Display name of the "none" group of a field ("No epic"…). */
export function noneLabel(field: GroupField): string {
  return NONE_LABELS[field] ?? 'None';
}

function inScopeProjectIds(filter: TaskFilter, lookups: BoardLookups): number[] {
  const listed = filter.projectIds;
  if (listed && listed.length > 0) return lookups.projects.filter((p) => listed.includes(p.id)).map((p) => p.id);
  return lookups.projects.filter((p) => filter.includeArchivedProjects || p.status !== 'archived').map((p) => p.id);
}

/** Label/color for any key of a field (also stale and deleted ones). */
export function describeGroup(
  field: GroupField,
  key: string,
  ctx: BoardContext,
  options: { custom?: readonly CustomColumn[]; multiProject?: boolean } = {},
): GroupInfo {
  const { lookups } = ctx;
  const id = Number(key);
  const projectHint = (projectId: number) =>
    options.multiProject ? lookups.projectById.get(projectId)?.key : undefined;
  if (key === NONE_GROUP_KEY && (field === 'milestone' || field === 'epic' || field === 'tag')) {
    return { key, label: noneLabel(field), color: null };
  }
  switch (field) {
    case 'status': {
      const s = lookups.statusById.get(id);
      return s ? { key, label: s.name, color: s.color } : { key, label: 'Deleted status', color: null };
    }
    case 'statusCategory': {
      const meta = STATUS_CATEGORY_META[key as StatusCategory];
      return { key, label: meta?.label ?? 'Unknown', color: null };
    }
    case 'priority': {
      const meta = PRIORITY_META[id as Priority];
      return meta ? { key, label: meta.label, color: meta.color } : { key, label: `Priority ${key}`, color: null };
    }
    case 'project': {
      const p = lookups.projectById.get(id);
      return p ? { key, label: p.name, hint: p.key, color: p.color } : { key, label: 'Deleted project', color: null };
    }
    case 'milestone': {
      const m = lookups.milestoneById.get(id);
      return m
        ? { key, label: m.name, hint: projectHint(m.projectId), color: null }
        : { key, label: 'Deleted milestone', color: null };
    }
    case 'epic': {
      const e = lookups.epicById.get(id);
      return e
        ? { key, label: e.name, hint: projectHint(e.projectId), color: e.color }
        : { key, label: 'Deleted epic', color: null };
    }
    case 'tag': {
      const t = lookups.tagById.get(id);
      return t ? { key, label: t.name, color: t.color } : { key, label: 'Deleted tag', color: null };
    }
    case 'due':
      return { key, label: DUE_BUCKET_LABELS[key as DueBucket] ?? key, color: null };
    case 'custom': {
      if (key === OTHER_GROUP_KEY) return { key, label: 'Other', color: null };
      const c = options.custom?.find((col) => col.id === key);
      return c ? { key, label: c.name, color: c.color, custom: c } : { key, label: 'Removed group', color: null };
    }
    case 'none':
      return { key, label: 'All tasks', color: null };
  }
}

interface NaturalGroup extends GroupInfo {
  /** Closed milestone / epic: shown only when it has tasks in the result. */
  onlyWithTasks?: boolean;
}

/** Natural order restricted by the filter (SPEC §8.1 table); none / __other last. */
function naturalGroups(field: GroupField, axis: AxisConfig, filter: TaskFilter, ctx: BoardContext): NaturalGroup[] {
  const { lookups } = ctx;
  const describe = (key: string, multiProject = false) => describeGroup(field, key, ctx, { custom: axis.custom, multiProject });
  switch (field) {
    case 'none':
      return [describe(NO_LANE)];
    case 'status': {
      let list = lookups.statuses;
      const ids = filter.statusIds;
      const cats = filter.statusCategories;
      if (ids && ids.length > 0) list = list.filter((s) => ids.includes(s.id));
      if (cats && cats.length > 0) list = list.filter((s) => cats.includes(s.category));
      return list.map((s) => describe(String(s.id)));
    }
    case 'statusCategory': {
      const ids = filter.statusIds;
      const cats = filter.statusCategories;
      return STATUS_CATEGORIES.filter((c) => lookups.statuses.some((s) => s.category === c))
        .filter((c) => !cats || cats.length === 0 || cats.includes(c))
        .filter((c) => !ids || ids.length === 0 || lookups.statuses.some((s) => s.category === c && ids.includes(s.id)))
        .map((c) => describe(c));
    }
    case 'priority': {
      const ps = filter.priorities;
      return [...PRIORITY_VALUES]
        .reverse()
        .filter((p) => !ps || ps.length === 0 || ps.includes(p))
        .map((p) => describe(String(p)));
    }
    case 'project':
      return inScopeProjectIds(filter, lookups).map((id) => describe(String(id)));
    case 'milestone': {
      const scope = new Set(inScopeProjectIds(filter, lookups));
      const multi = scope.size > 1;
      const ids = filter.milestoneIds;
      const out: NaturalGroup[] = lookups.milestones
        .filter((m) => scope.has(m.projectId) && (!ids || ids.length === 0 || ids.includes(m.id)))
        .map((m) => ({
          ...describe(String(m.id), multi),
          onlyWithTasks: m.status === 'completed' || m.status === 'cancelled',
        }));
      if (!ids || ids.length === 0 || ids.includes(null)) out.push(describe(NONE_GROUP_KEY));
      return out;
    }
    case 'epic': {
      const scope = new Set(inScopeProjectIds(filter, lookups));
      const multi = scope.size > 1;
      const ids = filter.epicIds;
      const mids = filter.milestoneIds;
      const out: NaturalGroup[] = lookups.epics
        .filter(
          (e) =>
            scope.has(e.projectId) &&
            (!ids || ids.length === 0 || ids.includes(e.id)) &&
            (!mids || mids.length === 0 || mids.includes(e.milestoneId)),
        )
        .map((e) => ({
          ...describe(String(e.id), multi),
          onlyWithTasks: e.status === 'done' || e.status === 'cancelled',
        }));
      if (!ids || ids.length === 0 || ids.includes(null)) out.push(describe(NONE_GROUP_KEY));
      return out;
    }
    case 'tag': {
      const listed = filter.tagIds;
      const wanted = (listed ?? []).filter((id): id is number => id !== null);
      const exclude = filter.excludeTagIds ?? [];
      let tags = lookups.tags;
      if (listed && listed.length > 0 && (filter.tagMode ?? 'any') === 'any') tags = tags.filter((t) => wanted.includes(t.id));
      if (exclude.length > 0) tags = tags.filter((t) => !exclude.includes(t.id));
      const out: NaturalGroup[] = tags.map((t) => describe(String(t.id)));
      if (!listed || listed.length === 0 || listed.includes(null)) out.push(describe(NONE_GROUP_KEY));
      return out;
    }
    case 'due':
      return DUE_BUCKETS.map((b) => describe(b));
    case 'custom':
      return [...axis.custom.map((c) => describe(c.id)), describe(OTHER_GROUP_KEY)];
  }
}

/**
 * The group key(s) of a task on one axis. A task with several tags has several keys;
 * a task without tags has 'none'. Unknown status categories map to 'none'.
 */
export function taskGroupKeys(field: GroupField, task: TaskDTO, axis: Pick<AxisConfig, 'custom'>, ctx: BoardContext): string[] {
  switch (field) {
    case 'none':
      return [NO_LANE];
    case 'status':
      return [String(task.statusId)];
    case 'statusCategory':
      return [ctx.fctx.statusCategoryById.get(task.statusId) ?? NONE_GROUP_KEY];
    case 'priority':
      return [String(task.priority)];
    case 'project':
      return [String(task.projectId)];
    case 'milestone':
      return [task.milestoneId === null ? NONE_GROUP_KEY : String(task.milestoneId)];
    case 'epic':
      return [task.epicId === null ? NONE_GROUP_KEY : String(task.epicId)];
    case 'tag':
      return task.tags.length === 0 ? [NONE_GROUP_KEY] : task.tags.map((t) => String(t.id));
    case 'due': {
      const cat = ctx.fctx.statusCategoryById.get(task.statusId);
      return [dueBucket(task.dueDate, ctx.fctx.today, ctx.fctx.weekStartsOn, cat ? isClosedCategory(cat) : false)];
    }
    case 'custom':
      return [customGroupKey(task, axis.custom, ctx.fctx)];
  }
}

export interface GroupEnumeration {
  /** Every group in display order, hidden ones included (the config panel lists them). */
  groups: BoardGroup[];
  /** Keys of each task on this axis (tags: only the enumerated tags, unless none of them is). */
  keysByTask: Map<number, string[]>;
}

const isLast = (key: string) => key === NONE_GROUP_KEY || key === OTHER_GROUP_KEY;

/**
 * Enumerate the groups of one axis (SPEC §8.1): natural order restricted by the filter,
 * none / __other last, stale keys appended (before none / __other), then the axis prefs of
 * the current field (`order` — ignored for custom —, `hidden`, `collapsed`) and visibility.
 */
export function enumerateGroups(
  field: GroupField,
  axis: AxisConfig,
  filter: TaskFilter,
  ctx: BoardContext,
  tasks: readonly TaskDTO[],
): GroupEnumeration {
  const natural = naturalGroups(field, axis, filter, ctx);
  const naturalKeys = new Set(natural.map((g) => g.key));

  // Keys per task and counts.
  const keysByTask = new Map<number, string[]>();
  const counts = new Map<string, number>();
  const staleOrder: string[] = [];
  for (const task of tasks) {
    let keys = taskGroupKeys(field, task, axis, ctx);
    if (keys.length > 1) {
      // Multi-tag: only the tags the scope enumerates; if none is, keep them all (stale) so the task never disappears.
      const inScope = keys.filter((k) => naturalKeys.has(k));
      if (inScope.length > 0) keys = inScope;
    }
    keysByTask.set(task.id, keys);
    for (const k of keys) {
      const n = counts.get(k) ?? 0;
      if (n === 0 && !naturalKeys.has(k)) staleOrder.push(k);
      counts.set(k, n + 1);
    }
  }

  const multiProject = (field === 'milestone' || field === 'epic') && inScopeProjectIds(filter, ctx.lookups).length > 1;
  const kept = natural.filter((g) => !g.onlyWithTasks || (counts.get(g.key) ?? 0) > 0);
  const stale: GroupInfo[] = staleOrder.map((k) => describeGroup(field, k, ctx, { custom: axis.custom, multiProject }));
  let ordered: Array<GroupInfo & { stale: boolean }> = [
    ...kept.filter((g) => !isLast(g.key)).map((g) => ({ ...g, stale: false })),
    ...stale.filter((g) => !isLast(g.key)).map((g) => ({ ...g, stale: true })),
    ...kept.filter((g) => isLast(g.key)).map((g) => ({ ...g, stale: false })),
    ...stale.filter((g) => isLast(g.key)).map((g) => ({ ...g, stale: true })),
  ];

  const prefs = axis.prefs[field] ?? { order: [], hidden: [], collapsed: [], wipLimits: {} };
  if (field !== 'custom' && prefs.order.length > 0) {
    const rank = new Map(prefs.order.map((k, i) => [k, i]));
    const listed = ordered.filter((g) => rank.has(g.key)).sort((a, b) => rank.get(a.key)! - rank.get(b.key)!);
    ordered = [...listed, ...ordered.filter((g) => !rank.has(g.key))];
  }

  const hidden = new Set(prefs.hidden);
  const collapsed = new Set(prefs.collapsed);
  const groups: BoardGroup[] = ordered.map((g) => {
    const count = counts.get(g.key) ?? 0;
    const isHidden = hidden.has(g.key);
    const definedCustom = field === 'custom' && g.key !== OTHER_GROUP_KEY && !g.stale;
    let visible: boolean;
    if (isHidden) visible = false;
    else if (field === 'custom' && g.key === OTHER_GROUP_KEY && !axis.showUnmatched) visible = false;
    else if (g.key === NONE_GROUP_KEY && !axis.showNone) visible = false;
    else visible = definedCustom || field === 'none' || count > 0 || axis.showEmpty;
    return { ...g, hidden: isHidden, collapsed: collapsed.has(g.key), count, visible };
  });
  return { groups, keysByTask };
}

// ---------------------------------------------------------------------------
// Grid: lanes × columns
// ---------------------------------------------------------------------------

export interface WipState {
  count: number;
  limit: number;
  over: boolean;
}

export interface BoardGrid {
  /** Every column group in display order (hidden ones included). */
  columns: BoardGroup[];
  visibleColumns: BoardGroup[];
  /** Lane groups; a single NO_LANE lane when the board has no swimlanes (or in list layout). */
  lanes: BoardGroup[];
  visibleLanes: BoardGroup[];
  hasLanes: boolean;
  /** Tasks per cell (`cellKey(lane, col)`) in board order. Only non-empty cells are present. */
  cells: ReadonlyMap<string, readonly TaskDTO[]>;
  /** Distinct tasks that appear in no visible cell ("N tasks in hidden groups"). */
  hiddenTaskCount: number;
  /** WIP state per column key that has a limit. */
  wip: ReadonlyMap<string, WipState>;
  /** Total tasks on the board (after filtering). */
  total: number;
}

const EMPTY: readonly TaskDTO[] = Object.freeze([]);

/** Tasks of one cell (empty array when none). */
export function cellTasks(grid: BoardGrid, lane: string, col: string): readonly TaskDTO[] {
  return grid.cells.get(cellKey(lane, col)) ?? EMPTY;
}

/**
 * Group the (already filtered and sorted) tasks into lanes × columns. `filter` is the
 * effective filter (it scopes the enumerations). `layout` overrides config.layout (the
 * per-device "show as list" toggle); list layout ignores swimlanes.
 */
export function buildBoardGrid(
  config: BoardConfig,
  ctx: BoardContext,
  tasks: readonly TaskDTO[],
  filter: TaskFilter,
  layout: BoardConfig['layout'] = config.layout,
): BoardGrid {
  const cols = enumerateGroups(config.columns.groupBy, config.columns, filter, ctx, tasks);
  const hasLanes = layout === 'kanban' && config.swimlanes.groupBy !== 'none';
  const lanes = enumerateGroups(hasLanes ? config.swimlanes.groupBy : 'none', config.swimlanes, filter, ctx, tasks);

  const visibleCols = new Set(cols.groups.filter((g) => g.visible).map((g) => g.key));
  const visibleLanes = new Set(lanes.groups.filter((g) => g.visible).map((g) => g.key));
  const cells = new Map<string, TaskDTO[]>();
  let hiddenTaskCount = 0;
  for (const task of tasks) {
    const colKeys = cols.keysByTask.get(task.id) ?? [];
    const laneKeys = lanes.keysByTask.get(task.id) ?? [NO_LANE];
    for (const lane of laneKeys) {
      for (const col of colKeys) {
        const key = cellKey(lane, col);
        const list = cells.get(key);
        if (list) list.push(task);
        else cells.set(key, [task]);
      }
    }
    if (!colKeys.some((k) => visibleCols.has(k)) || !laneKeys.some((k) => visibleLanes.has(k))) hiddenTaskCount++;
  }

  const limits = config.columns.prefs[config.columns.groupBy]?.wipLimits ?? {};
  const wip = new Map<string, WipState>();
  for (const g of cols.groups) {
    const limit = limits[g.key];
    if (limit !== undefined) wip.set(g.key, { count: g.count, limit, over: g.count > limit });
  }

  return {
    columns: cols.groups,
    visibleColumns: cols.groups.filter((g) => g.visible),
    lanes: lanes.groups,
    visibleLanes: lanes.groups.filter((g) => g.visible),
    hasLanes,
    cells,
    hiddenTaskCount,
    wip,
    total: tasks.length,
  };
}

/**
 * Cards each cell renders before "Show N more" (SPEC §8.3 performance). Without swimlanes this
 * is `page` (50). With swimlanes the rendered cells (visible, expanded lane × column cells that
 * hold tasks) share a board-wide budget instead, so lanes × columns × 50 (and multi-tag tasks
 * repeated in every tag lane) can't put well over a thousand cards on screen: ~`budget` cards,
 * at least `min` per cell.
 */
export function cellPageSize(
  grid: Pick<BoardGrid, 'hasLanes' | 'visibleLanes' | 'visibleColumns' | 'cells'>,
  options: { page?: number; budget?: number; min?: number } = {},
): number {
  const { page = 50, budget = 300, min = 5 } = options;
  if (!grid.hasLanes) return page;
  let cells = 0;
  for (const lane of grid.visibleLanes) {
    if (lane.collapsed) continue;
    for (const col of grid.visibleColumns) {
      if (!col.collapsed && grid.cells.has(cellKey(lane.key, col.key))) cells++;
    }
  }
  return Math.max(min, Math.min(page, Math.floor(budget / Math.max(1, cells))));
}

/**
 * The groups the config editor lists and the column / lane menus reorder. Quick filters are
 * view state and never saved (SPEC §8), so these are enumerated from the SAVED filter (plus the
 * project scope), not the effective one: a quick filter on the grouped field (e.g. ?pri=3,4 on
 * a priority board) must not hide groups from the editor or drop them from the saved order.
 */
export function editableGroups(
  config: BoardConfig,
  ctx: BoardContext,
  tasks: readonly TaskDTO[],
  savedFilter: TaskFilter,
  hasLanes: boolean,
): { columns: BoardGroup[]; lanes: BoardGroup[] } {
  return {
    columns: enumerateGroups(config.columns.groupBy, config.columns, savedFilter, ctx, tasks).groups,
    lanes: enumerateGroups(hasLanes ? config.swimlanes.groupBy : 'none', config.swimlanes, savedFilter, ctx, tasks).groups,
  };
}

/**
 * The axis whose hidden groups keep tasks out of view ("N tasks in hidden groups → Show"):
 * columns when any column with tasks is not visible (hidden, or a 'none' / 'Other' group
 * switched off), else lanes when the board has them.
 */
export function hiddenGroupsAxis(grid: Pick<BoardGrid, 'columns' | 'hasLanes'>): 'columns' | 'swimlanes' {
  const columnHidden = grid.columns.some((g) => !g.visible && g.count > 0);
  return columnHidden || !grid.hasLanes ? 'columns' : 'swimlanes';
}

// ---------------------------------------------------------------------------
// Drop patches (SPEC §8.2)
// ---------------------------------------------------------------------------

type AxisResult = TaskUpdateInput | null;

function customById(axis: Pick<AxisConfig, 'custom'>, key: string): CustomColumn | undefined {
  return axis.custom.find((c) => c.id === key);
}

/**
 * The status a drop / quick add into a status-category group sets: the first status (by
 * position) of the category that the board's filter allows (filter.statusIds, when set),
 * else the first of the category. Picking an excluded status would make the card vanish.
 */
export function categoryTargetStatus(
  statuses: readonly StatusDTO[],
  category: string,
  filter: Pick<TaskFilter, 'statusIds'>,
): StatusDTO | undefined {
  const inCategory = statuses.filter((s) => s.category === category);
  const ids = filter.statusIds;
  return (ids && ids.length > 0 ? inCategory.find((s) => ids.includes(s.id)) : undefined) ?? inCategory[0];
}

/** Patch moving a task from group `src` to `dst` of one axis (src !== dst); null = not droppable. */
function axisPatch(
  field: GroupField,
  axis: Pick<AxisConfig, 'custom'>,
  src: string,
  dst: string,
  ctx: BoardContext,
  other: { field: GroupField; dst: string } | null,
  filter: TaskFilter,
): AxisResult {
  const { lookups, fctx } = ctx;
  const id = Number(dst);
  switch (field) {
    case 'none':
      return {};
    case 'status':
      return lookups.statusById.has(id) ? { statusId: id } : null;
    case 'statusCategory': {
      const target = categoryTargetStatus(lookups.statuses, dst, filter);
      return target ? { statusId: target.id } : null;
    }
    case 'priority':
      return (PRIORITY_VALUES as readonly number[]).includes(id) && dst !== '' ? { priority: id as Priority } : null;
    case 'project':
      return lookups.projectById.has(id) ? { projectId: id } : null;
    case 'epic': {
      // Inside a project lane/column the epic move also pins the project (SPEC §8.2).
      const laneProject = other?.field === 'project' ? Number(other.dst) : undefined;
      if (dst === NONE_GROUP_KEY) return laneProject !== undefined ? { projectId: laneProject, epicId: null } : { epicId: null };
      if (!lookups.epicById.has(id)) return null;
      return laneProject !== undefined ? { projectId: laneProject, epicId: id } : { epicId: id };
    }
    case 'milestone':
      return null; // the milestone comes from the epic: reorder only
    case 'tag':
      if (dst === NONE_GROUP_KEY) return { tagIds: [] };
      if (!lookups.tagById.has(id)) return null;
      if (src === NONE_GROUP_KEY) return { addTagIds: [id] };
      return { removeTagIds: [Number(src)], addTagIds: [id] };
    case 'due': {
      const date = dueBucketDropDate(dst as DueBucket, fctx.today, fctx.weekStartsOn);
      return date === undefined ? null : { dueDate: date };
    }
    case 'custom': {
      if (dst === OTHER_GROUP_KEY) return null;
      const target = customById(axis, dst);
      if (!target || target.onDrop === null) return null;
      const patch = resolveDropPatch(target.onDrop, fctx.today, fctx.weekStartsOn);
      const source = customById(axis, src);
      const srcAdds = source?.onDrop?.addTagIds ?? [];
      const dstAdds = target.onDrop.addTagIds ?? [];
      const remove = srcAdds.filter((t) => !dstAdds.includes(t));
      if (remove.length > 0) patch.removeTagIds = [...new Set([...(patch.removeTagIds ?? []), ...remove])];
      // `onDrop: {}` is reorder-only: a move from another group that changes nothing isn't offered.
      return Object.keys(patch).length > 0 ? patch : null;
    }
  }
}

const TAG_FIELDS = ['tagIds', 'addTagIds', 'removeTagIds'] as const;

/** Merge the per-axis patches; null when they set the same field to different values or tag fields clash. */
function mergePatches(a: TaskUpdateInput, b: TaskUpdateInput): TaskUpdateInput | null {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (k in out && JSON.stringify(out[k]) !== JSON.stringify(v)) return null;
    out[k] = v;
  }
  const merged = out as TaskUpdateInput;
  const touchesTags = (p: TaskUpdateInput) => TAG_FIELDS.some((f) => p[f] !== undefined);
  // Tag edits from both axes, or a full tag replacement mixed with add/remove, are ambiguous.
  if (touchesTags(a) && touchesTags(b) && JSON.stringify(TAG_FIELDS.map((f) => a[f])) !== JSON.stringify(TAG_FIELDS.map((f) => b[f]))) {
    return null;
  }
  if (merged.tagIds !== undefined && (merged.addTagIds !== undefined || merged.removeTagIds !== undefined)) return null;
  if (merged.addTagIds?.some((id) => merged.removeTagIds?.includes(id))) return null;
  return merged;
}

/** Where a task's project / epic / milestone end up after a patch (mirrors the server rules). */
export function predictStructure(
  task: Pick<TaskDTO, 'projectId' | 'epicId' | 'milestoneId'>,
  patch: TaskUpdateInput,
  lookups: Pick<BoardLookups, 'epicById'>,
): { projectId: number; epicId: number | null; milestoneId: number | null } | null {
  let projectId = patch.projectId ?? task.projectId;
  let epicId = task.epicId;
  if (patch.epicId !== undefined) epicId = patch.epicId;
  else if (patch.projectId !== undefined && patch.projectId !== task.projectId) epicId = null;
  const epic = epicId === null ? undefined : lookups.epicById.get(epicId);
  if (epicId !== null) {
    if (!epic) return null;
    if (patch.projectId !== undefined && epic.projectId !== patch.projectId) return null; // conflicting move
    projectId = epic.projectId;
  }
  const milestoneId = epicId === null ? null : (epic?.milestoneId ?? null);
  return { projectId, epicId, milestoneId };
}

function structuralKey(field: GroupField, s: { projectId: number; epicId: number | null; milestoneId: number | null }): string | null {
  if (field === 'project') return String(s.projectId);
  if (field === 'epic') return s.epicId === null ? NONE_GROUP_KEY : String(s.epicId);
  if (field === 'milestone') return s.milestoneId === null ? NONE_GROUP_KEY : String(s.milestoneId);
  return null;
}

/**
 * TaskUpdateInput for dropping `task` from cell `from` into cell `to` (SPEC §8.2):
 * colPatch(src→dst) ∪ lanePatch(src→dst); an unchanged axis contributes nothing.
 * Returns null when the target is not droppable (a changed axis is not droppable, the axes
 * set a field to different values, the move contradicts the project/epic/milestone of the
 * target cell, the due date would precede the start date, or a move into a reorder-only custom
 * group would change nothing). `{}` = same groups (reorder only).
 * Pass the same lane (e.g. NO_LANE) twice for boards without swimlanes and for list layout.
 */
export function computeDropPatch(
  config: BoardConfig,
  ctx: BoardContext,
  task: TaskDTO,
  from: CellRef,
  to: CellRef,
): TaskUpdateInput | null {
  const colField = config.columns.groupBy;
  const laneField: GroupField = config.swimlanes.groupBy;
  const lanesActive = laneField !== 'none' && from.lane !== NO_LANE && to.lane !== NO_LANE;
  const colChanged = from.col !== to.col;
  const laneChanged = lanesActive && from.lane !== to.lane;

  let patch: TaskUpdateInput = {};
  if (colChanged) {
    // Quick filters never set statusIds, so the saved filter scopes status-category targets.
    const p = axisPatch(colField, config.columns, from.col, to.col, ctx, lanesActive ? { field: laneField, dst: to.lane } : null, config.filter);
    if (!p) return null;
    patch = p;
  }
  if (laneChanged) {
    const p = axisPatch(laneField, config.swimlanes, from.lane, to.lane, ctx, { field: colField, dst: to.col }, config.filter);
    if (!p) return null;
    const merged = mergePatches(patch, p);
    if (!merged) return null;
    patch = merged;
  }
  if (!colChanged && !laneChanged) return {};

  // The target cell must be where the task ends up on structural axes (no impossible cells
  // such as an epic of another project inside a project lane).
  const axes: Array<[GroupField, string]> = [[colField, to.col]];
  if (lanesActive) axes.push([laneField, to.lane]);
  if (axes.some(([f]) => f === 'project' || f === 'epic' || f === 'milestone')) {
    const predicted = predictStructure(task, patch, ctx.lookups);
    if (!predicted) return null;
    for (const [field, dst] of axes) {
      const key = structuralKey(field, predicted);
      if (key !== null && key !== dst) return null;
    }
  } else if (patch.projectId !== undefined || patch.epicId !== undefined) {
    if (!predictStructure(task, patch, ctx.lookups)) return null;
  }

  if (typeof patch.dueDate === 'string' && task.startDate !== null && task.startDate > patch.dueDate) return null;
  return patch;
}

/** The custom group a task lands in after a patch was applied (for the "now matches …" toast). */
export function landingCustomGroup(patched: TaskDTO, axis: Pick<AxisConfig, 'custom'>, ctx: BoardContext): string {
  return customGroupKey(patched, axis.custom, ctx.fctx);
}

/** A move's success toast; a move to another project also names the task's new ref. */
export function withNewRef(task: Pick<TaskDTO, 'ref'>, message: string): (saved: Pick<TaskDTO, 'ref'>) => string {
  return (saved) => (saved.ref !== task.ref ? `${message} (now ${saved.ref})` : message);
}

/**
 * SPEC §8.2 landing rule, shared by drag & drop and the "Move to column / lane" menus: when a
 * move between custom groups leaves the task matching another group than the target (first
 * match wins), the message to show instead of "Moved to …"; null when it lands as asked.
 * `patched` is the task with the move's patch applied (applyTaskPatch).
 */
export function customLandingMessage(
  config: BoardConfig,
  ctx: BoardContext,
  grid: Pick<BoardGrid, 'columns' | 'lanes' | 'hasLanes'>,
  patched: TaskDTO,
  from: CellRef,
  to: CellRef,
): string | null {
  const checks: Array<['columns' | 'swimlanes', string, string]> = [['columns', from.col, to.col]];
  if (grid.hasLanes) checks.push(['swimlanes', from.lane, to.lane]);
  for (const [axisName, src, dst] of checks) {
    const axis = config[axisName];
    if (axis.groupBy !== 'custom' || src === dst) continue;
    const landed = landingCustomGroup(patched, axis, ctx);
    if (landed === dst) continue;
    const groups = axisName === 'columns' ? grid.columns : grid.lanes;
    const name = groups.find((g) => g.key === landed)?.label ?? describeGroup('custom', landed, ctx, { custom: axis.custom }).label;
    return `Moved — it now matches “${name}”`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Manual order
// ---------------------------------------------------------------------------

/**
 * Rank position for a drop between `above` and `below` (cards of the target cell, SPEC §8.2).
 * Ascending: after the card above / before the one below; descending: the reverse.
 * Undefined when the sort is not manual or there are no neighbours (omit `position`).
 */
export function dropPosition(
  sort: TaskSort,
  above: Pick<TaskDTO, 'id'> | null | undefined,
  below: Pick<TaskDTO, 'id'> | null | undefined,
): RankPosition | undefined {
  if (sort.field !== 'manual') return undefined;
  const a = above?.id ?? null;
  const b = below?.id ?? null;
  if (a === null && b === null) return undefined;
  return sort.dir === 'asc' ? { afterId: a, beforeId: b } : { afterId: b, beforeId: a };
}

/**
 * Neighbours of a card inserted at `index` of a rendered cell list (index counts the
 * rendered list, which may include the moving task itself). `changed` is false when the
 * moving task would stay exactly where it is.
 */
export function insertionNeighbours(
  list: readonly TaskDTO[],
  index: number,
  movingId: number,
): { above: TaskDTO | null; below: TaskDTO | null; changed: boolean } {
  const from = list.findIndex((t) => t.id === movingId);
  const without = list.filter((t) => t.id !== movingId);
  const at = Math.max(0, Math.min(from >= 0 && from < index ? index - 1 : index, without.length));
  const above = without[at - 1] ?? null;
  const below = without[at] ?? null;
  const changed = from < 0 || at !== from;
  return { above, below, changed };
}

// ---------------------------------------------------------------------------
// Quick add
// ---------------------------------------------------------------------------

/**
 * Create-task defaults for the "+" of a cell (SPEC §8.3): the cell's patch fields (statusId,
 * priority, epicId, dueDate, tagIds = addTagIds) and the project from the lane / column
 * project (or the epic's), else the board's project, else filter.projectIds when it has
 * exactly one entry.
 */
export function cellCreateDefaults(
  config: BoardConfig,
  ctx: BoardContext,
  cell: CellRef,
  boardProjectId: number | null,
  filter: TaskFilter = config.filter,
): Partial<TaskCreateInput> {
  const { lookups, fctx } = ctx;
  const out: Partial<TaskCreateInput> = {};
  let tagIds: number[] = [];
  let projectId: number | undefined;
  const apply = (field: GroupField, axis: Pick<AxisConfig, 'custom'>, key: string) => {
    const id = Number(key);
    switch (field) {
      case 'status':
        if (lookups.statusById.has(id)) out.statusId = id;
        break;
      case 'statusCategory': {
        const target = categoryTargetStatus(lookups.statuses, key, filter);
        if (target) out.statusId = target.id;
        break;
      }
      case 'priority':
        if (key !== '' && (PRIORITY_VALUES as readonly number[]).includes(id)) out.priority = id as Priority;
        break;
      case 'project':
        if (lookups.projectById.has(id)) projectId = id;
        break;
      case 'epic': {
        const epic = lookups.epicById.get(id);
        if (epic) {
          out.epicId = epic.id;
          projectId ??= epic.projectId;
        }
        break;
      }
      case 'tag':
        if (lookups.tagById.has(id)) tagIds = [...new Set([...tagIds, id])];
        break;
      case 'due': {
        const date = dueBucketDropDate(key as DueBucket, fctx.today, fctx.weekStartsOn);
        if (typeof date === 'string') out.dueDate = date;
        break;
      }
      case 'custom': {
        const col = customById(axis, key);
        if (!col?.onDrop) break;
        const p = resolveDropPatch(col.onDrop, fctx.today, fctx.weekStartsOn);
        if (p.statusId !== undefined && lookups.statusById.has(p.statusId)) out.statusId = p.statusId;
        if (p.priority !== undefined) out.priority = p.priority;
        if (typeof p.dueDate === 'string') out.dueDate = p.dueDate;
        if (p.projectId !== undefined && lookups.projectById.has(p.projectId)) projectId = p.projectId;
        if (p.epicId !== undefined && p.epicId !== null && lookups.epicById.has(p.epicId)) out.epicId = p.epicId;
        if (p.addTagIds) tagIds = [...new Set([...tagIds, ...p.addTagIds.filter((t) => lookups.tagById.has(t))])];
        break;
      }
      default:
        break;
    }
  };
  // Lane first, so the column (the primary axis) wins on conflicts.
  if (config.swimlanes.groupBy !== 'none' && cell.lane !== NO_LANE) apply(config.swimlanes.groupBy, config.swimlanes, cell.lane);
  apply(config.columns.groupBy, config.columns, cell.col);

  if (projectId === undefined && typeof out.epicId === 'number') projectId = lookups.epicById.get(out.epicId)?.projectId;
  if (projectId === undefined && boardProjectId !== null) projectId = boardProjectId;
  if (projectId === undefined && filter.projectIds?.length === 1) projectId = filter.projectIds[0];
  if (projectId !== undefined) out.projectId = projectId;
  if (typeof out.epicId === 'number' && lookups.epicById.get(out.epicId)?.projectId !== projectId) delete out.epicId;
  if (tagIds.length > 0) out.tagIds = tagIds;
  return out;
}

// ---------------------------------------------------------------------------
// Prefs helpers
// ---------------------------------------------------------------------------

/** Add or remove a key of a prefs list. */
export function toggleKey(list: readonly string[], key: string, on: boolean): string[] {
  const has = list.includes(key);
  if (on === has) return [...list];
  return on ? [...list, key] : list.filter((k) => k !== key);
}
