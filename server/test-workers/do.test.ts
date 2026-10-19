// The Durable Objects' own behaviour (design §14.4, §10.3, §10.5), through the real Worker and objects:
// a space's _meta after init; the auth cache (three parallel requests make one authorizeSpace RPC, and an
// answer from before an invalidate is not cached); an uninitialized SpaceDO answering as a space answers an
// outsider, asking the directory and writing nothing (Appendix D 39), with Node's answers; the gate's second
// look once a held body arrives (Appendix D 27); a database the object cannot open answering 503 with the
// reason; destroy; and the directory's alarm (a purge destroys the object; a failing task stops neither
// the others nor the next alarm).

import { evictDurableObject, runDurableObjectAlarm, runInDurableObject, SELF } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import type { SpaceSummaryDTO, TagDTO } from '@shared/types';
import { readSchemaState } from '../src/core/migrate';
import { APP_VERSION } from '../src/core/version';
import { DIRECTORY_NAME } from '../src/runtime/cloudflare/clients';
import { DirectoryDO as WorkerDirectoryDO, SpaceDO as WorkerSpaceDO } from '../src/runtime/cloudflare/worker';
import { DoDb } from '../src/runtime/cloudflare/doDb';
import type { Env } from '../src/runtime/cloudflare/env';
import { storedSpaceId } from '../src/space/init';
import { heldBody, settle } from '../test/support/heldBody';
import { NOT_A_MEMBER, UNKNOWN_SESSION } from '../test/support/spaceRefusals';
import { callsOf, directoryCalls, objectDbs, testHooks } from './entry';
import { addAccount, inDirectory, ORIGIN, setupOwner, type WorkerClient } from './support';

/** Well-formed (43 characters) but no session's. */
const MADE_UP_COOKIE = `__Host-lyren_session=${'A'.repeat(43)}`;
const MADE_UP_SPACE = 'z9y8x7w6v5t4s3r2';

let owner: WorkerClient;
let ownerId: number;
let spaceId: string;

beforeAll(async () => {
  const setup = await setupOwner();
  owner = setup.client;
  ownerId = setup.user.id;
  spaceId = setup.spaceId;
});

/** Runs `fn` on the database of a space, inside its SpaceDO. */
const inSpace = <T>(id: string, fn: (db: DoDb, state: DurableObjectState) => T | Promise<T>) =>
  runInDurableObject(env.SPACES.getByName(id), (_instance, state) => fn(new DoDb(state.storage), state));

const answer = async (res: Response | Promise<Response>) => {
  const r = await res;
  return { status: r.status, body: await r.json() };
};

const newSpace = async (name: string) => (await owner.post<SpaceSummaryDTO>('/api/spaces', { name })).body.id;

/** The error an RPC call fails with (vitest's rejects leaves an RPC promise's rejection unhandled). */
const failure = (call: PromiseLike<unknown>) => Promise.resolve(call).then(
  () => null,
  (err: unknown) => String(err),
);

/**
 * The error a SpaceDO method fails with, called on the object itself: over RPC, workerd also prints an
 * expected rejection as an uncaught exception (the expected lines are listed in vitest.config.ts).
 */
const objectFailure = (id: string, call: (object: WorkerSpaceDO) => Promise<unknown>) =>
  runInDurableObject(env.SPACES.getByName(id), (instance) => failure(call(instance)));

