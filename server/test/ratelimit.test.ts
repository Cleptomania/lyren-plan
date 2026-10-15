import { describe, expect, it } from 'vitest';
import { FailureLimiter, GuessThrottle, limiterKey } from '../src/auth/rateLimit';
import { createTestContext } from './helpers';

describe('limiterKey', () => {
  it('groups IPv6 addresses by /64 and unwraps IPv4-mapped addresses', () => {
    expect(limiterKey('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64');
    expect(limiterKey('2001:db8:1:2::ffff')).toBe('2001:db8:1:2::/64');
    expect(limiterKey('2001:0DB8:0001:0002:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64');
    expect(limiterKey('2001:db8:1:3::1')).toBe('2001:db8:1:3::/64');
    expect(limiterKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(limiterKey('::1')).toBe('0:0:0:0::/64');
    expect(limiterKey('::')).toBe('0:0:0:0::/64');
    expect(limiterKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(limiterKey('[2001:db8:1:2::9]')).toBe('2001:db8:1:2::/64');
    expect(limiterKey('64:ff9b::192.0.2.1')).toBe('64:ff9b:0:0::/64');
    // IPv4-mapped IPv6 (a dual-stack socket) is the IPv4 client itself.
    expect(limiterKey('::ffff:192.0.2.1')).toBe('192.0.2.1');
    expect(limiterKey('::FFFF:192.0.2.1')).toBe('192.0.2.1');
    expect(limiterKey('0:0:0:0:0:ffff:c000:201')).toBe('192.0.2.1');
    // IPv4 and anything unparseable pass through unchanged.
    expect(limiterKey('192.0.2.1')).toBe('192.0.2.1');
    expect(limiterKey('unknown')).toBe('unknown');
    expect(limiterKey('not:an:address')).toBe('not:an:address');
  });
});

describe('FailureLimiter', () => {
  it('blocks after maxFailures within the window and forgets after it', () => {
    const l = new FailureLimiter(3, 1000);
    for (let i = 0; i < 3; i++) l.recordFailure('a', 0);
    expect(l.isBlocked('a', 10)).toBe(true);
    expect(l.isBlocked('b', 10)).toBe(false);
    expect(l.isBlocked('a', 1000)).toBe(false);
  });

  it('prunes expired and unblocked keys first, so spraying addresses cannot lift a block', () => {
    const l = new FailureLimiter(3, 1000, 50);
    for (let i = 0; i < 3; i++) l.recordFailure('blocked', 0);
    // 500 one-off failures from fresh addresses: far more than maxKeys.
    for (let i = 0; i < 500; i++) l.recordFailure(`spray-${i}`, 1);
    expect(l.size).toBeLessThanOrEqual(50);
    expect(l.isBlocked('blocked', 2)).toBe(true);
    // Expired windows go first.
    const e = new FailureLimiter(3, 1000, 5);
    for (let i = 0; i < 5; i++) e.recordFailure(`old-${i}`, 0);
    for (let i = 0; i < 3; i++) e.recordFailure('new', 2000);
    expect(e.size).toBe(1);
    expect(e.isBlocked('new', 2000)).toBe(true);
    // Only when every key is blocked do the oldest blocked keys go (memory stays bounded).
    const all = new FailureLimiter(1, 1000, 3);
    for (let i = 0; i < 10; i++) all.recordFailure(`k${i}`, 0);
    expect(all.size).toBe(3);
    expect(all.isBlocked('k9', 1)).toBe(true);
  });
});

describe('GuessThrottle', () => {
  const opts = { freeFailures: 3, windowMs: 60_000, baseDelayMs: 100, maxDelayMs: 1000, maxWaitMs: 2500 };

  it('lets the free allowance through, then spaces attempts out progressively', () => {
    const t = new GuessThrottle(opts);
    for (let i = 0; i < 3; i++) {
      expect(t.reserve(0)).toBe(0);
      t.recordFailure(0);
    }
    const waits: Array<number | null> = [];
    for (let i = 0; i < 6; i++) {
      waits.push(t.reserve(0));
      t.recordFailure(0);
    }
    // Sequential slots: 100, +200, +400, +800, +1000 (maxDelay) cumulative; then a wait would
    // exceed maxWait (2500), so the attempt is refused.
    expect(waits).toEqual([100, 300, 700, 1500, 2500, null]);
    // Later, the spacing stays at maxDelay while failures continue.
    expect(t.reserve(10_000)).toBe(1000);
  });

  it('does not count successes and resets with the window', () => {
    const t = new GuessThrottle(opts);
    for (let i = 0; i < 3; i++) t.recordFailure(0);
    t.forgive();
    expect(t.count).toBe(2);
    expect(t.reserve(0)).toBe(0);
    t.recordFailure(0);
    t.recordFailure(0);
    expect(t.reserve(1)).toBeGreaterThan(0);
    expect(t.reserve(60_000)).toBe(0); // new window
    expect(t.count).toBe(0);
  });
});

describe('sign-in rate limiting (API)', () => {
  const wrong = { username: 'owner', password: 'definitely wrong' };

  it('limits a whole IPv6 /64, not each address, and IPv4-mapped clients as IPv4', async () => {
    const ctx = createTestContext({ trustProxy: true });
    await ctx.signedIn({ password: 'correct horse battery' });
    const from = (ip: string) => ctx.client().request('POST', '/api/auth/login', wrong, { 'X-Forwarded-For': ip });

    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await from(`2001:db8:1:2::${(0x64 + i).toString(16)}`)).status);
    expect(statuses).toEqual([...Array(10).fill(401), 429, 429]);
    // The right password from yet another address in that /64 is blocked too ...
    const owner = { username: 'owner', password: 'correct horse battery' };
    const blocked = await ctx.client().request('POST', '/api/auth/login', owner, { 'X-Forwarded-For': '2001:db8:1:2::ffff' });
    expect(blocked.status).toBe(429);
    // ... but not from another network.
    const ok = await ctx.client().request('POST', '/api/auth/login', owner, { 'X-Forwarded-For': '2001:db8:9:9::1' });
    expect(ok.status).toBe(200);

    for (let i = 0; i < 10; i++) await from('::ffff:198.51.100.7');
    expect((await from('198.51.100.7')).status).toBe(429);
  });

  it('slows sign-in down account-wide once failures pile up from many networks', async () => {
    const ctx = createTestContext({ trustProxy: true });
    await ctx.signedIn({ password: 'correct horse battery' });
    const from = (n: number) =>
      ctx.client().request('POST', '/api/auth/login', wrong, { 'X-Forwarded-For': `2001:db8:${n.toString(16)}::1` });
    // 20 free failures, each from a different /64 (the per-network limit never triggers).
    for (let i = 0; i < 20; i++) expect((await from(i)).status).toBe(401);
    const timed = async (n: number) => {
      const t0 = performance.now();
      const res = await from(n);
      return { status: res.status, ms: performance.now() - t0 };
    };
    const a = await timed(100);
    const b = await timed(101);
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.ms).toBeGreaterThanOrEqual(240); // 250 ms
    expect(b.ms).toBeGreaterThanOrEqual(490); // 500 ms
    // A successful sign-in still works (after its slot) and is not counted as a failure.
    const owner = { username: 'owner', password: 'correct horse battery' };
    const res = await ctx.client().request('POST', '/api/auth/login', owner, { 'X-Forwarded-For': '2001:db8:ffff::1' });
    expect(res.status).toBe(200);
  }, 15_000);
});
