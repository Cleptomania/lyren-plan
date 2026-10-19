// Equal failure latency on Cloudflare (design §5.5, §13.6, Appendix D 38), measured in workerd through the
// real Worker and DirectoryDO: a failed sign-in must not tell an unknown address from a known one, whether
// its stored hash has the target parameters or older, cheaper ones, or the account is disabled; and a
// locked-out identifier answers 429 alike, known or not. Each case is sent N times through SELF.fetch, and
// the wall-clock times this test observes are compared (medians). Every request comes from its own address
// (its own /24), so that the per-address limits never answer for the case.
//
// Locally workerd's clock also moves while code runs (production's moves only at I/O), so these runs show
// the padding to the floor; the equal KDF work that stands in for it where the clock stands still is what
// the expected costs below are about: without both, the cheap hash would answer a hash's cost sooner.

import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { randomToken, toBase64 } from '../src/core/crypto';
import { verifyPasswordHash } from '../src/directory/passwords';
import { inDirectory, ORIGIN, PASSWORD, setupOwner } from './support';

const N = 10;
const WRONG = 'not the right password';

let next = 0;
/** A fresh client address for every request: 10.<a>.<b>.1, a /24 of its own. */
const address = () => {
  next += 1;
  return `10.${(next >> 8) & 255}.${next & 255}.1`;
};

async function login(identifier: string, password = WRONG): Promise<{ status: number; ms: number }> {
  const started = performance.now();
  const res = await SELF.fetch(`${ORIGIN}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Lyren-Request': '1', 'CF-Connecting-IP': address() },
    body: JSON.stringify({ identifier, password }),
  });
  await res.arrayBuffer();
  return { status: res.status, ms: performance.now() - started };
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
};

/** A pbkdf2 hash with 10,000 iterations, the cheapest parameters verify accepts (an older account's). */
function cheapHash(password: string): string {
  const salt = randomBytes(16);
  const key = pbkdf2Sync(password.normalize('NFKC'), salt, 10_000, 32, 'sha256');
  return `pbkdf2-sha256$10000$${toBase64(salt)}$${toBase64(key)}`;
}

async function addUser(email: string, hash: string, status: 'active' | 'disabled' = 'active'): Promise<number> {
  return inDirectory((db) => {
    const now = new Date().toISOString();
    return db.get<{ id: number }>(
      `INSERT INTO users (email, email_key, display_name, password_hash, webauthn_user_id, status, created_at, updated_at)
       VALUES (:email, :email, :name, :hash, :handle, :status, :now, :now) RETURNING id`,
      { email, name: email.split('@')[0], hash, handle: randomToken(32), status, now },
    )!.id;
  });
}

const CASES = {
  unknown: 'nobody@example.com',
  target: 'target@example.com',
  cheap: 'cheap@example.com',
  disabled: 'disabled@example.com',
};

describe('failed sign-ins answer alike (§5.5)', () => {
  let targetHash = '';

  beforeAll(async () => {
    await setupOwner();
    targetHash = (await inDirectory((db) => db.get<{ password_hash: string }>('SELECT password_hash FROM users')))!.password_hash;
    // Accounts added before the first failure: the parameter sets in use are read then.
    await addUser(CASES.target, targetHash);
    await addUser(CASES.cheap, cheapHash(PASSWORD));
    await addUser(CASES.disabled, targetHash, 'disabled');
    // Warm up: the dummy hashes and the floor's measurements happen at the first failures.
    for (const identifier of Object.values(CASES)) expect((await login(identifier)).status).toBe(401);
  });

  it(`a wrong password, an unknown address, an older cheaper hash and a disabled account (${N} each)`, async () => {
    const times: Record<string, number[]> = Object.fromEntries(Object.keys(CASES).map((k) => [k, []]));
    for (let round = 0; round < N; round++) {
      for (const [name, identifier] of Object.entries(CASES)) {
        const { status, ms } = await login(identifier);
        expect(status, name).toBe(401);
        times[name]!.push(ms);
      }
    }
    // What the checks cost by themselves (no padding): the gap a cheap hash would leave.
    const raw = async (stored: string) => {
      const started = performance.now();
      await verifyPasswordHash(WRONG, stored);
      return performance.now() - started;
    };
    const costs = async (stored: string) => {
      const ms: number[] = [];
      for (let i = 0; i < 3; i++) ms.push(await raw(stored));
      return median(ms);
    };
    const targetCost = await costs(targetHash);
    const cheapCost = await costs(cheapHash(PASSWORD));
    const medians = Object.fromEntries(Object.entries(times).map(([name, ms]) => [name, median(ms)]));
    console.log(
      `[padding] medians of ${N} (ms): ${JSON.stringify(Object.fromEntries(Object.entries(medians).map(([k, v]) => [k, Math.round(v * 10) / 10])))}; ` +
        `min/max: ${JSON.stringify(Object.fromEntries(Object.entries(times).map(([k, v]) => [k, [Math.round(Math.min(...v)), Math.round(Math.max(...v))]])))}; ` +
        `one verification alone: target ${targetCost.toFixed(1)}, cheap ${cheapCost.toFixed(1)}`,
    );
    const spread = Math.max(...Object.values(medians)) - Math.min(...Object.values(medians));
    // Without the padding and the equal work, the cheap hash would answer about (target - cheap) sooner.
    expect(targetCost - cheapCost).toBeGreaterThan(5);
    expect(spread).toBeLessThan(Math.max(4, (targetCost - cheapCost) / 2));
  });

  it('a locked-out identifier answers 429 before any hash, known or not', async () => {
    const until = new Date(Date.now() + 60_000).toISOString();
    const cheapId = (await inDirectory((db) => db.get<{ id: number }>('SELECT id FROM users WHERE email_key = :key', { key: CASES.cheap })))!.id;
    const locked = { known: CASES.cheap, unknown: 'locked-out@example.com' };
    await inDirectory((db) => {
      for (const key of [`lid:a:${cheapId}`, `lid:i:${locked.unknown}`]) {
        db.run(
          `INSERT INTO auth_throttle (key, window_start, count, blocked_until) VALUES (:key, :now, 25, :until)
           ON CONFLICT (key) DO UPDATE SET count = excluded.count, blocked_until = excluded.blocked_until`,
          {
            key,
            now: new Date().toISOString(),
            until,
          },
        );
      }
    });
    const times: Record<string, number[]> = { known: [], unknown: [] };
    for (let round = 0; round < N; round++) {
      for (const [name, identifier] of Object.entries(locked)) {
        const { status, ms } = await login(identifier, PASSWORD);
        expect(status, name).toBe(429);
        times[name]!.push(ms);
      }
    }
    const known = median(times.known!);
    const unknown = median(times.unknown!);
    console.log(`[padding] locked out (429), medians of ${N} (ms): known ${known.toFixed(1)}, unknown ${unknown.toFixed(1)}`);
    expect(Math.abs(known - unknown)).toBeLessThan(4);
  });
});
