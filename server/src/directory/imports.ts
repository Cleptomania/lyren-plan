// What the directory does for a space archive import (design §8.4, §8.5, §8.9): the accounts an importer may
// map the archive's users to, the import rate limit and the instance's daily import budget, and the commit's
// record (the space becomes active, the mapped accounts join its space_people).
//
// Candidates are exactly the accounts the importer can see already (§6.3): the importer and every active
// account that shares a non-deleted, active space with them; for an instance admin, who sees every account in
// Administration, every active account. Nobody else is ever matched or named, so an import never tells
// whether an address has an account.
//
// The budget (IMPORT_DAILY_ROW_WRITES, estimated rows per UTC day, instance-wide) is the auth_throttle row
// `import:<YYYY-MM-DD>` (count = rows reserved that day); each commit's reservation is a row of its own,
// `imr:<day>.<random>` with its rows, which refundImport deletes and gives back once (a second refund finds
// nothing). Both rows go with the throttle's purge a day after their window starts. `im:<userId>` counts
// analyze and commit calls as they start, whatever they answer, 10 an hour (§5.9, Appendix D 62).

import type { ImportCandidateDTO } from '@shared/types';
import { randomToken } from '../core/crypto';
import type { ImportReservation } from '../core/ports';
import { compareText } from '../services/sql';
import type { DirectoryContext } from './context';
import { findSpace } from './spaces';
import { POLICIES } from './throttle';

/** Candidates an analysis lists at most (the mapping's select has a filter box). */
export const MAX_CANDIDATES = 1000;

const DAY_MS = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

interface CandidateRow {
  id: number;
  display_name: string;
  email: string | null;
}

/**
 * The accounts an importer may map archive users to (§8.5), sorted by display name: the importer, then (up to
 * MAX_CANDIDATES in all) those whose email_key is one of `emailKeys`, then the rest by display name. An
 * importer that is no active account gets none.
 */
export function importCandidates(ctx: DirectoryContext, input: { userId: number; emailKeys: string[] }): ImportCandidateDTO[] {
  const { db } = ctx;
  const me = db.get<CandidateRow & { is_instance_admin: number }>(
    "SELECT id, display_name, email, is_instance_admin FROM users WHERE id = :id AND status = 'active'",
    { id: input.userId },
  );
  if (!me) return [];
  const keys = JSON.stringify([...new Set(input.emailKeys.filter((k) => typeof k === 'string'))].slice(0, 10_000));
  // Instance admins: every active account. Others: the members of the active spaces they belong to.
  const scope =
    me.is_instance_admin === 1
      ? ''
      : `AND u.id IN (SELECT m.user_id FROM memberships m JOIN spaces s ON s.id = m.space_id
                       WHERE s.deleted_at IS NULL AND s.status = 'active'
                         AND m.space_id IN (SELECT space_id FROM memberships WHERE user_id = :me))`;
  const others = db.all<CandidateRow>(
    `SELECT u.id, u.display_name, u.email FROM users u
      WHERE u.status = 'active' AND u.id <> :me ${scope}
      ORDER BY u.email_key IN (SELECT value FROM json_each(:keys)) DESC, u.display_name COLLATE NOCASE, u.id
      LIMIT ${MAX_CANDIDATES - 1}`,
    { me: me.id, keys },
  );
  const chosen = [me, ...others].sort((a, b) => compareText(foldAscii(a.display_name), foldAscii(b.display_name)) || a.id - b.id);
  return chosen.map((u) => ({ userId: u.id, displayName: u.display_name, email: u.email, isYou: u.id === me.id }));
}

/** ASCII capitals lower-cased, as SQLite's NOCASE compares (with compareText, its order). */
const foldAscii = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** Seconds until the next 00:00 UTC, when the daily import budget starts again. */
const untilMidnight = (nowMs: number) => Math.ceil((DAY_MS - (nowMs % DAY_MS)) / 1000);

/** The budget row of the UTC day of `nowMs`, and the rows reserved on it so far. */
function budgetOf(ctx: DirectoryContext, nowMs: number): { key: string; day: string; used: number } {
  const day = iso(nowMs).slice(0, 10);
  const key = `import:${day}`;
  const row = ctx.db.get<{ count: number }>('SELECT count FROM auth_throttle WHERE key = :key', { key });
  return { key, day, used: row?.count ?? 0 };
}

