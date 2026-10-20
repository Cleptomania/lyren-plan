// Persisted rate limits (design §5.9). Counters live in auth_throttle, so they survive a restart (Node)
// and the eviction of the directory object (Cloudflare); they replace auth/rateLimit.ts' in-memory
// FailureLimiter and GuessThrottle. A key is `<policy name>` or `<policy name>:<subject>` (li:<ip>,
// lid:a:<userId>, sc:<userId>, …).
//
// Rows written are the scarcest resource on Cloudflare's free plan, and most keys are fed by anonymous
// requests that can rotate addresses, so a policy has one of two storage classes:
// - exact: every hit writes the row. For keys that count an action which writes anyway (space
//   creation, mail, invitations, imports) and must not be exceeded.
// - buffered: hits are counted in memory (an LRU of 10,000 keys), and the row is written at the 3rd
//   hit, at every 10th hit after that (13th, 23rd, …), and when a block-mode key starts a block. A
//   check reads the larger of the memory count and the row. Losing the memory (a restart, an evicted
//   object) gives an attacker at most 9 extra attempts per key; in exchange a one-off anonymous
//   request writes no row.
//
// Modes: 'block' refuses every attempt once `limit` hits fell in the window, until the window ends;
// 'progressive' lets `limit` hits through freely, then spaces attempts out: each further hit n blocks
// the key for min(250 ms · 2^(n − limit), 10 s).

import type { Db } from '../core/db';
import type { Clock } from '../core/runtime';

export type ThrottleMode = 'block' | 'progressive';

export interface ThrottlePolicy {
  /** The key prefix: keys are `name` or `name:<subject>`. */
  name: string;
  limit: number;
  windowMs: number;
  mode: ThrottleMode;
  storage: 'exact' | 'buffered';
}

