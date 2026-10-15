// Manual task order: one GLOBAL fractional index over all tasks (SPEC §5.5).
//
// A new rank is always generated between two globally adjacent ranks — directly after
// `afterId` in (rank, id) order, or directly before `beforeId` — so ranks stay unique
// even when clients pass neighbours taken from a filtered view. Duplicate ranks (from
// older data) are repaired by renormalizing. Rank changes never bump updated_at.
//
// `{ rank }` (task updates only) restores a rank the task had before — the Undo of a move — so
// the task returns to exactly its old place among ALL tasks, not just among those a view shows.
//
// Repeatedly splitting the same gap (e.g. "move to top of column", which always lands
// between the column's head and the same global predecessor) makes fractional keys grow by
// about one character every few moves. A generated key longer than MAX_RANK_LENGTH also
// triggers a renormalize, so ranks stay short no matter how often a spot is reused.

import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';
import type { RankPosition, TaskPosition } from '@shared/schemas';
import type { Db } from '../db';
import { badRequest } from '../http/errors';

interface RankedRow {
  id: number;
  rank: string;
}

/**
 * Longest key rankForPosition hands out before it renormalizes all ranks first. Freshly
 * renormalized keys are a few characters long, so this is reached only after hundreds of
 * moves into the same gap.
 */
export const MAX_RANK_LENGTH = 50;

/** Marker: ranks need renormalizing before a key can be generated. */
const RENORMALIZE = Symbol('renormalize');
type Attempt = string | typeof RENORMALIZE;

/** Rewrite every task rank to a fresh, evenly spaced key preserving (rank, id) order. */
export function renormalizeRanks(db: Db): void {
  db.tx(() => {
    const rows = db.all<{ id: number }>('SELECT id FROM tasks ORDER BY rank, id');
    const keys = generateNKeysBetween(null, null, rows.length);
    rows.forEach((row, i) => db.run('UPDATE tasks SET rank = :rank WHERE id = :id', { id: row.id, rank: keys[i]! }));
  });
}

function keyBetween(lo: string | null, hi: string | null): Attempt {
  if (lo !== null && hi !== null && lo >= hi) return RENORMALIZE;
  try {
    return generateKeyBetween(lo, hi);
  } catch {
    // Malformed stored keys (e.g. hand-edited data): repair the whole order and retry.
    return RENORMALIZE;
  }
}

/** True when `rank` already lies strictly inside (lo, hi) — the task is already in place. */
function alreadyBetween(rank: string | undefined, lo: string | null, hi: string | null): rank is string {
  return rank !== undefined && (lo === null || rank > lo) && (hi === null || rank < hi);
}

function currentRank(db: Db, movingTaskId: number | undefined): string | undefined {
  if (movingTaskId === undefined) return undefined;
  return db.get<RankedRow>('SELECT id, rank FROM tasks WHERE id = :id', { id: movingTaskId })?.rank;
}

function edgeAttempt(db: Db, edge: 'top' | 'bottom', movingTaskId: number | undefined): Attempt {
  const moving = movingTaskId ?? null;
  const row =
    edge === 'top'
      ? db.get<{ rank: string | null }>('SELECT MIN(rank) AS rank FROM tasks WHERE id IS NOT :moving', { moving })
      : db.get<{ rank: string | null }>('SELECT MAX(rank) AS rank FROM tasks WHERE id IS NOT :moving', { moving });
  const extreme = row?.rank ?? null;
  const lo = edge === 'top' ? null : extreme;
  const hi = edge === 'top' ? extreme : null;
  const own = currentRank(db, movingTaskId);
  if (alreadyBetween(own, lo, hi)) return own;
  return keyBetween(lo, hi);
}

function afterAttempt(db: Db, afterId: number, movingTaskId: number | undefined): Attempt {
  const lo = requireNeighbour(db, afterId, 'afterId').rank;
  const next = db.get<RankedRow>(
    `SELECT id, rank FROM tasks
      WHERE (rank > :lo OR (rank = :lo AND id > :afterId)) AND id IS NOT :moving
      ORDER BY rank, id LIMIT 1`,
    { lo, afterId, moving: movingTaskId ?? null },
  );
  const hi = next?.rank ?? null;
  if (hi === lo) return RENORMALIZE;
  const own = currentRank(db, movingTaskId);
  if (alreadyBetween(own, lo, hi)) return own;
  return keyBetween(lo, hi);
}

function beforeAttempt(db: Db, beforeId: number, movingTaskId: number | undefined): Attempt {
  const hi = requireNeighbour(db, beforeId, 'beforeId').rank;
  const prev = db.get<RankedRow>(
    `SELECT id, rank FROM tasks
      WHERE (rank < :hi OR (rank = :hi AND id < :beforeId)) AND id IS NOT :moving
      ORDER BY rank DESC, id DESC LIMIT 1`,
    { hi, beforeId, moving: movingTaskId ?? null },
  );
  const lo = prev?.rank ?? null;
  if (lo === hi) return RENORMALIZE;
  const own = currentRank(db, movingTaskId);
  if (alreadyBetween(own, lo, hi)) return own;
  return keyBetween(lo, hi);
}

