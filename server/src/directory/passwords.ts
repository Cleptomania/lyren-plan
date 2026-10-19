// Password hashing (design §5.5), with node:crypto on both runtimes (it works in workerd with
// nodejs_compat). Stored hashes describe themselves, so old ones keep verifying:
//   scrypt$<N>$<r>$<p>$<saltB64>$<hashB64>         (the format before the multi-user upgrade; 64-byte key)
//   pbkdf2-sha256$<iterations>$<saltB64>$<hashB64>  (32-byte key)
// Both with a 16-byte salt and NFKC-normalized passwords (switching to NFC would break existing hashes).
//
// New hashes use the target: PASSWORD_KDF (scrypt, N = 16384, r = 8, p = PASSWORD_SCRYPT_P; or pbkdf2
// with 100,000 iterations, the cap of workerd's KDF limits). After a successful check a hash that
// differs from the target is replaced in the same request (rehash on success).
//
// Timing: login always runs exactly one verification, against a dummy hash with the target parameters
// when the account is unknown or has no password, and every failed check is padded with a timer (no
// CPU; on a Durable Object it does not block other requests) up to the failure floor: the measured
// cost of the most expensive parameter set in use, the target included. Otherwise an account whose
// hash still has older, cheaper parameters would answer faster than an unknown address.
//
// On Cloudflare the clock moves only at I/O (Date.now() and performance.now() return the time of the
// last I/O, never advancing while code runs), so a check cannot see how long its hash took (ioClock,
// Appendix D 38): a failed login also verifies a dummy hash of every other parameter set in use, so
// every failure does the same KDF work whatever the account (in the usual case of one set, still exactly
// one verification); the padding first waits a 0 ms timer, after which the clock includes the CPU the
// check spent; and the floor, the sum of the sets' costs, is measured across such a timer too.
//
// At most HASH_CONCURRENCY hashes or verifications run at once per directory; one more is refused
// with 503 (Retry-After: 5). scrypt runs on the isolate thread in a Durable Object, so the queue bounds
// how long a login flood can stall every other directory request.