export interface ThrottleState {
  blocked: boolean;
  /** How long until an attempt is let through again; 0 when not blocked. */
  retryAfterMs: number;
  /** Hits in the current window. */
  count: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The policies of §5.9 with a fixed limit (the mail budgets are directory/mailer.ts's, the import budget directory/imports.ts's). */
export const POLICIES = {
  /** Failed password logins, instance-wide; browsers with the account's device token are exempt. */
  lg: { name: 'lg', limit: 100, windowMs: 15 * MINUTE, mode: 'block', storage: 'buffered' },
  /** Failed password logins, setup codes, current and re-auth passwords, per client address. */
  li: { name: 'li', limit: 10, windowMs: 15 * MINUTE, mode: 'block', storage: 'buffered' },
  /** The same, per coarse network (netKey). */
  ln: { name: 'ln', limit: 50, windowMs: 15 * MINUTE, mode: 'block', storage: 'buffered' },
  /** Failed password logins of one account (a:<id>) or of an identifier that matches none (i:<identifier>). */
  lid: { name: 'lid', limit: 20, windowMs: 15 * MINUTE, mode: 'progressive', storage: 'buffered' },
  /** Failed password logins of one account (<id>) from browsers without its device token, or of an identifier that matches none (i:<identifier>), per day. */
  lda: { name: 'lda', limit: 100, windowMs: DAY, mode: 'block', storage: 'buffered' },
  /** Sign-up, forgot-password, verification and email-change requests for one address (email_key), per hour. */
  mh: { name: 'mh', limit: 3, windowMs: HOUR, mode: 'block', storage: 'exact' },
  /** The same, per day. */
  md: { name: 'md', limit: 10, windowMs: DAY, mode: 'block', storage: 'exact' },
  /** Sign-up and forgot-password requests per client address, per hour. */
  mi: { name: 'mi', limit: 10, windowMs: HOUR, mode: 'block', storage: 'buffered' },
  /** Invalid link tokens inspected or redeemed, per client address. */
  tk: { name: 'tk', limit: 20, windowMs: 15 * MINUTE, mode: 'block', storage: 'buffered' },
  /** Invitation mails to one address (email_key), instance-wide, per day. */
  ir: { name: 'ir', limit: 3, windowMs: DAY, mode: 'block', storage: 'exact' },
  /** Password reset links an admin creates, per day (ar:<adminId>). */
  ar: { name: 'ar', limit: 10, windowMs: DAY, mode: 'block', storage: 'exact' },
  /** Failed passkey assertions (sign-in, re-authentication) per client address (pk:<ip>). */
  pk: { name: 'pk', limit: 30, windowMs: 15 * MINUTE, mode: 'block', storage: 'buffered' },
  /** The same per coarse network (pk:<net>). */
  pkNet: { name: 'pk', limit: 150, windowMs: 15 * MINUTE, mode: 'block', storage: 'buffered' },
  /** WebAuthn options requests per client address (co:<ip>): buffered, so a one-off sign-in writes no row. */
  co: { name: 'co', limit: 60, windowMs: 15 * MINUTE, mode: 'block', storage: 'buffered' },
  /** The same per coarse network (co:<net>). */
  coNet: { name: 'co', limit: 300, windowMs: 15 * MINUTE, mode: 'block', storage: 'buffered' },
  /** Import analyze and commit calls per account (im:<userId>; directory/imports.ts reserveImport). */
  im: { name: 'im', limit: 10, windowMs: HOUR, mode: 'block', storage: 'exact' },
} as const satisfies Record<string, ThrottlePolicy>;

/** sc:<userId>: spaces created per day (SPACES_CREATED_PER_DAY; the caller skips it for 0 = no limit). */
export function spacesCreatedPolicy(limit: number): ThrottlePolicy {
  return { name: 'sc', limit, windowMs: DAY, mode: 'block', storage: 'exact' };
}

/**
 * iv:<userId>: invitations created and resent per day (INVITATIONS_PER_DAY, at most 5 for an account
 * younger than a day; the caller skips it for 0 = no limit).
 */
export function invitationsPolicy(limit: number): ThrottlePolicy {
  return { name: 'iv', limit, windowMs: DAY, mode: 'block', storage: 'exact' };
}

/** Rows of keys no registered policy covers are purged once this old. */
const LONGEST_WINDOW_MS = DAY;
/** Keys a buffered policy counts in memory. */
export const MEMORY_KEYS = 10_000;
/** The first buffered hit that writes the row, and how many more hits it takes to write it again. */
const FIRST_WRITE = 3;
const WRITE_EVERY = 10;
const PROGRESSIVE_BASE_MS = 250;
const PROGRESSIVE_MAX_MS = 10_000;

interface Counter {
  windowStart: number;
  count: number;
  /** ms epoch, or null. */
  blockedUntil: number | null;
}

interface MemoryCounter extends Counter {
  policy: ThrottlePolicy;
  /** The count the row holds (0: no row written in this window). */
  persisted: number;
}

interface ThrottleRow {
  window_start: string;
  count: number;
  blocked_until: string | null;
}

const UPSERT = `INSERT INTO auth_throttle (key, window_start, count, blocked_until)
  VALUES (:key, :windowStart, :count, :blockedUntil)
  ON CONFLICT (key) DO UPDATE SET window_start = excluded.window_start, count = excluded.count,
    blocked_until = excluded.blocked_until`;

const iso = (ms: number) => new Date(ms).toISOString();

export class Throttle {
  /** Buffered counters, least recently used first. */
  private readonly memory = new Map<string, MemoryCounter>();
  /** Every policy this instance has counted with, for purge(). */
  private readonly policies = new Map<string, ThrottlePolicy>();

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {
    for (const policy of Object.values(POLICIES)) this.policies.set(`${policy.name}/${policy.windowMs}`, policy);
  }

  /** Whether an attempt on `key` is refused now. Reads only. */
  check(key: string, policy: ThrottlePolicy): ThrottleState {
    const now = this.clock.now();
    return stateOf(this.read(key, policy, now).counter, policy, now);
  }

