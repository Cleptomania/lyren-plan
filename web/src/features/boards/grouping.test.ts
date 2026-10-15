import { describe, expect, it } from 'vitest';
import { defaultBoardConfig, type BoardConfig, type BoardConfigInput, type CustomColumn } from '@shared/board';
import { buildFilterContext } from '@shared/filter';
import type { TaskFilter } from '@shared/schemas';
import type { TagDTO, TaskDTO } from '@shared/types';
import { buildLookups } from '../../api/bootstrap';
import { epic, milestone, project, status, task as baseTask } from '../../components/domain/fixtures.test-utils';
import {
  buildBoardGrid,
  cardDndId,
  cellCreateDefaults,
  cellKey,
  cellPageSize,
  cellTasks,
  computeDropPatch,
  customLandingMessage,
  deriveBoardTasks,
  dropPosition,
  editableGroups,
  enumerateGroups,
  hiddenGroupsAxis,
  insertionNeighbours,
  landingCustomGroup,
  NO_LANE,
  parseCardDndId,
  predictStructure,
  toggleKey,
  withNewRef,
  type AxisConfig,
  type BoardContext,
  type GroupField,
} from './grouping';

// ---- Fixtures ---------------------------------------------------------------------------
// Statuses 1 Backlog · 2 Todo · 3 Doing · 4 Review (started) · 5 Done · 6 Cancelled
// Projects 1 WEB, 2 ME (active), 3 OLD (archived)
// Milestones 10 (WEB, active) · 11 (WEB, completed) · 12 (ME, planned)
// Epics 20 (WEB/M10) · 21 (WEB/M11, done) · 22 (WEB, no milestone) · 23 (ME/M12) · 24 (OLD)
// Tags 30 bug · 31 idea · 32 blocked (by name: blocked, bug, idea)

const TODAY = '2026-10-14'; // Wednesday; week starts Monday → end of week 2026-10-18
const NOW = Date.parse('2026-10-14T12:00:00.000Z');

const tag = (id: number, name: string, color = '#64748b'): TagDTO => ({ id, name, color, taskCount: 0, createdAt: '2026-01-01T00:00:00.000Z' });
const ref = (t: TagDTO) => ({ id: t.id, name: t.name, color: t.color });

const STATUSES = [
  { ...status(1, 'backlog', 0), name: 'Backlog' },
  { ...status(2, 'unstarted', 1), name: 'Todo' },
  { ...status(3, 'started', 2), name: 'Doing' },
  { ...status(4, 'started', 3), name: 'Review' },
  { ...status(5, 'completed', 4), name: 'Done' },
  { ...status(6, 'cancelled', 5), name: 'Cancelled' },
];
const PROJECTS = [project(1, 'WEB', { position: 0 }), project(2, 'ME', { position: 1 }), project(3, 'OLD', { position: 2, status: 'archived' })];
const MILESTONES = [milestone(10, 1, 0), milestone(11, 1, 1, { status: 'completed' }), milestone(12, 2, 0, { status: 'planned' })];
const EPICS = [
  epic(20, 1, 10, 0),
  epic(21, 1, 11, 1, { status: 'done' }),
  epic(22, 1, null, 2),
  epic(23, 2, 12, 0),
  epic(24, 3, null, 0),
];
const BUG = tag(30, 'bug', '#ef4444');
const IDEA = tag(31, 'idea');
const BLOCKED = tag(32, 'blocked');

function makeCtx(over: { statuses?: typeof STATUSES } = {}): BoardContext {
  const statuses = over.statuses ?? STATUSES;
  const lookups = buildLookups({
    user: { id: 1, username: 'o', displayName: 'O', createdAt: '' },
    settings: { weekStartsOn: 1, estimateUnit: 'points', defaultBoardId: null, homePage: 'dashboard' },
    version: 'test',
    statuses,
    tags: [BUG, IDEA, BLOCKED],
    projects: PROJECTS,
    milestones: MILESTONES,
    epics: EPICS,
    boards: [],
  });
  return {
    lookups,
    fctx: buildFilterContext({ statuses, projects: PROJECTS, today: TODAY, weekStartsOn: 1, nowMs: NOW }),
  };
}
const ctx = makeCtx();

let nextId = 1;
function task(over: Partial<TaskDTO> = {}): TaskDTO {
  const id = over.id ?? nextId++;
  const epicId = over.epicId ?? null;
  const e = epicId === null ? undefined : EPICS.find((x) => x.id === epicId);
  return baseTask({
    id,
    ref: `T-${id}`,
    rank: `a${String(id).padStart(3, '0')}`,
    statusId: 2,
    projectId: e?.projectId ?? 1,
    milestoneId: e?.milestoneId ?? null,
    ...over,
  });
}

const cfg = (input: BoardConfigInput = {}): BoardConfig => defaultBoardConfig(input);

function axis(groupBy: GroupField, over: Partial<AxisConfig> = {}): AxisConfig {
  return { groupBy, prefs: {}, showEmpty: true, showNone: true, custom: [], showUnmatched: true, ...over };
}

const keys = (field: GroupField, filter: TaskFilter = {}, tasks: TaskDTO[] = [], a: Partial<AxisConfig> = {}) =>
  enumerateGroups(field, axis(field, a), filter, ctx, tasks).groups.map((g) => g.key);

const col = (id: string, name: string, match: TaskFilter, onDrop: CustomColumn['onDrop'], color: string | null = null): CustomColumn => ({
  id,
  name,
  color,
  match,
  onDrop,
});

// ---- Data flow ----------------------------------------------------------------------------

describe('deriveBoardTasks', () => {
  const sctx = { statusPositionById: new Map(STATUSES.map((s) => [s.id, s.position])) };
  const a = task({ id: 101, rank: 'a2', priority: 1 });
  const b = task({ id: 102, rank: 'a1', priority: 4 });
  const archived = task({ id: 103, rank: 'a0', archivedAt: '2026-10-01T00:00:00.000Z' });
  const oldProject = task({ id: 104, rank: 'a3', projectId: 3 });
  const closedLongAgo = task({ id: 105, rank: 'a4', statusId: 5, completedAt: '2026-09-01T00:00:00.000Z' });

  it('filters with the effective filter and sorts with compareTasks', () => {
    const all = [a, b, archived, oldProject, closedLongAgo];
    const f: TaskFilter = { closedWithinDays: 14 };
    expect(deriveBoardTasks(all, f, { field: 'manual', dir: 'asc' }, ctx.fctx, sctx).map((t) => t.id)).toEqual([102, 101]);
    expect(deriveBoardTasks(all, f, { field: 'manual', dir: 'desc' }, ctx.fctx, sctx).map((t) => t.id)).toEqual([101, 102]);
    expect(deriveBoardTasks(all, {}, { field: 'priority', dir: 'asc' }, ctx.fctx, sctx).map((t) => t.id)).toEqual([101, 102, 105]);
    expect(deriveBoardTasks(all, { archived: 'include', includeArchivedProjects: true }, { field: 'manual', dir: 'asc' }, ctx.fctx, sctx).map((t) => t.id)).toEqual([
      103, 102, 101, 104, 105,
    ]);
  });

  it('applies the extra (client-only) filter too', () => {
    const tagged = task({ id: 106, tags: [ref(BUG)] });
    const out = deriveBoardTasks([a, tagged], {}, { field: 'manual', dir: 'asc' }, ctx.fctx, sctx, { tagIds: [30], archived: 'include' });
    expect(out.map((t) => t.id)).toEqual([106]);
  });
});