/**
 * `{ rank }`: that exact key when no other task holds it (it then sits where it used to among
 * all tasks that did not move since); taken meanwhile → directly after the task holding it.
 */
function restoreAttempt(db: Db, rank: string, movingTaskId: number | undefined): Attempt {
  try {
    generateKeyBetween(rank, null); // validates the key's format
  } catch {
    throw badRequest('Position refers to an invalid rank', [{ path: 'position.rank', message: 'Not a valid rank' }]);
  }
  const moving = movingTaskId ?? null;
  if (currentRank(db, movingTaskId) === rank) return rank;
  const taken = db.get<{ id: number }>('SELECT id FROM tasks WHERE rank = :rank AND id IS NOT :moving LIMIT 1', { rank, moving });
  if (!taken) return rank;
  const next = db.get<{ rank: string }>('SELECT rank FROM tasks WHERE rank > :rank AND id IS NOT :moving ORDER BY rank, id LIMIT 1', {
    rank,
    moving,
  });
  return keyBetween(rank, next?.rank ?? null);
}

function requireNeighbour(db: Db, id: number, field: 'afterId' | 'beforeId'): RankedRow {
  const row = db.get<RankedRow>('SELECT id, rank FROM tasks WHERE id = :id', { id });
  if (!row) {
    throw badRequest(`Position refers to an unknown task (${field} ${id})`, [
      { path: `position.${field}`, message: 'Task not found' },
    ]);
  }
  return row;
}

function validateNeighbours(afterId: number | null, beforeId: number | null, movingTaskId: number | undefined): void {
  for (const [field, id] of [['afterId', afterId], ['beforeId', beforeId]] as const) {
    if (id !== null && id === movingTaskId) {
      throw badRequest('A task cannot be positioned relative to itself', [
        { path: `position.${field}`, message: 'Must be another task' },
      ]);
    }
  }
  if (afterId !== null && afterId === beforeId) {
    throw badRequest('afterId and beforeId must be different tasks', [
      { path: 'position.beforeId', message: 'Must differ from afterId' },
    ]);
  }
}

/**
 * Rank for a task placed at `position` (SPEC §5.5). Pass `movingTaskId` when repositioning
 * an existing task (it is ignored as a neighbour).
 *  - 'top' / 'bottom': before the global min / after the global max.
 *  - { afterId }: directly after that task in the global (rank, id) order (beforeId, when
 *    also given, is only validated). { beforeId } alone: directly before that task.
 *  - { rank } (updates): that rank again (restoreAttempt).
 *  - {} or both null: returns null — keep the current rank (no-op).
 * Returns the task's current rank when it already sits at the requested place.
 * Unknown neighbours, self references, afterId === beforeId and malformed ranks are 400s.
 */
export function rankForPosition(db: Db, position: TaskPosition, movingTaskId?: number): string | null {
  let attempt: () => Attempt;
  if (typeof position === 'object' && 'rank' in position) {
    // An old key is restored as is (whatever its length); the order around it is what counts.
    const restored = restoreAttempt(db, position.rank, movingTaskId);
    if (restored !== RENORMALIZE) return restored;
    // Malformed stored neighbours: repair them and keep the task where it is (its fresh key).
    renormalizeRanks(db);
    return currentRank(db, movingTaskId) ?? null;
  }
  if (position === 'top' || position === 'bottom') {
    attempt = () => edgeAttempt(db, position, movingTaskId);
  } else {
    const afterId = position.afterId ?? null;
    const beforeId = position.beforeId ?? null;
    if (afterId === null && beforeId === null) return null;
    validateNeighbours(afterId, beforeId, movingTaskId);
    if (beforeId !== null) requireNeighbour(db, beforeId, 'beforeId');
    attempt =
      afterId !== null
        ? () => afterAttempt(db, afterId, movingTaskId)
        : () => beforeAttempt(db, beforeId!, movingTaskId);
  }
  const first = attempt();
  if (first !== RENORMALIZE && first.length <= MAX_RANK_LENGTH) return first;
  renormalizeRanks(db);
  const second = attempt();
  // After renormalizing, neighbours are short, so the new key is short too.
  if (second !== RENORMALIZE) return second;
  throw new Error('Could not compute a task rank after renormalizing');
}

/** Rank for a new task: `position` (default 'bottom'); a no-op position also means bottom. */
export function rankForNewTask(db: Db, position: RankPosition | undefined): string {
  return rankForPosition(db, position ?? 'bottom') ?? rankForPosition(db, 'bottom')!;
}
