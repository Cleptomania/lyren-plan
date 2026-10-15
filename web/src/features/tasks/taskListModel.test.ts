import { describe, expect, it } from 'vitest';
import { LIMITS } from '@shared/constants';
import { buildFilterContext, matchesTaskFilter } from '@shared/filter';
import { taskQueryInput, type TaskFilter } from '@shared/schemas';
import type { TaskDTO } from '@shared/types';
import { epic, milestone, project, status, task } from '../../components/domain/fixtures.test-utils';
import {
  applySelection,
  archiveTargets,
  commonProjectId,
  effectiveTaskFilter,
  groupByChoices,
  groupCreatePatch,
  groupLabel,
  groupTasks,
  hiddenTaskCounts,
  hiddenTaskProbes,
  hiddenTasksMessage,
  initialShowArchived,
  initialShowClosed,
  pruneSelection,
  quickAddDefaults,
  serverTaskFilter,
  type GroupContext,
  type TaskListLookups,
} from './taskListModel';

function lookups(): TaskListLookups {
  // Positions deliberately differ from ids to prove ordering uses the lookups' order.
  const statuses = [status(3, 'backlog', 0), status(1, 'unstarted', 1), status(2, 'started', 2), status(4, 'completed', 3)];
  const projects = [project(2, 'TWO', { position: 0 }), project(1, 'ONE', { position: 1 })];
  const milestones = [milestone(20, 2, 0), milestone(10, 1, 0)];
  const epics = [epic(200, 2, 20, 0), epic(100, 1, null, 0), epic(101, 1, 10, 1)];
  return {
    statuses,
    statusById: new Map(statuses.map((s) => [s.id, s])),
    projects,
    projectById: new Map(projects.map((p) => [p.id, p])),
    milestones,
    milestoneById: new Map(milestones.map((m) => [m.id, m])),
    epics,
    epicById: new Map(epics.map((e) => [e.id, e])),
  };
}

const ctx: GroupContext = { lookups: lookups(), today: '2026-10-14', weekStartsOn: 1 }; // a Wednesday

let nextId = 1;
function t(extra: Partial<TaskDTO>): TaskDTO {
  const id = nextId++;
  return task({ id, ref: `T-${id}`, statusId: 1, ...extra });
}

const keys = (groups: { key: string; tasks: TaskDTO[] }[]) => groups.map((g) => g.key);
const ids = (groups: { key: string; tasks: TaskDTO[] }[]) => groups.map((g) => g.tasks.map((x) => x.id));

describe('groupTasks', () => {
  it('returns one group (or none) without grouping', () => {
    const a = t({});
    expect(groupTasks([a], 'none', ctx)).toEqual([{ key: 'none', tasks: [a] }]);
    expect(groupTasks([], 'none', ctx)).toEqual([]);
    expect(groupTasks([], 'status', ctx)).toEqual([]);
  });

  it('orders status groups by status position and keeps task order inside groups', () => {
    const a = t({ statusId: 2 });
    const b = t({ statusId: 3 });
    const c = t({ statusId: 2 });
    const d = t({ statusId: 1 });
    const groups = groupTasks([a, b, c, d], 'status', ctx);
    expect(keys(groups)).toEqual(['3', '1', '2']);
    expect(ids(groups)).toEqual([[b.id], [d.id], [a.id, c.id]]);
  });

  it('orders status categories canonically', () => {
    const groups = groupTasks([t({ statusId: 4 }), t({ statusId: 3 }), t({ statusId: 2 })], 'statusCategory', ctx);
    expect(keys(groups)).toEqual(['backlog', 'started', 'completed']);
  });

  it('orders priorities urgent first and "No priority" last', () => {
    const groups = groupTasks([t({ priority: 0 }), t({ priority: 2 }), t({ priority: 4 })], 'priority', ctx);
    expect(keys(groups)).toEqual(['4', '2', '0']);
  });

  it('orders projects, milestones and epics by lookups order with "none" last', () => {
    expect(keys(groupTasks([t({ projectId: 1 }), t({ projectId: 2 })], 'project', ctx))).toEqual(['2', '1']);
    const ms = groupTasks([t({ milestoneId: null }), t({ milestoneId: 10 }), t({ milestoneId: 20 })], 'milestone', ctx);
    expect(keys(ms)).toEqual(['20', '10', 'none']);
    const es = groupTasks([t({ epicId: null }), t({ epicId: 101 }), t({ epicId: 100 }), t({ epicId: 200 })], 'epic', ctx);
    expect(keys(es)).toEqual(['200', '100', '101', 'none']);
  });

  it('appends stale keys after known ones but before "none"', () => {
    const groups = groupTasks([t({ epicId: null }), t({ epicId: 999 }), t({ epicId: 100 })], 'epic', ctx);
    expect(keys(groups)).toEqual(['100', '999', 'none']);
  });

  it('buckets due dates in DUE_BUCKETS order; closed past-due tasks go to "past"', () => {
    const groups = groupTasks(
      [
        t({ dueDate: null }),
        t({ dueDate: '2026-10-30' }),
        t({ dueDate: '2026-10-15' }),
        t({ dueDate: '2026-10-14' }),
        t({ dueDate: '2026-10-01' }),
        t({ dueDate: '2026-10-02', statusId: 4 }),
        t({ dueDate: '2026-10-17' }),
        t({ dueDate: '2026-10-20' }),
      ],
      'due',
      ctx,
    );
    expect(keys(groups)).toEqual(['past', 'overdue', 'today', 'tomorrow', 'this_week', 'next_week', 'later', 'no_date']);
  });
});