// ---- Enumeration (SPEC §8.1 table) ----------------------------------------------------------------

describe('enumerateGroups — natural order and scope', () => {
  it('status: by position, ∩ statusIds, ∩ statusCategories', () => {
    expect(keys('status')).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(keys('status', { statusIds: [5, 2, 4] })).toEqual(['2', '4', '5']);
    expect(keys('status', { statusCategories: ['started', 'completed'] })).toEqual(['3', '4', '5']);
    expect(keys('status', { statusIds: [2, 3, 5], statusCategories: ['started'] })).toEqual(['3']);
    const g = enumerateGroups('status', axis('status'), {}, ctx, []).groups[2]!;
    expect(g).toMatchObject({ key: '3', label: 'Doing', color: '#3b82f6', count: 0, visible: true, hidden: false, collapsed: false, stale: false });
  });

  it('statusCategory: category order, only categories with statuses, ∩ categories, ∩ categories of statusIds', () => {
    expect(keys('statusCategory')).toEqual(['backlog', 'unstarted', 'started', 'completed', 'cancelled']);
    const noCancelled = makeCtx({ statuses: STATUSES.filter((s) => s.id !== 6) });
    expect(enumerateGroups('statusCategory', axis('statusCategory'), {}, noCancelled, []).groups.map((g) => g.key)).toEqual([
      'backlog', 'unstarted', 'started', 'completed',
    ]);
    expect(keys('statusCategory', { statusCategories: ['completed', 'backlog'] })).toEqual(['backlog', 'completed']);
    expect(keys('statusCategory', { statusIds: [4, 1] })).toEqual(['backlog', 'started']);
    expect(enumerateGroups('statusCategory', axis('statusCategory'), {}, ctx, []).groups[1]!.label).toBe('To do');
  });

  it('priority: 4, 3, 2, 1, 0 ∩ priorities', () => {
    expect(keys('priority')).toEqual(['4', '3', '2', '1', '0']);
    expect(keys('priority', { priorities: [0, 3] })).toEqual(['3', '0']);
    const labels = enumerateGroups('priority', axis('priority'), {}, ctx, []).groups.map((g) => g.label);
    expect(labels).toEqual(['Urgent', 'High', 'Medium', 'Low', 'No priority']);
  });

  it('project: by position; listed projects (even archived), else non-archived, all with includeArchivedProjects', () => {
    expect(keys('project')).toEqual(['1', '2']);
    expect(keys('project', { projectIds: [3, 2] })).toEqual(['2', '3']);
    expect(keys('project', { includeArchivedProjects: true })).toEqual(['1', '2', '3']);
    expect(enumerateGroups('project', axis('project'), {}, ctx, []).groups[0]).toMatchObject({ label: 'Project WEB', hint: 'WEB', color: '#6366f1' });
  });

  it('milestone: in-scope projects in order, closed ones only with tasks, ∩ milestoneIds, none rule', () => {
    expect(keys('milestone')).toEqual(['10', '12', 'none']);
    expect(keys('milestone', {}, [task({ epicId: 21 })])).toEqual(['10', '11', '12', 'none']);
    expect(keys('milestone', { projectIds: [2] })).toEqual(['12', 'none']);
    expect(keys('milestone', { milestoneIds: [12, 10] })).toEqual(['10', '12']);
    expect(keys('milestone', { milestoneIds: [12, null] })).toEqual(['12', 'none']);
    const groups = enumerateGroups('milestone', axis('milestone'), {}, ctx, []).groups;
    expect(groups[0]).toMatchObject({ label: 'M10', hint: 'WEB' });
    expect(groups.at(-1)).toMatchObject({ label: 'No milestone' });
    expect(enumerateGroups('milestone', axis('milestone'), { projectIds: [1] }, ctx, []).groups[0]!.hint).toBeUndefined();
  });

  it('epic: in-scope projects, done ones only with tasks, ∩ epicIds, ∩ milestoneIds, none rule', () => {
    expect(keys('epic')).toEqual(['20', '22', '23', 'none']);
    expect(keys('epic', {}, [task({ epicId: 21 })])).toEqual(['20', '21', '22', '23', 'none']);
    expect(keys('epic', { includeArchivedProjects: true })).toEqual(['20', '22', '23', '24', 'none']);
    expect(keys('epic', { epicIds: [23, 20] })).toEqual(['20', '23']);
    expect(keys('epic', { epicIds: [null] })).toEqual(['none']);
    expect(keys('epic', { milestoneIds: [10] })).toEqual(['20', 'none']);
    expect(keys('epic', { milestoneIds: [null] })).toEqual(['22', 'none']);
    expect(enumerateGroups('epic', axis('epic'), {}, ctx, []).groups[0]).toMatchObject({ label: 'E20', color: '#8b5cf6', hint: 'WEB' });
  });

  it('tag: by name, listed tags in "any" mode, all tags in "all" mode, minus excluded, none rule', () => {
    expect(keys('tag')).toEqual(['32', '30', '31', 'none']);
    expect(keys('tag', { tagIds: [31, 30] })).toEqual(['30', '31']);
    expect(keys('tag', { tagIds: [31, null] })).toEqual(['31', 'none']);
    expect(keys('tag', { tagIds: [31, 30], tagMode: 'all' })).toEqual(['32', '30', '31']);
    expect(keys('tag', { excludeTagIds: [32] })).toEqual(['30', '31', 'none']);
    expect(enumerateGroups('tag', axis('tag'), {}, ctx, []).groups.at(-1)!.label).toBe('No tags');
  });

  it('due: bucket order', () => {
    expect(keys('due')).toEqual(['past', 'overdue', 'today', 'tomorrow', 'this_week', 'next_week', 'later', 'no_date']);
  });

  it('custom: array order, then __other', () => {
    const custom = [col('b', 'B', {}, null), col('a', 'A', {}, null)];
    expect(keys('custom', {}, [], { custom })).toEqual(['b', 'a', '__other']);
    expect(enumerateGroups('custom', axis('custom', { custom }), {}, ctx, []).groups.map((g) => g.label)).toEqual(['B', 'A', 'Other']);
  });
});

