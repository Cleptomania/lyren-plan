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
    expect(user.username).toBe('owner');
    expect(client.cookie).toMatch(/^lyren_session=/);

    const again = await ctx.client().post('/api/auth/setup', {
      username: 'other', password: 'password123', displayName: 'Other',
    });
    expect(again.status).toBe(409);

    const s2 = await client.get('/api/auth/status');
    expect(s2.body.setupRequired).toBe(false);
    expect(s2.body.user.username).toBe('owner');
  });

  it('protects API routes and requires the CSRF header on mutations', async () => {
    const ctx = createTestContext();
    const { client } = await ctx.signedIn();
    expect((await ctx.client().get('/api/auth/me')).status).toBe(401);
    expect((await client.get('/api/auth/me')).status).toBe(200);
    const res = await client.request('PATCH', '/api/auth/me', { displayName: 'X' }, { 'X-Lyren-Request': '' });
    expect(res.status).toBe(403);
    const ok = await client.patch('/api/auth/me', { displayName: 'New Name' });
    expect(ok.status).toBe(200);
    expect(ok.body.displayName).toBe('New Name');
  });

  it('logs in and out, rejects bad passwords, and rate-limits failures', async () => {
    const ctx = createTestContext();
    await ctx.signedIn({ username: 'alice', password: 'supersecret1' });
    const c = ctx.client();
    expect((await c.post('/api/auth/login', { username: 'alice', password: 'wrongpass' })).status).toBe(401);
    expect((await c.post('/api/auth/login', { username: 'nobody', password: 'wrongpass' })).status).toBe(401);
    const ok = await c.post('/api/auth/login', { username: 'ALICE', password: 'supersecret1' });
    expect(ok.status).toBe(200);
    expect((await c.get('/api/auth/me')).status).toBe(200);
    await c.post('/api/auth/logout');
    expect(c.cookie).toBeNull();

    const attacker = ctx.client();
    for (let i = 0; i < 10; i++) await attacker.post('/api/auth/login', { username: 'alice', password: 'nope-nope' });
    expect((await attacker.post('/api/auth/login', { username: 'alice', password: 'supersecret1' })).status).toBe(429);
  });

  it('changes password and revokes other sessions', async () => {
    const ctx = createTestContext();
    const { client } = await ctx.signedIn({ username: 'bob', password: 'firstpass1' });
    const other = ctx.client();
    await other.post('/api/auth/login', { username: 'bob', password: 'firstpass1' });
    expect((await client.get('/api/auth/sessions')).body).toHaveLength(2);
    const bad = await client.post('/api/auth/password', { currentPassword: 'nope', newPassword: 'secondpass2' });
    expect(bad.status).toBe(400);
    const ok = await client.post('/api/auth/password', { currentPassword: 'firstpass1', newPassword: 'secondpass2' });
    expect(ok.status).toBe(200);
    expect((await other.get('/api/auth/me')).status).toBe(401);
    expect((await client.get('/api/auth/me')).status).toBe(200);
    expect((await ctx.client().post('/api/auth/login', { username: 'bob', password: 'secondpass2' })).status).toBe(200);
  });

  it('seeds default statuses, settings and a board', async () => {
    const ctx = createTestContext();
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
