import { describe, expect, it } from 'vitest';
import { limiterKey } from '../src/core/net';
import { createTestContext } from './helpers';
import { fakeClock } from './support/directoryHarness';

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

describe('sign-in rate limiting (API)', () => {
  const wrong = { identifier: 'owner@example.com', password: 'definitely wrong' };

  it('limits a whole IPv6 /64, not each address, and IPv4-mapped clients as IPv4', async () => {
    const ctx = createTestContext({ trustProxy: true });
    await ctx.signedIn({ password: 'correct horse battery' });
    const from = (ip: string) => ctx.client().request('POST', '/api/auth/login', wrong, { 'X-Forwarded-For': ip });

    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await from(`2001:db8:1:2::${(0x64 + i).toString(16)}`)).status);
    expect(statuses).toEqual([...Array(10).fill(401), 429, 429]);
    // The right password from yet another address in that /64 is blocked too ...
    const owner = { identifier: 'owner@example.com', password: 'correct horse battery' };
    const blocked = await ctx.client().request('POST', '/api/auth/login', owner, { 'X-Forwarded-For': '2001:db8:1:2::ffff' });
    expect(blocked.status).toBe(429);
    // ... but not from another network.
    const ok = await ctx.client().request('POST', '/api/auth/login', owner, { 'X-Forwarded-For': '2001:db8:9:9::1' });
    expect(ok.status).toBe(200);

    for (let i = 0; i < 10; i++) await from('::ffff:198.51.100.7');
    expect((await from('198.51.100.7')).status).toBe(429);
  });

  it('slows sign-in down account-wide once failures pile up from many networks', async () => {
    const clock = fakeClock(Date.now());
    const ctx = createTestContext({ config: { trustProxy: true }, clock });
    await ctx.signedIn({ password: 'correct horse battery' });
    const from = (n: number) =>
      ctx.client().request('POST', '/api/auth/login', wrong, { 'X-Forwarded-For': `2001:db8:${n.toString(16)}::1` });
    // 20 free failures, each from a different /64 (the per-network limit never triggers).
    for (let i = 0; i < 20; i++) expect((await from(i)).status).toBe(401);
    // §5.9 (lid): each further failure n spaces the account's attempts out by 250 ms · 2^(n − 20), and an
    // attempt before its slot answers 429 with Retry-After instead of waiting (the old limiter slept).
    expect((await from(100)).status).toBe(401); // the 21st: the next slot is 500 ms away
    const early = await from(101);
    expect(early.status).toBe(429);
    expect(early.headers.get('Retry-After')).toBe('1');
    clock.advance(500);
    expect((await from(102)).status).toBe(401); // the 22nd: 1 s
    expect((await from(103)).status).toBe(429);
    clock.advance(999);
    expect((await from(104)).status).toBe(429);
    clock.advance(1);
    // A successful sign-in still works (after its slot) and is not counted as a failure.
    const owner = { identifier: 'owner@example.com', password: 'correct horse battery' };
    const res = await ctx.client().request('POST', '/api/auth/login', owner, { 'X-Forwarded-For': '2001:db8:ffff::1' });
    expect(res.status).toBe(200);
  }, 15_000);
});