describe('enumerateGroups — membership, stale keys, prefs, visibility', () => {
  it('counts tasks per group; a task with several tags is in each tag group', () => {
    const t1 = task({ tags: [ref(BUG), ref(IDEA)] });
    const t2 = task({ tags: [ref(BUG)] });
    const t3 = task();
    const { groups, keysByTask } = enumerateGroups('tag', axis('tag'), {}, ctx, [t1, t2, t3]);
    expect(groups.map((g) => [g.key, g.count])).toEqual([
      ['32', 0],
      ['30', 2],
      ['31', 1],
      ['none', 1],
    ]);
    expect(keysByTask.get(t1.id)).toEqual(['30', '31']);
    expect(keysByTask.get(t3.id)).toEqual(['none']);
  });

  it('keeps multi-tag keys to the enumerated tags (and all of them when none is enumerated)', () => {
    const t1 = task({ tags: [ref(BUG), ref(IDEA)] });
    const t2 = task({ tags: [ref(BLOCKED), ref(IDEA)] });
    const { groups, keysByTask } = enumerateGroups('tag', axis('tag'), { tagIds: [30] }, ctx, [t1, t2]);
    expect(keysByTask.get(t1.id)).toEqual(['30']);
    expect(keysByTask.get(t2.id)).toEqual(['32', '31']); // stale: never disappears
    expect(groups.map((g) => [g.key, g.stale])).toEqual([
      ['30', false],
      ['32', true],
      ['31', true],
    ]);
  });

  it('appends stale keys (before none / __other) so tasks never disappear', () => {
    const t = task({ statusId: 4 });
    expect(keys('status', { statusIds: [2] }, [t])).toEqual(['2', '4']);
    const deleted = task({ statusId: 99 });
    const g = enumerateGroups('status', axis('status'), {}, ctx, [deleted]).groups.at(-1)!;
    expect(g).toMatchObject({ key: '99', label: 'Deleted status', stale: true, visible: true, count: 1 });
    // Epic of an out-of-scope project, appended before "No epic".
    expect(keys('epic', { projectIds: [2] }, [task({ epicId: 20 }), task({ projectId: 2 })])).toEqual(['23', '20', 'none']);
    // A custom column removed from the config while a task still matched it is impossible
    // (keys are recomputed), so __other stays last.
    const custom = [col('a', 'A', { priorities: [4] }, null)];
    expect(keys('custom', {}, [task({ priority: 4 }), task()], { custom })).toEqual(['a', '__other']);
  });

  it('applies prefs.order (listed first), hidden and collapsed of the current field only', () => {
    const prefs = {
      status: { order: ['5', '3'], hidden: ['6'], collapsed: ['1'], wipLimits: {} },
      priority: { order: ['0'], hidden: [], collapsed: [], wipLimits: {} },
    };
    const groups = enumerateGroups('status', axis('status', { prefs }), {}, ctx, []).groups;
    expect(groups.map((g) => g.key)).toEqual(['5', '3', '1', '2', '4', '6']);
    expect(groups.find((g) => g.key === '6')).toMatchObject({ hidden: true, visible: false });
    expect(groups.find((g) => g.key === '1')).toMatchObject({ collapsed: true, visible: true });
    expect(enumerateGroups('priority', axis('priority', { prefs }), {}, ctx, []).groups.map((g) => g.key)).toEqual(['0', '4', '3', '2', '1']);
    // Unknown keys in order are ignored.
    expect(
      enumerateGroups('status', axis('status', { prefs: { status: { order: ['77', '2'], hidden: [], collapsed: [], wipLimits: {} } } }), {}, ctx, []).groups[0]!.key,
    ).toBe('2');
  });

  it('ignores prefs.order for custom grouping (array order rules)', () => {
    const custom = [col('a', 'A', {}, null), col('b', 'B', {}, null)];
    const prefs = { custom: { order: ['b'], hidden: [], collapsed: ['a'], wipLimits: {} } };
    const groups = enumerateGroups('custom', axis('custom', { custom, prefs }), {}, ctx, []).groups;
    expect(groups.map((g) => g.key)).toEqual(['a', 'b', '__other']);
    expect(groups[0]!.collapsed).toBe(true);
  });

  it('visibility: showEmpty, showNone, custom columns always (unless hidden), __other with showUnmatched', () => {
    const t = task({ statusId: 3 });
    const vis = (field: GroupField, a: Partial<AxisConfig>, tasks: TaskDTO[] = [t]) =>
      enumerateGroups(field, axis(field, a), {}, ctx, tasks).groups.filter((g) => g.visible).map((g) => g.key);
    expect(vis('status', { showEmpty: false })).toEqual(['3']);
    expect(vis('status', { showEmpty: true })).toHaveLength(6);
    expect(vis('epic', { showEmpty: false })).toEqual(['none']);
    expect(vis('epic', { showEmpty: false, showNone: false })).toEqual([]);
    expect(vis('epic', { showEmpty: true, showNone: false })).toEqual(['20', '22', '23']);
    const custom = [col('a', 'A', { priorities: [4] }, null), col('b', 'B', { priorities: [3] }, {})];
    expect(vis('custom', { custom, showEmpty: false })).toEqual(['a', 'b', '__other']);
    expect(vis('custom', { custom, showEmpty: false }, [])).toEqual(['a', 'b']);
    expect(vis('custom', { custom, showUnmatched: false })).toEqual(['a', 'b']);
    expect(vis('custom', { custom, prefs: { custom: { order: [], hidden: ['b'], collapsed: [], wipLimits: {} } } })).toEqual(['a', '__other']);
  });
});

// ---- Grid ---------------------------------------------------------------------------------------

