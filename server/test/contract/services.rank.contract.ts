// Ranks (services/rank.ts) on any Db (design §14.4): run on NodeDb by server/test/services.rank.test.ts and
// on DoDb in workerd by server/test-workers/services.test.ts.

import { describe, expect, it } from 'vitest';
import type { RankPosition } from '@shared/schemas';
import type { Db } from '../../src/db';
import { HttpError } from '../../src/http/errors';
import { MAX_RANK_LENGTH, rankForNewTask, rankForPosition, renormalizeRanks } from '../../src/services/rank';
import { insertProject, insertTask, prng, taskRow, type SpaceDb, type WithSpaceDb } from './fixtures';

function setup({ db }: SpaceDb, n: number) {
  const projectId = insertProject(db, 'RNK');
  const ids = Array.from({ length: n }, (_, i) => insertTask(db, { projectId, title: `T${i}` }));
  return { db, projectId, ids };
}

/** Task ids in global (rank, id) order. */
function globalOrder(db: Db): number[] {
  return db.all<{ id: number }>('SELECT id FROM tasks ORDER BY rank, id').map((r) => r.id);
}

function move(db: Db, id: number, position: RankPosition): void {
  const rank = rankForPosition(db, position, id);
  if (rank !== null) db.run('UPDATE tasks SET rank = :rank WHERE id = :id', { id, rank });
}

function expectUniqueRanks(db: Db): void {
  const { n, unique } = db.get<{ n: number; unique: number }>(
    'SELECT COUNT(*) AS n, COUNT(DISTINCT rank) AS "unique" FROM tasks',
  )!;
  expect(unique).toBe(n);
}

function expectBadRequest(fn: () => unknown, path: string): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(400);
    expect((err as HttpError).details?.[0]?.path).toBe(path);
    return;
  }
  throw new Error('expected a 400');
}

