// Device cookies (design §5.8.2): issued after a successful sign-in, refreshed rather than multiplied,
// at most 10 per account, and the exemption they give the account's own browsers from the per-account
// and instance-wide login limits that a stranger can trip.

import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../../src/core/crypto';
import { createDirectoryHarness, OWNER_EMAIL, PASSWORD } from '../support/directoryHarness';

describe('device cookies', () => {
  it('a sign-in sets one (HttpOnly, a year); the next sign-in from that browser keeps it', async () => {
    const h = createDirectoryHarness();
    await h.setup();
    const c = h.client();
    const first = await c.post('/api/auth/login', { identifier: OWNER_EMAIL, password: PASSWORD });
    const cookie = first.setCookies.find((v) => v.startsWith('lyren_device='))!;
    expect(cookie).toMatch(/^lyren_device=[A-Za-z0-9_-]{43}; Max-Age=31536000; Path=\/; HttpOnly; SameSite=Lax$/);
    const token = c.jar.get('lyren_device')!;
    const second = await c.post('/api/auth/login', { identifier: OWNER_EMAIL, password: PASSWORD });
    expect(second.setCookies.some((v) => v.startsWith('lyren_device='))).toBe(false);
    expect(c.jar.get('lyren_device')).toBe(token);
    expect(h.db.all('SELECT token_hash FROM device_tokens WHERE token_hash = :h', { h: sha256Hex(token) })).toHaveLength(1);
  });

  it('on HTTPS it is __Host-lyren_device', async () => {
    const h = createDirectoryHarness();
    await h.setup();
    const res = await h.client({ secure: true }).post('/api/auth/login', { identifier: OWNER_EMAIL, password: PASSWORD });
    expect(res.setCookies.find((v) => v.startsWith('__Host-lyren_device='))).toMatch(/; Max-Age=31536000; Path=\/; HttpOnly; Secure; SameSite=Lax$/);
  });

  it('keeps at most 10 per account, replacing the least recently used', async () => {
    const h = createDirectoryHarness();
    await h.setup();
    const browsers = [];
    for (let i = 0; i < 11; i++) {
      h.clock.advance(1000);
      const c = h.client();
      await c.post('/api/auth/login', { identifier: OWNER_EMAIL, password: PASSWORD });
      browsers.push(c);
    }
    // 12 sign-ins in all (setup included): the setup browser's and the first login's tokens are gone.
    expect(h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM device_tokens')!.n).toBe(10);
    const stored = new Set(h.db.all<{ token_hash: string }>('SELECT token_hash FROM device_tokens').map((r) => r.token_hash));
    expect(stored.has(sha256Hex(browsers[0]!.jar.get('lyren_device')!))).toBe(false);
    expect(stored.has(sha256Hex(browsers[10]!.jar.get('lyren_device')!))).toBe(true);
  });

  it("exempts the account's own browser from the per-account limit a stranger tripped", async () => {
    const h = createDirectoryHarness();
    const { client: own } = await h.setup();
    await own.post('/api/auth/logout');
    // A stranger, rotating addresses, fails 25 times for this account: lid blocks untrusted browsers.
    for (let i = 0; i < 25; i++) {
      h.clock.advance(11_000);
      await h.client({ ip: `203.0.113.${i + 1}` }).post('/api/auth/login', { identifier: OWNER_EMAIL, password: 'guess guess' });
    }
    const stranger = await h.client({ ip: '198.51.100.99' }).post('/api/auth/login', { identifier: OWNER_EMAIL, password: PASSWORD });
    expect(stranger.status).toBe(429);
    // The owner's browser still has its device token from setup.
    const res = await own.post('/api/auth/login', { identifier: OWNER_EMAIL, password: PASSWORD });
    expect(res.status).toBe(200);
  });

  it('does not exempt a browser whose device token belongs to another account', async () => {
    const h = createDirectoryHarness();
    const { client: own, spaceId } = await h.setup();
    const other = await h.addUser({ email: 'other@example.com', spaceId });
    for (let i = 0; i < 25; i++) {
      h.clock.advance(11_000);
      await h.client({ ip: `203.0.113.${i + 1}` }).post('/api/auth/login', { identifier: 'other@example.com', password: 'guess guess' });
    }
    await own.post('/api/auth/logout');
    // The owner's browser carries the owner's device token, not other's: no exemption for other.
    expect((await own.post('/api/auth/login', { identifier: 'other@example.com', password: PASSWORD })).status).toBe(429);
    expect((await other.client.post('/api/auth/login', { identifier: 'other@example.com', password: PASSWORD })).status).toBe(200);
  });
});