describe('buildBoardGrid', () => {
  const t1 = task({ statusId: 2, epicId: 20 });
  const t2 = task({ statusId: 3, epicId: 20 });
  const t3 = task({ statusId: 3, epicId: 22 });
  const t4 = task({ statusId: 3 });
  const tasks = [t1, t2, t3, t4];

  it('places tasks into lane × column cells in board order', () => {
    const config = cfg({ columns: { groupBy: 'status' }, swimlanes: { groupBy: 'epic' } });
    const grid = buildBoardGrid(config, ctx, tasks, config.filter);
    expect(grid.hasLanes).toBe(true);
    expect(grid.lanes.map((l) => l.key)).toEqual(['20', '22', '23', 'none']);
    expect(grid.visibleLanes.map((l) => l.key)).toEqual(['20', '22', 'none']); // empty lanes hidden by default
    expect(cellTasks(grid, '20', '3')).toEqual([t2]);
    expect(cellTasks(grid, '20', '2')).toEqual([t1]);
    expect(cellTasks(grid, 'none', '3')).toEqual([t4]);
    expect(cellTasks(grid, '23', '3')).toEqual([]);
    expect(grid.columns.find((c) => c.key === '3')!.count).toBe(3);
    expect(grid.lanes.find((l) => l.key === '20')!.count).toBe(2);
    expect(grid.total).toBe(4);
    expect(grid.hiddenTaskCount).toBe(0);
  });

  it('uses a single lane without swimlanes and in list layout', () => {
    const config = cfg({ columns: { groupBy: 'status' }, swimlanes: { groupBy: 'epic' } });
    const list = buildBoardGrid(config, ctx, tasks, config.filter, 'list');
    expect(list.hasLanes).toBe(false);
    expect(list.lanes.map((l) => l.key)).toEqual([NO_LANE]);
    expect(cellTasks(list, NO_LANE, '3')).toEqual([t2, t3, t4]);
  });

  it('puts multi-tag tasks into each tag column (within each lane)', () => {
    const a = task({ projectId: 1, tags: [ref(BUG), ref(IDEA)] });
    const b = task({ projectId: 2, tags: [ref(BUG)] });
    const config = cfg({ columns: { groupBy: 'tag' }, swimlanes: { groupBy: 'project' } });
    const grid = buildBoardGrid(config, ctx, [a, b], config.filter);
    expect(cellTasks(grid, '1', '30')).toEqual([a]);
    expect(cellTasks(grid, '1', '31')).toEqual([a]);
    expect(cellTasks(grid, '2', '30')).toEqual([b]);
    expect(grid.columns.find((c) => c.key === '30')!.count).toBe(2);
  });

  it('computes WIP across lanes and flags excess', () => {
    const config = cfg({
      columns: { groupBy: 'status', prefs: { status: { order: [], hidden: [], collapsed: [], wipLimits: { '3': 2, '2': 5 } } } },
      swimlanes: { groupBy: 'epic' },
    });
    const grid = buildBoardGrid(config, ctx, tasks, config.filter);
    expect(grid.wip.get('3')).toEqual({ count: 3, limit: 2, over: true });
    expect(grid.wip.get('2')).toEqual({ count: 1, limit: 5, over: false });
    expect(grid.wip.has('4')).toBe(false);
  });

  it('counts tasks in hidden groups (hidden columns, hidden lanes, none without showNone)', () => {
    const hiddenCol = cfg({ columns: { groupBy: 'status', prefs: { status: { order: [], hidden: ['3'], collapsed: ['2'], wipLimits: {} } } } });
    expect(buildBoardGrid(hiddenCol, ctx, tasks, hiddenCol.filter).hiddenTaskCount).toBe(3);
    const hiddenLane = cfg({ swimlanes: { groupBy: 'epic', prefs: { epic: { order: [], hidden: ['20'], collapsed: [], wipLimits: {} } } } });
    expect(buildBoardGrid(hiddenLane, ctx, tasks, hiddenLane.filter).hiddenTaskCount).toBe(2);
    expect(buildBoardGrid(hiddenLane, ctx, tasks, hiddenLane.filter, 'list').hiddenTaskCount).toBe(0); // lanes ignored
    const noNone = cfg({ columns: { groupBy: 'epic', showNone: false } });
    expect(buildBoardGrid(noNone, ctx, tasks, noNone.filter).hiddenTaskCount).toBe(1);
    const multi = cfg({ columns: { groupBy: 'tag', prefs: { tag: { order: [], hidden: ['30'], collapsed: [], wipLimits: {} } } } });
    const both = task({ tags: [ref(BUG), ref(IDEA)] });
    const onlyBug = task({ tags: [ref(BUG)] });
    expect(buildBoardGrid(multi, ctx, [both, onlyBug], multi.filter).hiddenTaskCount).toBe(1);
  });

  it('cell page size: 50 without lanes, a shared budget across lane cells', () => {
    const flatBoard = cfg({ columns: { groupBy: 'status' } });
    const many = Array.from({ length: 400 }, (_, i) => task({ statusId: (i % 5) + 1, tags: [ref([BUG, IDEA, BLOCKED][i % 3]!)] }));
    expect(cellPageSize(buildBoardGrid(flatBoard, ctx, many, flatBoard.filter))).toBe(50);
    // 5 statuses × 3 tag lanes = 15 non-empty cells → 300 / 15 = 20 per cell.
    const tagLanes = cfg({ columns: { groupBy: 'status' }, swimlanes: { groupBy: 'tag' } });
    const grid = buildBoardGrid(tagLanes, ctx, many, tagLanes.filter);
    expect(cellPageSize(grid)).toBe(20);
    expect(cellPageSize(grid, { budget: 30 })).toBe(5); // never below the minimum
    expect(cellPageSize(grid, { budget: 3000 })).toBe(50); // never above a page
    // Collapsed lanes / columns render no cards and don't take a share.
    const collapsed = cfg({
      columns: { groupBy: 'status' },
      swimlanes: { groupBy: 'tag', prefs: { tag: { order: [], hidden: [], collapsed: ['30', '31'], wipLimits: {} } } },
    });
    expect(cellPageSize(buildBoardGrid(collapsed, ctx, many, collapsed.filter))).toBe(50);
  });

  it('editable groups ignore quick filters (the editor lists every saved group)', () => {
    const config = cfg({ columns: { groupBy: 'priority', prefs: { priority: { order: ['0', '1', '2', '3', '4'], hidden: [], collapsed: [], wipLimits: {} } } } });
    const quickFiltered: TaskFilter = { ...config.filter, priorities: [3, 4] };
    const grid = buildBoardGrid(config, ctx, [], quickFiltered);
    expect(grid.columns.map((g) => g.key)).toEqual(['3', '4']);
    const edit = editableGroups(config, ctx, [], config.filter, grid.hasLanes);
    expect(edit.columns.map((g) => g.key)).toEqual(['0', '1', '2', '3', '4']);
    expect(edit.lanes.map((g) => g.key)).toEqual([NO_LANE]);
    const tagLanes = cfg({ columns: { groupBy: 'status' }, swimlanes: { groupBy: 'tag' } });
    const tagGrid = buildBoardGrid(tagLanes, ctx, [], { ...tagLanes.filter, tagIds: [30], tagMode: 'any' });
    expect(tagGrid.lanes.map((g) => g.key)).toEqual(['30']);
    expect(editableGroups(tagLanes, ctx, [], tagLanes.filter, true).lanes.map((g) => g.key)).toEqual(['32', '30', '31', 'none']);
  });

  it('"Show" for hidden groups opens the axis that is hiding tasks', () => {
    // Hidden column on a board with lanes → Columns (not Lanes).
    const colHidden = cfg({
      columns: { groupBy: 'status', prefs: { status: { order: [], hidden: ['3'], collapsed: [], wipLimits: {} } } },
      swimlanes: { groupBy: 'epic' },
    });
    expect(hiddenGroupsAxis(buildBoardGrid(colHidden, ctx, tasks, colHidden.filter))).toBe('columns');
    const laneHidden = cfg({ swimlanes: { groupBy: 'epic', prefs: { epic: { order: [], hidden: ['20'], collapsed: [], wipLimits: {} } } } });
    expect(hiddenGroupsAxis(buildBoardGrid(laneHidden, ctx, tasks, laneHidden.filter))).toBe('swimlanes');
    // 'none' switched off on the columns axis counts as hidden too.
    const noNone = cfg({ columns: { groupBy: 'epic', showNone: false }, swimlanes: { groupBy: 'priority' } });
    expect(hiddenGroupsAxis(buildBoardGrid(noNone, ctx, tasks, noNone.filter))).toBe('columns');
    const flatBoard = cfg({ columns: { groupBy: 'epic', showNone: false } });
    expect(hiddenGroupsAxis(buildBoardGrid(flatBoard, ctx, tasks, flatBoard.filter))).toBe('columns');
  });

  it('honours showUnmatched for custom columns', () => {
    const custom = [col('urgent', 'Urgent', { priorities: [4] }, { priority: 4 })];
    const config = cfg({ columns: { groupBy: 'custom', custom, showUnmatched: false } });
    const grid = buildBoardGrid(config, ctx, [task({ priority: 4 }), task({ priority: 1 })], config.filter);
    expect(grid.visibleColumns.map((c) => c.key)).toEqual(['urgent']);
    expect(grid.hiddenTaskCount).toBe(1);
  });
});

