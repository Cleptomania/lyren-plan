import { describe, expect, it } from 'vitest';
import { Db, openDb } from '../src/db';
import { createTestContext } from './helpers';

describe('Db wrapper', () => {
  it('recovers from a failed COMMIT (deferred FK violation) and keeps working', () => {
    const db = openDb(':memory:');
    db.exec('CREATE TABLE p (id INTEGER PRIMARY KEY); CREATE TABLE c (id INTEGER PRIMARY KEY, p INTEGER REFERENCES p(id) DEFERRABLE INITIALLY DEFERRED)');
    expect(() => db.tx(() => db.run('INSERT INTO c (p) VALUES (:p)', { p: 99 }))).toThrow(/FOREIGN KEY/);
    expect(db.inTransaction).toBe(false);
    db.tx(() => db.run('INSERT INTO p (id) VALUES (:id)', { id: 1 }));
    db.tx(() => db.tx(() => db.run('INSERT INTO c (p) VALUES (:p)', { p: 1 })));
    expect(db.all('SELECT * FROM c')).toHaveLength(1);
  });

  it('rolls back nested savepoints only', () => {
    const db = openDb(':memory:');
    db.exec('CREATE TABLE t (v TEXT)');
    db.tx(() => {
      db.run("INSERT INTO t VALUES ('outer')");
      expect(() =>
        db.tx(() => {
          db.run("INSERT INTO t VALUES ('inner')");
          throw new Error('boom');
        }),
      ).toThrow('boom');
    });
    expect(db.all<{ v: string }>('SELECT v FROM t').map((r) => r.v)).toEqual(['outer']);
  });

  it('throws on missing named params, ignores extras, binds booleans/undefined', () => {
    const db = new Db(':memory:');
    db.exec('CREATE TABLE t (a, b)');
    expect(() => db.run('INSERT INTO t (a, b) VALUES (:a, :b)', { a: 1 })).toThrow(/:b missing/);
    db.run('INSERT INTO t (a, b) VALUES (:a, :b)', { a: true, b: undefined, extra: 'ignored' });
    expect(db.get('SELECT a, b FROM t')).toEqual({ a: 1, b: null });
    // ':x' inside string literals is not a parameter
    expect(db.get("SELECT ':nope' AS v, strftime('%H:%M', '2026-01-01 10:20') AS w")).toEqual({ v: ':nope', w: '10:20' });
  });

  it('lyren_lower folds Unicode like JS', () => {
    const db = new Db(':memory:');
    expect(db.get<{ v: string }>("SELECT lyren_lower('ÄRGER Été') AS v")!.v).toBe('ärger été');
  });

  it('does not reuse ids after deletion (AUTOINCREMENT)', async () => {
    const ctx = createTestContext();
    const now = new Date().toISOString();
    const ins = () =>
      ctx.db.run("INSERT INTO tags (name, color, created_at, updated_at) VALUES (:n, '#000000', :now, :now)", {
        n: `t${Math.random()}`,
        now,
      }).lastInsertRowid;
    const a = ins();
    ctx.db.run('DELETE FROM tags WHERE id = :id', { id: a });
    expect(ins()).toBeGreaterThan(a);
  });
});

describe('security middleware', () => {
  it('rate-limits logins even when X-Forwarded-For is spoofed (trust proxy)', async () => {
    const ctx = createTestContext({ trustProxy: true });
    await ctx.signedIn({ username: 'alice', password: 'supersecret1' });
    const c = ctx.client();
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await c.request('POST', '/api/auth/login', { username: 'alice', password: 'wrong-pass' }, {
        'X-Forwarded-For': `10.0.0.${i}, 203.0.113.7`,
      });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });

  it('counts concurrent login attempts before hashing', async () => {
    const ctx = createTestContext();
    await ctx.signedIn({ username: 'alice', password: 'supersecret1' });
    const c = ctx.client();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => c.post('/api/auth/login', { username: 'alice', password: 'wrong-pass' })),
    );
    expect(results.filter((r) => r.status === 401).length).toBeLessThanOrEqual(10);
    expect(results.filter((r) => r.status === 429).length).toBeGreaterThanOrEqual(10);
  });

  it('requires the setup code when configured', async () => {
    const ctx = createTestContext({ setupToken: 'abc123' });
    const status = await ctx.client().get('/api/auth/status');
    expect(status.body.setupCodeRequired).toBe(true);
    const bad = await ctx.client().post('/api/auth/setup', {
      username: 'owner', password: 'password123', displayName: 'Owner', setupCode: 'nope',
    });
    expect(bad.status).toBe(403);
    const { user } = await ctx.signedIn();
    expect(user.username).toBe('owner');
    expect((await ctx.client().get('/api/auth/status')).body.setupCodeRequired).toBe(false);
  });

  it('re-issues the session cookie when the sliding expiry is extended', async () => {
    const ctx = createTestContext();
    const { client } = await ctx.signedIn();
    const first = await client.get('/api/auth/me');
    expect(first.headers.get('set-cookie')).toBeNull();
    ctx.db.run('UPDATE sessions SET last_seen_at = :old', { old: new Date(Date.now() - 2 * 3600_000).toISOString() });
    const second = await client.get('/api/auth/me');
    expect(second.status).toBe(200);
    expect(second.headers.get('set-cookie')).toMatch(/^lyren_session=.+Max-Age=2592000/);
  });

  it('applies body limits (including the import route)', async () => {
    const ctx = createTestContext({ bodyLimit: 1024, importBodyLimit: 4096 });
    const { client } = await ctx.signedIn();
    const big = { pad: 'x'.repeat(5000) };
    expect((await client.post('/api/tasks/query', big)).status).toBe(413);
    expect((await client.post('/api/data/import', big)).status).toBe(413);
  });

  it('sends security headers and no-store on the API', async () => {
    const ctx = createTestContext();
    const res = await ctx.client().get('/api/health');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('content-security-policy')).toContain("img-src 'self' data: blob:;");
  });
});
