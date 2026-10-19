// The space host (design §2.2, §10.5): the path rewrite, the identity hand-off without cookies (and the
// recheck the gate makes after a body, Appendix D 27), the reasons it answers 401 and 404 itself, the
// auth cache (TTL, invalidate, single flight, no stale fills), and what it does when a mirror sync or
// self-heal cannot complete.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DailyQuotaError, type SqlParams } from '../../src/core/db';
import { META_HEADER } from '../../src/core/meta';
import type { SpaceAuthResult } from '../../src/core/ports';
import type { AppEnv } from '../../src/env';
import { AuthCache, createSpaceHost } from '../../src/space/host';
import { createSpaceHarness, OTHER_SPACE_ID } from '../support/spaceHarness';

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  env: AppEnv['Bindings'];
}

/** A space app that records what reached it. */
function spyApp() {
  const seen: Seen[] = [];
  return {
    seen,
    app: {
      async fetch(request: Request, env: AppEnv['Bindings']) {
        seen.push({
          method: request.method,
          url: request.url,
          headers: Object.fromEntries(request.headers),
          body: await request.text(),
          env,
        });
        return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
      },
    },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the space host', () => {
  it('rewrites /api/s/<id>/… to /api/… and hands over the identity without the Cookie header', async () => {
    const spy = spyApp();
    const h = createSpaceHarness({ app: spy.app });
    const res = await h.owner.client.request('POST', '/api/tasks/12/comments?x=1&y=%20', { body: 'hi' }, {
      Cookie: 'lyren_session=abc; other=1',
      [META_HEADER]: 'spoofed',
      'If-None-Match': '"1.1.3.abc"',
    });
    expect(res.status).toBe(200);
    const [seen] = spy.seen;
    expect(new URL(seen!.url).pathname + new URL(seen!.url).search).toBe('/api/tasks/12/comments?x=1&y=%20');
    expect(seen!.method).toBe('POST');
    expect(seen!.body).toBe('{"body":"hi"}');
    expect(seen!.headers.cookie).toBeUndefined();
    expect(seen!.headers[META_HEADER]).toBeUndefined();
    expect(seen!.headers['if-none-match']).toBe('"1.1.3.abc"');
    expect(seen!.headers['content-type']).toBe('application/json');
    expect(seen!.env.identity).toMatchObject({ userId: 1, role: 'owner', space: { id: h.spaceId, status: 'active' } });
    expect(seen!.env.fromCache).toBe(false);
    expect(seen!.env.meta.sessionTokenHash).toBe(h.meta(h.owner.token).sessionTokenHash);
    // reauthorize asks the directory again.
    const calls = h.directory.count('authorizeSpace');
    expect(await seen!.env.reauthorize()).toMatchObject({ userId: 1 });
    expect(h.directory.count('authorizeSpace')).toBe(calls + 1);

    await h.owner.client.get(`/api/s/${h.spaceId}`);
    expect(new URL(spy.seen[1]!.url).pathname).toBe('/api');
    // A percent-encoded path stays as it was sent; Hono decodes it when it routes (the gate's rule).
    await h.owner.client.get('/api/t%61gs');
    expect(new URL(spy.seen[2]!.url).pathname).toBe('/api/t%61gs');
  });

  it('recheck looks the request up again as the host did, and throws what the host would answer', async () => {
    const spy = spyApp();
    const h = createSpaceHarness({ app: spy.app });
    const member = h.addUser({ role: 'member' });
    await member.client.get('/api/tags');
    const { recheck } = spy.seen[0]!.env;
    const calls = h.directory.count('authorizeSpace');
    h.directory.setRole(member.userId, 'viewer');
    expect(await recheck()).toMatchObject({ identity: { userId: member.userId, role: 'viewer' }, fromCache: false });
    expect(h.directory.count('authorizeSpace')).toBe(calls + 1);
    h.directory.removeMember(member.userId);
    await expect(recheck()).rejects.toMatchObject({ status: 404, code: 'not_found', message: 'Space not found' });
    h.directory.signOut(member.token);
    await expect(recheck()).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
    h.directory.failures.authorizeSpace = new Error('directory down (test)');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(recheck()).rejects.toMatchObject({ status: 503, code: 'unavailable' });
  });

  it('a Cookie header never reaches the real space app either', async () => {
    const h = createSpaceHarness();
    const res = await h.owner.client.request('GET', '/api/bootstrap', undefined, { Cookie: 'lyren_session=x' });
    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({ id: 1, displayName: 'Owner' });
  });

  it('answers 404 for another space\'s path without asking the directory', async () => {
    const h = createSpaceHarness();
    const res = await h.owner.client.get(`/api/s/${OTHER_SPACE_ID}/tags`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
    expect((await h.owner.client.get(`/api/s/${h.spaceId}x/tags`)).status).toBe(404);
    expect(h.directory.calls).toEqual([]);
  });

  it('answers 401 and 404 for what the directory says, and 503 when it cannot be asked', async () => {
    const h = createSpaceHarness();
    const noSession = await h.client(null).get('/api/tags');
    expect(noSession.status).toBe(401);
    expect(noSession.body.error).toEqual({ code: 'unauthorized', message: 'Not signed in' });
    expect(noSession.headers.get('cache-control')).toBe('no-store');
    expect(h.directory.calls).toEqual([]);

    expect((await h.client('made-up-token').get('/api/tags')).status).toBe(401);
    const expired = h.directory.signIn(1, { expiresAt: h.clock.now() + 1000 });
    h.clock.advance(1000);
    expect((await h.client(expired).get('/api/tags')).status).toBe(401);
    const disabled = h.addUser();
    h.directory.updateAccount(disabled.userId, { disabled: true });
    expect((await disabled.client.get('/api/tags')).status).toBe(401);

    const outsider = h.addUser();
    h.directory.removeMember(outsider.userId);
    const notMember = await outsider.client.get('/api/tags');
    expect(notMember.status).toBe(404);
    expect(notMember.body.error).toEqual({ code: 'not_found', message: 'Space not found' });
    h.directory.space.deleted = true;
    expect((await h.owner.client.get('/api/tags')).status).toBe(404);
    h.directory.space.deleted = false;

    h.directory.failures.authorizeSpace = new Error('directory down (test)');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const down = await h.owner.client.get('/api/tags');
    expect(down.status).toBe(503);
    expect(down.body.error.code).toBe('unavailable');
  });

  it('refuses an identity the directory gave for another space (404)', async () => {
    const h = createSpaceHarness();
    const authorize = h.directory.authorizeSpace.bind(h.directory);
    vi.spyOn(h.directory, 'authorizeSpace').mockImplementation(async (input) => {
      const result = await authorize(input);
      if (!result.ok) return result;
      return { ...result, identity: { ...result.identity, space: { ...result.identity.space, id: OTHER_SPACE_ID } } };
    });
    const res = await h.owner.client.get('/api/tags');
    expect(res.status).toBe(404);
    expect(res.body.error).toEqual({ code: 'not_found', message: 'Space not found' });
  });

  it('answers 503 when a fresh re-authorization cannot reach the directory', async () => {
    const h = createSpaceHarness({ authCacheTtlMs: 30_000 });
    expect((await h.owner.client.get('/api/tags')).status).toBe(200);
    h.directory.failures.authorizeSpace = new Error('directory down (test)');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect((await h.owner.client.get('/api/tags')).status).toBe(200); // cached
    const fresh = await h.owner.client.get('/api/data/export');
    expect(fresh.status).toBe(503);
    expect(fresh.body.error.code).toBe('unavailable');
  });

  it('counts the requests it is serving', async () => {
    const h = createSpaceHarness();
    const hold = deferred();
    h.directory.authorizeHold = hold.promise;
    const pending = [h.owner.client.get('/api/tags'), h.owner.client.get('/api/statuses')];
    await new Promise((r) => setTimeout(r, 5));
    expect(h.host.activeRequests).toBe(2);
    hold.resolve();
    await Promise.all(pending);
    expect(h.host.activeRequests).toBe(0);
  });
});

describe('the auth cache', () => {
  it('is off with a TTL of 0 (Node): every request asks the directory', async () => {
    const h = createSpaceHarness();
    await h.owner.client.get('/api/tags');
    await h.owner.client.get('/api/tags');
    expect(h.directory.count('authorizeSpace')).toBe(2);
  });

  it('keeps an authorization for the TTL, and never past the session\'s end', async () => {
    const spy = spyApp();
    const h = createSpaceHarness({ authCacheTtlMs: 30_000, app: spy.app });
    await h.owner.client.get('/api/tags');
    h.clock.advance(29_999);
    await h.owner.client.get('/api/tags');
    expect(h.directory.count('authorizeSpace')).toBe(1);
    expect(spy.seen.map((s) => s.env.fromCache)).toEqual([false, true]);
    h.clock.advance(2);
    await h.owner.client.get('/api/tags');
    expect(h.directory.count('authorizeSpace')).toBe(2);

    const short = h.directory.signIn(1, { expiresAt: h.clock.now() + 5_000 });
    await h.client(short).get('/api/tags');
    h.clock.advance(5_001);
    expect((await h.client(short).get('/api/tags')).status).toBe(401);
    expect(h.directory.count('authorizeSpace')).toBe(4);
  });

  it('remembers an unknown token for 60 s and a non-member never', async () => {
    const h = createSpaceHarness({ authCacheTtlMs: 30_000 });
    const unknown = h.client('made-up-token');
    await unknown.get('/api/tags');
    h.clock.advance(59_000);
    await unknown.get('/api/tags');
    expect(h.directory.count('authorizeSpace')).toBe(1);
    h.clock.advance(1_001);
    await unknown.get('/api/tags');
    expect(h.directory.count('authorizeSpace')).toBe(2);

    const outsider = h.addUser();
    h.directory.removeMember(outsider.userId);
    await outsider.client.get('/api/tags');
    await outsider.client.get('/api/tags');
    expect(h.directory.count('authorizeSpace')).toBe(4);
  });

  it('is dropped by invalidate(), which also forces a mirror sync', async () => {
    const h = createSpaceHarness({ authCacheTtlMs: 30_000 });
    await h.owner.client.get('/api/tags');
    h.directory.setRole(1, 'viewer'); // the push below announces it
    expect((await h.owner.client.patch('/api/settings', {})).status).toBe(200);
    h.host.invalidate();
    expect((await h.owner.client.patch('/api/settings', {})).status).toBe(403);
    expect(h.directory.count('authorizeSpace')).toBe(2);
    expect(h.directory.count('spaceSync')).toBe(1);
  });

  it('shares one directory call between concurrent requests of one token', async () => {
    const h = createSpaceHarness({ authCacheTtlMs: 30_000 });
    const hold = deferred();
    h.directory.authorizeHold = hold.promise;
    const pending = ['/api/tags', '/api/statuses', '/api/boards'].map((p) => h.owner.client.get(p));
    await new Promise((r) => setTimeout(r, 5));
    hold.resolve();
    expect((await Promise.all(pending)).map((r) => r.status)).toEqual([200, 200, 200]);
    expect(h.directory.count('authorizeSpace')).toBe(1);
  });

  it('does not store an answer the directory gave before an invalidate', async () => {
    const h = createSpaceHarness({ authCacheTtlMs: 30_000 });
    const hold = deferred();
    h.directory.authorizeHold = hold.promise;
    const pending = h.owner.client.get('/api/tags');
    await new Promise((r) => setTimeout(r, 5));
    h.host.invalidate();
    hold.resolve();
    expect((await pending).status).toBe(200);
    h.directory.authorizeHold = null;
    await h.owner.client.get('/api/tags');
    expect(h.directory.count('authorizeSpace')).toBe(2);
  });
});

describe('AuthCache', () => {
  const ok = (cacheUntil: number): SpaceAuthResult => ({
    ok: true,
    cacheUntil,
    identity: {
      userId: 1,
      displayName: 'A',
      email: null,
      role: 'member',
      instanceAdmin: false,
      sessionId: 1,
      reauthAt: '2026-10-17T12:00:00.000Z',
      space: { id: 's', name: 'S', status: 'active', syncVersion: 1 },
    },
  });

  it('is an LRU of at most `max` entries', async () => {
    const cache = new AuthCache(30_000, 2);
    const load = vi.fn(async () => ok(Number.MAX_SAFE_INTEGER));
    for (const token of ['a', 'b', 'a', 'c']) await cache.lookup(token, 0, load);
    expect(load).toHaveBeenCalledTimes(3);
    expect(cache.size).toBe(2);
    expect((await cache.lookup('a', 0, load)).fromCache).toBe(true);
    expect((await cache.lookup('b', 0, load)).fromCache).toBe(false); // evicted as the least recently used
  });

  it('refresh() bypasses the entry and replaces it; clear() empties everything', async () => {
    const cache = new AuthCache(30_000);
    await cache.lookup('a', 0, async () => ok(1000));
    const fresh = await cache.refresh('a', 10, async () => ({ ok: false, reason: 'unauthenticated' }));
    expect(fresh).toEqual({ ok: false, reason: 'unauthenticated' });
    expect((await cache.lookup('a', 20, async () => ok(1000))).result.ok).toBe(false);
    cache.clear();
    expect(cache.size).toBe(0);
    expect((await cache.lookup('a', 30, async () => ok(1000))).result.ok).toBe(true);
  });
});

describe('a sync or self-heal that cannot complete', () => {
  it('a request that joined a sync begun before an invalidate syncs again, so it never shows the older mirror', async () => {
    const h = createSpaceHarness();
    const bob = h.addUser({ displayName: 'Bob' });
    const hold = deferred();
    h.directory.syncHold = hold.promise;
    const first = h.owner.client.get('/api/tags'); // its sync read the directory with Bob, and waits
    await new Promise((r) => setTimeout(r, 5));
    h.directory.updateAccount(bob.userId, { displayName: 'Robert' });
    h.host.invalidate();
    const second = h.owner.client.get('/api/bootstrap');
    await new Promise((r) => setTimeout(r, 5));
    h.directory.syncHold = null;
    hold.resolve();
    expect((await first).status).toBe(200);
    const res = await second;
    expect(res.body.people.find((p: { id: number }) => p.id === bob.userId).displayName).toBe('Robert');
    expect(h.directory.count('spaceSync')).toBe(2);
  });

  it('a file whose mirror is ahead of its directory (put back by hand) syncs at its first request, then follows the directory', async () => {
    const h = createSpaceHarness();
    const bob = h.addUser({ displayName: 'Bob' });
    expect((await h.owner.client.get('/api/tags')).status).toBe(200);
    // A copy of the file from a later state, next to an older directory: Bob renamed, a version the
    // directory has not reached.
    h.db.run("UPDATE _meta SET value = '99' WHERE key = 'sync_version'");
    h.db.run("UPDATE users SET display_name = 'Stale Bob' WHERE id = :id", { id: bob.userId });
    // The next start: a new host on the file.
    const host = createSpaceHost({ deps: h.deps, authCacheTtlMs: 0 });
    const people = async () => {
      const res = await host.serve(new Request(`http://127.0.0.1:19620/api/s/${h.spaceId}/bootstrap`), h.meta(h.owner.token));
      expect(res.status).toBe(200);
      return ((await res.json()) as { people: Array<{ id: number; displayName: string }> }).people;
    };
    const syncs = h.directory.count('spaceSync');
    expect((await people()).find((p) => p.id === bob.userId)?.displayName).toBe('Bob');
    expect(h.directory.count('spaceSync')).toBe(syncs + 1);
    expect(h.db.get<{ value: string }>("SELECT value FROM _meta WHERE key = 'sync_version'")!.value).toBe(String(h.directory.space.syncVersion));
    // Once only; the next change of the directory reaches it as usual.
    await people();
    expect(h.directory.count('spaceSync')).toBe(syncs + 1);
    h.directory.updateAccount(bob.userId, { displayName: 'Robert' });
    expect((await people()).find((p) => p.id === bob.userId)?.displayName).toBe('Robert');
    expect(h.directory.count('spaceSync')).toBe(syncs + 2);
  });

  it('a self-heal that cannot write is logged and the request still served (reads work when writes fail)', async () => {
    const h = createSpaceHarness();
    const member = h.addUser({ displayName: 'Mia' });
    const run = h.db.run.bind(h.db);
    const writes = vi.spyOn(h.db, 'run').mockImplementation((sql: string, params?: SqlParams) => {
      if (/\b(users|_meta)\b/.test(sql)) throw new DailyQuotaError(new Error('Exceeded the daily rows written limit (test)'));
      return run(sql, params);
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await member.client.get('/api/tags');
    expect(res.status).toBe(200);
    expect(errors.mock.calls.map((call) => String(call[0]))).toEqual([
      `[lyren] Users mirror sync of space ${h.spaceId} failed:`,
      `[lyren] Self-heal of user ${member.userId} in space ${h.spaceId} failed:`,
    ]);
    // Once writes work again, the next request heals the row.
    writes.mockRestore();
    const people = (await member.client.get('/api/bootstrap')).body.people as Array<{ id: number; displayName: string }>;
    expect(people.find((p) => p.id === member.userId)?.displayName).toBe('Mia');
  });
});