describe('SpaceDO', () => {
  it('init leaves the space schema and the space records in _meta', async () => {
    const meta = await inSpace(spaceId, (db) => ({
      state: readSchemaState(db),
      id: storedSpaceId(db),
      rows: Object.fromEntries(db.all<{ key: string; value: string }>('SELECT key, value FROM _meta').map((r) => [r.key, r.value])),
    }));
    expect(meta.state).toMatchObject({ schema: 'space', empty: false });
    expect(meta.state.version).toBeGreaterThan(0);
    expect(meta.id).toBe(spaceId);
    expect(meta.rows).toMatchObject({ schema: 'space', space_name: "Owner's space", sync_version: '1', app_version: APP_VERSION });
    const stats = await env.SPACES.getByName(spaceId).stats();
    expect(stats).toEqual({ bytes: expect.any(Number), tasks: 0 });
    expect(stats!.bytes).toBeGreaterThan(4096);
  });

  it('the object’s meter gives the rows a request read and wrote (the cost tests read it)', async () => {
    await owner.get(`/api/s/${spaceId}/tags`);
    const meter = () => ({ ...objectDbs.spaces.get(spaceId)!.meter });
    const before = meter();
    expect((await owner.get(`/api/s/${spaceId}/tags`)).status).toBe(200);
    const read = meter();
    expect(read.rowsRead).toBeGreaterThan(before.rowsRead);
    expect(read.rowsWritten).toBe(before.rowsWritten);
    expect((await owner.post(`/api/s/${spaceId}/tags`, { name: 'metered' })).status).toBe(201);
    expect(meter().rowsWritten).toBeGreaterThan(read.rowsWritten);
    expect(objectDbs.directory!.meter.rowsRead).toBeGreaterThan(0);
  });

  it('the auth cache: three parallel requests of a new session make one authorizeSpace call', async () => {
    const member = await addAccount({ email: 'parallel@example.com', role: 'member', spaceId, ip: '192.0.2.31' });
    const before = directoryCalls.authorizeSpace;
    const results = await Promise.all([1, 2, 3].map(() => member.client.get(`/api/s/${spaceId}/tags`)));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(directoryCalls.authorizeSpace - before).toBe(1);
    // Cached: the next one makes none.
    expect((await member.client.get(`/api/s/${spaceId}/tags`)).status).toBe(200);
    expect(directoryCalls.authorizeSpace - before).toBe(1);
  });

  it('the auth cache keeps no answer the directory gave before an invalidate', async () => {
    const member = await addAccount({ email: 'stale@example.com', role: 'member', spaceId, ip: '192.0.2.32' });
    let release!: () => void;
    testHooks.holdAuthorize = new Promise<void>((resolve) => {
      release = resolve;
    });
    // A new session's first request: the directory answers "member" and holds the answer.
    const first = member.client.get(`/api/s/${spaceId}/tags`);
    let firstDone = false;
    void first.then(() => {
      firstDone = true;
    });
    await settle();
    const before = directoryCalls.authorizeSpace;
    // Demoted meanwhile: the push (awaited for a demotion) clears the space's cache.
    testHooks.holdAuthorize = null;
    const demoted = owner.patch(`/api/spaces/${spaceId}/members/${member.user.id}`, { role: 'viewer' });
    expect((await demoted).status).toBe(200);
    expect(callsOf(spaceId).invalidate).toBeGreaterThan(0);
    // The invalidate reached the space while the first answer was still on its way.
    expect(firstDone).toBe(false);
    release();
    // The held request itself was authorized before the change; its answer is not kept.
    expect((await first).status).toBe(200);
    const write = await member.client.post(`/api/s/${spaceId}/tags`, { name: 'after the demotion' });
    expect(write.status).toBe(403);
    expect(directoryCalls.authorizeSpace - before).toBeGreaterThanOrEqual(1);
  });

  it('judges a write again once its held body has arrived: a member removed meanwhile writes nothing (404)', async () => {
    const member = await addAccount({ email: 'held@example.com', role: 'member', spaceId, ip: '192.0.2.33' });
    const body = heldBody({ name: 'written late' });
    const write = SELF.fetch(`${ORIGIN}/api/s/${spaceId}/tags`, {
      method: 'POST',
      headers: { ...body.headers, Cookie: member.client.cookieHeader(), 'X-Lyren-Request': '1' },
      body: body.stream,
    });
    await settle();
    expect((await owner.delete(`/api/spaces/${spaceId}/members/${member.user.id}`)).status).toBe(200);
    body.release();
    expect(await answer(write)).toEqual(NOT_A_MEMBER);
    const tags = await owner.get<TagDTO[]>(`/api/s/${spaceId}/tags`);
    expect(tags.body.map((t) => t.name)).not.toContain('written late');
  });

  it('a made-up space answers as a real one does to an outsider, asks the directory, and writes nothing', async () => {
    const outsider = await addAccount({ email: 'outsider@example.com', ip: '192.0.2.34' });
    const unknown = (id: string) => SELF.fetch(`${ORIGIN}/api/s/${id}/bootstrap`, { headers: { Cookie: MADE_UP_COOKIE } });
    let calls = directoryCalls.authorizeSpace;
    const sinceLast = () => {
      const n = directoryCalls.authorizeSpace - calls;
      calls = directoryCalls.authorizeSpace;
      return n;
    };

    // An unknown session: 401, as Node answers, for a made-up id and for a real one; the second time from the cache.
    expect(await answer(unknown(MADE_UP_SPACE))).toEqual(UNKNOWN_SESSION);
    expect(sinceLast()).toBe(1);
    expect(await answer(unknown(MADE_UP_SPACE))).toEqual(UNKNOWN_SESSION);
    expect(sinceLast()).toBe(0);
    expect(await answer(unknown(spaceId))).toEqual(UNKNOWN_SESSION);
    expect(sinceLast()).toBe(1);

    // A session that may not open the space: 404, for both, asked every time (not_found is never cached).
    for (const id of [MADE_UP_SPACE, MADE_UP_SPACE, spaceId]) {
      const res = await outsider.client.get(`/api/s/${id}/bootstrap`);
      expect({ status: res.status, body: res.body }, id).toEqual(NOT_A_MEMBER);
      expect(sinceLast()).toBe(1);
    }
    // Even the owner of other spaces gets 404 there.
    expect((await owner.get(`/api/s/${MADE_UP_SPACE}/bootstrap`)).status).toBe(404);

    // The object created no tables and holds nothing.
    const stored = await inSpace(MADE_UP_SPACE, (db, state) => ({ empty: readSchemaState(db).empty, bytes: state.storage.sql.databaseSize }));
    expect(stored.empty).toBe(true);
    expect(await env.SPACES.getByName(MADE_UP_SPACE).stats()).toBeNull();
    expect(callsOf(MADE_UP_SPACE).init).toBe(0);
  });

  it('destroy deletes everything: the object then answers as a made-up space, until it is evicted', async () => {
    const id = await newSpace('Doomed');
    await owner.post(`/api/s/${id}/tags`, { name: 'gone soon' });
    await env.SPACES.getByName(id).destroy();
    expect(await inSpace(id, (db) => readSchemaState(db).empty)).toBe(true);
    // The directory still lists the space (only maintenance purges call destroy); the object holds nothing.
    expect(await answer(SELF.fetch(`${ORIGIN}/api/s/${id}/tags`, { headers: { Cookie: owner.cookieHeader() } }))).toEqual(NOT_A_MEMBER);
    expect(await env.SPACES.getByName(id).stats()).toBeNull();
    const init = { spaceId: id, name: 'Again', owner: { userId: ownerId, displayName: 'Owner', email: null }, syncVersion: 1, sampleData: null };
    expect(await objectFailure(id, (object) => object.init(init))).toMatch(/was destroyed/);
    // Destroying again is a no-op.
    await env.SPACES.getByName(id).destroy();
  });

  it('a database from a newer build answers 503 with what to do; any other failure with its reason', async () => {
    const id = await newSpace('Rolled back');
    const read = () => answer(SELF.fetch(`${ORIGIN}/api/s/${id}/tags`, { headers: { Cookie: owner.cookieHeader() } }));
    expect((await read()).status).toBe(200);

    await inSpace(id, (db) => db.run("UPDATE _meta SET value = '999' WHERE key IN ('version', 'compatible_from')"));
    await evictDurableObject(env.SPACES.getByName(id));
    expect(await read()).toEqual({
      status: 503,
      body: { error: { code: 'unavailable', message: 'This data was upgraded by a newer version of Lyren Plan. Deploy that version again.' } },
    });

    await inSpace(id, (db) => db.run("UPDATE _meta SET value = 'x' WHERE key = 'version'"));
    await evictDurableObject(env.SPACES.getByName(id));
    expect(await read()).toEqual({
      status: 503,
      body: { error: { code: 'unavailable', message: 'The database could not be opened: _meta.version is not a migration count: x' } },
    });
    expect(await objectFailure(id, (object) => object.stats())).toMatch(/could not be opened/);
    // An object that cannot open its database can still be destroyed (a purge).
    await env.SPACES.getByName(id).destroy();
  });
});

