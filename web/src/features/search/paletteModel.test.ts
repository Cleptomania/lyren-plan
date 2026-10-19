import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { buildFilterContext, matchesTaskFilter } from '@shared/filter';
import { taskQueryInput } from '@shared/schemas';
import type { BoardDTO, SearchResultDTO, TaskDTO, TaskQueryResult } from '@shared/types';
import { qk } from '../../api/keys';
import { findCachedTask } from '../../api/tasks';
import { task as fullTask } from '../../components/domain/fixtures.test-utils';
import {
  buildSections,
  buildSpaceSections,
  filterActions,
  filterBoards,
  flattenSections,
  highlightRanges,
  highlightSegments,
  matchesAllTokens,
  matchesWordPrefixes,
  paletteTokens,
  resolveRecents,
  wrapIndex,
  type PaletteActionLike,
} from './paletteModel';
import { recentTasksQuery } from './useRecentItems';
import { addRecent, applyRecentUpdates, parseRecent, removeRecent, RECENT_MAX, type RecentItem, type RecentTaskUpdate } from './recent';

const SID = '7k2m9q4w8x1c3v5b';

const board = (id: number, name: string, description = ''): BoardDTO =>
  ({ id, name, description, projectId: null, position: id }) as BoardDTO;
const task = (id: number, title: string): TaskDTO => ({ id, title, ref: `WEB-${id}` }) as TaskDTO;

const ACTIONS: PaletteActionLike[] = [
  { id: 'new-task', label: 'New task', keywords: 'create add' },
  { id: 'go-dashboard', label: 'Go to Dashboard', keywords: 'home' },
  { id: 'go-settings', label: 'Go to Settings', keywords: 'preferences account' },
  { id: 'theme', label: 'Switch to dark theme', keywords: 'toggle appearance mode light' },
];

describe('matching', () => {
  it('tokenizes like the server (lower-case, whitespace separated)', () => {
    expect(paletteTokens('  Login   BUG ')).toEqual(['login', 'bug']);
    expect(paletteTokens('   ')).toEqual([]);
  });

  it('matchesAllTokens requires every token as a substring', () => {
    expect(matchesAllTokens('Sprint Planning', ['plan', 'spr'])).toBe(true);
    expect(matchesAllTokens('Sprint Planning', ['plan', 'x'])).toBe(false);
    expect(matchesAllTokens('anything', [])).toBe(true);
    expect(matchesAllTokens('ÉCOLE', ['école'])).toBe(true);
  });

  it('matchesWordPrefixes requires each token to start a word', () => {
    expect(matchesWordPrefixes('New task', ['new', 'ta'])).toBe(true);
    expect(matchesWordPrefixes('New task', ['ask'])).toBe(false);
    expect(matchesWordPrefixes('Go to Work log', ['work-log'])).toBe(true);
    expect(matchesWordPrefixes('New task', ['-'])).toBe(false);
    expect(matchesWordPrefixes('Anything', [])).toBe(true);
  });

  it('filterActions matches labels and keywords by word prefix', () => {
    const ids = (tokens: string[]) => filterActions(ACTIONS, tokens).map((a) => a.id);
    expect(ids(['new'])).toEqual(['new-task']);
    expect(ids(['create'])).toEqual(['new-task']);
    expect(ids(['go'])).toEqual(['go-dashboard', 'go-settings']);
    expect(ids(['dark'])).toEqual(['theme']);
    expect(ids(['light'])).toEqual(['theme']);
    expect(ids(['ings'])).toEqual([]);
  });

  it('filterBoards matches name or description and limits', () => {
    const boards = [board(1, 'Priority triage'), board(2, 'Sprint', 'weekly triage'), board(3, 'Roadmap')];
    expect(filterBoards(boards, ['triage'], 5).map((b) => b.id)).toEqual([1, 2]);
    expect(filterBoards(boards, ['triage'], 1).map((b) => b.id)).toEqual([1]);
    expect(filterBoards(boards, [], 5)).toEqual([]);
  });
});

describe('highlighting', () => {
  it('returns merged, sorted ranges for every occurrence', () => {
    expect(highlightRanges('Login and logout', ['log'])).toEqual([
      [0, 3],
      [10, 13],
    ]);
    expect(highlightRanges('abcdef', ['bcd', 'cde'])).toEqual([[1, 5]]);
    expect(highlightRanges('abc', [])).toEqual([]);
  });

  it('gives up when lower-casing changes the length', () => {
    expect(highlightRanges('İstanbul', ['stan'])).toEqual([]);
  });

  it('splits text into segments', () => {
    expect(highlightSegments('Fix login bug', ['login'])).toEqual([
      { text: 'Fix ', match: false },
      { text: 'login', match: true },
      { text: ' bug', match: false },
    ]);
    expect(highlightSegments('Nothing', ['x'])).toEqual([{ text: 'Nothing', match: false }]);
  });
});