import { pbkdf2 as pbkdf2Callback, randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import type { PasswordKdf } from '../core/config';
import { fromBase64Url, randomToken, toBase64 } from '../core/crypto';
import type { Db } from '../core/db';
import type { Clock } from '../core/runtime';
import { unavailable } from '../http/errors';

export const HASH_CONCURRENCY = 4;

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_KEYLEN = 64;
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_KEYLEN = 32;
const SALT_BYTES = 16;
const HASH_MAXMEM = 64 * 1024 * 1024;
/** 128 · N · r of the largest parameters verify accepts (N · r · p ≤ 2^20), with room to spare. */
const VERIFY_MAXMEM = 256 * 1024 * 1024;

/** What verify accepts (workerd caps scrypt at N · r · p ≤ 2^20). */
const LIMITS = {
  scryptMaxN: 2 ** 17,
  scryptMaxR: 16,
  scryptMaxP: 16,
  scryptMaxCost: 2 ** 20,
  pbkdf2MinIterations: 10_000,
  pbkdf2MaxIterations: 1_000_000,
} as const;

export interface PasswordTarget {
  kdf: PasswordKdf;
  /** scrypt's p (PASSWORD_SCRYPT_P). */
  scryptP: number;
}

type Params =
  | { kdf: 'scrypt'; n: number; r: number; p: number }
  | { kdf: 'pbkdf2'; iterations: number };

interface ParsedHash {
  params: Params;
  salt: Uint8Array;
  key: Uint8Array;
}

function scrypt(password: string, salt: Uint8Array, keylen: number, options: ScryptOptions): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

function pbkdf2(password: string, salt: Uint8Array, iterations: number, keylen: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    pbkdf2Callback(password, salt, iterations, keylen, 'sha256', (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** The parameter set's prefix: `scrypt$N$r$p` or `pbkdf2-sha256$iterations`. */
function prefixOf(params: Params): string {
  return params.kdf === 'scrypt' ? `scrypt$${params.n}$${params.r}$${params.p}` : `pbkdf2-sha256$${params.iterations}`;
}

function targetParams(target: PasswordTarget): Params {
  return target.kdf === 'scrypt'
    ? { kdf: 'scrypt', n: SCRYPT_N, r: SCRYPT_R, p: target.scryptP }
    : { kdf: 'pbkdf2', iterations: PBKDF2_ITERATIONS };
}

const isCount = (text: string | undefined) => text !== undefined && /^[1-9]\d{0,9}$/.test(text);

/** The parameters of `scrypt$N$r$p` or `pbkdf2-sha256$iterations` when verify accepts them, else null. */
function parseParams(parts: readonly string[]): Params | null {
  if (parts[0] === 'scrypt' && parts.length === 4) {
    const [, n, r, p] = parts;
    if (!isCount(n) || !isCount(r) || !isCount(p)) return null;
    const params = { kdf: 'scrypt' as const, n: Number(n), r: Number(r), p: Number(p) };
    const powerOfTwo = params.n > 1 && (params.n & (params.n - 1)) === 0;
    const fits =
      params.n <= LIMITS.scryptMaxN &&
      params.r <= LIMITS.scryptMaxR &&
      params.p <= LIMITS.scryptMaxP &&
      params.n * params.r * params.p <= LIMITS.scryptMaxCost;
    return powerOfTwo && fits ? params : null;
  }
  if (parts[0] === 'pbkdf2-sha256' && parts.length === 2) {
    if (!isCount(parts[1])) return null;
    const iterations = Number(parts[1]);
    if (iterations < LIMITS.pbkdf2MinIterations || iterations > LIMITS.pbkdf2MaxIterations) return null;
    return { kdf: 'pbkdf2', iterations };
  }
  return null;
}

/** A stored hash whose parameters verify accepts, or null. */
function parseHash(stored: string): ParsedHash | null {
  const parts = stored.split('$');
  if (parts.length < 4) return null;
  const params = parseParams(parts.slice(0, -2));
  if (!params) return null;
  try {
    const salt = fromBase64Url(parts.at(-2)!);
    const key = fromBase64Url(parts.at(-1)!);
    return key.length > 0 && key.length <= 128 && salt.length <= 128 ? { params, salt, key } : null;
  } catch {
    return null;
  }
}

function derive(password: string, params: Params, salt: Uint8Array, keylen: number, maxmem: number): Promise<Uint8Array> {
  const normalized = password.normalize('NFKC');
  return params.kdf === 'scrypt'
    ? scrypt(normalized, salt, keylen, { N: params.n, r: params.r, p: params.p, maxmem })
    : pbkdf2(normalized, salt, params.iterations, keylen);
}

async function hashWith(password: string, params: Params): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const keylen = params.kdf === 'scrypt' ? SCRYPT_KEYLEN : PBKDF2_KEYLEN;
  const key = await derive(password, params, salt, keylen, HASH_MAXMEM);
  return `${prefixOf(params)}$${toBase64(salt)}$${toBase64(key)}`;
}

/** Whether `password` matches `stored`. Malformed hashes, refused parameters and KDF errors are false. */
export async function verifyPasswordHash(password: string, stored: string): Promise<boolean> {
  const parsed = parseHash(stored);
  if (!parsed) return false;
  try {
    const actual = await derive(password, parsed.params, parsed.salt, parsed.key.length, VERIFY_MAXMEM);
    return actual.length === parsed.key.length && timingSafeEqual(actual, parsed.key);
  } catch {
    return false; // a RangeError for parameters this runtime refuses
  }
}

/** The parameter-set prefix of a stored hash, or null when verify would refuse it. */
export function hashPrefix(stored: string): string | null {
  const parsed = parseHash(stored);
  return parsed ? prefixOf(parsed.params) : null;
}

export interface PasswordHasherOptions {
  target: PasswordTarget;
  clock: Clock;
  /** The failure padding's timer (default setTimeout). */
  sleep?: (ms: number) => Promise<void>;
  /** The cost in ms of one hash with a parameter set (default: hash a constant once and time it). */
  measure?: (prefix: string) => Promise<number>;
  /**
   * The clock moves only at I/O, not while code runs (Cloudflare): failures do equal KDF work, and the
   * padding and the measurement let the clock catch up at a 0 ms timer (see the header).
   */
  ioClock?: boolean;
}

export interface VerifyResult {
  ok: boolean;
  /** A new hash with the target parameters, when `ok` and the stored one differs from the target. */
  rehash: string | null;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Time one hash of a constant with the parameters of `prefix` (performance.now: real time, not the app's
 * clock). With `ioClock` the time is read after a 0 ms timer, since that clock moves only at I/O.
 */
async function measureCost(prefix: string, ioClock: boolean): Promise<number> {
  const params = parseParams(prefix.split('$'));
  if (!params) return 0;
  const keylen = params.kdf === 'scrypt' ? SCRYPT_KEYLEN : PBKDF2_KEYLEN;
  const started = performance.now();
  try {
    await derive('lyren-plan failure floor', params, new Uint8Array(SALT_BYTES), keylen, VERIFY_MAXMEM);
  } catch {
    return 0;
  }
  if (ioClock) await new Promise((resolve) => setTimeout(resolve, 0));
  return performance.now() - started;
}

/** One directory's hashing: the target KDF, the hash queue, the dummy hash and the failure floor. */
export class PasswordHasher {
  private readonly target: Params;
  private readonly targetPrefix: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly measure: (prefix: string) => Promise<number>;
  private active = 0;
  /** Dummy hashes by parameter-set prefix, each computed once. */
  private readonly dummies = new Map<string, Promise<string>>();
  /** Prefixes of the stored hashes (null until read); the floor covers these and the target. */
  private inUse: Set<string> | null = null;
  private readonly costs = new Map<string, Promise<number>>();

  constructor(private readonly options: PasswordHasherOptions) {
    this.target = targetParams(options.target);
    this.targetPrefix = prefixOf(this.target);
    this.sleep = options.sleep ?? defaultSleep;
    this.measure = options.measure ?? ((prefix) => measureCost(prefix, options.ioClock === true));
  }

  /** Hashes and verifications queued or running. */
  get pending(): number {
    return this.active;
  }

  /**
   * The queue's 503 now, when it is full. A check that counts an attempt before it runs (login, re-auth)
   * asks first, with no await before its verify, so a check the queue refuses counts as no attempt.
   */
  assertCapacity(): void {
    if (this.active >= HASH_CONCURRENCY) {
      throw unavailable('Too many sign-ins at the moment. Try again in a few seconds.', 5);
    }
  }

  /** A new hash with the target parameters (through the queue). */
  hash(password: string): Promise<string> {
    return this.queued(() => hashWith(password, this.target));
  }

  /**
   * Check `password` against `stored`, or against the dummy hash when there is none (so the work is the
   * same). Through the queue; a match whose parameters differ from the target is rehashed in the same
   * slot. Failures are not padded here: see padFailure. With ioClock and `db` (login), a failure also
   * verifies a dummy hash of every other parameter set in use, in the same slot, so that every failed
   * login does the same KDF work.
   */
  verify(password: string, stored: string | null, db?: Db): Promise<VerifyResult> {
    return this.queued(async () => {
      const ok = await verifyPasswordHash(password, stored ?? (await this.dummyFor(this.targetPrefix)));
      if (ok && stored !== null) {
        return { ok: true, rehash: this.needsRehash(stored) ? await hashWith(password, this.target) : null };
      }
      if (this.options.ioClock && db) {
        const checked = stored === null ? this.targetPrefix : hashPrefix(stored);
        this.inUse ??= readPrefixes(db);
        for (const prefix of this.prefixesInUse()) {
          if (prefix !== checked) await verifyPasswordHash(password, await this.dummyFor(prefix));
        }
      }
      return { ok: false, rehash: null };
    });
  }

  /** A stored hash differs from the target (another algorithm or other parameters). */
  needsRehash(stored: string): boolean {
    return hashPrefix(stored) !== this.targetPrefix;
  }

  /** Wait until `startedAt` (the app clock's ms) plus the failure floor. */
  async padFailure(db: Db, startedAt: number): Promise<void> {
    const floor = await this.failureFloorMs(db);
    // ioClock: the clock has stood still since the last I/O; a timer lets it catch up with the check.
    if (this.options.ioClock) await this.sleep(0);
    const wait = startedAt + floor - this.options.clock.now();
    if (wait > 0) await this.sleep(wait);
  }

  /**
   * The measured cost of the most expensive parameter set in use, the target included; with ioClock the
   * sum of their costs (a failure verifies each of them, see verify).
   */
  async failureFloorMs(db: Db): Promise<number> {
    this.inUse ??= readPrefixes(db);
    const costs: number[] = [];
    // One at a time: measurements that overlapped would each count the others' work.
    for (const prefix of this.prefixesInUse()) costs.push(await this.cost(prefix));
    return this.options.ioClock ? costs.reduce((sum, cost) => sum + cost, 0) : Math.max(0, ...costs);
  }

  /** Maintenance (hourly): read the parameter sets in use again, and measure new ones. */
  async refresh(db: Db): Promise<void> {
    this.inUse = readPrefixes(db);
    await this.failureFloorMs(db);
  }

  private cost(prefix: string): Promise<number> {
    let cost = this.costs.get(prefix);
    if (!cost) {
      cost = this.measure(prefix).catch(() => 0);
      this.costs.set(prefix, cost);
    }
    return cost;
  }

  /** The target and the parameter sets of the stored hashes (as last read). */
  private prefixesInUse(): Set<string> {
    return new Set([this.targetPrefix, ...(this.inUse ?? [])]);
  }

  /** A hash of a random password with the parameters of `prefix`, computed once. */
  private dummyFor(prefix: string): Promise<string> {
    let dummy = this.dummies.get(prefix);
    if (!dummy) {
      const params = parseParams(prefix.split('$')) ?? this.target;
      dummy = hashWith(randomToken(16), params);
      this.dummies.set(prefix, dummy);
    }
    return dummy;
  }

  private async queued<T>(fn: () => Promise<T>): Promise<T> {
    this.assertCapacity();
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
    }
  }
}

/** The parameter sets of every stored password hash (one pass over users). */
function readPrefixes(db: Db): Set<string> {
  const prefixes = new Set<string>();
  for (const row of db.all<{ password_hash: string }>('SELECT password_hash FROM users WHERE password_hash IS NOT NULL')) {
    const prefix = hashPrefix(row.password_hash);
    if (prefix) prefixes.add(prefix);
  }
  return prefixes;
}
