// The write generation and the daily write budget of one space (design §6.4.2).
//
// _meta.write_state = { gen, day, rows } is loaded once and kept in memory; the space host is the only
// writer of its database, so it knows when anything could have changed:
// - gen is bumped after every request whose gate rule writes (whatever its status) and after a mirror
//   sync or self-heal that changed rows, always after those writes, so a read that ran meanwhile saw
//   the old generation (and is refetched later) or the new one together with the new data. Conditional
//   reads (304) compare it through the ETag (space/gate.ts).
// - rows counts today's billed row writes of write requests (DoDb's meter); day is the UTC date, and a
//   new day starts again from 0. Requests interleave at their awaits, so a request's own rows cannot
//   be told apart from those of a request that overlapped it: each bump counts the rows written since
//   its request began that no earlier bump counted (a high-water mark), so every row is counted once,
//   by whichever overlapping request ends first. Rows written while no write request is in flight are
//   never counted, and uncounted() leaves out what it runs: an import's replace (imports have their
//   own budget, §8.9), a mirror sync, a self-heal (Appendix D 19).
//
// Node: NodeDb has no meter, so there is nothing to count and the budget is off whatever
// SPACE_DAILY_ROW_WRITES says (its Node default is 0 anyway). The bump is its own autocommit right after
// the route, so a space file that Node opens is marked `reopened` (below): a crash between a write and
// its bump, or a restored older copy of the file, can then never repeat a generation a client holds.

import type { Db } from '../core/db';
import { systemClock, type Clock } from '../core/runtime';

export interface WriteState {
  /** Bumped after every request that may have written (§6.4.2). */
  readonly gen: number;
  /**
   * gen + 1, persisted in _meta.write_state (one row). `since` is the meter's rowsWritten when the write
   * request began (the gate): today's rows grow by the rows written from then on that no other bump
   * counted and that uncounted() did not write. Without it (a mirror sync, a self-heal) nothing is counted.
   */
  bump(since?: number): void;
  /** Runs `fn` (synchronous, so nothing interleaves) and leaves the rows it writes out of the budget. */
  uncounted<T>(fn: () => T): T;
  /** SPACE_DAILY_ROW_WRITES minus today's rows (at least 0); Infinity when no budget applies. */
  budgetLeft(nowMs: number): number;
}

export interface StoredWriteState {
  gen: number;
  /** UTC date (YYYY-MM-DD) that `rows` counts. */
  day: string;
  rows: number;
}

export interface WriteStateOptions {
  /** SPACE_DAILY_ROW_WRITES; 0 = no limit. */
  dailyRowWrites: number;
  clock?: Clock;
  /**
   * The database was just opened by a process (Node): gen moves past every generation an earlier
   * process can have handed out (max(gen + 1, now in ms)), and the new value is persisted.
   */
  reopened?: boolean;
}

const KEY = 'write_state';

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const count = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0);

/** The stored state; a missing or malformed row reads as generation 0 with nothing counted. */
export function readWriteState(db: Db): StoredWriteState {
  const row = db.get<{ value: string }>('SELECT value FROM _meta WHERE key = :key', { key: KEY });
  let parsed: unknown = null;
  try {
    parsed = row ? JSON.parse(row.value) : null;
  } catch {
    // Treated as missing.
  }
  const v = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>;
  return { gen: count(v.gen), day: typeof v.day === 'string' ? v.day : '', rows: count(v.rows) };
}

function persist(db: Db, state: StoredWriteState): void {
  db.run('INSERT INTO _meta (key, value) VALUES (:key, :value) ON CONFLICT (key) DO UPDATE SET value = excluded.value', {
    key: KEY,
    value: JSON.stringify(state),
  });
}

export function createWriteState(db: Db, o: WriteStateOptions): WriteState {
  const clock = o.clock ?? systemClock;
  const { meter } = db;
  // No meter (NodeDb): the budget is off, see the header.
  const limit = meter === undefined ? 0 : o.dailyRowWrites;
  const written = () => meter?.rowsWritten ?? 0;
  const state = readWriteState(db);
  if (o.reopened) {
    state.gen = Math.max(state.gen + 1, clock.now());
    persist(db, state);
  }
  /** The meter's reading up to which rows are accounted for (counted, or written while nothing was). */
  let counted = written();
  /** Rows uncounted() wrote since the last counting bump, past `counted`. */
  let excluded = 0;
  return {
    get gen() {
      return state.gen;
    },
    bump(since) {
      const day = utcDay(clock.now());
      if (state.day !== day) {
        state.day = day;
        state.rows = 0;
      }
      state.gen += 1;
      if (since !== undefined) {
        state.rows += Math.max(0, written() - Math.max(since, counted) - excluded);
        excluded = 0;
      }
      try {
        persist(db, state);
      } finally {
        // Past the counted rows and this bump's own write_state row, even when writing it failed.
        if (since !== undefined) counted = written();
      }
    },
    uncounted(fn) {
      const before = written();
      try {
        return fn();
      } finally {
        // Nothing unaccounted before it: the mark moves past it; else the next counting bump subtracts it.
        if (before === counted) counted = written();
        else excluded += written() - before;
      }
    },
    budgetLeft(nowMs) {
      if (limit === 0) return Infinity;
      return state.day === utcDay(nowMs) ? Math.max(0, limit - state.rows) : limit;
    },
  };
}