describe('buildSections', () => {
  const results: SearchResultDTO = { tasks: [task(1, 'Fix login')], projects: [], milestones: [], epics: [] };
  const recents: RecentItem[] = [{ kind: 'task', id: 9, ref: 'WEB-9', title: 'Recent one', at: 1 }];

  it('shows recent items and every action for an empty query', () => {
    const sections = buildSections({ query: '  ', actions: ACTIONS, recents, boards: [board(1, 'Login board')], results });
    expect(sections.map((s) => s.id)).toEqual(['recent', 'actions']);
    expect(sections[1]!.items).toHaveLength(ACTIONS.length);
    expect(flattenSections(sections).map((i) => i.key)).toEqual([
      'recent:task:9',
      'action:new-task',
      'action:go-dashboard',
      'action:go-settings',
      'action:theme',
    ]);
  });

  it('puts matching actions first, then server results, then boards; drops empty groups', () => {
    const sections = buildSections({
      query: 'log',
      actions: [...ACTIONS, { id: 'go-worklog', label: 'Go to Work log' }],
      recents,
      boards: [board(4, 'Login board'), board(5, 'Other')],
      results,
    });
    expect(sections.map((s) => s.id)).toEqual(['actions', 'tasks', 'boards']);
    expect(flattenSections(sections).map((i) => i.key)).toEqual(['action:go-worklog', 'task:1', 'board:4']);
  });

  it('keeps client-side groups while server results are loading', () => {
    const sections = buildSections({ query: 'new', actions: ACTIONS, recents, boards: [], results: undefined });
    expect(sections.map((s) => s.id)).toEqual(['actions']);
  });

  it('orders server groups as tasks, projects, milestones, epics', () => {
    const all = {
      tasks: [task(1, 'x')],
      projects: [{ id: 2 }],
      milestones: [{ id: 3 }],
      epics: [{ id: 4 }],
    } as unknown as SearchResultDTO;
    const sections = buildSections({ query: 'zzz', actions: ACTIONS, recents: [], boards: [], results: all });
    expect(sections.map((s) => s.id)).toEqual(['tasks', 'projects', 'milestones', 'epics']);
  });
});

describe('buildSpaceSections ("Switch space…")', () => {
  const spaces = [
    { id: 'a1a1a1a1a1a1a1a1', name: 'Team planning', role: 'owner' as const, current: true },
    { id: 'b2b2b2b2b2b2b2b2', name: 'Home', role: 'viewer' as const, current: false },
    { id: 'c3c3c3c3c3c3c3c3', name: 'Client work', role: 'member' as const, current: false },
  ];

  it('lists every space for an empty query, in the switcher’s order', () => {
    const sections = buildSpaceSections('', spaces);
    expect(sections.map((s) => s.id)).toEqual(['spaces']);
    expect(flattenSections(sections).map((i) => i.key)).toEqual(['space:a1a1a1a1a1a1a1a1', 'space:b2b2b2b2b2b2b2b2', 'space:c3c3c3c3c3c3c3c3']);
  });

  it('keeps the spaces whose name contains every token, and nothing else', () => {
    expect(flattenSections(buildSpaceSections('pla tea', spaces)).map((i) => (i.kind === 'space' ? i.space.name : ''))).toEqual(['Team planning']);
    expect(flattenSections(buildSpaceSections('o', spaces)).length).toBe(2);
    expect(buildSpaceSections('nothing', spaces)).toEqual([]);
  });
});

describe('wrapIndex', () => {
  it('wraps in both directions and handles empty lists', () => {
    expect(wrapIndex(0, 1, 3)).toBe(1);
    expect(wrapIndex(2, 1, 3)).toBe(0);
    expect(wrapIndex(0, -1, 3)).toBe(2);
    expect(wrapIndex(-1, 1, 3)).toBe(0);
    expect(wrapIndex(-1, -1, 3)).toBe(2);
    expect(wrapIndex(0, 1, 0)).toBe(-1);
  });
});

