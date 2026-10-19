// Recently opened tasks and boards for the command palette's empty state. A per-device
// convenience kept in localStorage per space (small: at most RECENT_MAX entries, newest first).

import { spaceKey } from '../../lib/spaceStorage';

/** `archived`: the task was archived when last seen (stored only when true). */
export type RecentItem =
  | { kind: 'task'; id: number; ref: string; title: string; archived?: true; at: number }
  | { kind: 'board'; id: number; name: string; at: number };

export type RecentInput =
  | { kind: 'task'; id: number; ref: string; title: string; archived?: boolean }
  | { kind: 'board'; id: number; name: string };

/** The space's list (lyren.s.<spaceId>.palette.recent). */
export const recentKey = (spaceId: string) => spaceKey(spaceId, 'palette.recent');
export const RECENT_MAX = 8;

const isId = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;
const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

function parseItem(raw: unknown): RecentItem | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (!isId(o.id) || typeof o.at !== 'number' || !Number.isFinite(o.at)) return null;
  if (o.kind === 'task' && isText(o.ref, 40) && isText(o.title, 500)) {
    return { kind: 'task', id: o.id, ref: o.ref, title: o.title, ...(o.archived === true && { archived: true }), at: o.at };
  }
  if (o.kind === 'board' && isText(o.name, 200)) return { kind: 'board', id: o.id, name: o.name, at: o.at };
  return null;
}

/** Parse the stored JSON leniently: invalid entries are dropped, never thrown. */
export function parseRecent(raw: string | null): RecentItem[] {
  if (!raw) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const seen = new Set<string>();
  const out: RecentItem[] = [];
  for (const entry of data) {
    const item = parseItem(entry);
    if (!item || seen.has(`${item.kind}:${item.id}`)) continue;
    seen.add(`${item.kind}:${item.id}`);
    out.push(item);
  }
  return out.sort((a, b) => b.at - a.at).slice(0, RECENT_MAX);
}

/** A stored entry for `item` (a task's `archived` is kept only when true). */
function toEntry(item: RecentInput, at: number): RecentItem {
  if (item.kind === 'board') return { ...item, at };
  const { archived, ...rest } = item;
  return { ...rest, ...(archived && { archived: true }), at };
}

/** Put `item` first (replacing an older entry for the same task/board) and trim. */
export function addRecent(list: readonly RecentItem[], item: RecentInput, at: number, max = RECENT_MAX): RecentItem[] {
  const entry = toEntry(item, at);
  return [entry, ...list.filter((r) => !(r.kind === item.kind && r.id === item.id))].slice(0, max);
}

export function removeRecent(list: readonly RecentItem[], kind: RecentItem['kind'], id: number): RecentItem[] {
  return list.filter((r) => !(r.kind === kind && r.id === id));
}

// ---- Storage (never throws: private mode / disabled storage just means no history) ------------

export function loadRecent(spaceId: string): RecentItem[] {
  try {
    return parseRecent(window.localStorage.getItem(recentKey(spaceId)));
  } catch {
    return [];
  }
}

function save(spaceId: string, list: readonly RecentItem[]): void {
  try {
    window.localStorage.setItem(recentKey(spaceId), JSON.stringify(list));
  } catch {
    /* storage unavailable or full */
  }
}

function sameEntry(a: RecentItem, b: RecentInput): boolean {
  if (a.kind === 'task' && b.kind === 'task') {
    return a.id === b.id && a.ref === b.ref && a.title === b.title && !!a.archived === !!b.archived;
  }
  if (a.kind === 'board' && b.kind === 'board') return a.id === b.id && a.name === b.name;
  return false;
}

export function rememberRecent(spaceId: string, item: RecentInput): void {
  const list = loadRecent(spaceId);
  // Re-opening the newest entry unchanged is a no-op (no storage write).
  if (list[0] && sameEntry(list[0], item)) return;
  save(spaceId, addRecent(list, item, Date.now()));
}

export function forgetRecent(spaceId: string, kind: RecentItem['kind'], id: number): void {
  const list = loadRecent(spaceId);
  const next = removeRecent(list, kind, id);
  if (next.length !== list.length) save(spaceId, next);
}

/** What the server says about a recent task now; null = it no longer exists. */
export type RecentTaskUpdate = { ref: string; title: string; archived: boolean } | null;

/**
 * Recent tasks brought up to date (ref, title, archived; deleted ones dropped), keeping their
 * order and times. Returns `list` itself when nothing changed.
 */
export function applyRecentUpdates(list: readonly RecentItem[], updates: ReadonlyMap<number, RecentTaskUpdate>): readonly RecentItem[] {
  const out: RecentItem[] = [];
  for (const r of list) {
    const update = r.kind === 'task' ? updates.get(r.id) : undefined;
    if (update === null) continue;
    if (r.kind !== 'task' || update === undefined || (update.ref === r.ref && update.title === r.title && update.archived === !!r.archived)) {
      out.push(r);
      continue;
    }
    const { archived: _old, ...rest } = r;
    out.push({ ...rest, ref: update.ref, title: update.title, ...(update.archived && { archived: true }) });
  }
  return out.length === list.length && out.every((r, k) => r === list[k]) ? list : out;
}

/** Store what the server said about recent tasks (another device may have changed them). */
export function refreshRecentTasks(spaceId: string, updates: ReadonlyMap<number, RecentTaskUpdate>): void {
  if (updates.size === 0) return;
  const list = loadRecent(spaceId);
  const next = applyRecentUpdates(list, updates);
  if (next !== list) save(spaceId, next);
}
