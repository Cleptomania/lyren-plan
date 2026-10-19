// Pure logic of the command palette: query tokens, client-side matching (actions, boards),
// match highlighting and the grouped / flattened result list. No React — unit-tested.

import { searchTokens } from '@shared/filter';
import type { SpaceRole } from '@shared/roles';
import type { BoardDTO, EpicDTO, MilestoneDTO, ProjectDTO, SearchResultDTO, TaskDTO } from '@shared/types';
import type { RecentItem } from './recent';

/** Whitespace-separated, lower-cased tokens (same semantics as the server search). */
export const paletteTokens = (query: string): string[] => searchTokens(query);

/** Every token occurs somewhere in `text` (case-insensitive) — the server's search semantics. */
export function matchesAllTokens(text: string, tokens: readonly string[]): boolean {
  if (tokens.length === 0) return true;
  const hay = text.toLowerCase();
  return tokens.every((t) => hay.includes(t));
}

const WORD_SPLIT = /[^\p{L}\p{N}]+/u;

/**
 * Every token is the start of some word in `text` ("new ta" matches "New task", "ask" doesn't).
 * Stricter than substring matching, so commands only show up when the query names them.
 */
export function matchesWordPrefixes(text: string, tokens: readonly string[]): boolean {
  if (tokens.length === 0) return true;
  const words = text.toLowerCase().split(WORD_SPLIT).filter(Boolean);
  return tokens.every((t) => {
    const parts = t.split(WORD_SPLIT).filter(Boolean);
    // A token made only of punctuation can't name a word.
    if (parts.length === 0) return false;
    return parts.every((p) => words.some((w) => w.startsWith(p)));
  });
}

/**
 * Character ranges [start, end) of `text` matched by the tokens (case-insensitive), sorted and
 * merged — for bolding matches. Empty when lower-casing changes the text's length (rare
 * Unicode cases), because offsets would no longer line up.
 */
export function highlightRanges(text: string, tokens: readonly string[]): Array<[number, number]> {
  const lower = text.toLowerCase();
  if (tokens.length === 0 || lower.length !== text.length) return [];
  const ranges: Array<[number, number]> = [];
  for (const token of tokens) {
    if (!token) continue;
    let from = 0;
    for (;;) {
      const i = lower.indexOf(token, from);
      if (i < 0) break;
      ranges.push([i, i + token.length]);
      from = i + token.length;
    }
  }
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}

/** Split text into plain / highlighted segments using highlightRanges(). */
export function highlightSegments(text: string, tokens: readonly string[]): Array<{ text: string; match: boolean }> {
  const ranges = highlightRanges(text, tokens);
  if (ranges.length === 0) return [{ text, match: false }];
  const out: Array<{ text: string; match: boolean }> = [];
  let pos = 0;
  for (const [start, end] of ranges) {
    if (start > pos) out.push({ text: text.slice(pos, start), match: false });
    out.push({ text: text.slice(start, end), match: true });
    pos = end;
  }
  if (pos < text.length) out.push({ text: text.slice(pos), match: false });
  return out;
}

// ---- Result model ----------------------------------------------------------------------

/** Anything the palette can run: `id` is stable, `keywords` are extra words to match on. */
export interface PaletteActionLike {
  id: string;
  label: string;
  keywords?: string;
}

export type PaletteItem<A extends PaletteActionLike = PaletteActionLike> =
  | { kind: 'action'; key: string; action: A }
  | { kind: 'recent'; key: string; recent: RecentItem }
  | { kind: 'task'; key: string; task: TaskDTO }
  | { kind: 'project'; key: string; project: ProjectDTO }
  | { kind: 'milestone'; key: string; milestone: MilestoneDTO }
  | { kind: 'epic'; key: string; epic: EpicDTO }
  | { kind: 'board'; key: string; board: BoardDTO }
  | { kind: 'space'; key: string; space: PaletteSpace };

export type PaletteSectionId = 'recent' | 'actions' | 'tasks' | 'projects' | 'milestones' | 'epics' | 'boards' | 'spaces';

/** One of the account's spaces, in "Switch space…" (components/layout/navigation.ts spaceChoices). */
export interface PaletteSpace {
  id: string;
  name: string;
  role: SpaceRole;
  /** The space being viewed. */
  current: boolean;
}

export interface PaletteSection<A extends PaletteActionLike = PaletteActionLike> {
  id: PaletteSectionId;
  label: string;
  items: Array<PaletteItem<A>>;
}

export const PALETTE_LIMITS = {
  /** Actions shown while typing (all of them with an empty query). */
  actions: 4,
  boards: 5,
  recent: 5,
} as const;

/** Boards whose name or description contains every token, in lookup (position) order. */
export function filterBoards(boards: readonly BoardDTO[], tokens: readonly string[], limit: number): BoardDTO[] {
  if (tokens.length === 0) return [];
  return boards.filter((b) => matchesAllTokens(`${b.name}\n${b.description}`, tokens)).slice(0, limit);
}