describe('groupLabel', () => {
  const l = lookups();
  it('names groups for every field', () => {
    expect(groupLabel('status', '2', l)).toBe('S2');
    expect(groupLabel('statusCategory', 'unstarted', l)).toBe('To do');
    expect(groupLabel('priority', '4', l)).toBe('Urgent');
    expect(groupLabel('project', '1', l)).toBe('Project ONE');
    expect(groupLabel('milestone', 'none', l)).toBe('No milestone');
    expect(groupLabel('epic', 'none', l)).toBe('No epic');
    expect(groupLabel('epic', '100', l)).toBe('E100');
    expect(groupLabel('epic', '999', l)).toBe('Unknown epic');
    expect(groupLabel('due', 'this_week', l)).toBe('Later this week');
  });
});

describe('groupCreatePatch / quickAddDefaults', () => {
  it('derives the fields that put a new task into a group', () => {
    expect(groupCreatePatch('none', 'none', ctx)).toEqual({});
    expect(groupCreatePatch('status', '2', ctx)).toEqual({ statusId: 2 });
    expect(groupCreatePatch('status', '99', ctx)).toBeNull();
    expect(groupCreatePatch('statusCategory', 'completed', ctx)).toEqual({ statusId: 4 });
    expect(groupCreatePatch('statusCategory', 'cancelled', ctx)).toBeNull();
    expect(groupCreatePatch('priority', '3', ctx)).toEqual({ priority: 3 });
    expect(groupCreatePatch('project', '1', ctx)).toEqual({ projectId: 1 });
    expect(groupCreatePatch('epic', '200', ctx)).toEqual({ epicId: 200, projectId: 2 });
    expect(groupCreatePatch('epic', 'none', ctx)).toEqual({ epicId: null });
    expect(groupCreatePatch('milestone', '10', ctx)).toBeNull();
    expect(groupCreatePatch('milestone', 'none', ctx)).toEqual({ epicId: null });
    expect(groupCreatePatch('due', 'today', ctx)).toEqual({ dueDate: '2026-10-14' });
    expect(groupCreatePatch('due', 'no_date', ctx)).toEqual({ dueDate: null });
    expect(groupCreatePatch('due', 'overdue', ctx)).toBeNull();
    expect(groupCreatePatch('due', 'later', ctx)).toBeNull();
  });

  it('resolves the project and drops a mismatching epic', () => {
    const l = lookups();
    expect(quickAddDefaults({ projectId: 1 }, { statusId: 2 }, {}, l)).toEqual({ projectId: 1, statusId: 2 });
    expect(quickAddDefaults({}, {}, { projectIds: [2] }, l)).toEqual({ projectId: 2 });
    expect(quickAddDefaults({}, {}, { projectIds: [1, 2] }, l)).toEqual({});
    expect(quickAddDefaults({ epicId: 100 }, {}, {}, l)).toEqual({ epicId: 100, projectId: 1 });
    // Grouped by project: the default epic belongs to another project.
    expect(quickAddDefaults({ projectId: 1, epicId: 100 }, { projectId: 2 }, {}, l)).toEqual({ projectId: 2 });
    // Grouped by epic: the epic decides the project.
    expect(quickAddDefaults({ projectId: 1 }, { epicId: 200, projectId: 2 }, {}, l)).toEqual({ projectId: 2, epicId: 200 });
    expect(quickAddDefaults({ projectId: 999 }, {}, {}, l)).toEqual({});
  });
});