// ---- Drop patches (SPEC §8.2 table) ---------------------------------------------------------------------

describe('computeDropPatch — per field', () => {
  const at = (lane: string, c: string) => ({ lane, col: c });
  const flat = (c: string) => at(NO_LANE, c);
  const drop = (config: BoardConfig, t: TaskDTO, from: { lane: string; col: string }, to: { lane: string; col: string }) =>
    computeDropPatch(config, ctx, t, from, to);

  it('status → statusId', () => {
    const t = task({ statusId: 2 });
    expect(drop(cfg(), t, flat('2'), flat('5'))).toEqual({ statusId: 5 });
    expect(drop(cfg(), t, flat('2'), flat('99'))).toBeNull();
  });

  it('statusCategory → first status of the category by position', () => {
    const c = cfg({ columns: { groupBy: 'statusCategory' } });
    expect(drop(c, task(), flat('unstarted'), flat('started'))).toEqual({ statusId: 3 });
    expect(drop(c, task(), flat('unstarted'), flat('cancelled'))).toEqual({ statusId: 6 });
  });

  it('statusCategory → the first status of the category the board filter allows', () => {
    // "In progress" exists because Review (4) is in the filter; Doing (3) is not, so a drop must pick Review.
    const c = cfg({ filter: { statusIds: [2, 4] }, columns: { groupBy: 'statusCategory' } });
    expect(drop(c, task({ statusId: 2 }), flat('unstarted'), flat('started'))).toEqual({ statusId: 4 });
    expect(drop(c, task({ statusId: 4 }), flat('started'), flat('unstarted'))).toEqual({ statusId: 2 });
    // No allowed status in the category: fall back to the first by position.
    expect(drop(c, task({ statusId: 2 }), flat('unstarted'), flat('completed'))).toEqual({ statusId: 5 });
    const lanes = cfg({ filter: { statusIds: [4] }, columns: { groupBy: 'priority' }, swimlanes: { groupBy: 'statusCategory' } });
    expect(drop(lanes, task({ statusId: 2 }), { lane: 'unstarted', col: '0' }, { lane: 'started', col: '0' })).toEqual({ statusId: 4 });
  });

  it('priority → priority (including "no priority")', () => {
    const c = cfg({ columns: { groupBy: 'priority' } });
    expect(drop(c, task({ priority: 2 }), flat('2'), flat('4'))).toEqual({ priority: 4 });
    expect(drop(c, task({ priority: 2 }), flat('2'), flat('0'))).toEqual({ priority: 0 });
  });

  it('project → projectId (the server clears the epic)', () => {
    const c = cfg({ columns: { groupBy: 'project' } });
    expect(drop(c, task({ epicId: 20 }), flat('1'), flat('2'))).toEqual({ projectId: 2 });
  });

  it('epic → epicId, none → null', () => {
    const c = cfg({ columns: { groupBy: 'epic' } });
    expect(drop(c, task({ epicId: 20 }), flat('20'), flat('22'))).toEqual({ epicId: 22 });
    expect(drop(c, task({ epicId: 20 }), flat('20'), flat('none'))).toEqual({ epicId: null });
    // An epic of another project moves the task there.
    expect(drop(c, task({ epicId: 20 }), flat('20'), flat('23'))).toEqual({ epicId: 23 });
  });

  it('milestone → not droppable across groups, reorder only', () => {
    const c = cfg({ columns: { groupBy: 'milestone' } });
    const t = task({ epicId: 20 });
    expect(drop(c, t, flat('10'), flat('12'))).toBeNull();
    expect(drop(c, t, flat('10'), flat('none'))).toBeNull();
    expect(drop(c, t, flat('10'), flat('10'))).toEqual({});
  });

  it('tag → replace the source tag, add from none, clear into none', () => {
    const c = cfg({ columns: { groupBy: 'tag' } });
    const t = task({ tags: [ref(BUG), ref(IDEA)] });
    expect(drop(c, t, flat('30'), flat('32'))).toEqual({ removeTagIds: [30], addTagIds: [32] });
    expect(drop(c, t, flat('30'), flat('none'))).toEqual({ tagIds: [] });
    expect(drop(c, task(), flat('none'), flat('31'))).toEqual({ addTagIds: [31] });
    expect(drop(c, t, flat('30'), flat('77'))).toBeNull();
  });

  it('due → bucket drop date; past / overdue / later are not droppable', () => {
    const c = cfg({ columns: { groupBy: 'due' } });
    const t = task({ dueDate: '2026-10-26' });
    expect(drop(c, t, flat('later'), flat('today'))).toEqual({ dueDate: '2026-10-14' });
    expect(drop(c, t, flat('later'), flat('tomorrow'))).toEqual({ dueDate: '2026-10-15' });
    expect(drop(c, t, flat('later'), flat('this_week'))).toEqual({ dueDate: '2026-10-18' });
    expect(drop(c, t, flat('later'), flat('next_week'))).toEqual({ dueDate: '2026-10-19' });
    expect(drop(c, t, flat('later'), flat('no_date'))).toEqual({ dueDate: null });
    expect(drop(c, task(), flat('no_date'), flat('overdue'))).toBeNull();
    expect(drop(c, task(), flat('no_date'), flat('past'))).toBeNull();
    expect(drop(c, task(), flat('no_date'), flat('later'))).toBeNull();
  });

  it('due → not droppable when the new due date would precede the start date', () => {
    const c = cfg({ columns: { groupBy: 'due' } });
    expect(drop(c, task({ startDate: '2026-10-16' }), flat('no_date'), flat('today'))).toBeNull();
    expect(drop(c, task({ startDate: '2026-10-16' }), flat('no_date'), flat('this_week'))).toEqual({ dueDate: '2026-10-18' });
  });

  it('custom → resolved onDrop, removing the source column tags; __other / null onDrop not droppable; {} reorder only', () => {
    const custom = [
      col('blocked', 'Blocked', { tagIds: [32] }, { addTagIds: [32] }),
      col('now', 'Now', { priorities: [4, 3] }, { priority: 4, due: 'tomorrow' }),
      col('review', 'Review', { tagIds: [31] }, { addTagIds: [31, 30] }),
      col('static', 'Static', { priorities: [2] }, null),
      col('reorder', 'Reorder', { priorities: [1] }, {}),
    ];
    const c = cfg({ columns: { groupBy: 'custom', custom } });
    const t = task({ tags: [ref(BLOCKED)] });
    expect(drop(c, t, flat('blocked'), flat('now'))).toEqual({ priority: 4, dueDate: '2026-10-15', removeTagIds: [32] });
    expect(drop(c, t, flat('__other'), flat('now'))).toEqual({ priority: 4, dueDate: '2026-10-15' });
    expect(drop(c, t, flat('review'), flat('blocked'))).toEqual({ addTagIds: [32], removeTagIds: [31, 30] });
    expect(drop(c, t, flat('blocked'), flat('review'))).toEqual({ addTagIds: [31, 30], removeTagIds: [32] });
    expect(drop(c, t, flat('now'), flat('__other'))).toBeNull();
    expect(drop(c, t, flat('now'), flat('static'))).toBeNull();
    expect(drop(c, t, flat('now'), flat('reorder'))).toBeNull(); // would change nothing
    expect(drop(c, t, flat('blocked'), flat('reorder'))).toEqual({ removeTagIds: [32] });
    expect(drop(c, t, flat('reorder'), flat('reorder'))).toEqual({});
    expect(drop(c, t, flat('now'), flat('gone'))).toBeNull();
  });

  it('custom → still returns the patch when the task would land elsewhere (caller toasts)', () => {
    const custom = [col('urgent', 'Urgent', { priorities: [4] }, { priority: 4 }), col('mine', 'Mine', { projectIds: [2] }, { priority: 1 })];
    const c = cfg({ columns: { groupBy: 'custom', custom } });
    const t = task({ priority: 4, projectId: 1 });
    const patch = drop(c, task({ projectId: 2, priority: 4 }), flat('urgent'), flat('mine'));
    expect(patch).toEqual({ priority: 1 });
    expect(landingCustomGroup({ ...t, projectId: 2, priority: 1 }, c.columns, ctx)).toBe('mine');
    expect(landingCustomGroup({ ...t, priority: 4 }, c.columns, ctx)).toBe('urgent');
  });

  it('move toast names the new ref after a move to another project', () => {
    const message = withNewRef({ ref: 'WEB-5' }, 'Moved WEB-5 to Personal · Urgent');
    expect(message({ ref: 'ME-5' })).toBe('Moved WEB-5 to Personal · Urgent (now ME-5)');
    expect(message({ ref: 'WEB-5' })).toBe('Moved WEB-5 to Personal · Urgent');
  });

  it('landing message: overlapping custom groups keep the card in an earlier group', () => {
    const custom = [col('urgent', 'Urgent', { priorities: [4] }, { priority: 4 }), col('bugs', 'Bugs', { tagIds: [30] }, { addTagIds: [30] })];
    const c = cfg({ columns: { groupBy: 'custom', custom }, swimlanes: { groupBy: 'custom', custom: [col('l1', 'Mine', { projectIds: [1] }, { projectId: 1 })] } });
    const t = task({ priority: 4, projectId: 1 });
    const grid = buildBoardGrid(c, ctx, [t], c.filter, 'list');
    const patch = drop(c, t, flat('urgent'), flat('bugs'));
    expect(patch).toEqual({ addTagIds: [30] });
    const patched = { ...t, tags: [ref(BUG)] };
    expect(customLandingMessage(c, ctx, grid, patched, flat('urgent'), flat('bugs'))).toBe('Moved — it now matches “Urgent”');
    // Lands as asked → no message (the caller says "Moved to …").
    const plain = { ...t, priority: 1 as const, tags: [ref(BUG)] };
    expect(customLandingMessage(c, ctx, grid, plain, flat('urgent'), flat('bugs'))).toBeNull();
    // Unmatched → "Other"; same column → nothing to check.
    expect(customLandingMessage(c, ctx, grid, { ...t, priority: 1 }, flat('urgent'), flat('bugs'))).toBe('Moved — it now matches “Other”');
    expect(customLandingMessage(c, ctx, grid, t, flat('urgent'), flat('urgent'))).toBeNull();
    // Non-custom axes never produce a message.
    const status = cfg();
    expect(customLandingMessage(status, ctx, buildBoardGrid(status, ctx, [t], status.filter), t, flat('2'), flat('3'))).toBeNull();
  });

  it('same cell → {} (reorder only)', () => {
    expect(drop(cfg(), task(), flat('2'), flat('2'))).toEqual({});
  });
});