describe('DirectoryDO', () => {
  it('a configuration error answers 503 with the reason, and every RPC throws it', async () => {
    // A directory object of its own, built with a broken setting, on a bare object's storage.
    await runInDurableObject(env.TEST_DB.getByName('broken-directory'), async (_instance, state) => {
      const broken = new WorkerDirectoryDO(state, { ...(env as unknown as Env), MAIL_TRANSPORT: 'pigeon' });
      await settle();
      const res = await broken.fetch(new Request(`${ORIGIN}/api/auth/status`));
      expect(await answer(res)).toEqual({
        status: 503,
        body: { error: { code: 'unavailable', message: 'Configuration error: Invalid value for MAIL_TRANSPORT: pigeon (expected log, smtp, resend, cloudflare)' } },
      });
      expect(await failure(broken.authorizeSpace({ tokenHash: 'a'.repeat(64), spaceId, cookie: 'host', secure: true }))).toMatch(/Configuration error/);
      // Nothing was written: the database was never opened.
      expect(readSchemaState(new DoDb(state.storage)).empty).toBe(true);
    });
  });

  it('a request without the Worker’s meta header is refused (only the Worker reaches the objects)', async () => {
    const res = await env.DIRECTORY.getByName(DIRECTORY_NAME).fetch(`${ORIGIN}/api/auth/status`);
    expect(res.status).toBe(500);
    const space = await env.SPACES.getByName(spaceId).fetch(`${ORIGIN}/api/s/${spaceId}/tags`);
    expect(space.status).toBe(500);
  });

  it('the alarm: the next one first, purges destroy their objects, and a failing task stops neither the others nor the schedule', async () => {
    const failing = await newSpace('Fails to purge');
    const purged = await newSpace('Purged');
    for (const id of [failing, purged]) await owner.post(`/api/s/${id}/tags`, { name: 'data' });
    const past = new Date(Date.now() - 60_000).toISOString();
    await inDirectory((db) => {
      db.run(
        `UPDATE spaces SET deleted_at = :past, purge_after = :past
         WHERE public_id IN (SELECT value FROM json_each(:ids))`,
        { past, ids: JSON.stringify([failing, purged]) },
      );
      db.run(
        `INSERT INTO sessions (token_hash, user_id, auth_method, created_at, last_seen_at, expires_at, reauth_at)
         VALUES (:hash, :userId, 'password', :past, :past, :past, :past)`,
        { hash: 'e'.repeat(64), userId: ownerId, past },
      );
    });
    testHooks.failDestroy.add(failing);
    const stub = env.DIRECTORY.getByName(DIRECTORY_NAME);
    const started = Date.now();
    try {
      expect(await runDurableObjectAlarm(stub)).toBe(true);
    } finally {
      testHooks.failDestroy.delete(failing);
    }

    // The next alarm, an hour on.
    const next = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
    expect(next).toBeGreaterThanOrEqual(started + 60 * 60_000 - 1000);
    // The purge that worked destroyed the object and deleted the row; the one that failed kept both.
    expect(await inSpace(purged, (db) => readSchemaState(db).empty)).toBe(true);
    expect(await inSpace(failing, (db) => readSchemaState(db).empty)).toBe(false);
    const rows = await inDirectory((db) => ({
      spaces: db.all<{ public_id: string }>('SELECT public_id FROM spaces WHERE public_id IN (SELECT value FROM json_each(:ids))', {
        ids: JSON.stringify([failing, purged]),
      }),
      expiredSession: db.get("SELECT 1 AS n FROM sessions WHERE token_hash = :hash", { hash: 'e'.repeat(64) }) ?? null,
    }));
    expect(rows.spaces.map((s) => s.public_id)).toEqual([failing]);
    // The other tasks ran.
    expect(rows.expiredSession).toBeNull();

    // The next run purges what is left.
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await inSpace(failing, (db) => readSchemaState(db).empty)).toBe(true);
    expect(await inDirectory((db) => db.get('SELECT 1 AS n FROM spaces WHERE public_id = :id', { id: failing }) ?? null)).toBeNull();
  });

  it('a task whose SQL fails does not stop the others, and the alarm is set again', async () => {
    const stub = env.DIRECTORY.getByName(DIRECTORY_NAME);
    const { doDbTestHooks } = await import('../src/runtime/cloudflare/doDb');
    doDbTestHooks.beforeExec = (sql) => {
      if (/^DELETE FROM sessions\b/.test(sql.trim())) throw new Error('disk I/O error (test)');
    };
    try {
      expect(await runDurableObjectAlarm(stub)).toBe(true);
    } finally {
      doDbTestHooks.beforeExec = null;
    }
    expect(await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm())).not.toBeNull();
    // The service still answers.
    expect((await owner.get('/api/spaces')).status).toBe(200);
  });
});

describe('SpaceDO built by hand', () => {
  it('an object whose name is no space id holds no space and answers 404', async () => {
    await runInDurableObject(env.TEST_DB.getByName('not-a-space-id'), async (_instance, state) => {
      const space = new WorkerSpaceDO(state, env as unknown as Env);
      await settle();
      expect(await space.stats()).toBeNull();
      const init = { spaceId, name: 'x', owner: { userId: 1, displayName: 'x', email: null }, syncVersion: 1, sampleData: null };
      expect(await failure(space.init(init))).toMatch(new RegExp(`This object holds space null, not ${spaceId}`));
    });
  });
});