  /** Count one event on `key`; returns the state after it. */
  hit(key: string, policy: ThrottlePolicy): ThrottleState {
    const now = this.clock.now();
    this.policies.set(`${policy.name}/${policy.windowMs}`, policy);
    const { counter: before, persisted } = this.read(key, policy, now);
    const counter: Counter = before ?? { windowStart: now, count: 0, blockedUntil: null };
    counter.count += 1;
    const wasBlocked = counter.blockedUntil !== null && counter.blockedUntil > now;
    if (policy.mode === 'block') {
      if (counter.count >= policy.limit) counter.blockedUntil = counter.windowStart + policy.windowMs;
    } else if (counter.count > policy.limit) {
      const delay = Math.min(PROGRESSIVE_BASE_MS * 2 ** (counter.count - policy.limit), PROGRESSIVE_MAX_MS);
      counter.blockedUntil = now + delay;
    }
    if (policy.storage === 'exact') {
      this.write(key, counter);
    } else {
      const entry = this.remember(key, policy, counter, persisted);
      const blockStarts = policy.mode === 'block' && !wasBlocked && counter.blockedUntil !== null;
      const due = entry.count === FIRST_WRITE || (entry.count > FIRST_WRITE && (entry.count - FIRST_WRITE) % WRITE_EVERY === 0);
      if (due || blockStarts) this.persist(key, entry);
    }
    return stateOf(counter, policy, now);
  }

  /**
   * Give back one hit that turned out not to count: a password check counts as a failure before it
   * runs (so parallel requests cannot slip past the limits) and is forgiven when it succeeds. A block
   * that the hit started ends with it, in the row too when the row holds the hit (it was written at
   * that hit), so a success never leaves its own block behind.
   */
  forgive(key: string, policy: ThrottlePolicy): void {
    const now = this.clock.now();
    const entry = policy.storage === 'buffered' ? this.memory.get(key) : undefined;
    if (entry && inWindow(entry, entry.policy, now)) {
      if (entry.count === 0) return;
      entry.count -= 1;
      if (entry.count <= freeHits(policy)) entry.blockedUntil = null;
      if (entry.persisted > entry.count) this.persist(key, entry);
      return;
    }
    // Exact storage, or a buffered key whose memory was evicted since its hit (the eviction wrote the row).
    this.db.run(
      `UPDATE auth_throttle SET count = count - 1,
         blocked_until = CASE WHEN count - 1 <= :free THEN NULL ELSE blocked_until END
       WHERE key = :key AND count > 0`,
      { key, free: freeHits(policy) },
    );
  }

  /** Forget `key` (memory and row). */
  clear(key: string): void {
    this.memory.delete(key);
    this.db.run('DELETE FROM auth_throttle WHERE key = :key', { key });
  }

  /**
   * Write every buffered count that has passed its first write but changed since, so a restart loses
   * nothing (one row per such key at most; keys with fewer than 3 hits are never written).
   */
  flush(): number {
    let written = 0;
    const now = this.clock.now();
    for (const [key, entry] of this.memory) {
      if (!inWindow(entry, entry.policy, now)) continue;
      if (entry.count >= FIRST_WRITE && entry.count !== entry.persisted) {
        this.persist(key, entry);
        written++;
      }
    }
    return written;
  }

  /** Keys counted in memory now (at most MEMORY_KEYS). */
  get size(): number {
    return this.memory.size;
  }

  /** Delete rows (and counters) whose window and block are over; returns the rows deleted. */
  purge(nowMs: number): number {
    for (const [key, entry] of this.memory) {
      if (!inWindow(entry, entry.policy, nowMs) && !(entry.blockedUntil !== null && entry.blockedUntil > nowMs)) {
        this.memory.delete(key);
      }
    }
    const now = iso(nowMs);
    let deleted = 0;
    for (const policy of this.policies.values()) {
      deleted += this.db.run(
        `DELETE FROM auth_throttle WHERE (key = :name OR substr(key, 1, length(:prefix)) = :prefix)
           AND window_start <= :windowOver AND (blocked_until IS NULL OR blocked_until <= :now)`,
        { name: policy.name, prefix: `${policy.name}:`, windowOver: iso(nowMs - policy.windowMs), now },
      ).changes;
    }
    deleted += this.db.run(
      'DELETE FROM auth_throttle WHERE window_start <= :windowOver AND (blocked_until IS NULL OR blocked_until <= :now)',
      { windowOver: iso(nowMs - LONGEST_WINDOW_MS), now },
    ).changes;
    return deleted;
  }