/** Actions whose label/keywords contain a word starting with each token. */
export function filterActions<A extends PaletteActionLike>(actions: readonly A[], tokens: readonly string[]): A[] {
  return actions.filter((a) => matchesWordPrefixes(`${a.label} ${a.keywords ?? ''}`, tokens));
}

export interface BuildSectionsInput<A extends PaletteActionLike> {
  query: string;
  actions: readonly A[];
  /** Already resolved against current data (deleted boards removed). */
  recents: readonly RecentItem[];
  boards: readonly BoardDTO[];
  /** Server results for the current query (undefined while none have loaded). */
  results: SearchResultDTO | undefined;
}

/**
 * Sections in display order. Empty query: Recent, then every action. With a query: matching
 * actions first (word-prefix matches are deliberate, so "new" puts "New task" on top), then
 * Tasks, Projects, Milestones, Epics (server) and Boards (client). Empty sections are dropped.
 */
export function buildSections<A extends PaletteActionLike>(input: BuildSectionsInput<A>): Array<PaletteSection<A>> {
  const tokens = paletteTokens(input.query);
  const sections: Array<PaletteSection<A>> = [];
  const push = (id: PaletteSectionId, label: string, items: Array<PaletteItem<A>>) => {
    if (items.length > 0) sections.push({ id, label, items });
  };

  if (tokens.length === 0) {
    push(
      'recent',
      'Recent',
      input.recents.slice(0, PALETTE_LIMITS.recent).map((recent) => ({ kind: 'recent', key: `recent:${recent.kind}:${recent.id}`, recent })),
    );
    push('actions', 'Actions', input.actions.map((action) => ({ kind: 'action', key: `action:${action.id}`, action })));
    return sections;
  }

  push(
    'actions',
    'Actions',
    filterActions(input.actions, tokens)
      .slice(0, PALETTE_LIMITS.actions)
      .map((action) => ({ kind: 'action', key: `action:${action.id}`, action })),
  );
  const r = input.results;
  if (r) {
    push('tasks', 'Tasks', r.tasks.map((task) => ({ kind: 'task', key: `task:${task.id}`, task })));
    push('projects', 'Projects', r.projects.map((project) => ({ kind: 'project', key: `project:${project.id}`, project })));
    push('milestones', 'Milestones', r.milestones.map((milestone) => ({ kind: 'milestone', key: `milestone:${milestone.id}`, milestone })));
    push('epics', 'Epics', r.epics.map((epic) => ({ kind: 'epic', key: `epic:${epic.id}`, epic })));
  }
  push(
    'boards',
    'Boards',
    filterBoards(input.boards, tokens, PALETTE_LIMITS.boards).map((board) => ({ kind: 'board', key: `board:${board.id}`, board })),
  );
  return sections;
}

/**
 * "Switch space…" (design §12.9): the palette lists the account's spaces instead of searching the
 * current one, every space whose name contains each token, in the switcher's order.
 */
export function buildSpaceSections<A extends PaletteActionLike>(query: string, spaces: readonly PaletteSpace[]): Array<PaletteSection<A>> {
  const tokens = paletteTokens(query);
  const items = spaces.filter((s) => matchesAllTokens(s.name, tokens)).map((space) => ({ kind: 'space' as const, key: `space:${space.id}`, space }));
  return items.length > 0 ? [{ id: 'spaces', label: 'Spaces', items }] : [];
}

/** Items in keyboard order. */
export function flattenSections<A extends PaletteActionLike>(sections: ReadonlyArray<PaletteSection<A>>): Array<PaletteItem<A>> {
  return sections.flatMap((s) => s.items);
}

/** Next enabled index when moving by `dir` from `from`, wrapping around (-1 when empty). */
export function wrapIndex(from: number, dir: 1 | -1, length: number): number {
  if (length === 0) return -1;
  if (from < 0) return dir === 1 ? 0 : length - 1;
  return (((from + dir) % length) + length) % length;
}

// ---- Recent items ------------------------------------------------------------------------

/**
 * Recent items as shown: boards renamed from the lookups (deleted ones dropped), tasks with the
 * ref, title and archived state of the freshest cached copy (`cachedTask`: api/tasks
 * findCachedTask, which also reads list caches), else as stored. A stored ref can be stale
 * after a move, so the palette opens Recent tasks by id.
 */
export function resolveRecents(
  list: readonly RecentItem[],
  boardById: ReadonlyMap<number, Pick<BoardDTO, 'name'>>,
  cachedTask: (id: number) => Pick<TaskDTO, 'ref' | 'title' | 'archivedAt'> | undefined,
): RecentItem[] {
  const out: RecentItem[] = [];
  for (const r of list) {
    if (r.kind === 'board') {
      const board = boardById.get(r.id);
      if (board) out.push({ ...r, name: board.name });
    } else {
      const task = cachedTask(r.id);
      if (!task) {
        out.push(r);
        continue;
      }
      const { archived: _stored, ...rest } = r;
      out.push({ ...rest, ref: task.ref, title: task.title, ...(task.archivedAt !== null && { archived: true }) });
    }
  }
  return out;
}