export function defineRankContract(kind: string, withSpaceDb: WithSpaceDb): void {
  describe(`rankForPosition (${kind})`, () => {
    it('appends new tasks at the bottom by default and supports top', async () => {
      await withSpaceDb(({ db: empty }) => {
        expect(rankForNewTask(empty, undefined)).toBe('a0');
        expect(rankForNewTask(empty, {})).toBe('a0');
      });
      await withSpaceDb((space) => {
        const { db, ids } = setup(space, 3);
        expect(globalOrder(db)).toEqual(ids);
        const top = rankForPosition(db, 'top')!;
        expect(top < taskRow(db, ids[0]!).rank).toBe(true);
        const bottom = rankForPosition(db, 'bottom')!;
        expect(bottom > taskRow(db, ids[2]!).rank).toBe(true);
      });
    });

    it('moves a task to the top / bottom (and keeps the rank when already there)', () =>
      withSpaceDb((space) => {
        const { db, ids } = setup(space, 4);
        const [a, b, c, d] = ids as [number, number, number, number];
        move(db, c, 'top');
        expect(globalOrder(db)).toEqual([c, a, b, d]);
        move(db, a, 'bottom');
        expect(globalOrder(db)).toEqual([c, b, d, a]);
        expect(rankForPosition(db, 'bottom', a)).toBe(taskRow(db, a).rank);
        expect(rankForPosition(db, 'top', c)).toBe(taskRow(db, c).rank);
      }));

    it('places directly after afterId in the global order', () =>
      withSpaceDb((space) => {
        const { db, ids } = setup(space, 5);
        const [a, b, c, d, e] = ids as [number, number, number, number, number];
        // A filtered view showing only a and d: dropping e between them must land right after a.
        move(db, e, { afterId: a, beforeId: d });
        expect(globalOrder(db)).toEqual([a, e, b, c, d]);
        move(db, a, { afterId: d });
        expect(globalOrder(db)).toEqual([e, b, c, d, a]);
        expectUniqueRanks(db);
      }));

    it('places directly before beforeId when only that is given', () =>
      withSpaceDb((space) => {
        const { db, ids } = setup(space, 4);
        const [a, b, c, d] = ids as [number, number, number, number];
        move(db, a, { beforeId: d });
        expect(globalOrder(db)).toEqual([b, c, a, d]);
        move(db, d, { afterId: null, beforeId: b });
        expect(globalOrder(db)).toEqual([d, b, c, a]);
      }));

    it('treats {} and both-null as a no-op', () =>
      withSpaceDb((space) => {
        const { db, ids } = setup(space, 2);
        expect(rankForPosition(db, {}, ids[0])).toBeNull();
        expect(rankForPosition(db, { afterId: null, beforeId: null }, ids[0])).toBeNull();
      }));

    it('keeps the current rank when the task already sits at the requested place', () =>
      withSpaceDb((space) => {
        const { db, ids } = setup(space, 3);
        const [a, b] = ids as [number, number, number];
        expect(rankForPosition(db, { afterId: a }, b)).toBe(taskRow(db, b).rank);
      }));

    it('rejects unknown neighbours, self references and afterId === beforeId with 400', () =>
      withSpaceDb((space) => {
        const { db, ids } = setup(space, 3);
        const [a, b] = ids as [number, number, number];
        expectBadRequest(() => rankForPosition(db, { afterId: 9999 }, a), 'position.afterId');
        expectBadRequest(() => rankForPosition(db, { beforeId: 9999 }, a), 'position.beforeId');
        expectBadRequest(() => rankForPosition(db, { afterId: b, beforeId: 9999 }, a), 'position.beforeId');
        expectBadRequest(() => rankForPosition(db, { afterId: a }, a), 'position.afterId');
        expectBadRequest(() => rankForPosition(db, { beforeId: a }, a), 'position.beforeId');
        expectBadRequest(() => rankForPosition(db, { afterId: b, beforeId: b }, a), 'position.beforeId');
      }));

    it('renormalizes duplicate ranks without touching updated_at', () =>
      withSpaceDb((space) => {
        const { db, ids } = setup(space, 4);
        const [a, b, c, d] = ids as [number, number, number, number];
        db.run('UPDATE tasks SET rank = :rank', { rank: 'a5' });
        db.run("UPDATE tasks SET updated_at = '2020-01-01T00:00:00.000Z'");
        move(db, d, { afterId: a });
        expect(globalOrder(db)).toEqual([a, d, b, c]);
        expectUniqueRanks(db);
        const stamps = db.all<{ updated_at: string }>('SELECT DISTINCT updated_at FROM tasks');
        expect(stamps).toEqual([{ updated_at: '2020-01-01T00:00:00.000Z' }]);
      }));

    it('renormalizes duplicates for beforeId as well', () =>
      withSpaceDb((space) => {
        const { db, ids } = setup(space, 3);
        const [a, b, c] = ids as [number, number, number];
        db.run('UPDATE tasks SET rank = :rank WHERE id IN (:a, :b)', { rank: 'a1', a, b });
        move(db, c, { beforeId: b });
        expect(globalOrder(db)).toEqual([a, c, b]);
        expectUniqueRanks(db);
      }));

    it('repairs malformed stored ranks instead of throwing a fractional-indexing error', () =>
      withSpaceDb((space) => {
        const { db, ids } = setup(space, 3);
        const [a, b, c] = ids as [number, number, number];
        db.run("UPDATE tasks SET rank = 'zzzz' WHERE id = :a", { a });
        db.run("UPDATE tasks SET rank = 'a' WHERE id = :b", { b });
        move(db, c, { afterId: b });
        expect(globalOrder(db)).toEqual([b, c, a]); // 'a' < 'zzzz'
        expectUniqueRanks(db);
        expect(() => rankForPosition(db, 'bottom')).not.toThrow();
      }));

    it('renormalizeRanks preserves (rank, id) order', () =>
      withSpaceDb((space) => {
        const { db } = setup(space, 30);
        db.run("UPDATE tasks SET rank = 'b' || (id % 3)");
        const before = globalOrder(db);
        renormalizeRanks(db);
        expect(globalOrder(db)).toEqual(before);
        expectUniqueRanks(db);
      }));

    it('stays unique and exact over hundreds of moves with neighbours from filtered views', () =>
      withSpaceDb((space) => {
        const rnd = prng(99);
        const { db, projectId, ids } = setup(space, 60);
        const all = [...ids];
        for (let step = 0; step < 600; step++) {
          // Occasionally create a task right after a random one (duplicate-style insert).
          if (rnd.chance(0.05)) {
            const after = rnd.pick(all);
            all.push(insertTask(db, { projectId, position: { afterId: after } }));
            const order = globalOrder(db);
            expect(order[order.indexOf(after) + 1]).toBe(all.at(-1));
            continue;
          }
          const moving = rnd.pick(all);
          // A "filtered view": a random subset in global order, without the moving task.
          const view = globalOrder(db).filter((id) => id !== moving && rnd.chance(0.3));
          const kind = rnd.int(0, 5);
          let position: RankPosition;
          if (kind === 0) position = 'top';
          else if (kind === 1) position = 'bottom';
          else if (view.length === 0) position = {};
          else {
            const i = rnd.int(0, view.length - 1);
            if (kind === 2) position = { beforeId: view[i]! };
            else position = { afterId: view[i]!, beforeId: view[i + 1] ?? null };
          }
          move(db, moving, position);
          const order = globalOrder(db);
          const at = order.indexOf(moving);
          if (position === 'top') expect(at).toBe(0);
          else if (position === 'bottom') expect(at).toBe(order.length - 1);
          else if (position.afterId) expect(order[at - 1]).toBe(position.afterId);
          else if (position.beforeId) expect(order[at + 1]).toBe(position.beforeId);
          if (step % 25 === 0) expectUniqueRanks(db);
        }
        expectUniqueRanks(db);
      }));

    it('keeps keys short when moves keep splitting the same gap (repeated "move to top of column")', () =>
      withSpaceDb((space) => {
        const { db, ids } = setup(space, 6);
        const [first, ...column] = ids as [number, ...number[]];
        const before = taskRow(db, first).updated_at;
        // `first` stands in for a task of another project that is globally first; the column is
        // the rest. Every move puts the column's last card directly before its first card, which
        // always halves the same gap (between `first` and the column's head).
        for (let step = 0; step < 1500; step++) {
          const order = globalOrder(db).filter((id) => id !== first);
          const head = order[0]!;
          const moving = order.at(-1)!;
          move(db, moving, { afterId: null, beforeId: head });
          const after = globalOrder(db);
          expect(after[after.indexOf(moving) + 1]).toBe(head);
        }
        const maxLen = db.get<{ n: number }>('SELECT MAX(LENGTH(rank)) AS n FROM tasks')!.n;
        expect(maxLen).toBeLessThanOrEqual(MAX_RANK_LENGTH + 1);
        expect(globalOrder(db)[0]).toBe(first);
        expect(column.length).toBe(5);
        expectUniqueRanks(db);
        // Renormalizing is not a user edit.
        expect(taskRow(db, first).updated_at).toBe(before);
      }));

    it('repeated top / bottom moves stay short too', () =>
      withSpaceDb((space) => {
        const { db, ids } = setup(space, 4);
        for (let step = 0; step < 800; step++) move(db, ids[step % 4]!, step % 2 === 0 ? 'top' : 'bottom');
        const maxLen = db.get<{ n: number }>('SELECT MAX(LENGTH(rank)) AS n FROM tasks')!.n;
        expect(maxLen).toBeLessThanOrEqual(MAX_RANK_LENGTH + 1);
        expectUniqueRanks(db);
      }));
  });
}