describe('filters', () => {
  it('adds the toolbar search and the closed toggle', () => {
    const base = { projectIds: [1], search: 'foo', closedWithinDays: 7 };
    expect(effectiveTaskFilter(base, { enabled: false, search: 'x', showClosed: false })).toBe(base);
    expect(effectiveTaskFilter(base, { enabled: true, search: ' bar ', showClosed: false })).toEqual({
      projectIds: [1],
      search: 'foo bar',
      closedWithinDays: 0,
    });
    expect(effectiveTaskFilter({ projectIds: [1] }, { enabled: true, search: '', showClosed: true })).toEqual({ projectIds: [1] });
  });

  it('keeps the query search within the API limit (whole tokens), matching the rest locally', () => {
    const saved = 'a'.repeat(150);
    const typed = `${'b'.repeat(30)} ${'c'.repeat(29)}`; // 60 characters
    const full = effectiveTaskFilter({ search: saved }, { enabled: true, search: typed, showClosed: true });
    expect(full.search).toBe(`${saved} ${typed}`); // the full search still filters locally
    expect(full.search!.length).toBeGreaterThan(LIMITS.searchMax);
    const server = serverTaskFilter(full);
    expect(server.search).toBe(`${saved} ${'b'.repeat(30)}`);
    expect(server.search!.length).toBeLessThanOrEqual(LIMITS.searchMax);
    expect(taskQueryInput.safeParse({ filter: server }).success).toBe(true);
    expect(taskQueryInput.safeParse({ filter: full }).success).toBe(false);
    // Short searches go through unchanged (same object).
    const short = { projectIds: [1], search: 'foo bar' };
    expect(serverTaskFilter(short)).toBe(short);
    expect(serverTaskFilter({})).toEqual({});
    // Repeated tokens are sent once.
    const repeated = serverTaskFilter({ search: `${'x'.repeat(120)} ${'X'.repeat(120)} yy` });
    expect(repeated.search).toBe(`${'x'.repeat(120)} yy`);
    // A single over-long token (not producible by the UI) is cut to a prefix.
    expect(serverTaskFilter({ search: 'z'.repeat(250) }).search).toBe('z'.repeat(LIMITS.searchMax));
  });

  it('adds the archived toggle, with or without a toolbar', () => {
    const base = { projectIds: [1] };
    expect(effectiveTaskFilter(base, { enabled: true, search: '', showClosed: true, showArchived: true })).toEqual({
      projectIds: [1],
      archived: 'include',
    });
    // Off is the default mode, left out so the query key matches lists without the toggle.
    expect(effectiveTaskFilter(base, { enabled: true, search: '', showClosed: true, showArchived: false })).toEqual(base);
    expect(
      effectiveTaskFilter({ ...base, archived: 'include' }, { enabled: true, search: '', showClosed: true, showArchived: false }),
    ).toEqual(base);
    // An archived-only filter stays archived-only.
    expect(
      effectiveTaskFilter({ archived: 'only' }, { enabled: true, search: '', showClosed: true, showArchived: true }).archived,
    ).toBe('only');
    // Omitted: the filter's own mode.
    expect(effectiveTaskFilter({ archived: 'include' }, { enabled: true, search: '', showClosed: true }).archived).toBe('include');
    // Without a toolbar only "Show archived" applies (turned on from the empty state)…
    const own = { projectIds: [1], closedWithinDays: 7 };
    expect(effectiveTaskFilter(own, { enabled: false, search: 'x', showClosed: false, showArchived: true })).toEqual({
      ...own,
      archived: 'include',
    });
    // …and the caller's filter is passed through untouched while it is at its default.
    expect(effectiveTaskFilter(own, { enabled: false, search: 'x', showClosed: false, showArchived: false })).toBe(own);
    expect(taskQueryInput.safeParse({ filter: effectiveTaskFilter(own, { enabled: false, search: '', showClosed: false, showArchived: true }) }).success).toBe(true);
  });

  it('shows archived tasks initially only when the filter asks for them', () => {
    expect(initialShowArchived({})).toBe(false);
    expect(initialShowArchived({ archived: 'exclude' })).toBe(false);
    expect(initialShowArchived({ archived: 'include' })).toBe(true);
    expect(initialShowArchived({ archived: 'only' })).toBe(true);
  });

  it('shows closed tasks initially only for closed-only filters', () => {
    expect(initialShowClosed({})).toBe(false);
    expect(initialShowClosed({ statusCategories: ['completed', 'cancelled'] })).toBe(true);
    expect(initialShowClosed({ statusCategories: ['completed', 'started'] })).toBe(false);
  });

  it('offers only meaningful groupings', () => {
    expect(groupByChoices({ projectIds: [1] })).not.toContain('project');
    expect(groupByChoices({ projectIds: [1, 2] })).toContain('project');
    expect(groupByChoices({ epicIds: [5] })).not.toContain('epic');
    expect(groupByChoices({ epicIds: [null] })).toContain('epic');
  });
});

