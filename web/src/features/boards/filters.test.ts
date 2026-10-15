import { describe, expect, it } from 'vitest';
import { LIMITS } from '@shared/constants';
import { buildFilterContext, matchesTaskFilter } from '@shared/filter';
import type { TaskFilter } from '@shared/schemas';
import { task } from '../../components/domain/fixtures.test-utils';
import {
  EMPTY_QUICK_FILTERS,
  effectiveFilters,
  hasQuickFilters,
  parseQuickFilters,
  quickFilterCount,
  writeQuickFilters,
  type QuickFilters,
} from './filters';

const quick = (over: Partial<QuickFilters>): QuickFilters => ({ ...EMPTY_QUICK_FILTERS, ...over });

describe('quick filter URL params', () => {
  it('parses ?q=&tags=&pri=&closed=, ignoring invalid parts', () => {
    expect(parseQuickFilters(new URLSearchParams('q=login%20bug&tags=3,x,4,3&pri=4,9,0,&closed=0'))).toEqual({
      q: 'login bug',
      tagIds: [3, 4],
      priorities: [4, 0],
      hideClosed: true,
    });
    expect(parseQuickFilters(new URLSearchParams('closed=1&tags=-1,0'))).toEqual(EMPTY_QUICK_FILTERS);
    expect(parseQuickFilters(new URLSearchParams(`q=${'x'.repeat(300)}`)).q).toHaveLength(LIMITS.searchMax);
  });

  it('writes params, keeping unrelated ones and removing empty values', () => {
    const base = new URLSearchParams('board=7&task=12&q=old&closed=0');
    const next = writeQuickFilters(base, quick({ tagIds: [1, 2], priorities: [3] }));
    expect(next.toString()).toBe('board=7&task=12&tags=1%2C2&pri=3');
    expect(base.get('q')).toBe('old'); // not mutated
    const round = parseQuickFilters(writeQuickFilters(new URLSearchParams(), quick({ q: 'a b', hideClosed: true, priorities: [0] })));
    expect(round).toEqual(quick({ q: 'a b', hideClosed: true, priorities: [0] }));
    expect(writeQuickFilters(new URLSearchParams('q=x'), quick({ q: '   ' })).has('q')).toBe(false);
  });

  it('counts the filters behind the phone "Filters" button', () => {
    expect(quickFilterCount(EMPTY_QUICK_FILTERS)).toBe(0);
    expect(quickFilterCount({ ...EMPTY_QUICK_FILTERS, q: 'search text' })).toBe(0);
    expect(quickFilterCount({ q: '', tagIds: [1, 2], priorities: [4], hideClosed: true })).toBe(4);
  });

  it('knows when any quick filter is active', () => {
    expect(hasQuickFilters(EMPTY_QUICK_FILTERS)).toBe(false);
    expect(hasQuickFilters(quick({ q: '  ' }))).toBe(false);
    expect(hasQuickFilters(quick({ hideClosed: true }))).toBe(true);
    expect(hasQuickFilters(quick({ tagIds: [1] }))).toBe(true);
  });
});