describe('computeDropPatch — combinations', () => {
  const at = (lane: string, c: string) => ({ lane, col: c });

  it('status columns × epic lanes: both axes contribute', () => {
    const c = cfg({ columns: { groupBy: 'status' }, swimlanes: { groupBy: 'epic' } });
    const t = task({ statusId: 2, epicId: 20 });
    expect(computeDropPatch(c, ctx, t, at('20', '2'), at('22', '3'))).toEqual({ statusId: 3, epicId: 22 });
    expect(computeDropPatch(c, ctx, t, at('20', '2'), at('20', '3'))).toEqual({ statusId: 3 });
    expect(computeDropPatch(c, ctx, t, at('20', '2'), at('none', '2'))).toEqual({ epicId: null });
  });

  it('a non-droppable changed axis makes the cell non-droppable', () => {
    const c = cfg({ columns: { groupBy: 'status' }, swimlanes: { groupBy: 'milestone' } });
    const t = task({ statusId: 2, epicId: 20 });
    expect(computeDropPatch(c, ctx, t, at('10', '2'), at('12', '3'))).toBeNull();
    expect(computeDropPatch(c, ctx, t, at('10', '2'), at('10', '3'))).toEqual({ statusId: 3 });
  });

  it('epic columns × project lanes: none inside a project lane pins the project; mismatched cells are not droppable', () => {
    const c = cfg({ columns: { groupBy: 'epic' }, swimlanes: { groupBy: 'project' } });
    const t = task({ epicId: 20 });
    expect(computeDropPatch(c, ctx, t, at('1', '20'), at('1', 'none'))).toEqual({ projectId: 1, epicId: null });
    expect(computeDropPatch(c, ctx, t, at('1', '20'), at('2', 'none'))).toEqual({ projectId: 2, epicId: null });
    expect(computeDropPatch(c, ctx, t, at('1', '20'), at('1', '22'))).toEqual({ projectId: 1, epicId: 22 });
    expect(computeDropPatch(c, ctx, t, at('1', '20'), at('2', '23'))).toEqual({ projectId: 2, epicId: 23 });
    // projectId together with an epic of a different project
    expect(computeDropPatch(c, ctx, t, at('1', '20'), at('1', '23'))).toBeNull();
    expect(computeDropPatch(c, ctx, t, at('1', '20'), at('2', '22'))).toBeNull();
    // the epic column stays but the lane changes: the task would lose its epic → not that cell
    expect(computeDropPatch(c, ctx, t, at('1', '20'), at('2', '20'))).toBeNull();
    const noEpic = task();
    expect(computeDropPatch(c, ctx, noEpic, at('1', 'none'), at('2', 'none'))).toEqual({ projectId: 2 });
  });

  it('project columns × epic lanes behave the same way', () => {
    const c = cfg({ columns: { groupBy: 'project' }, swimlanes: { groupBy: 'epic' } });
    const t = task({ epicId: 22 });
    expect(computeDropPatch(c, ctx, t, at('22', '1'), at('23', '2'))).toEqual({ projectId: 2, epicId: 23 });
    expect(computeDropPatch(c, ctx, t, at('22', '1'), at('23', '1'))).toBeNull();
  });

  it('epic columns × milestone lanes: an epic of another milestone is not droppable in this lane', () => {
    const c = cfg({ columns: { groupBy: 'epic' }, swimlanes: { groupBy: 'milestone' } });
    const t = task({ epicId: 22 });
    expect(computeDropPatch(c, ctx, t, at('none', '22'), at('none', '20'))).toBeNull();
    expect(computeDropPatch(c, ctx, task({ epicId: 20 }), at('10', '20'), at('10', '20'))).toEqual({});
  });

  it('the same field set twice: conflicting values are not droppable, equal values are', () => {
    const custom = [col('done', 'Done', { statusIds: [5] }, { statusId: 5 }), col('doing', 'Doing', { statusIds: [3] }, { statusId: 3 })];
    const c = cfg({ columns: { groupBy: 'custom', custom }, swimlanes: { groupBy: 'status' } });
    const t = task({ statusId: 3 });
    expect(computeDropPatch(c, ctx, t, at('3', 'doing'), at('2', 'done'))).toBeNull();
    expect(computeDropPatch(c, ctx, t, at('3', 'doing'), at('5', 'done'))).toEqual({ statusId: 5 });
    // only the column changes: the unchanged lane contributes nothing
    expect(computeDropPatch(c, ctx, t, at('3', 'doing'), at('3', 'done'))).toEqual({ statusId: 5 });
  });

  it('tag swaps combined with tag-setting custom lanes are not droppable', () => {
    const custom = [col('flag', 'Flagged', { tagIds: [32] }, { addTagIds: [32] }), col('rest', 'Rest', {}, {})];
    const c = cfg({ columns: { groupBy: 'tag' }, swimlanes: { groupBy: 'custom', custom } });
    const t = task({ tags: [ref(BUG)] });
    expect(computeDropPatch(c, ctx, t, at('rest', '30'), at('flag', '31'))).toBeNull();
    expect(computeDropPatch(c, ctx, t, at('rest', '30'), at('flag', '30'))).toEqual({ addTagIds: [32] });
    expect(computeDropPatch(c, ctx, t, at('rest', '30'), at('rest', '31'))).toEqual({ removeTagIds: [30], addTagIds: [31] });
    expect(computeDropPatch(c, ctx, t, at('flag', '30'), at('rest', 'none'))).toBeNull(); // tagIds [] + removeTagIds
  });

  it('priority columns × custom lanes with due dates combine', () => {
    const custom = [col('soon', 'Soon', { due: ['next_7_days'] }, { due: 'today' }), col('rest', 'Rest', {}, {})];
    const c = cfg({ columns: { groupBy: 'priority' }, swimlanes: { groupBy: 'custom', custom } });
    expect(computeDropPatch(c, ctx, task({ priority: 1 }), at('rest', '1'), at('soon', '3'))).toEqual({ priority: 3, dueDate: '2026-10-14' });
  });

  it('ignores lanes without swimlanes and with lane keys of list layout', () => {
    const c = cfg({ columns: { groupBy: 'status' }, swimlanes: { groupBy: 'epic' } });
    expect(computeDropPatch(c, ctx, task({ epicId: 20 }), at(NO_LANE, '2'), at(NO_LANE, '3'))).toEqual({ statusId: 3 });
    const plain = cfg();
    expect(computeDropPatch(plain, ctx, task(), at('x', '2'), at('y', '3'))).toEqual({ statusId: 3 });
  });

  it('a custom drop patch with an epic of another project than its projectId is not droppable', () => {
    const custom = [col('bad', 'Bad', {}, { projectId: 2, epicId: 20 }), col('ok', 'Ok', {}, { projectId: 2, epicId: 23 })];
    const c = cfg({ columns: { groupBy: 'custom', custom } });
    expect(computeDropPatch(c, ctx, task(), at(NO_LANE, '__other'), at(NO_LANE, 'bad'))).toBeNull();
    expect(computeDropPatch(c, ctx, task(), at(NO_LANE, '__other'), at(NO_LANE, 'ok'))).toEqual({ projectId: 2, epicId: 23 });
  });
});