describe('recent items', () => {
  it('adds newest first, de-duplicates and trims', () => {
    let list: RecentItem[] = [];
    for (let i = 1; i <= RECENT_MAX + 2; i++) list = addRecent(list, { kind: 'board', id: i, name: `B${i}` }, i);
    expect(list).toHaveLength(RECENT_MAX);
    expect(list[0]).toEqual({ kind: 'board', id: RECENT_MAX + 2, name: `B${RECENT_MAX + 2}`, at: RECENT_MAX + 2 });
    list = addRecent(list, { kind: 'board', id: 5, name: 'Renamed' }, 100);
    expect(list.map((r) => r.id).slice(0, 2)).toEqual([5, RECENT_MAX + 2]);
    expect(list.filter((r) => r.id === 5)).toHaveLength(1);
    // Same id, different kind: separate entries.
    list = addRecent(list, { kind: 'task', id: 5, ref: 'WEB-5', title: 'T' }, 101);
    expect(list.filter((r) => r.id === 5)).toHaveLength(2);
    expect(removeRecent(list, 'task', 5).filter((r) => r.id === 5)).toEqual([{ kind: 'board', id: 5, name: 'Renamed', at: 100 }]);
  });

  it('parses stored JSON leniently', () => {
    expect(parseRecent(null)).toEqual([]);
    expect(parseRecent('not json')).toEqual([]);
    expect(parseRecent('{"a":1}')).toEqual([]);
    const raw = JSON.stringify([
      { kind: 'task', id: 1, ref: 'WEB-1', title: 'One', at: 1 },
      { kind: 'board', id: 2, name: 'Two', at: 3 },
      { kind: 'task', id: 1, ref: 'WEB-1', title: 'Dup', at: 0 },
      { kind: 'task', id: -1, ref: 'X', title: 'bad id', at: 2 },
      { kind: 'board', id: 3, name: '', at: 2 },
      { kind: 'other', id: 4, at: 2 },
      null,
    ]);
    expect(parseRecent(raw)).toEqual([
      { kind: 'board', id: 2, name: 'Two', at: 3 },
      { kind: 'task', id: 1, ref: 'WEB-1', title: 'One', at: 1 },
    ]);
  });

  it('keeps a task’s archived flag only when true', () => {
    let list = addRecent([], { kind: 'task', id: 1, ref: 'WEB-1', title: 'One', archived: true }, 1);
    list = addRecent(list, { kind: 'task', id: 2, ref: 'WEB-2', title: 'Two', archived: false }, 2);
    expect(list).toEqual([
      { kind: 'task', id: 2, ref: 'WEB-2', title: 'Two', at: 2 },
      { kind: 'task', id: 1, ref: 'WEB-1', title: 'One', archived: true, at: 1 },
    ]);
    // Round trip through storage; junk values are dropped, not kept.
    const raw = JSON.stringify([...list, { kind: 'task', id: 3, ref: 'WEB-3', title: 'Three', archived: 'yes', at: 0 }]);
    expect(parseRecent(raw)).toEqual([...list, { kind: 'task', id: 3, ref: 'WEB-3', title: 'Three', at: 0 }]);
    // Unarchiving replaces the entry without the flag.
    expect(addRecent(list, { kind: 'task', id: 1, ref: 'WEB-1', title: 'One', archived: false }, 3)[0]).toEqual({
      kind: 'task',
      id: 1,
      ref: 'WEB-1',
      title: 'One',
      at: 3,
    });
  });
});