/**
 * An import's limits (§8.4, §8.9, Appendix D 62). `start` (every analyze and commit, before the file is read):
 * refused while im:<userId> is used up (rate_limited), else counted, and what is left of today's budget reported
 * (dailyLeft, null without a budget). `rows` (a commit, after its estimate): refused when `rowWrites` do not fit
 * into what is left of today's budget (daily_budget, until 00:00 UTC), else reserved (reservationId).
 */
export function reserveImport(
  ctx: DirectoryContext,
  input: { userId: number; step: 'start' | 'rows'; rowWrites: number },
): ImportReservation {
  const { db } = ctx;
  const nowMs = ctx.now();
  const limit = ctx.config.quotas.importDailyRowWrites;
  const budget = limit > 0 ? budgetOf(ctx, nowMs) : null;
  if (input.step === 'start') {
    const limiter = `im:${input.userId}`;
    const limited = ctx.throttle.check(limiter, POLICIES.im);
    if (limited.blocked) return { ok: false, reason: 'rate_limited', retryAfterSec: Math.ceil(limited.retryAfterMs / 1000) };
    ctx.throttle.hit(limiter, POLICIES.im);
    return { ok: true, reservationId: null, dailyLeft: budget === null ? null : Math.max(0, limit - budget.used) };
  }
  if (!budget) return { ok: true, reservationId: null, dailyLeft: null };
  const rows = Math.max(0, Math.ceil(input.rowWrites));
  if (budget.used + rows > limit) return { ok: false, reason: 'daily_budget', retryAfterSec: untilMidnight(nowMs) };
  const reservationId = `${budget.day}.${randomToken(16)}`;
  const windowStart = `${budget.day}T00:00:00.000Z`;
  db.tx(() => {
    db.run(
      `INSERT INTO auth_throttle (key, window_start, count) VALUES (:key, :windowStart, :rows)
       ON CONFLICT (key) DO UPDATE SET count = count + excluded.count`,
      { key: budget.key, windowStart, rows },
    );
    db.run('INSERT INTO auth_throttle (key, window_start, count) VALUES (:key, :windowStart, :rows)', {
      key: `imr:${reservationId}`,
      windowStart,
      rows,
    });
  });
  return { ok: true, reservationId, dailyLeft: Math.max(0, limit - budget.used - rows) };
}

/**
 * Give back a commit's reservation (a failed write), once only, less `spentRows`: the rows a transaction that
 * failed part way was billed for (a Durable Object meters the writes it rolls back), which stay spent.
 */
export function refundImport(ctx: DirectoryContext, input: { reservationId: string; spentRows?: number }): void {
  const { db } = ctx;
  const day = /^(\d{4}-\d{2}-\d{2})\./.exec(input.reservationId)?.[1];
  if (day === undefined) return;
  const spent = Number.isSafeInteger(input.spentRows) ? Math.max(0, input.spentRows!) : 0;
  db.tx(() => {
    const reserved = db.get<{ count: number }>('DELETE FROM auth_throttle WHERE key = :key RETURNING count', {
      key: `imr:${input.reservationId}`,
    });
    if (!reserved) return;
    const rows = Math.max(0, reserved.count - spent);
    db.run('UPDATE auth_throttle SET count = max(0, count - :rows) WHERE key = :key', { key: `import:${day}`, rows });
  });
}

/**
 * A space host finished an import (§8.4, both modes): an importing space becomes active, the mapped accounts
 * join its space_people (so their later profile changes and deletion reach its mirror, §3.5), and its
 * sync_version is bumped (always, Appendix D 11). Idempotent; nothing for a space that is gone or going.
 */
export function importCommitted(ctx: DirectoryContext, input: { spaceId: string; mappedUserIds: number[] }): void {
  const { db } = ctx;
  const space = findSpace(db, input.spaceId);
  if (!space || space.deleted_at !== null || space.status === 'provisioning') return;
  const mapped = [...new Set(input.mappedUserIds)].filter((id) => Number.isSafeInteger(id) && id > 0);
  // Idempotent: a second call finds the space active and the rows present, and only bumps again.
  db.tx(() => {
    db.run(
      `INSERT OR IGNORE INTO space_people (space_id, user_id)
       SELECT :spaceId, id FROM users WHERE id IN (SELECT value FROM json_each(:ids))`,
      { spaceId: space.id, ids: JSON.stringify(mapped) },
    );
    db.run(
      `UPDATE spaces SET status = 'active', sync_version = sync_version + 1, updated_at = :now WHERE id = :spaceId`,
      { spaceId: space.id, now: iso(ctx.now()) },
    );
  });
}
