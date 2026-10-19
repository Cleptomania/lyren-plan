// The Node composition (runtime/node/stack.ts, design §9.1-§9.3): a stack in memory and on disk, the file
// layout and permissions, what it refuses before writing anything (a 1.x database in maintenance mode, a
// newer one, also one a crash left a -wal behind for, one that another connection holds exclusively; the
// upgrade itself is legacyUpgrade.test.ts), the backup download, closing every database, the space store's
// LRU and idle closing, and how a space request is authorized: before its space is touched (§13.2), and
// again once its body has arrived (Appendix D 27).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { CSRF_HEADER } from '@shared/constants';
import type { AuthStatusDTO, BootstrapDTO, TagDTO } from '@shared/types';
import { loadConfig, type Config } from '../../src/config';
import { sha256Hex } from '../../src/core/crypto';
import { openBackupSet } from '../../src/runtime/node/backupSet';
import { LEGACY_NOT_UPGRADED, stillOpen } from '../../src/runtime/node/legacy';
import type { NodeDb } from '../../src/runtime/node/nodeDb';
import { spacesDirFor } from '../../src/runtime/node/spaceStore';
import { DataRefusal, openNodeStack, requestLogPrinter, type NodeStack } from '../../src/runtime/node/stack';
import { createTestContext, NO_SPACE_ID, type TestClient } from '../helpers';
import { fakeClock } from '../support/directoryHarness';
import { heldBody, settle } from '../support/heldBody';
import { NOT_A_MEMBER, UNKNOWN_SESSION } from '../support/spaceRefusals';

const posix = process.platform !== 'win32';
const SETUP_CODE = 'stack-test-code';
const PASSWORD = 'correct horse battery';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyren-stack-'));
  dirs.push(dir);
  return dir;
}

function config(o: Partial<Config> & { dataDir: string }): Config {
  return loadConfig({ dbPath: path.join(o.dataDir, 'lyren.db'), webDir: null, setupToken: SETUP_CODE, logRequests: false, ...o });
}

/** The value of the session cookie a response set. */
function sessionCookie(res: Response): string {
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith('lyren_session='));
  if (!cookie) throw new Error('no session cookie');
  return cookie.split(';')[0]!;
}