describe('selection', () => {
  const order = [1, 2, 3, 4, 5];
  it('toggles one id', () => {
    expect([...applySelection(new Set([1]), order, null, 3, true, false)]).toEqual([1, 3]);
    expect([...applySelection(new Set([1, 3]), order, 1, 3, false, false)]).toEqual([1]);
  });

  it('selects / clears a range with shift', () => {
    expect([...applySelection(new Set([2]), order, 2, 4, true, true)].sort()).toEqual([2, 3, 4]);
    expect([...applySelection(new Set([1, 2, 3, 4, 5]), order, 4, 2, false, true)].sort()).toEqual([1, 5]);
    // A stale anchor falls back to a single toggle.
    expect([...applySelection(new Set(), order, 99, 2, true, true)]).toEqual([2]);
  });

  it('prunes hidden ids and keeps identity when nothing changes', () => {
    const sel = new Set([1, 2]);
    expect(pruneSelection(sel, new Set([1, 2, 3]))).toBe(sel);
    expect([...pruneSelection(sel, new Set([2]))]).toEqual([2]);
  });

  it('finds the common project', () => {
    expect(commonProjectId([])).toBeNull();
    expect(commonProjectId([{ projectId: 1 }, { projectId: 1 }])).toBe(1);
    expect(commonProjectId([{ projectId: 1 }, { projectId: 2 }])).toBeNull();
  });
});