describe('predictStructure', () => {
  it('mirrors the server rules for project / epic moves', () => {
    const l = ctx.lookups;
    expect(predictStructure(task({ epicId: 20 }), { projectId: 2 }, l)).toEqual({ projectId: 2, epicId: null, milestoneId: null });
    expect(predictStructure(task(), { epicId: 23 }, l)).toEqual({ projectId: 2, epicId: 23, milestoneId: 12 });
    expect(predictStructure(task(), { projectId: 1, epicId: 23 }, l)).toBeNull();
    expect(predictStructure(task(), { epicId: 999 }, l)).toBeNull();
  });
});

// ---- Ordering ----------------------------------------------------------------------------------------

describe('manual order', () => {
  const a = task({ id: 201 });
  const b = task({ id: 202 });
  const m = task({ id: 203 });

  it('dropPosition: asc after the card above / before the one below; desc reversed; non-manual none', () => {
    const asc = { field: 'manual', dir: 'asc' } as const;
    const desc = { field: 'manual', dir: 'desc' } as const;
    expect(dropPosition(asc, a, b)).toEqual({ afterId: 201, beforeId: 202 });
    expect(dropPosition(asc, null, b)).toEqual({ afterId: null, beforeId: 202 });
    expect(dropPosition(asc, a, null)).toEqual({ afterId: 201, beforeId: null });
    expect(dropPosition(desc, a, b)).toEqual({ afterId: 202, beforeId: 201 });
    expect(dropPosition(desc, null, b)).toEqual({ afterId: 202, beforeId: null });
    expect(dropPosition(desc, a, null)).toEqual({ afterId: null, beforeId: 201 });
    expect(dropPosition(asc, null, null)).toBeUndefined();
    expect(dropPosition({ field: 'priority', dir: 'desc' }, a, b)).toBeUndefined();
  });

  it('insertionNeighbours: skips the moving card and detects no-op drops', () => {
    const list = [a, m, b];
    expect(insertionNeighbours(list, 0, m.id)).toEqual({ above: null, below: a, changed: true });
    expect(insertionNeighbours(list, 1, m.id)).toEqual({ above: a, below: b, changed: false });
    expect(insertionNeighbours(list, 2, m.id)).toEqual({ above: a, below: b, changed: false });
    expect(insertionNeighbours(list, 3, m.id)).toEqual({ above: b, below: null, changed: true });
    expect(insertionNeighbours([a, b], 1, m.id)).toEqual({ above: a, below: b, changed: true });
    expect(insertionNeighbours([], 0, m.id)).toEqual({ above: null, below: null, changed: true });
    expect(insertionNeighbours([a, b], 9, m.id)).toEqual({ above: b, below: null, changed: true });
  });
});