/** Whether the connection is open (DatabaseSync's isOpen is newer than Node 22.13, which package.json allows). */
function isOpen(db: NodeDb): boolean {
  try {
    db.raw.prepare('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

async function setup(stack: NodeStack): Promise<{ cookie: string; spaceId: string }> {
  const res = await stack.app.request('/api/auth/setup', {
    method: 'POST',
    headers: { [CSRF_HEADER]: '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'owner@example.com', displayName: 'Owner', password: PASSWORD, setupCode: SETUP_CODE }),
  });
  expect(res.status).toBe(201);
  const cookie = sessionCookie(res);
  const status = (await (await stack.app.request('/api/auth/status', { headers: { Cookie: cookie } })).json()) as AuthStatusDTO;
  return { cookie, spaceId: status.spaces[0]!.id };
}

/** A new space of the signed-in account; returns its id. */
async function createSpace(stack: NodeStack, cookie: string, name: string): Promise<string> {
  const res = await stack.app.request('/api/spaces', {
    method: 'POST',
    headers: { [CSRF_HEADER]: '1', 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ name }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

type RequestApp = { request(path: string, init: RequestInit): Response | Promise<Response> };

/** A space request whose JSON body arrives when the test releases it (the request waits meanwhile). */
function heldRequest(app: RequestApp, method: string, path: string, cookie: string, json: unknown, chunked = false) {
  const body = heldBody(json, { chunked });
  // `duplex` is required by undici for stream bodies (not yet in the RequestInit typings).
  const init = { method, headers: { [CSRF_HEADER]: '1', Cookie: cookie, ...body.headers }, body: body.stream, duplex: 'half' };
  return { response: Promise.resolve(app.request(path, init as RequestInit)), release: body.release };
}

/** A file's contents, as a hash to compare. */
const fileHash = (file: string) => sha256Hex(fs.readFileSync(file).toString('base64'));

describe('a stack in memory (tests)', () => {
  it('serves the directory and the spaces; unprefixed space paths are the directory’s (404 signed in)', async () => {
    const stack = openNodeStack(config({ dataDir: tempDir(), dbPath: ':memory:' }), { mode: 'maintenance' });
    try {
      expect(stack.firstRun).toBe(true);
      const { cookie, spaceId } = await setup(stack);
      const prefixed = await stack.app.request(`/api/s/${spaceId}/bootstrap`, { headers: { Cookie: cookie } });
      expect(prefixed.status).toBe(200);
      const body = (await prefixed.json()) as BootstrapDTO;
      expect(body.space).toEqual({ id: spaceId, name: "Owner's space", role: 'owner' });
      // The temporary shim of §7.3 is gone (P4): the old client's paths reach no space.
      const unprefixed = await stack.app.request('/api/bootstrap', { headers: { Cookie: cookie } });
      expect(unprefixed.status).toBe(404);
      expect(await unprefixed.json()).toEqual({ error: { code: 'not_found', message: 'Lyren Plan has been updated. Reload the page to continue.' } });
      // Any other path it does not know is just not found.
      expect(await (await stack.app.request('/api/nothing-here', { headers: { Cookie: cookie } })).json()).toEqual({ error: { code: 'not_found', message: 'Not found' } });
      expect(await (await stack.app.request('/api/tasksx', { headers: { Cookie: cookie } })).json()).toEqual({ error: { code: 'not_found', message: 'Not found' } });
      expect((await stack.app.request('/api/bootstrap')).status).toBe(401);
      // The space's database is reachable for maintenance and tests.
      expect(stack.spaces.database(spaceId)!.get<{ n: number }>('SELECT COUNT(*) AS n FROM statuses')!.n).toBeGreaterThan(0);
      expect(stack.spaces.list()).toEqual([spaceId]);
      expect(stack.spaces.database('0123456789abcdef')).toBeNull();
    } finally {
      stack.close();
    }
  });
});

describe('the request log (LOG_REQUESTS)', () => {
  it("prints Hono's two lines per request, without colors unless stdout is a terminal and NO_COLOR is unset", async () => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    // vitest's stdout is no terminal, as journald's and `docker logs`' are not.
    const stack = openNodeStack(config({ dataDir: tempDir(), dbPath: ':memory:', logRequests: true }), { mode: 'maintenance' });
    try {
      expect((await stack.app.request('/api/health')).status).toBe(200);
      const lines = logs.mock.calls.map((args) => String(args[0]));
      expect(lines[0]).toBe('<-- GET /api/health');
      expect(lines[1]).toMatch(/^--> GET \/api\/health 200 \d+m?s$/);
      const colored = '--> GET /api/health \x1b[32m200\x1b[0m 1ms';
      logs.mockClear();
      requestLogPrinter({ isTTY: true }, {})(colored);
      requestLogPrinter({ isTTY: true }, { NO_COLOR: '1' })(colored);
      requestLogPrinter({ isTTY: false }, {})(colored);
      requestLogPrinter({ isTTY: true }, { NO_COLOR: '' })(colored);
      expect(logs.mock.calls.map((args) => args[0])).toEqual([colored, '--> GET /api/health 200 1ms', '--> GET /api/health 200 1ms', colored]);
    } finally {
      logs.mockRestore();
      stack.close();
    }
  });
});

describe('a stack on disk', () => {
  it('keeps the directory in DB_PATH and each space in spaces/<id>.db, owner-only, marked user_version 100', async () => {
    const dataDir = tempDir();
    const cfg = config({ dataDir });
    let stack = openNodeStack(cfg, { mode: 'maintenance' });
    const { cookie, spaceId } = await setup(stack);
    const created = await stack.app.request(`/api/s/${spaceId}/projects`, {
      method: 'POST',
      headers: { [CSRF_HEADER]: '1', 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ name: 'Disk', key: 'DSK' }),
    });
    expect(created.status).toBe(201);
    stack.close();
    stack.close(); // idempotent

    const spaceFile = path.join(dataDir, 'spaces', `${spaceId}.db`);
    expect(fs.readdirSync(dataDir).sort()).toEqual(['lyren.db', 'spaces']);
    expect(fs.readdirSync(path.join(dataDir, 'spaces'))).toEqual([`${spaceId}.db`]);
    if (posix) {
      expect(fs.statSync(path.join(dataDir, 'spaces')).mode & 0o777).toBe(0o700);
      expect(fs.statSync(spaceFile).mode & 0o777).toBe(0o600);
    }
    for (const file of [cfg.dbPath, spaceFile]) {
      const db = new DatabaseSync(file);
      expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(100);
      db.close();
    }

    // A second start finds everything again.
    stack = openNodeStack(cfg, { mode: 'maintenance' });
    try {
      expect(stack.firstRun).toBe(false);
      const projects = await stack.app.request(`/api/s/${spaceId}/projects`, { headers: { Cookie: cookie } });
      expect(((await projects.json()) as Array<{ key: string }>).map((p) => p.key)).toContain('DSK');
    } finally {
      stack.close();
    }
  });

  it('names the spaces folder after a custom DB_PATH file (§3.1)', () => {
    expect(spacesDirFor(path.join('/srv', 'lyren.db'), 'linux')).toBe(path.join('/srv', 'spaces'));
    expect(spacesDirFor(path.join('/srv', 'Lyren.DB'), 'linux')).toBe(path.join('/srv', 'Lyren.DB.spaces'));
    expect(spacesDirFor(path.join('/srv', 'Lyren.DB'), 'win32')).toBe(path.join('/srv', 'spaces'));
    expect(spacesDirFor(path.join('/srv', 'work.db'), 'linux')).toBe(path.join('/srv', 'work.db.spaces'));
  });

  it('streams the backup download as a backup set of the directory and every space, leaving no temporary files', async () => {
    const dataDir = tempDir();
    const stack = openNodeStack(config({ dataDir, dbPath: path.join(dataDir, 'work.db') }), { mode: 'maintenance' });
    try {
      const { cookie, spaceId } = await setup(stack);
      const res = await stack.app.request('/api/admin/backup', { headers: { Cookie: cookie } });
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('application/x-tar');
      expect(res.headers.get('Content-Encoding')).toBeNull();
      const tar = new Uint8Array(await res.arrayBuffer());
      expect(Number(res.headers.get('Content-Length'))).toBe(tar.length);
      const file = path.join(tempDir(), 'download.tar');
      fs.writeFileSync(file, tar);
      const set = openBackupSet(file);
      expect(set.manifest.spaces.map((s) => s.file)).toEqual([`spaces/${spaceId}.db`]);
      expect(fs.readdirSync(dataDir).filter((n) => n.startsWith('.backup-'))).toEqual([]);
      expect(fs.existsSync(path.join(dataDir, 'work.db.spaces', `${spaceId}.db`))).toBe(true);
    } finally {
      stack.close();
    }
  });

  it('the admin spaces list gives each space’s file sizes (the database and its -wal), without opening it (null in memory)', async () => {
    const dataDir = tempDir();
    const stack = openNodeStack(config({ dataDir }), { mode: 'maintenance' });
    try {
      const { cookie, spaceId } = await setup(stack);
      const list = async () => (await (await stack.app.request('/api/admin/spaces', { headers: { Cookie: cookie } })).json()) as { items: Array<{ id: string; bytes: number | null }> };
      const file = path.join(dataDir, 'spaces', `${spaceId}.db`);
      const size = (f: string) => fs.statSync(f, { throwIfNoEntry: false })?.size ?? 0;
      expect(size(`${file}-wal`)).toBeGreaterThan(0);
      expect((await list()).items).toEqual([expect.objectContaining({ id: spaceId, bytes: size(file) + size(`${file}-wal`) })]);
      fs.rmSync(file);
      expect((await list()).items[0]!.bytes).toBeNull();
    } finally {
      stack.close();
    }
    const memory = openNodeStack(config({ dataDir: tempDir(), dbPath: ':memory:' }), { mode: 'maintenance' });
    try {
      const { cookie } = await setup(memory);
      const res = await memory.app.request('/api/admin/spaces', { headers: { Cookie: cookie } });
      expect(((await res.json()) as { items: Array<{ bytes: number | null }> }).items[0]!.bytes).toBeNull();
    } finally {
      memory.close();
    }
  });
});

describe('data this build refuses, before writing anything', () => {
  function refusal(cfg: Config): string {
    try {
      openNodeStack(cfg, { mode: 'maintenance' }).close();
    } catch (err) {
      expect(err).toBeInstanceOf(DataRefusal);
      return (err as Error).message;
    }
    throw new Error('expected a refusal');
  }

  it('a 1.x database (no _meta, a projects table, user_version 1) in maintenance mode', () => {
    const dataDir = tempDir();
    const file = path.join(dataDir, 'lyren.db');
    const legacy = new DatabaseSync(file);
    legacy.exec('CREATE TABLE projects (id INTEGER PRIMARY KEY); CREATE TABLE users (id INTEGER PRIMARY KEY); PRAGMA user_version = 1');
    legacy.close();
    const before = fs.readFileSync(file);
    expect(refusal(config({ dataDir }))).toBe(LEGACY_NOT_UPGRADED);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    expect(fs.readdirSync(dataDir)).toEqual(['lyren.db']);
  });

  it('a 1.x database whose last run ended uncleanly (its data still in the -wal) is left byte for byte', () => {
    const live = path.join(tempDir(), 'lyren.db');
    const legacy = new DatabaseSync(live);
    legacy.exec(`PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;
      CREATE TABLE projects (id INTEGER PRIMARY KEY); CREATE TABLE users (id INTEGER PRIMARY KEY);
      INSERT INTO projects (id) VALUES (1); PRAGMA user_version = 1`);
    // Copied while 1.x still has it open: what a crash (kill -9, power loss) leaves behind.
    const dataDir = tempDir();
    const file = path.join(dataDir, 'lyren.db');
    for (const suffix of ['', '-wal', '-shm']) fs.copyFileSync(`${live}${suffix}`, `${file}${suffix}`);
    legacy.close();
    const before = { db: fileHash(file), wal: fileHash(`${file}-wal`) };
    expect(refusal(config({ dataDir }))).toBe(LEGACY_NOT_UPGRADED);
    // Not checkpointed into the file: both are as 1.x left them.
    expect({ db: fileHash(file), wal: fileHash(`${file}-wal`) }).toEqual(before);
  });

  it('a pre-split database with a newer user_version, and a directory from a newer build', () => {
    const dataDir = tempDir();
    const file = path.join(dataDir, 'lyren.db');
    const newer = new DatabaseSync(file);
    newer.exec('CREATE TABLE projects (id INTEGER PRIMARY KEY); PRAGMA user_version = 2');
    newer.close();
    expect(refusal(config({ dataDir }))).toBe('Database schema version 2 is newer than this build supports (1). Upgrade the app.');

    const second = tempDir();
    openNodeStack(config({ dataDir: second }), { mode: 'maintenance' }).close();
    const db = new DatabaseSync(path.join(second, 'lyren.db'));
    db.exec("UPDATE _meta SET value = '9' WHERE key IN ('version', 'compatible_from')");
    db.close();
    expect(refusal(config({ dataDir: second }))).toBe('Database schema version 9 is newer than this build supports (1). Upgrade the app.');
  });

  it('a directory that another connection holds exclusively (another start upgrading or converting it), in both modes', () => {
    const dataDir = tempDir();
    const cfg = config({ dataDir });
    openNodeStack(cfg, { mode: 'maintenance' }).close();
    const holder = new DatabaseSync(cfg.dbPath);
    holder.exec('PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE');
    try {
      expect(refusal(cfg)).toBe(stillOpen(cfg.dbPath));
      expect(() => openNodeStack(cfg, { mode: 'serve' })).toThrow(new DataRefusal(stillOpen(cfg.dbPath)));
    } finally {
      holder.exec('COMMIT');
      holder.close();
    }
    openNodeStack(cfg, { mode: 'maintenance' }).close();
  });
});

describe('the space store', () => {
  it('keeps at most SPACES_OPEN_MAX spaces open and reopens the others on demand', async () => {
    const dataDir = tempDir();
    const stack = openNodeStack(config({ dataDir, spacesOpenMax: 1 }), { mode: 'maintenance' });
    try {
      const { cookie, spaceId } = await setup(stack);
      const secondId = await createSpace(stack, cookie, 'Second');
      const first = stack.spaces.database(spaceId)!;
      expect(isOpen(first)).toBe(true);
      stack.spaces.database(secondId);
      expect(isOpen(first)).toBe(false);
      expect((await stack.app.request(`/api/s/${spaceId}/bootstrap`, { headers: { Cookie: cookie } })).status).toBe(200);
      expect(stack.spaces.list().sort()).toEqual([spaceId, secondId].sort());
    } finally {
      stack.close();
    }
  });

  // Root writes read-only files anyway.
  it.skipIf(!posix || process.getuid?.() === 0)('a space file the server cannot write: 503, explained once in the log, served again once fixed', async () => {
    const dataDir = tempDir();
    const stack = openNodeStack(config({ dataDir, spacesOpenMax: 1 }), { mode: 'maintenance' });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { cookie, spaceId } = await setup(stack);
      // The LRU closes the first space, so its next request opens the file again.
      await createSpace(stack, cookie, 'Second');
      const file = path.join(spacesDirFor(path.join(dataDir, 'lyren.db')), `${spaceId}.db`);
      fs.chmodSync(file, 0o400);
      for (let i = 0; i < 2; i++) {
        const res = await stack.app.request(`/api/s/${spaceId}/bootstrap`, { headers: { Cookie: cookie } });
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({ error: { code: 'unavailable', message: "The server cannot open this space's data; its log says why." } });
      }
      const logged = errors.mock.calls.map((args) => args.map(String).join(' '));
      expect(logged[0]).toMatch(new RegExp(`^\\[lyren\\] Could not open the database ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: .*readonly`));
      expect(logged[1]).toBe(`The directory ${path.dirname(file)} and the files in it must be writable by the user running the server (uid ${process.getuid!()}).`);
      expect(logged.join('\n')).not.toMatch(/\n\s+at /);
      // Once: the second request logged nothing more.
      expect(logged.filter((line) => line.startsWith('[lyren]'))).toHaveLength(1);
      // The failed open left a -wal and -shm with the file's mode: the fix is for all of them (chown -R).
      for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(file + suffix)) fs.chmodSync(file + suffix, 0o600);
      expect((await stack.app.request(`/api/s/${spaceId}/bootstrap`, { headers: { Cookie: cookie } })).status).toBe(200);
    } finally {
      errors.mockRestore();
      stack.close();
    }
  });

  it('the hourly maintenance closes spaces idle for 10 minutes, and their next request opens them again', async () => {
    const clock = fakeClock(Date.now());
    const stack = openNodeStack(config({ dataDir: tempDir() }), { mode: 'maintenance', clock });
    try {
      const { cookie, spaceId } = await setup(stack);
      const secondId = await createSpace(stack, cookie, 'Second');
      const idle = stack.spaces.database(spaceId)!;
      const recent = stack.spaces.database(secondId)!;
      clock.advance(9 * 60_000);
      expect((await stack.app.request(`/api/s/${secondId}/bootstrap`, { headers: { Cookie: cookie } })).status).toBe(200);
      clock.advance(2 * 60_000);
      await stack.maintenance();
      expect(isOpen(idle)).toBe(false);
      expect(isOpen(recent)).toBe(true);
      expect((await stack.app.request(`/api/s/${spaceId}/bootstrap`, { headers: { Cookie: cookie } })).status).toBe(200);
      const reopened = stack.spaces.database(spaceId)!;
      expect(reopened === idle).toBe(false);
      expect(isOpen(reopened)).toBe(true);
    } finally {
      stack.close();
    }
  });

  it('a space the LRU let go while a request still runs in it is taken back, never opened a second time', async () => {
    const stack = openNodeStack(config({ dataDir: tempDir(), spacesOpenMax: 1 }), { mode: 'maintenance' });
    try {
      const { cookie, spaceId } = await setup(stack);
      const secondId = await createSpace(stack, cookie, 'Second');
      const get = (id: string, p: string, headers: Record<string, string> = {}) =>
        stack.app.request(`/api/s/${id}${p}`, { headers: { Cookie: cookie, ...headers } });
      expect((await get(spaceId, '/tags')).status).toBe(200);
      const db = stack.spaces.database(spaceId)!;

      const write = heldRequest(stack.app, 'POST', `/api/s/${spaceId}/tags`, cookie, { name: 'late' });
      await settle();
      // The second space pushes the first out of the LRU while its write waits for its body.
      expect((await get(secondId, '/bootstrap')).status).toBe(200);
      const during = await get(spaceId, '/tags');
      expect(during.status).toBe(200);
      expect(stack.spaces.database(spaceId) === db).toBe(true);

      write.release();
      expect((await write.response).status).toBe(201);
      // The write moved the generation the read's ETag was built on: no stale 304.
      const after = await get(spaceId, '/tags', { 'If-None-Match': during.headers.get('etag')! });
      expect(after.status).toBe(200);
      expect(((await after.json()) as TagDTO[]).map((t) => t.name)).toEqual(['late']);
      expect(after.headers.get('etag')).not.toBe(during.headers.get('etag'));
    } finally {
      stack.close();
    }
  });
});

describe('space requests on a Node stack', () => {
  it('are authorized before the space is touched: 401 without a known session, 404 for a non-member, existing or not', async () => {
    const ctx = createTestContext();
    const owner = await ctx.signedIn();
    const outsider = await ctx.addUser({ email: 'outsider@example.com', spaceId: null });
    const acquire = vi.spyOn(ctx.stack.spaces, 'acquire');
    const madeUp = `lyren_session=${'A'.repeat(43)}`;
    for (const spaceId of [ctx.spaceId, NO_SPACE_ID]) {
      const anonymous = await ctx.app.request(`/api/s/${spaceId}/bootstrap`, { headers: { Cookie: madeUp } });
      expect({ status: anonymous.status, body: await anonymous.json() }, spaceId).toEqual(UNKNOWN_SESSION);
      const nonMember = await outsider.client.get(`/api/s/${spaceId}/bootstrap`);
      expect({ status: nonMember.status, body: nonMember.body }, spaceId).toEqual(NOT_A_MEMBER);
    }
    expect(acquire).not.toHaveBeenCalled();
    expect((await owner.client.get('/api/bootstrap')).status).toBe(200);
    expect(acquire).toHaveBeenCalledTimes(1);
  });

  it('a write whose body arrives late is judged as of its arrival: removed, demoted or signed out, it writes nothing', async () => {
    const ctx = createTestContext();
    const owner = await ctx.signedIn();
    const project = (await owner.client.post<{ id: number }>('/api/projects', { name: 'Keep', key: 'KEEP' })).body;
    const admin = await ctx.addUser({ email: 'admin@example.com', role: 'admin' });
    const role = (client: TestClient, userId: number, value: string) =>
      client.patch(`/api/spaces/${ctx.spaceId}/members/${userId}`, { role: value });
    const held = (client: TestClient, method: string, p: string, json: unknown, chunked = false) =>
      heldRequest(ctx.app, method, ctx.path(p), client.cookieHeader(), json, chunked);

    // Demoted while a PATCH /settings is on its way.
    const patch = held(admin.client, 'PATCH', '/api/settings', { estimateUnit: 'hours' });
    await settle();
    expect((await role(owner.client, admin.user.id, 'member')).status).toBe(200);
    patch.release();
    expect((await patch.response).status).toBe(403);
    expect((await owner.client.get('/api/settings')).body.estimateUnit).toBe('points');

    // Removed while a DELETE with a chunked body is on its way.
    expect((await role(owner.client, admin.user.id, 'admin')).status).toBe(200);
    const deletion = held(admin.client, 'DELETE', `/api/projects/${project.id}`, {}, true);
    await settle();
    expect((await owner.client.delete(`/api/spaces/${ctx.spaceId}/members/${admin.user.id}`)).status).toBe(200);
    deletion.release();
    expect((await deletion.response).status).toBe(404);
    expect((await owner.client.get(`/api/projects/${project.id}`)).status).toBe(200);

    // Signed out (another tab) while a POST is on its way.
    const member = await ctx.addUser({ email: 'member@example.com' });
    const cookie = member.client.cookieHeader();
    const create = heldRequest(ctx.app, 'POST', ctx.path('/api/tags'), cookie, { name: 'late' });
    await settle();
    expect((await member.client.post('/api/auth/logout')).status).toBe(200);
    create.release();
    expect((await create.response).status).toBe(401);
    expect((await owner.client.get<TagDTO[]>('/api/tags')).body).toEqual([]);
  });
});