describe('hidden tasks of an empty list', () => {
  const base: TaskFilter = { projectIds: [1], epicIds: [5] };
  const view = (showClosed: boolean, showArchived: boolean, enabled = true, search = '') => ({ enabled, search, showClosed, showArchived });

  it('probes only toggles that hide something', () => {
    expect(hiddenTaskProbes(base, view(true, true))).toBeNull();
    // Toolbar-less lists show closed tasks (as their filter says): only archived ones can hide.
    expect(hiddenTaskProbes(base, view(false, true, false))).toBeNull();
    expect(hiddenTaskProbes({ ...base, closedWithinDays: 7 }, view(false, false, false))).toEqual({
      all: { ...base, closedWithinDays: 7, archived: 'include' },
      archived: null,
    });
    // Both off: everything (search kept, no closed limit), and the archived share.
    expect(hiddenTaskProbes(base, view(false, false, true, 'foo'))).toEqual({
      all: { ...base, search: 'foo', archived: 'include' },
      archived: { ...base, search: 'foo', archived: 'only' },
    });
    expect(hiddenTaskProbes(base, view(false, true))).toEqual({ all: { ...base, archived: 'include' }, archived: null });
    expect(hiddenTaskProbes(base, view(true, false))).toEqual({ all: { ...base, archived: 'include' }, archived: null });
    for (const v of [view(false, false), view(true, false), view(false, true)]) {
      const p = hiddenTaskProbes(base, v)!;
      expect(taskQueryInput.safeParse({ filter: p.all }).success).toBe(true);
      if (p.archived) expect(taskQueryInput.safeParse({ filter: p.archived }).success).toBe(true);
    }
  });

  it('splits the probe totals by the toggle that hides them', () => {
    expect(hiddenTaskCounts(base, view(false, false), { all: 5, archived: 2 })).toEqual({ closed: 3, archived: 2 });
    expect(hiddenTaskCounts(base, view(false, true), { all: 4, archived: null })).toEqual({ closed: 4, archived: 0 });
    expect(hiddenTaskCounts(base, view(true, false), { all: 4, archived: null })).toEqual({ closed: 0, archived: 4 });
    expect(hiddenTaskCounts(base, view(false, false, false), { all: 2, archived: null })).toEqual({ closed: 0, archived: 2 });
    expect(hiddenTaskCounts(base, view(true, true), { all: 9, archived: null })).toEqual({ closed: 0, archived: 0 });
    // Inconsistent totals (results from different moments) never go negative.
    expect(hiddenTaskCounts(base, view(false, false), { all: 1, archived: 2 })).toEqual({ closed: 0, archived: 1 });
  });

  it('agrees with the reference filter for every toggle combination', () => {
    // Tasks: open, done, archived open, archived done (status 1 unstarted, 4 completed).
    const tasks = [
      t({ projectId: 1, epicId: 5, statusId: 1 }),
      t({ projectId: 1, epicId: 5, statusId: 4, completedAt: '2020-01-01T00:00:00.000Z' }),
      t({ projectId: 1, epicId: 5, statusId: 1, archivedAt: '2026-01-01T00:00:00.000Z' }),
      t({ projectId: 1, epicId: 5, statusId: 4, completedAt: '2020-01-01T00:00:00.000Z', archivedAt: '2026-01-01T00:00:00.000Z' }),
    ];
    const fctx = buildFilterContext({ statuses: [...ctx.lookups.statuses], projects: [...ctx.lookups.projects], today: ctx.today, weekStartsOn: 1 });
    const count = (f: TaskFilter, list: TaskDTO[]) => list.filter((x) => matchesTaskFilter(x, f, fctx)).length;
    // Every subset of the tasks, every toggle combination: when the list is empty, the counts
    // add up to the tasks the toggles hide, each counted under a toggle that reveals it.
    for (let mask = 0; mask < 16; mask++) {
      const list = tasks.filter((_, i) => mask & (1 << i));
      for (const enabled of [true, false]) {
        for (const showClosed of [true, false]) {
          for (const showArchived of [true, false]) {
            const v = view(showClosed, showArchived, enabled);
            if (count(effectiveTaskFilter(base, v), list) > 0) continue;
            const p = hiddenTaskProbes(base, v);
            const all = p ? count(p.all, list) : 0;
            const hidden = p
              ? hiddenTaskCounts(base, v, { all, archived: p.archived ? count(p.archived, list) : null })
              : { closed: 0, archived: 0 };
            expect(hidden.closed + hidden.archived).toBe(count(effectiveTaskFilter(base, view(true, true, enabled)), list));
            // Turning on the toggle a count is offered under reveals at least that many (archived
            // ones also need "Show closed", which the empty state's button turns on too).
            if (hidden.closed > 0) expect(count(effectiveTaskFilter(base, view(true, showArchived, enabled)), list)).toBe(hidden.closed);
            if (hidden.archived > 0) expect(count(effectiveTaskFilter(base, view(true, true, enabled)), list)).toBeGreaterThanOrEqual(hidden.archived);
          }
        }
      }
    }
  });

  it('describes what is hidden', () => {
    expect(hiddenTasksMessage({ closed: 0, archived: 0 }, '')).toBeNull();
    expect(hiddenTasksMessage({ closed: 0, archived: 2 }, '')).toEqual({
      title: 'All tasks here are archived',
      body: '2 archived tasks are hidden.',
    });
    expect(hiddenTasksMessage({ closed: 1, archived: 0 }, '')).toEqual({
      title: 'All tasks here are closed',
      body: '1 closed task is hidden.',
    });
    expect(hiddenTasksMessage({ closed: 3, archived: 1 }, '')).toEqual({
      title: 'All tasks here are closed or archived',
      body: '3 closed and 1 archived tasks are hidden.',
    });
    expect(hiddenTasksMessage({ closed: 0, archived: 1 }, 'events')).toEqual({
      title: 'No tasks match “events”',
      body: '1 archived task matches but is hidden.',
    });
    expect(hiddenTasksMessage({ closed: 2, archived: 0 }, 'x')?.body).toBe('2 closed tasks match but are hidden.');
  });
});

describe('archiveTargets', () => {
  it('splits a selection into tasks to archive and to unarchive', () => {
    const live = { id: 1, archivedAt: null };
    const gone = { id: 2, archivedAt: '2026-01-01T00:00:00.000Z' };
    expect(archiveTargets([])).toEqual({ archive: [], unarchive: [] });
    expect(archiveTargets([live, gone, { id: 3, archivedAt: null }])).toEqual({ archive: [1, 3], unarchive: [2] });
    expect(archiveTargets([gone])).toEqual({ archive: [], unarchive: [2] });
  });
});
