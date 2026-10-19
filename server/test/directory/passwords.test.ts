// Password hashing (directory/passwords.ts, design §5.5): both formats, the parameter caps, the rehash
// decision, the failure floor with an injected clock, sleep and measurement, and the hash queue.

import { pbkdf2Sync, randomBytes, scryptSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { APP_VERSION } from '../../src/core/version';
import { migrate } from '../../src/core/migrate';
import { hashPrefix, HASH_CONCURRENCY, PasswordHasher, verifyPasswordHash } from '../../src/directory/passwords';
import { DIRECTORY_MIGRATIONS } from '../../src/directory/schema';
import { NodeDb } from '../../src/runtime/node/nodeDb';
import { fakeClock } from '../support/directoryHarness';

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

/** A hash in the format before the multi-user upgrade (auth/passwords.ts: p = 1, 64-byte key). */
function legacyHash(password: string, o: { n?: number; r?: number; p?: number } = {}): string {
  const { n = 16384, r = 8, p = 1 } = o;
  const salt = randomBytes(16);
  const key = scryptSync(password.normalize('NFKC'), salt, 64, { N: n, r, p, maxmem: 256 * 1024 * 1024 });
  return ['scrypt', n, r, p, b64(salt), b64(key)].join('$');
}

function directoryDb(): NodeDb {
  const db = new NodeDb(':memory:');
  migrate(db, DIRECTORY_MIGRATIONS, { appVersion: APP_VERSION });
  return db;
}

function addHash(db: NodeDb, hash: string, n: number) {
  db.run(
    `INSERT INTO users (email, email_key, display_name, password_hash, webauthn_user_id, created_at, updated_at)
     VALUES (:e, :e, 'U', :hash, :handle, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    { e: `u${n}@example.com`, hash, handle: `handle-${n}` },
  );
}

describe('password formats', () => {
  it('verifies the format from before the upgrade, and hashes with the target', async () => {
    const stored = legacyHash('correct horse');
    expect(await verifyPasswordHash('correct horse', stored)).toBe(true);
    expect(await verifyPasswordHash('wrong horse', stored)).toBe(false);
    const hasher = new PasswordHasher({ target: { kdf: 'scrypt', scryptP: 2 }, clock: fakeClock() });
    const fresh = await hasher.hash('correct horse');
    expect(fresh).toMatch(/^scrypt\$16384\$8\$2\$[A-Za-z0-9+/]+=*\$[A-Za-z0-9+/]+=*$/);
    expect(await verifyPasswordHash('correct horse', fresh)).toBe(true);
  });

  it('pbkdf2-sha256: 100,000 iterations, a 32-byte key; verifies its own and hand-made hashes', async () => {
    const hasher = new PasswordHasher({ target: { kdf: 'pbkdf2', scryptP: 1 }, clock: fakeClock() });
    const fresh = await hasher.hash('pässword');
    expect(fresh.split('$').slice(0, 2)).toEqual(['pbkdf2-sha256', '100000']);
    expect(Buffer.from(fresh.split('$')[3]!, 'base64')).toHaveLength(32);
    expect(await verifyPasswordHash('pässword', fresh)).toBe(true);
    const salt = randomBytes(16);
    const manual = `pbkdf2-sha256$20000$${b64(salt)}$${b64(pbkdf2Sync('x', salt, 20000, 32, 'sha256'))}`;
    expect(await verifyPasswordHash('x', manual)).toBe(true);
  });

  it('normalizes with NFKC, as before (switching would break existing hashes)', async () => {
    const stored = legacyHash('ﬁle'); // U+FB01 LATIN SMALL LIGATURE FI
    expect(await verifyPasswordHash('file', stored)).toBe(true);
  });

  it('refuses parameters outside the caps, and malformed strings, as false', async () => {
    const salt = b64(randomBytes(16));
    const key = b64(randomBytes(64));
    for (const stored of [
      `scrypt$262144$8$1$${salt}$${key}`, // N > 2^17
      `scrypt$16384$17$1$${salt}$${key}`, // r > 16
      `scrypt$16384$8$17$${salt}$${key}`, // p > 16
      `scrypt$131072$8$2$${salt}$${key}`, // N·r·p > 2^20
      `scrypt$1000$8$1$${salt}$${key}`, // N not a power of two
      `pbkdf2-sha256$9999$${salt}$${key}`,
      `pbkdf2-sha256$1000001$${salt}$${key}`,
      'scrypt$16384$8$1$onlysalt',
      'bcrypt$10$abc',
      '',
      `scrypt$16384$8$1$${salt}$!!!`,
    ]) {
      expect(await verifyPasswordHash('anything', stored), stored).toBe(false);
      expect(hashPrefix(stored), stored).toBeNull();
    }
    expect(hashPrefix(`scrypt$131072$8$1$${salt}$${key}`)).toBe('scrypt$131072$8$1');
  });
});

describe('PasswordHasher', () => {
  it('rehashes a match whose parameters differ from the target, in the same call', async () => {
    const hasher = new PasswordHasher({ target: { kdf: 'scrypt', scryptP: 2 }, clock: fakeClock() });
    const old = legacyHash('secret pass');
    expect(hasher.needsRehash(old)).toBe(true);
    const result = await hasher.verify('secret pass', old);
    expect(result.ok).toBe(true);
    expect(result.rehash).toMatch(/^scrypt\$16384\$8\$2\$/);
    expect(hasher.needsRehash(result.rehash!)).toBe(false);
    expect(await hasher.verify('secret pass', result.rehash!)).toEqual({ ok: true, rehash: null });
    expect(await hasher.verify('wrong', old)).toEqual({ ok: false, rehash: null });
    // No stored hash: the dummy is checked (same work) and the answer is false.
    expect(await hasher.verify('secret pass', null)).toEqual({ ok: false, rehash: null });
  });

  it('pads failures to the cost of the most expensive parameter set in use, the target included', async () => {
    const db = directoryDb();
    addHash(db, legacyHash('a'), 1); // scrypt$16384$8$1, cheaper than the target
    const clock = fakeClock();
    const costs: Record<string, number> = { 'scrypt$16384$8$1': 15, 'scrypt$16384$8$5': 70, 'scrypt$32768$8$1': 120 };
    const measured: string[] = [];
    const hasher = new PasswordHasher({
      target: { kdf: 'scrypt', scryptP: 5 },
      clock,
      sleep: clock.sleep,
      measure: async (prefix) => {
        measured.push(prefix);
        return costs[prefix] ?? 0;
      },
    });
    // A missing identifier and the cheaper hash both wait until the same floor, the target's 70 ms.
    let started = clock.now();
    clock.advance(10); // the dummy check took 10 ms
    await hasher.padFailure(db, started);
    started = clock.now();
    clock.advance(3); // the old hash took 3 ms
    await hasher.padFailure(db, started);
    expect(clock.sleeps).toEqual([60, 67]);
    expect(measured.sort()).toEqual(['scrypt$16384$8$1', 'scrypt$16384$8$5']);
    // Maintenance finds a more expensive set in use; the floor follows it.
    addHash(db, legacyHash('b', { n: 32768 }), 2);
    expect(await hasher.failureFloorMs(db)).toBe(70);
    await hasher.refresh(db);
    expect(await hasher.failureFloorMs(db)).toBe(120);
    // A failure that already took longer than the floor does not wait.
    started = clock.now();
    clock.advance(200);
    await hasher.padFailure(db, started);
    expect(clock.sleeps).toHaveLength(2);
  });

  it('ioClock (Cloudflare): the clock catches up at a 0 ms timer, so every failure ends at the same floor, the sum of the sets', async () => {
    const db = directoryDb();
    addHash(db, legacyHash('a'), 1); // scrypt$16384$8$1, cheaper than the target
    // A clock that, as Cloudflare's, stands still while code runs and catches up at I/O (a timer).
    let real = Date.parse('2026-10-17T12:00:00.000Z');
    let seen = real;
    const sleeps: number[] = [];
    const clock = { now: () => seen };
    const sleep = async (ms: number) => {
      sleeps.push(ms);
      real += ms;
      seen = real;
    };
    const costs: Record<string, number> = { 'scrypt$16384$8$1': 15, 'scrypt$16384$8$5': 70 };
    const hasher = new PasswordHasher({ target: { kdf: 'scrypt', scryptP: 5 }, clock, sleep, measure: async (prefix) => costs[prefix] ?? 0, ioClock: true });
    expect(await hasher.failureFloorMs(db)).toBe(85);
    // An unknown address (both sets verified: 85 ms that the clock does not see), then the cheaper hash.
    for (const took of [85, 85]) {
      const started = clock.now();
      real += took;
      await hasher.padFailure(db, started);
      expect(real - started).toBe(85);
    }
    expect(sleeps).toEqual([0, 0]);
    // Had the check been quicker than the floor, the wait makes up the rest.
    const started = clock.now();
    real += 30;
    await hasher.padFailure(db, started);
    expect(real - started).toBe(85);
    expect(sleeps.slice(-2)).toEqual([0, 55]);
  });

  it('ioClock (Cloudflare): a failed login verifies every parameter set in use, so a cheap hash fails as slowly as no account', async () => {
    const db = directoryDb();
    const cheap = (() => {
      const salt = randomBytes(16);
      return `pbkdf2-sha256$10000$${b64(salt)}$${b64(pbkdf2Sync('right'.normalize('NFKC'), salt, 10_000, 32, 'sha256'))}`;
    })();
    addHash(db, cheap, 1);
    /** The quickest of three failed checks, in ms (real time). */
    const timed = async (hasher: PasswordHasher, stored: string | null) => {
      let best = Infinity;
      for (let i = 0; i < 3; i++) {
        const started = performance.now();
        expect((await hasher.verify('wrong', stored, db)).ok).toBe(false);
        best = Math.min(best, performance.now() - started);
      }
      return best;
    };
    for (const ioClock of [true, false]) {
      const hasher = new PasswordHasher({ target: { kdf: 'scrypt', scryptP: 1 }, clock: fakeClock(), ioClock });
      await timed(hasher, null); // the dummy hashes are made once
      await timed(hasher, cheap);
      const unknown = await timed(hasher, null);
      const cheapFailure = await timed(hasher, cheap);
      if (ioClock) expect(cheapFailure / unknown).toBeGreaterThan(0.6);
      else expect(cheapFailure / unknown).toBeLessThan(0.4);
    }
    // A match is checked against its own hash only (and rehashed to the target).
    const hasher = new PasswordHasher({ target: { kdf: 'scrypt', scryptP: 1 }, clock: fakeClock(), ioClock: true });
    const match = await hasher.verify('right', cheap, db);
    expect(match.ok).toBe(true);
    expect(hashPrefix(match.rehash!)).toBe('scrypt$16384$8$1');
  });

  it(`refuses more than ${HASH_CONCURRENCY} hashes or verifications at once with 503`, async () => {
    const hasher = new PasswordHasher({ target: { kdf: 'scrypt', scryptP: 1 }, clock: fakeClock() });
    const running = Array.from({ length: HASH_CONCURRENCY }, () => hasher.hash('x'));
    expect(hasher.pending).toBe(HASH_CONCURRENCY);
    await expect(hasher.verify('x', null)).rejects.toMatchObject({
      status: 503,
      code: 'unavailable',
      headers: { 'Retry-After': '5' },
    });
    await Promise.all(running);
    expect(hasher.pending).toBe(0);
    expect(await hasher.verify('x', await hasher.hash('x'))).toEqual({ ok: true, rehash: null });
  });
});