describe('resolveRecents', () => {
  const stored: RecentItem[] = [
    { kind: 'task', id: 18, ref: 'ME-1', title: 'Renew passport', at: 3 },
    { kind: 'board', id: 1, name: 'Old name', at: 2 },
    { kind: 'board', id: 2, name: 'Deleted', at: 1 },
    { kind: 'task', id: 5, ref: 'WEB-5', title: 'Not cached', at: 0 },
  ];

  it('refreshes a moved task from the freshest cached copy (lists included), renames boards and drops deleted ones', () => {
    const qc = new QueryClient();
    // An inactive detail entry from before the move, and a newer list copy after it.
    qc.setQueryData(qk.task(SID, 18), fullTask({ id: 18, ref: 'ME-1', title: 'Renew passport', updatedAt: '2026-10-01T00:00:00.000Z' }));
    const list: TaskQueryResult = {
      tasks: [fullTask({ id: 18, ref: 'WEB-19', title: 'Renew passport (moved)', updatedAt: '2026-10-05T00:00:00.000Z' })],
      total: 1,
    } as TaskQueryResult;
    qc.setQueryData(qk.taskQuery(SID, { limit: 1 }), list);
    const out = resolveRecents(stored, new Map([[1, { name: 'All tasks' }]]), (id) => findCachedTask(qc, SID, id));
    expect(out).toEqual([
      { kind: 'task', id: 18, ref: 'WEB-19', title: 'Renew passport (moved)', at: 3 },
      { kind: 'board', id: 1, name: 'All tasks', at: 2 },
      { kind: 'task', id: 5, ref: 'WEB-5', title: 'Not cached', at: 0 },
    ]);
  });

  it('takes the archived state from the cached copy, else keeps the stored one', () => {
    const qc = new QueryClient();
    const recents: RecentItem[] = [
      { kind: 'task', id: 1, ref: 'WEB-1', title: 'Archived since', at: 3 },
      { kind: 'task', id: 2, ref: 'WEB-2', title: 'Unarchived since', archived: true, at: 2 },
      { kind: 'task', id: 3, ref: 'WEB-3', title: 'Not cached', archived: true, at: 1 },
    ];
    qc.setQueryData(qk.task(SID, 1), fullTask({ id: 1, ref: 'WEB-1', title: 'Archived since', archivedAt: '2026-10-02T00:00:00.000Z' }));
    qc.setQueryData(qk.task(SID, 2), fullTask({ id: 2, ref: 'WEB-2', title: 'Unarchived since', archivedAt: null }));
    expect(resolveRecents(recents, new Map(), (id) => findCachedTask(qc, SID, id))).toEqual([
      { kind: 'task', id: 1, ref: 'WEB-1', title: 'Archived since', archived: true, at: 3 },
      { kind: 'task', id: 2, ref: 'WEB-2', title: 'Unarchived since', at: 2 },
      { kind: 'task', id: 3, ref: 'WEB-3', title: 'Not cached', archived: true, at: 1 },
    ]);
  });
});

describe('applyRecentUpdates (Recent refreshed from the server)', () => {
  const list: RecentItem[] = [
    { kind: 'task', id: 3, ref: 'WEB-3', title: 'Dark mode', archived: true, at: 30 },
    { kind: 'board', id: 1, name: 'All tasks', at: 20 },
    { kind: 'task', id: 4, ref: 'WEB-4', title: 'Focus ring', at: 10 },
    { kind: 'task', id: 5, ref: 'WEB-5', title: 'Docs', at: 5 },
  ];
  const updates = (entries: Array<[number, RecentTaskUpdate]>) => new Map(entries);

  it('clears a stored Archived label when the task was unarchived elsewhere, and sets one the other way', () => {
    const next = applyRecentUpdates(list, updates([
      [3, { ref: 'WEB-3', title: 'Dark mode', archived: false }],
      [4, { ref: 'WEB-4', title: 'Focus ring', archived: true }],
    ]));
    expect(next[0]).toEqual({ kind: 'task', id: 3, ref: 'WEB-3', title: 'Dark mode', at: 30 });
    expect(next[2]).toEqual({ kind: 'task', id: 4, ref: 'WEB-4', title: 'Focus ring', archived: true, at: 10 });
  });

  it('takes renames and moves, drops deleted tasks, and keeps order and times', () => {
    const next = applyRecentUpdates(list, updates([
      [4, { ref: 'ME-9', title: 'Focus ring (Safari)', archived: false }],
      [5, null],
    ]));
    expect(next.map((r) => [r.kind, r.id, r.at])).toEqual([
      ['task', 3, 30],
      ['board', 1, 20],
      ['task', 4, 10],
    ]);
    expect(next[2]).toMatchObject({ ref: 'ME-9', title: 'Focus ring (Safari)' });
  });

  it('returns the same list when nothing changed (no storage write)', () => {
    expect(applyRecentUpdates(list, updates([]))).toBe(list);
    expect(applyRecentUpdates(list, updates([[3, { ref: 'WEB-3', title: 'Dark mode', archived: true }], [99, null]]))).toBe(list);
  });
});

describe('recentTasksQuery', () => {
  it('asks for exactly the Recent tasks, archived ones and archived projects included', () => {
    const input = taskQueryInput.parse(recentTasksQuery([3, 4, 9]));
    expect(input.filter).toEqual({ ids: [3, 4, 9], archived: 'include', includeArchivedProjects: true });
    expect(input.limit).toBe(3);
    const ctx = buildFilterContext({ statuses: [], projects: [], today: '2026-10-14', weekStartsOn: 1 });
    const pick = (t: TaskDTO) => matchesTaskFilter(t, input.filter!, ctx);
    expect(pick(fullTask({ id: 3, archivedAt: '2026-10-01T00:00:00.000Z' }))).toBe(true);
    expect(pick(fullTask({ id: 5 }))).toBe(false);
  });
});