// ---- Quick add ---------------------------------------------------------------------------------------

describe('cellCreateDefaults', () => {
  it('status column × epic lane → status, epic and the epic’s project', () => {
    const c = cfg({ columns: { groupBy: 'status' }, swimlanes: { groupBy: 'epic' } });
    expect(cellCreateDefaults(c, ctx, { lane: '23', col: '3' }, null)).toEqual({ statusId: 3, epicId: 23, projectId: 2 });
    expect(cellCreateDefaults(c, ctx, { lane: 'none', col: '3' }, null)).toEqual({ statusId: 3 });
  });

  it('priority / tag / due / project / category columns', () => {
    expect(cellCreateDefaults(cfg({ columns: { groupBy: 'priority' } }), ctx, { lane: NO_LANE, col: '0' }, null)).toEqual({ priority: 0 });
    expect(cellCreateDefaults(cfg({ columns: { groupBy: 'tag' } }), ctx, { lane: NO_LANE, col: '31' }, null)).toEqual({ tagIds: [31] });
    expect(cellCreateDefaults(cfg({ columns: { groupBy: 'tag' } }), ctx, { lane: NO_LANE, col: 'none' }, null)).toEqual({});
    expect(cellCreateDefaults(cfg({ columns: { groupBy: 'due' } }), ctx, { lane: NO_LANE, col: 'tomorrow' }, null)).toEqual({ dueDate: '2026-10-15' });
    expect(cellCreateDefaults(cfg({ columns: { groupBy: 'due' } }), ctx, { lane: NO_LANE, col: 'overdue' }, null)).toEqual({});
    expect(cellCreateDefaults(cfg({ columns: { groupBy: 'project' } }), ctx, { lane: NO_LANE, col: '2' }, null)).toEqual({ projectId: 2 });
    expect(cellCreateDefaults(cfg({ columns: { groupBy: 'statusCategory' } }), ctx, { lane: NO_LANE, col: 'started' }, null)).toEqual({ statusId: 3 });
  });

  it('category columns pick a status the board filter allows', () => {
    const c = cfg({ filter: { statusIds: [2, 4] }, columns: { groupBy: 'statusCategory' } });
    expect(cellCreateDefaults(c, ctx, { lane: NO_LANE, col: 'started' }, null)).toEqual({ statusId: 4 });
    expect(cellCreateDefaults(c, ctx, { lane: NO_LANE, col: 'started' }, null, { statusIds: [3, 4] })).toEqual({ statusId: 3 });
  });

  it('custom columns use their drop patch (tags = addTagIds)', () => {
    const custom = [col('x', 'X', {}, { statusId: 4, priority: 3, addTagIds: [30, 999], due: 'today', epicId: 22 })];
    const c = cfg({ columns: { groupBy: 'custom', custom } });
    expect(cellCreateDefaults(c, ctx, { lane: NO_LANE, col: 'x' }, null)).toEqual({
      statusId: 4,
      priority: 3,
      dueDate: '2026-10-14',
      epicId: 22,
      projectId: 1,
      tagIds: [30],
    });
    expect(cellCreateDefaults(c, ctx, { lane: NO_LANE, col: '__other' }, null)).toEqual({});
  });

  it('project from the lane, else the board project, else a single filtered project', () => {
    const c = cfg({ columns: { groupBy: 'status' }, swimlanes: { groupBy: 'project' } });
    expect(cellCreateDefaults(c, ctx, { lane: '2', col: '2' }, null)).toEqual({ statusId: 2, projectId: 2 });
    expect(cellCreateDefaults(cfg(), ctx, { lane: NO_LANE, col: '2' }, 1)).toEqual({ statusId: 2, projectId: 1 });
    const filtered = cfg({ filter: { projectIds: [2] } });
    expect(cellCreateDefaults(filtered, ctx, { lane: NO_LANE, col: '2' }, null)).toEqual({ statusId: 2, projectId: 2 });
    const two = cfg({ filter: { projectIds: [1, 2] } });
    expect(cellCreateDefaults(two, ctx, { lane: NO_LANE, col: '2' }, null)).toEqual({ statusId: 2 });
  });

  it('drops an epic that conflicts with the lane project', () => {
    const c = cfg({ columns: { groupBy: 'epic' }, swimlanes: { groupBy: 'project' } });
    expect(cellCreateDefaults(c, ctx, { lane: '2', col: '20' }, null)).toEqual({ projectId: 2 });
    expect(cellCreateDefaults(c, ctx, { lane: '1', col: '20' }, null)).toEqual({ epicId: 20, projectId: 1 });
  });
});

// ---- Small helpers -------------------------------------------------------------------------------------

describe('ids and prefs helpers', () => {
  it('round-trips card dnd ids', () => {
    expect(cardDndId('20', '3', 42)).toBe('20|3|42');
    expect(parseCardDndId('20|3|42')).toEqual({ lane: '20', col: '3', taskId: 42 });
    expect(parseCardDndId(cardDndId(NO_LANE, '__other', 7))).toEqual({ lane: NO_LANE, col: '__other', taskId: 7 });
    expect(parseCardDndId('cell:1|2')).toBeNull();
    expect(parseCardDndId('a|b|c')).toBeNull();
    expect(cellKey('a', 'b')).toBe('a|b');
  });

  it('toggles keys', () => {
    expect(toggleKey(['a'], 'b', true)).toEqual(['a', 'b']);
    expect(toggleKey(['a', 'b'], 'a', false)).toEqual(['b']);
    expect(toggleKey(['a'], 'a', true)).toEqual(['a']);
  });
});
