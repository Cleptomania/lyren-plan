// Board quick filters (SPEC §8): view state in the URL (`?q=&tags=1,2&pri=3,4&closed=0`),
// ANDed with the saved config.filter and the project scope, never saved. Pure; unit-tested.

import { LIMITS, PRIORITY_VALUES, type Priority } from '@shared/constants';
import type { TaskFilter } from '@shared/schemas';

export interface QuickFilters {
  /** Free text (every token must match title, description or ref). */
  q: string;
  /** Tasks having ANY of these tags. */
  tagIds: number[];
  priorities: Priority[];
  /** Hide every closed task (closed=0). */
  hideClosed: boolean;
}

export const EMPTY_QUICK_FILTERS: QuickFilters = Object.freeze({ q: '', tagIds: [], priorities: [], hideClosed: false }) as QuickFilters;

export const QUICK_FILTER_PARAMS = ['q', 'tags', 'pri', 'closed'] as const;

function idList(value: string | null): number[] {
  if (!value) return [];
  const ids = value
    .split(',')
    .map((v) => Number(v.trim()))
    .filter((n) => Number.isInteger(n) && n > 0 && n <= Number.MAX_SAFE_INTEGER);
  return [...new Set(ids)];
}

/** Read quick filters from URL search params (invalid parts are ignored). */
export function parseQuickFilters(params: URLSearchParams): QuickFilters {
  const priorities = [
    ...new Set(
      (params.get('pri') ?? '')
        .split(',')
        .filter((v) => v.trim() !== '')
        .map(Number)
        .filter((n): n is Priority => (PRIORITY_VALUES as readonly number[]).includes(n)),
    ),
  ];
  return {
    q: (params.get('q') ?? '').slice(0, LIMITS.searchMax),
    tagIds: idList(params.get('tags')),
    priorities,
    hideClosed: params.get('closed') === '0',
  };
}

/** Write quick filters into (a copy of) the search params; empty values are removed. */
export function writeQuickFilters(params: URLSearchParams, quick: QuickFilters): URLSearchParams {
  const next = new URLSearchParams(params);
  const set = (key: string, value: string) => (value ? next.set(key, value) : next.delete(key));
  set('q', quick.q.trim() ? quick.q : '');
  set('tags', quick.tagIds.join(','));
  set('pri', quick.priorities.join(','));
  set('closed', quick.hideClosed ? '0' : '');
  return next;
}

export function hasQuickFilters(quick: QuickFilters): boolean {
  return quick.q.trim() !== '' || quick.tagIds.length > 0 || quick.priorities.length > 0 || quick.hideClosed;
}

/** Active quick filters behind the phone "Filters" button (tags, priorities, hide closed; not the search text). */
export function quickFilterCount(quick: QuickFilters): number {
  return quick.tagIds.length + quick.priorities.length + (quick.hideClosed ? 1 : 0);
}

export interface EffectiveFilters {
  /** Sent to POST /tasks/query and used to derive / scope the board. */
  server: TaskFilter;
  /**
   * Extra client-side condition when a quick filter cannot be expressed in one TaskFilter
   * (quick tags combined with a saved tag filter). Neutral on archive rules.
   */
  local: TaskFilter | null;
  /** Provably matches nothing (e.g. disjoint priorities): skip the request. */
  empty: boolean;
}

const nonEmpty = <T,>(a: readonly T[] | undefined): a is readonly T[] => Array.isArray(a) && a.length > 0;

/** A local filter that only constrains tags (does not re-apply archive defaults). */
function tagsOnly(tagIds: number[]): TaskFilter {
  return { tagIds, tagMode: 'any', archived: 'include', includeArchivedProjects: true };
}

/**
 * config.filter ∧ quick filters ∧ project scope as one server filter (plus, rarely, a local
 * remainder). Quick tags mean "has any of these tags".
 */
export function effectiveFilters(base: TaskFilter, quick: QuickFilters, scopeProjectId: number | null): EffectiveFilters {
  const server: TaskFilter = { ...base };
  let local: TaskFilter | null = null;
  let empty = false;

  if (scopeProjectId !== null) server.projectIds = [scopeProjectId];

  // Text: tokens are ANDed, so appending works while it fits the length limit.
  const q = quick.q.trim();
  if (q) {
    const joined = [base.search?.trim(), q].filter(Boolean).join(' ');
    if (joined.length <= LIMITS.searchMax) server.search = joined;
    else local = { ...(local ?? {}), search: q, archived: 'include', includeArchivedProjects: true };
  }

  // Priorities: intersection.
  if (quick.priorities.length > 0) {
    if (nonEmpty(base.priorities)) {
      const both = base.priorities.filter((p) => quick.priorities.includes(p));
      if (both.length === 0) empty = true;
      else server.priorities = both;
    } else {
      server.priorities = [...quick.priorities];
    }
  }

  // Closed: hiding all closed tasks is the narrowest window.
  if (quick.hideClosed) server.closedWithinDays = 0;

  // Tags (any of Q), minus excluded tags.
  const exclude = base.excludeTagIds ?? [];
  const q2 = quick.tagIds.filter((id) => !exclude.includes(id));
  if (quick.tagIds.length > 0 && q2.length === 0) empty = true;
  if (q2.length > 0) {
    const listed = base.tagIds;
    const mode = base.tagMode ?? 'any';
    const wanted = (listed ?? []).filter((id): id is number => id !== null);
    if (!nonEmpty(listed)) {
      server.tagIds = q2;
      server.tagMode = 'any';
    } else if (mode === 'any') {
      if (q2.every((id) => wanted.includes(id))) server.tagIds = q2; // (any of B) ∧ (any of Q ⊆ B) = any of Q
      else if (wanted.every((id) => q2.includes(id)) && !listed.includes(null)) {
        /* B ⊆ Q: the saved filter already implies the quick one */
      } else local = { ...(local ?? {}), ...tagsOnly(q2) };
    } else if (wanted.length === 0) {
      empty = true; // "untagged only" ∧ "has a tag"
    } else if (q2.some((id) => wanted.includes(id))) {
      /* all of W, and one of them is in Q: already implied */
    } else if (q2.length === 1) {
      server.tagIds = [...wanted, q2[0]!];
    } else {
      local = { ...(local ?? {}), ...tagsOnly(q2) };
    }
  }

  return { server, local, empty };
}
