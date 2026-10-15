// Brute-force protection for authentication, all in memory (reset on restart):
//  - FailureLimiter: fixed-window failure counter per client network (limiterKey), hard block.
//  - GuessThrottle: one account-wide failure counter that, past a free allowance, spaces sign-in
//    attempts out progressively (globally, whatever address they come from), so rotating source
//    addresses cannot buy unlimited guesses, while the owner can still sign in from a new address.
// Callers record an attempt BEFORE the (slow) password check and undo it on success, so
// concurrent requests cannot all slip past the limits.

import net from 'node:net';

const MAX_KEYS = 10_000;

/** Expand a valid IPv6 address (no zone id) to its 8 hextets, as numbers. */
function ipv6Groups(ip: string): number[] {
  let s = ip;
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number];
    s = `${s.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', tail] = s.split('::');
  const parse = (part: string) => (part ? part.split(':').map((g) => parseInt(g, 16)) : []);
  const h = parse(head);
  if (tail === undefined) return h;
  const t = parse(tail);
  return [...h, ...Array<number>(8 - h.length - t.length).fill(0), ...t];
}

/**
 * The rate-limit key for a client address. One IPv6 subscriber usually controls a whole /64
 * (2^64 addresses), so IPv6 addresses are grouped by their /64 network; IPv4-mapped IPv6
 * addresses (`::ffff:192.0.2.1`) count as the plain IPv4 address. Anything else (IPv4, or an
 * unparseable value such as 'unknown') is used as-is.
 */
export function limiterKey(ip: string): string {
  let s = ip.trim();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  s = s.replace(/%.*$/, ''); // zone id (fe80::1%eth0)
  if (!net.isIPv6(s)) return ip;
  const groups = ipv6Groups(s.toLowerCase());
  if (groups.length !== 8) return ip;
  // IPv4-mapped: 0:0:0:0:0:ffff:x:y
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const [hi, lo] = [groups[6]!, groups[7]!];
    return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.');
  }
  return `${groups
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(':')}::/64`;
}

export class FailureLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly maxFailures: number,
    private readonly windowMs: number,
    private readonly maxKeys = MAX_KEYS,
  ) {}

  /** True when the key has exhausted its attempts in the current window. */
  isBlocked(key: string, now = Date.now()): boolean {
    const entry = this.hits.get(key);
    if (!entry) return false;
    if (entry.resetAt <= now) {
      this.hits.delete(key);
      return false;
    }
    return entry.count >= this.maxFailures;
  }

  recordFailure(key: string, now = Date.now()): void {
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.delete(key);
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
    } else {
      entry.count++;
    }
    if (this.hits.size > this.maxKeys) this.prune(now);
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  /** Number of tracked keys (tests). */
  get size(): number {
    return this.hits.size;
  }

  /**
   * Bound memory without lifting blocks: drop expired windows, then the oldest NOT-blocked
   * keys, and only when every remaining key is blocked, the oldest blocked ones. Spraying fresh
   * addresses therefore cannot clear an existing block (it would need maxKeys blocked keys).
   */
  private prune(now: number): void {
    for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
    for (const [k, v] of this.hits) {
      if (this.hits.size <= this.maxKeys) return;
      if (v.count < this.maxFailures) this.hits.delete(k);
    }
    for (const k of this.hits.keys()) {
      if (this.hits.size <= this.maxKeys) return;
      this.hits.delete(k);
    }
  }
}

export interface GuessThrottleOptions {
  /** Failures per window before any slowdown. */
  freeFailures: number;
  windowMs: number;
  /** Spacing of the first throttled attempt; doubles with every further failure. */
  baseDelayMs: number;
  maxDelayMs: number;
  /** An attempt that would have to wait longer than this is refused at once (429). */
  maxWaitMs: number;
}

export const GUESS_THROTTLE_DEFAULTS: GuessThrottleOptions = {
  freeFailures: 20,
  windowMs: 15 * 60 * 1000,
  baseDelayMs: 250,
  maxDelayMs: 10_000,
  maxWaitMs: 15_000,
};

/**
 * Account-wide progressive slowdown (the app has a single account). Once more than
 * `freeFailures` failures happened in the window, attempts get time slots spaced
 * min(baseDelay · 2^(failures − free), maxDelay) apart, across all clients. Concurrency does not
 * help an attacker: the slots are sequential, so sustained guessing is capped at one attempt per
 * maxDelay, and a full queue answers 429 instead of piling up waiting requests.
 */
export class GuessThrottle {
  private failures = 0;
  private windowEnd = 0;
  private nextSlot = 0;
  private readonly opts: GuessThrottleOptions;

  constructor(opts: Partial<GuessThrottleOptions> = {}) {
    this.opts = { ...GUESS_THROTTLE_DEFAULTS, ...opts };
  }

  private roll(now: number): void {
    if (now >= this.windowEnd) {
      this.failures = 0;
      this.windowEnd = now + this.opts.windowMs;
    }
  }

  /**
   * Reserve the next attempt: the number of ms to wait before checking the password (0 while
   * under the free allowance), or null when the attempt must be refused right away.
   */
  reserve(now = Date.now()): number | null {
    this.roll(now);
    const over = this.failures - this.opts.freeFailures;
    if (over < 0) return 0;
    const delay = Math.min(this.opts.baseDelayMs * 2 ** over, this.opts.maxDelayMs);
    const slot = Math.max(now, this.nextSlot) + delay;
    if (slot - now > this.opts.maxWaitMs) return null;
    this.nextSlot = slot;
    return slot - now;
  }

  recordFailure(now = Date.now()): void {
    this.roll(now);
    this.failures++;
  }

  /** Undo the failure recorded for an attempt that turned out to succeed. */
  forgive(): void {
    if (this.failures > 0) this.failures--;
  }

  /** Failures counted in the current window (tests). */
  get count(): number {
    return this.failures;
  }
}