describe('effectiveFilters', () => {
  it('passes the saved filter through and forces the project scope', () => {
    const base: TaskFilter = { closedWithinDays: 14, projectIds: [1, 2] };
    expect(effectiveFilters(base, EMPTY_QUICK_FILTERS, null)).toEqual({ server: base, local: null, empty: false });
    expect(effectiveFilters(base, EMPTY_QUICK_FILTERS, 5).server.projectIds).toEqual([5]);
  });

  it('appends the search text (tokens are ANDed)', () => {
    expect(effectiveFilters({ search: 'login' }, quick({ q: ' safari ' }), null).server.search).toBe('login safari');
    expect(effectiveFilters({}, quick({ q: 'x' }), null).server.search).toBe('x');
    const long = effectiveFilters({ search: 'y'.repeat(150) }, quick({ q: 'z'.repeat(100) }), null);
    expect(long.server.search).toBe('y'.repeat(150));
    expect(long.local).toMatchObject({ search: 'z'.repeat(100), archived: 'include', includeArchivedProjects: true });
  });

  it('intersects priorities (disjoint = empty)', () => {
    expect(effectiveFilters({}, quick({ priorities: [4, 3] }), null).server.priorities).toEqual([4, 3]);
    expect(effectiveFilters({ priorities: [4, 2] }, quick({ priorities: [4, 3] }), null).server.priorities).toEqual([4]);
    expect(effectiveFilters({ priorities: [2] }, quick({ priorities: [4] }), null).empty).toBe(true);
  });

  it('hides every closed task with closed=0', () => {
    expect(effectiveFilters({ closedWithinDays: 14 }, quick({ hideClosed: true }), null).server.closedWithinDays).toBe(0);
    expect(effectiveFilters({}, quick({ hideClosed: true }), null).server.closedWithinDays).toBe(0);
  });

  it('combines quick tags (any of) with the saved tag filter', () => {
    const tags = (base: TaskFilter, q: number[]) => effectiveFilters(base, quick({ tagIds: q }), null);
    expect(tags({}, [1, 2]).server).toMatchObject({ tagIds: [1, 2], tagMode: 'any' });
    // any of B ∧ any of Q ⊆ B
    expect(tags({ tagIds: [1, 2, 3] }, [2, 3]).server.tagIds).toEqual([2, 3]);
    expect(tags({ tagIds: [1, null] }, [1]).server.tagIds).toEqual([1]);
    // B ⊆ Q: already implied
    expect(tags({ tagIds: [1] }, [1, 2])).toMatchObject({ server: { tagIds: [1] }, local: null });
    // overlapping but neither contains the other: client-side remainder
    const mixed = tags({ tagIds: [1, 2] }, [2, 3]);
    expect(mixed.server.tagIds).toEqual([1, 2]);
    expect(mixed.local).toEqual({ tagIds: [2, 3], tagMode: 'any', archived: 'include', includeArchivedProjects: true });
    // all mode
    expect(tags({ tagIds: [1, 2], tagMode: 'all' }, [2, 5]).server.tagIds).toEqual([1, 2]);
    expect(tags({ tagIds: [1, 2], tagMode: 'all' }, [5]).server.tagIds).toEqual([1, 2, 5]);
    expect(tags({ tagIds: [1, 2], tagMode: 'all' }, [5, 6]).local?.tagIds).toEqual([5, 6]);
    expect(tags({ tagIds: [null], tagMode: 'all' }, [5]).empty).toBe(true);
    // excluded tags
    expect(tags({ excludeTagIds: [5] }, [5]).empty).toBe(true);
    expect(tags({ excludeTagIds: [5] }, [5, 6]).server.tagIds).toEqual([6]);
  });

  it('is equivalent to ANDing the saved filter with the quick filters (randomized)', () => {
    const fctx = buildFilterContext({
      statuses: [
        { id: 1, category: 'unstarted' },
        { id: 2, category: 'completed' },
      ],
      projects: [{ id: 1, status: 'active' }],
      today: '2026-10-14',
      weekStartsOn: 1,
      nowMs: Date.parse('2026-10-14T12:00:00Z'),
    });
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const pick = <T,>(xs: T[]) => xs.filter(() => rnd() < 0.4);
    const tasks = Array.from({ length: 60 }, (_, i) =>
      task({
        id: i + 1,
        priority: (i % 5) as 0 | 1 | 2 | 3 | 4,
        statusId: i % 3 === 0 ? 2 : 1,
        completedAt: i % 3 === 0 ? '2026-10-01T00:00:00.000Z' : null,
        title: i % 4 === 0 ? 'login form' : 'other',
        tags: [1, 2, 3, 4].filter((t) => (i >> t) % 2 === 1).map((t) => ({ id: t, name: `t${t}`, color: '#000000' })),
      }),
    );
    for (let n = 0; n < 300; n++) {
      const base: TaskFilter = {
        ...(rnd() < 0.5 && { tagIds: pick([1, 2, 3, 4]) as Array<number | null>, tagMode: rnd() < 0.5 ? 'all' : 'any' }),
        ...(rnd() < 0.3 && { excludeTagIds: pick([1, 2, 3, 4]) }),
        ...(rnd() < 0.4 && { priorities: pick([0, 1, 2, 3, 4]) as Array<0 | 1 | 2 | 3 | 4> }),
        ...(rnd() < 0.3 && { closedWithinDays: 30 }),
        ...(rnd() < 0.2 && { search: 'login' }),
      };
      const q = quick({
        tagIds: rnd() < 0.6 ? pick([1, 2, 3, 4]) : [],
        priorities: rnd() < 0.4 ? (pick([0, 1, 2, 3, 4]) as Array<0 | 1 | 2 | 3 | 4>) : [],
        hideClosed: rnd() < 0.3,
        q: rnd() < 0.2 ? 'form' : '',
      });
      const eff = effectiveFilters(base, q, null);
      const quickAsFilter: TaskFilter = {
        archived: 'include',
        ...(q.tagIds.length && { tagIds: q.tagIds }),
        ...(q.priorities.length && { priorities: q.priorities }),
        ...(q.hideClosed && { closedWithinDays: 0 }),
        ...(q.q && { search: q.q }),
      };
      for (const t of tasks) {
        const expected = matchesTaskFilter(t, base, fctx) && matchesTaskFilter(t, quickAsFilter, fctx);
        const actual = !eff.empty && matchesTaskFilter(t, eff.server, fctx) && (!eff.local || matchesTaskFilter(t, eff.local, fctx));
        if (actual !== expected) throw new Error(`mismatch for ${JSON.stringify({ base, q, task: t.id })}`);
      }
    }
  });
});
