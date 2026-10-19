import { describe, expect, it } from 'vitest';
import { createTestContext } from './helpers';

describe('auth', () => {
  it('reports setup required, then completes setup once', async () => {
    const ctx = createTestContext();
    const anon = ctx.client();
    const status = await anon.get('/api/auth/status');
    expect(status.status).toBe(200);
    expect(status.body.setupRequired).toBe(true);
    expect(status.body.user).toBeNull();

    const { client, user } = await ctx.signedIn();
    // §5.1: accounts sign in by email; only accounts from before the upgrade have a username.
    expect(user.email).toBe('owner@example.com');
    expect(client.cookie).toMatch(/^lyren_session=/);

    const again = await ctx.client().post('/api/auth/setup', {
      email: 'other@example.com', password: 'password123', displayName: 'Other',
    });
    expect(again.status).toBe(409);

    const s2 = await client.get('/api/auth/status');
    expect(s2.body.setupRequired).toBe(false);
    expect(s2.body.user.email).toBe('owner@example.com');
  });

  // §7.2: /api/auth/me moved to /api/account.
  it('protects API routes and requires the CSRF header on mutations', async () => {
    const ctx = createTestContext();
    const { client } = await ctx.signedIn();
    expect((await ctx.client().get('/api/account')).status).toBe(401);
    expect((await client.get('/api/account')).status).toBe(200);
    const res = await client.request('PATCH', '/api/account', { displayName: 'X' }, { 'X-Lyren-Request': '' });
    expect(res.status).toBe(403);
    const ok = await client.patch('/api/account', { displayName: 'New Name' });
    expect(ok.status).toBe(200);
    expect(ok.body.displayName).toBe('New Name');
  });

  it('logs in and out, rejects bad passwords, and rate-limits failures', async () => {
    const ctx = createTestContext();
    await ctx.signedIn({ email: 'alice@example.com', password: 'supersecret1' });
    const c = ctx.client();
    expect((await c.post('/api/auth/login', { identifier: 'alice@example.com', password: 'wrongpass' })).status).toBe(401);
    expect((await c.post('/api/auth/login', { identifier: 'nobody@example.com', password: 'wrongpass' })).status).toBe(401);
    const ok = await c.post('/api/auth/login', { identifier: 'ALICE@example.com', password: 'supersecret1' });
    expect(ok.status).toBe(200);
    expect((await c.get('/api/account')).status).toBe(200);
    // The session reaches the spaces too, until it ends (Node has no auth cache, §5.4.3).
    const saved = c.cookieHeader();
    expect((await c.get('/api/bootstrap')).status).toBe(200);
    await c.post('/api/auth/logout');
    expect(c.cookie).toBeNull();
    expect((await ctx.client(saved).get('/api/bootstrap')).status).toBe(401);

    const attacker = ctx.client();
    for (let i = 0; i < 10; i++) await attacker.post('/api/auth/login', { identifier: 'alice@example.com', password: 'nope-nope' });
    expect((await attacker.post('/api/auth/login', { identifier: 'alice@example.com', password: 'supersecret1' })).status).toBe(429);
  });

  // §7.2: /api/auth/sessions and /api/auth/password moved under /api/account.
  it('changes password and revokes other sessions', async () => {
    const ctx = createTestContext();
    const { client } = await ctx.signedIn({ email: 'bob@example.com', password: 'firstpass1' });
    const other = ctx.client();
    await other.post('/api/auth/login', { identifier: 'bob@example.com', password: 'firstpass1' });
    expect((await client.get('/api/account/sessions')).body).toHaveLength(2);
    expect((await other.get('/api/bootstrap')).status).toBe(200);
    const bad = await client.post('/api/account/password', { currentPassword: 'nope', newPassword: 'secondpass2' });
    expect(bad.status).toBe(400);
    const ok = await client.post('/api/account/password', { currentPassword: 'firstpass1', newPassword: 'secondpass2' });
    expect(ok.status).toBe(200);
    expect((await other.get('/api/account')).status).toBe(401);
    expect((await other.get('/api/bootstrap')).status).toBe(401); // the spaces at once too
    expect((await client.get('/api/account')).status).toBe(200);
    expect((await client.get('/api/bootstrap')).status).toBe(200);
    expect((await ctx.client().post('/api/auth/login', { identifier: 'bob@example.com', password: 'secondpass2' })).status).toBe(200);
  });

  it('seeds default statuses, settings and a board', async () => {
    const ctx = createTestContext();
    // §3.1: the defaults are seeded in each space, which setup creates.
    await ctx.signedIn();
    const statuses = ctx.db.all<{ name: string }>('SELECT name FROM statuses ORDER BY position');
    expect(statuses.map((s) => s.name)).toEqual(['Backlog', 'Todo', 'In Progress', 'In Review', 'Done', 'Cancelled']);
    expect(ctx.db.all('SELECT * FROM boards')).toHaveLength(1);
  });

  it('returns JSON 404 for unknown API routes and validation errors as 400', async () => {
    const ctx = createTestContext();
    const { client } = await ctx.signedIn();
    const nf = await client.get('/api/nope');
    expect(nf.status).toBe(404);
    expect(nf.body.error.code).toBe('not_found');
    const bad = await ctx.client().post('/api/auth/login', { username: '' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('validation_error');
    const badJson = await ctx.client().request('POST', '/api/auth/login', '{nope', { 'Content-Type': 'application/json' });
    expect(badJson.status).toBe(400);
  });
});