  /**
   * The key's counter in its current window (the larger of memory and row), or null, and the count
   * its row holds in that window (0 when there is none).
   */
  private read(key: string, policy: ThrottlePolicy, now: number): { counter: Counter | null; persisted: number } {
    const row = this.db.get<ThrottleRow>('SELECT window_start, count, blocked_until FROM auth_throttle WHERE key = :key', { key });
    const stored: Counter | null = row
      ? { windowStart: Date.parse(row.window_start), count: row.count, blockedUntil: row.blocked_until ? Date.parse(row.blocked_until) : null }
      : null;
    const fromRow = stored && inWindow(stored, policy, now) ? stored : null;
    const persisted = fromRow?.count ?? 0;
    let entry = policy.storage === 'buffered' ? this.memory.get(key) : undefined;
    // The row no longer holds what this memory wrote: it was cleared from outside (the reset-password
    // command, another process), and the memory goes with it.
    if (entry && entry.persisted > 0 && (row === undefined || row.count < entry.persisted)) {
      this.memory.delete(key);
      entry = undefined;
    }
    const fromMemory = entry && inWindow(entry, policy, now) ? entry : null;
    if (!fromMemory) return { counter: fromRow, persisted };
    const memory: Counter = { windowStart: fromMemory.windowStart, count: fromMemory.count, blockedUntil: fromMemory.blockedUntil };
    if (!fromRow) return { counter: memory, persisted };
    return {
      counter: {
        windowStart: Math.min(memory.windowStart, fromRow.windowStart),
        count: Math.max(memory.count, fromRow.count),
        blockedUntil: Math.max(memory.blockedUntil ?? 0, fromRow.blockedUntil ?? 0) || null,
      },
      persisted,
    };
  }

  /** Keep `counter` in memory as the key's newest state (most recently used). */
  private remember(key: string, policy: ThrottlePolicy, counter: Counter, persisted: number): MemoryCounter {
    const entry: MemoryCounter = { ...counter, policy, persisted };
    this.memory.delete(key);
    this.memory.set(key, entry);
    if (this.memory.size > MEMORY_KEYS) {
      const [oldestKey, oldest] = this.memory.entries().next().value as [string, MemoryCounter];
      this.memory.delete(oldestKey);
      // Written once, as a restart would have lost it otherwise; one-off keys are just dropped.
      if (oldest.count >= FIRST_WRITE && oldest.count !== oldest.persisted) this.write(oldestKey, oldest);
    }
    return entry;
  }

  private persist(key: string, entry: MemoryCounter): void {
    this.write(key, entry);
    entry.persisted = entry.count;
  }

  private write(key: string, counter: Counter): void {
    this.db.run(UPSERT, {
      key,
      windowStart: iso(counter.windowStart),
      count: counter.count,
      blockedUntil: counter.blockedUntil === null ? null : iso(counter.blockedUntil),
    });
  }
}

/** Hits a key takes before it is blocked: block mode blocks at the limit-th, progressive after it. */
const freeHits = (policy: ThrottlePolicy) => (policy.mode === 'block' ? policy.limit - 1 : policy.limit);

/** The counter's window has not ended (a block mode block ends with it; a progressive delay is at most 10 s). */
function inWindow(counter: Counter, policy: ThrottlePolicy, now: number): boolean {
  return counter.windowStart + policy.windowMs > now;
}

function stateOf(counter: Counter | null, policy: ThrottlePolicy, now: number): ThrottleState {
  if (counter === null) return { blocked: false, retryAfterMs: 0, count: 0 };
  let until = counter.blockedUntil ?? 0;
  if (policy.mode === 'block' && counter.count >= policy.limit) until = Math.max(until, counter.windowStart + policy.windowMs);
  const blocked = until > now;
  return { blocked, retryAfterMs: blocked ? until - now : 0, count: counter.count };
}
