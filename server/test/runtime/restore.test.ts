// The restore (runtime/node/restore.ts, design §9.6, §14.3): staging a backup set, one space's database
// and an old single-file backup, and applying them at the next serving start; an apply interrupted after
// any step; undoing a v1 import with its pre-import snapshot; the mirror of a restored space syncing at
// its first request; `restore -`; data from a newer build refused before anything moves; the maintenance
// commands refusing while a restore waits; a serving start refusing while another connection has DB_PATH
// open, or while another start applies the restore; foreign and malicious archives; and the snapshot of a
// space that is gone.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { CSRF_HEADER } from '@shared/constants';
import type { AuthStatusDTO, BootstrapDTO, SafetyPointDTO } from '@shared/types';
import { loadConfig, type Config } from '../../src/config';
import { systemClock } from '../../src/core/runtime';
import { pruneSnapshots } from '../../src/db/snapshots';
import { PasswordHasher } from '../../src/directory/passwords';
import { BackupError, NEWER_BACKUP, openBackupSet, writeBackupSet } from '../../src/runtime/node/backupSet';
import { detectLegacy, LEGACY_NOT_UPGRADED } from '../../src/runtime/node/legacy';
import { NodeDb } from '../../src/runtime/node/nodeDb';
import {
  applyPendingRestore,
  DIRECTORY_ONLY,
  isRestorePending,
  PENDING_FOLDER,
  pendingFolderFor,
  RestoreError,
  restoreNextStep,
  restoreWaitingMessage,
  RestoreStopped,
  SPACE_GONE,
  stageRestore,
  STILL_RUNNING,
  type RestoreStep,
} from '../../src/runtime/node/restore';
import { DataRefusal, openNodeStack, type NodeStack } from '../../src/runtime/node/stack';
import { createLegacyDb, LEGACY_PASSWORD, LIVE_TOKEN, OWNER_NAME } from '../fixtures/legacyV1';
import { downloadArchive, formBytes, importArchive } from '../support/archive';
import { addMembership, insertAccount } from '../support/directoryHarness';
import { rawTar } from '../support/rawTar';
import { ROOT, tsxCommand, tsxEnv } from '../tsxNode';

const SETUP_CODE = 'restore-test-code';
const PASSWORD = 'correct horse battery';
const OWNER = 'owner@example.com';
const DAY = 86_400_000;
const NOW = Date.parse('2026-10-17T12:00:00.000Z');

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyren-restore-'));
  dirs.push(dir);
  return dir;
}

/** dataDir too, not only dbPath: without it Config.dataDir would be DATA_DIR's default, ./data of the checkout. */
function config(dataDir: string, o: Partial<Config> = {}): Config {
  return loadConfig({ dataDir, dbPath: path.join(dataDir, 'lyren.db'), webDir: null, setupToken: SETUP_CODE, logRequests: false, ...o });
}

/** A request helper for one stack and cookie (CSRF header, JSON both ways). */
function api(stack: NodeStack, cookie: string | null = null) {
  const call = async <T = any>(method: string, p: string, body?: unknown) => {
    const res = await stack.app.request(p, {
      method,
      headers: { [CSRF_HEADER]: '1', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    return { status: res.status, body: parsed as T, cookies: res.headers.getSetCookie() };
  };
  return { get: <T = any>(p: string) => call<T>('GET', p), post: <T = any>(p: string, body: unknown = {}) => call<T>('POST', p, body) };
}

const cookieOf = (setCookies: string[]) => setCookies.map((c) => c.split(';')[0]!).join('; ');

/** A client for the archive helpers (support/archive.ts): forms as multipart bytes, the raw Response. */
function formClient(stack: NodeStack, cookie: string) {
  const raw = async (method: string, p: string, body?: unknown) => {
    const headers: Record<string, string> = { [CSRF_HEADER]: '1', Cookie: cookie };
    let sent: Uint8Array | undefined;
    if (body instanceof FormData) {
      const form = await formBytes(body);
      sent = form.body;
      headers['Content-Type'] = form.contentType;
    }
    return stack.app.request(p, { method, headers, body: sent });
  };
  return {
    raw,
    request: async (method: string, p: string, body?: unknown) => {
      const res = await raw(method, p, body);
      return { status: res.status, body: (await res.json()) as any };
    },
  };
}

/** Sign in by password (a restored directory has no sessions); returns the cookie. */
async function signIn(stack: NodeStack, identifier = OWNER, password = PASSWORD): Promise<string> {
  const res = await api(stack).post('/api/auth/login', { identifier, password });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return cookieOf(res.cookies);
}

const projectNames = async (stack: NodeStack, cookie: string, spaceId: string) =>
  ((await api(stack, cookie).get<Array<{ name: string }>>(`/api/s/${spaceId}/projects`)).body ?? []).map((p) => p.name).sort();

/**
 * A data folder on disk with the owner, their space ("Original" project) and a team space ("Team"
 * project). Returns the open stack (maintenance mode) with the owner's cookie.
 */
async function liveFolder(dataDir = tempDir()) {
  const cfg = config(dataDir);
  const stack = openNodeStack(cfg, { mode: 'maintenance' });
  const setup = await api(stack).post('/api/auth/setup', { email: OWNER, displayName: 'Owner', password: PASSWORD, setupCode: SETUP_CODE });
  expect(setup.status).toBe(201);
  const cookie = cookieOf(setup.cookies);
  const client = api(stack, cookie);
  const own = (await client.get<AuthStatusDTO>('/api/auth/status')).body.spaces[0]!.id;
  const team = (await client.post<{ id: string }>('/api/spaces', { name: 'Team space' })).body.id;
  expect((await client.post(`/api/s/${own}/projects`, { name: 'Original', key: 'ORI' })).status).toBe(201);
  expect((await client.post(`/api/s/${team}/projects`, { name: 'Team', key: 'TEAM' })).status).toBe(201);
  return { cfg, dataDir, stack, cookie, client, own, team };
}

function writeSet(stack: NodeStack, cfg: Config, target: string): void {
  writeBackupSet({ directoryDb: stack.directoryDb, store: stack.spaces, dataDir: path.dirname(cfg.dbPath), target, nowMs: Date.now() });
}

/** A serving start's open (mode 'serve': the apply, the upgrade), with what it logged; closed again. */
function serveOnce(cfg: Config, o: Parameters<typeof openNodeStack>[1] = {}): string[] {
  const lines: string[] = [];
  const stack = openNodeStack(cfg, { mode: 'serve', restoreHooks: { log: (l) => lines.push(l), ...o.restoreHooks }, ...o });
  stack.close();
  return lines;
}

/** Every file and folder under `dir` (relative, sorted), without SQLite's -wal and -shm. */
/** Every file below `dir` but -wal and -shm files, and the apply's lock (an apply that refused leaves it). */
function listing(dir: string): string[] {
  return (fs.readdirSync(dir, { recursive: true }) as string[])
    .filter((n) => !/-(?:wal|shm)$/.test(n) && !/restore-pending[\\/]APPLYING$/.test(n))
    .sort();
}

/** Rows of a database file, read-only. */
function rows(file: string, sql: string): Array<Record<string, unknown>> {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(sql).all().map((r) => ({ ...r }));
  } finally {
    db.close();
  }
}

describe('a backup set', () => {
  it('is staged without touching the current data, and applied by the next serving start', async () => {
    const live = await liveFolder();
    const set = path.join(tempDir(), 'set.tar');
    writeSet(live.stack, live.cfg, set);
    // Changes after the backup, which the restore undoes: a project, a space, an account's name.
    expect((await live.client.post(`/api/s/${live.own}/projects`, { name: 'Later', key: 'LAT' })).status).toBe(201);
    const later = (await live.client.post<{ id: string }>('/api/spaces', { name: 'Made later' })).body.id;
    live.stack.close();
    const before = listing(live.dataDir);

    const staged = stageRestore({ dbPath: live.cfg.dbPath, source: set, nowMs: NOW });
    expect(staged).toMatchObject({ kind: 'set', stamp: '2026-10-17T12-00-00-000Z' });
    expect(staged.description).toMatch(/^the backup set made \S+ \(2 spaces\)$/);
    expect(isRestorePending(live.cfg.dbPath)).toBe(true);
    const pending = path.join(live.dataDir, PENDING_FOLDER);
    expect(listing(pending)).toEqual(['READY', 'directory.db', 'spaces', `spaces/${live.own}.db`, `spaces/${live.team}.db`].sort());
    expect(JSON.parse(fs.readFileSync(path.join(pending, 'READY'), 'utf8'))).toMatchObject({ kind: 'set', stamp: staged.stamp });
    // Each staged space syncs its mirror at its first request.
    expect(rows(path.join(pending, 'spaces', `${live.own}.db`), "SELECT value FROM _meta WHERE key = 'sync_version'")).toEqual([{ value: '0' }]);
    expect(listing(live.dataDir).filter((n) => !n.startsWith(PENDING_FOLDER))).toEqual(before);
    expect(staged.movesOut).toBe(true);
    expect(restoreNextStep('server', staged)).toBe(
      'Restart Lyren Plan to complete the restore (systemctl restart lyren-plan, or docker restart lyren-plan). ' +
        'The current data will be moved to backups/before-restore-2026-10-17T12-00-00-000Z/.',
    );
    expect(restoreNextStep('desktop', staged)).toBe('Quit Lyren Plan and start it again to complete the restore.');

    // A maintenance command refuses; the serving start applies it.
    expect(() => openNodeStack(live.cfg, { mode: 'maintenance' })).toThrow(new DataRefusal(restoreWaitingMessage(live.cfg.dbPath)));
    const lines = serveOnce(live.cfg);
    expect(lines).toEqual([
      `Restored ${staged.description}. The data it replaced was moved to ${path.join('backups', 'before-restore-2026-10-17T12-00-00-000Z')}/.`,
    ]);
    expect(fs.existsSync(pending)).toBe(false);
    const moved = path.join(live.dataDir, 'backups', `before-restore-${staged.stamp}`);
    expect(listing(moved)).toEqual(['lyren.db', 'spaces', `spaces/${later}.db`, `spaces/${live.own}.db`, `spaces/${live.team}.db`].sort());

    const stack = openNodeStack(live.cfg, { mode: 'maintenance' });
    try {
      // A set holds no sessions: sign in again.
      expect((await api(stack, live.cookie).get('/api/account')).status).toBe(401);
      const cookie = await signIn(stack);
      const status = (await api(stack, cookie).get<AuthStatusDTO>('/api/auth/status')).body;
      expect(status.spaces.map((s) => s.id).sort()).toEqual([live.own, live.team].sort());
      expect(await projectNames(stack, cookie, live.own)).toEqual(['Original']);
      expect(await projectNames(stack, cookie, live.team)).toEqual(['Team']);
      expect(fs.existsSync(path.join(live.dataDir, 'spaces', `${later}.db`))).toBe(false);
      // The first request synced the mirror (sync_version 0 before it).
      const synced = stack.spaces.database(live.own)!.get<{ value: string }>("SELECT value FROM _meta WHERE key = 'sync_version'")!.value;
      expect(Number(synced)).toBe(stack.directoryDb.get<{ v: number }>('SELECT sync_version AS v FROM spaces WHERE public_id = :id', { id: live.own })!.v);
    } finally {
      stack.close();
    }

    // before-restore folders are never pruned (they are folders, which no snapshot rule touches).
    pruneSnapshots(path.join(live.dataDir, 'backups'), 'before-upgrade', 1, 'x.db');
    expect(fs.existsSync(moved)).toBe(true);
  });

  it('works on a new server: no data folder yet, nothing to move out', async () => {
    const live = await liveFolder();
    const set = path.join(tempDir(), 'set.tar');
    writeSet(live.stack, live.cfg, set);
    live.stack.close();
    const fresh = config(path.join(tempDir(), 'new', 'data'));
    const staged = stageRestore({ dbPath: fresh.dbPath, source: set, nowMs: NOW });
    // Nothing will move out, and `restore` does not say it would.
    expect(staged.movesOut).toBe(false);
    expect(restoreNextStep('server', staged)).toBe(
      'Restart Lyren Plan to complete the restore (systemctl restart lyren-plan, or docker restart lyren-plan).',
    );
    expect(serveOnce(fresh)).toEqual([expect.stringMatching(/^Restored the backup set made \S+ \(2 spaces\)\.$/)]);
    expect(fs.existsSync(path.join(fresh.dataDir, 'backups'))).toBe(false);
    const stack = openNodeStack(fresh, { mode: 'maintenance' });
    try {
      expect(await projectNames(stack, await signIn(stack), live.own)).toEqual(['Original']);
    } finally {
      stack.close();
    }
  });
});

describe('one space: a pre-import snapshot undoes a replace import', () => {
  it('restores that space only, keeps the directory as it is now, and its mirror resyncs at the first request', async () => {
    const live = await liveFolder();
    const { stack, own, team } = live;
    // The import: the team space's archive replaces the owner's space, after a pre-import snapshot.
    const exported = await downloadArchive(formClient(stack, live.cookie), `/api/s/${team}/data/export`);
    expect(exported.status).toBe(200);
    const imported = await importArchive(formClient(stack, live.cookie), {
      path: `/api/s/${own}/data`,
      mode: 'replace',
      file: exported.bytes,
    });
    expect(imported.commit.status, JSON.stringify(imported.commit.body)).toBe(200);
    const { path: backupFile, restoreCommand } = imported.commit.body.safety as SafetyPointDTO;
    expect(backupFile).toMatch(new RegExp(`^backups/spaces/${own}/pre-import-.+\\.db$`));
    expect(restoreCommand).toBe(`restore "${backupFile}"`);
    expect(await projectNames(stack, live.cookie, own)).toEqual(['Team']);
    // After the snapshot the directory changes: a new member the snapshot's mirror never saw.
    const hasher = new PasswordHasher({ target: { kdf: 'scrypt', scryptP: 1 }, clock: systemClock });
    const newcomer = await insertAccount(stack.directoryDb, hasher, { email: 'new@example.com', displayName: 'Newcomer' }, Date.now());
    addMembership(stack.directoryDb, { spaceId: own, userId: newcomer, role: 'member', nowMs: Date.now() });
    const spaceRow = stack.directoryDb.get<{ id: number }>('SELECT id FROM spaces WHERE public_id = :id', { id: own })!.id;
    stack.close();

    // The restore command, as the import's result names it: relative to the data folder.
    const staged = stageRestore({ dbPath: live.cfg.dbPath, source: path.join(live.dataDir, backupFile), nowMs: NOW });
    expect(staged).toMatchObject({ kind: 'space', description: `the space Owner's space (${own})` });
    expect(listing(path.join(live.dataDir, PENDING_FOLDER))).toEqual(['READY', 'spaces', `spaces/${own}.db`]);
    expect(serveOnce(live.cfg)).toEqual([
      `Restored the space Owner's space (${own}). The data it replaced was moved to ${path.join('backups', `before-restore-${staged.stamp}`)}/.`,
    ]);
    expect(listing(path.join(live.dataDir, 'backups', `before-restore-${staged.stamp}`))).toEqual(['spaces', `spaces/${own}.db`]);

    const again = openNodeStack(live.cfg, { mode: 'maintenance' });
    try {
      // The sessions are the directory's, which a single space's restore leaves alone.
      expect(await projectNames(again, live.cookie, own)).toEqual(['Original']);
      expect(await projectNames(again, live.cookie, team)).toEqual(['Team']);
      const people = (await api(again, live.cookie).get<BootstrapDTO>(`/api/s/${own}/bootstrap`)).body.people;
      expect(people.map((p) => p.displayName)).toContain('Newcomer');
      const db = again.spaces.database(own)!;
      expect(db.get<{ value: string }>("SELECT value FROM _meta WHERE key = 'sync_version'")!.value).toBe(
        String(again.directoryDb.get<{ v: number }>('SELECT sync_version AS v FROM spaces WHERE id = :s', { s: spaceRow })!.v),
      );
    } finally {
      again.close();
    }
  });

  it('refuses the snapshot of a space the directory no longer lists, or that is past its grace period', async () => {
    const live = await liveFolder();
    const snapshot = path.join(tempDir(), 'team.db');
    live.stack.spaces.snapshot(live.team, snapshot);
    const now = Date.now();
    live.stack.directoryDb.run('UPDATE spaces SET deleted_at = :d, purge_after = :p WHERE public_id = :id', {
      id: live.team,
      d: new Date(now - 8 * DAY).toISOString(),
      p: new Date(now - DAY).toISOString(),
    });
    expect(() => stageRestore({ dbPath: live.cfg.dbPath, source: snapshot, nowMs: now })).toThrow(new RestoreError(SPACE_GONE));
    // Within the grace period it can still be restored (as the space itself can).
    live.stack.directoryDb.run('UPDATE spaces SET purge_after = :p WHERE public_id = :id', { id: live.team, p: new Date(now + DAY).toISOString() });
    expect(stageRestore({ dbPath: live.cfg.dbPath, source: snapshot, nowMs: now }).kind).toBe('space');
    fs.rmSync(path.join(live.dataDir, PENDING_FOLDER), { recursive: true });
    // Purged: the row is gone.
    live.stack.directoryDb.run('DELETE FROM spaces WHERE public_id = :id', { id: live.team });
    expect(() => stageRestore({ dbPath: live.cfg.dbPath, source: snapshot, nowMs: now })).toThrow(new RestoreError(SPACE_GONE));
    // A data folder without a directory lists no space either.
    expect(() => stageRestore({ dbPath: path.join(tempDir(), 'lyren.db'), source: snapshot, nowMs: now })).toThrow(new RestoreError(SPACE_GONE));
    live.stack.close();
    expect(fs.existsSync(path.join(live.dataDir, PENDING_FOLDER))).toBe(false);
  });
});

describe('an old single-file backup', () => {
  it('becomes DB_PATH, and the same start upgrades it into a directory and a space', async () => {
    const live = await liveFolder();
    live.stack.close();
    const old = path.join(tempDir(), 'lyren-2026-01-01.db');
    await createLegacyDb(old);
    const staged = stageRestore({ dbPath: live.cfg.dbPath, source: old, nowMs: NOW });
    expect(staged).toMatchObject({ kind: 'legacy', description: 'an old single-file backup (Lyren Plan 1.x)' });
    expect(listing(path.join(live.dataDir, PENDING_FOLDER))).toEqual(['READY', 'legacy.db', 'spaces']);
    expect(rows(path.join(live.dataDir, PENDING_FOLDER, 'legacy.db'), 'SELECT COUNT(*) AS n FROM sessions')).toEqual([{ n: 0 }]);
    expect(rows(old, 'SELECT COUNT(*) AS n FROM sessions')).toEqual([{ n: 3 }]);
    const lines: string[] = [];
    const logged = (line: unknown) => lines.push(String(line));
    const original = console.log;
    console.log = logged;
    let stack: NodeStack;
    try {
      stack = openNodeStack(live.cfg, { mode: 'serve' });
    } finally {
      console.log = original;
    }
    try {
      expect(lines[0]).toBe(
        `Restored an old single-file backup (Lyren Plan 1.x). The data it replaced was moved to ${path.join('backups', `before-restore-${staged.stamp}`)}/.`,
      );
      expect(lines[1]).toMatch(/^Upgraded the database for multi-user spaces: your data is now in the space /);
      // Its sign-in sessions stay behind, revoked ones included (§9.5): the old cookie signs nobody in.
      expect(stack.directoryDb.get<{ n: number }>('SELECT COUNT(*) AS n FROM sessions')!.n).toBe(0);
      const old = (await stack.app.request('/api/auth/status', { headers: { Cookie: `lyren_session=${LIVE_TOKEN}` } })).json();
      expect(((await old) as AuthStatusDTO).user).toBeNull();
      // The 1.x account signs in with its old password; the account the restore replaced is gone.
      expect((await api(stack).post('/api/auth/login', { identifier: OWNER, password: PASSWORD })).status).toBe(401);
      const cookie = await signIn(stack, 'owner', LEGACY_PASSWORD);
      const status = (await api(stack, cookie).get<AuthStatusDTO>('/api/auth/status')).body;
      expect(status.spaces.map((s) => s.name)).toEqual([`${OWNER_NAME}'s space`]);
      expect(await projectNames(stack, cookie, status.spaces[0]!.id)).toEqual(['Ops', 'Website Ünïcode']);
    } finally {
      stack.close();
    }
    const moved = path.join(live.dataDir, 'backups', `before-restore-${staged.stamp}`);
    expect(listing(moved)).toEqual(['lyren.db', 'spaces', `spaces/${live.own}.db`, `spaces/${live.team}.db`].sort());
    expect(fs.readdirSync(path.join(live.dataDir, 'backups')).some((n) => n.startsWith('lyren-v1-before-upgrade-'))).toBe(true);
  });
});

describe('an apply interrupted after any step finishes at the next start', () => {
  /** The current data with a restore of `kind` staged, in a folder of its own to copy for each run. */
  async function template(kind: 'set' | 'space' | 'legacy') {
    const live = await liveFolder();
    const source = path.join(tempDir(), 'source');
    if (kind === 'set') writeSet(live.stack, live.cfg, source);
    else if (kind === 'space') live.stack.spaces.snapshot(live.own, source);
    else await createLegacyDb(source);
    // The current data differs from the backup.
    expect((await live.client.post(`/api/s/${live.own}/projects`, { name: 'Later', key: 'LAT' })).status).toBe(201);
    live.stack.close();
    stageRestore({ dbPath: live.cfg.dbPath, source, nowMs: NOW });
    return { dataDir: live.dataDir, own: live.own };
  }

  /** What the data folder holds: its files, the directory's spaces, and the projects of each space file. */
  function stateOf(dataDir: string): unknown {
    const dbPath = path.join(dataDir, 'lyren.db');
    const files = listing(dataDir);
    const spacesDir = path.join(dataDir, 'spaces');
    const projects = fs.existsSync(spacesDir)
      ? Object.fromEntries(
          fs
            .readdirSync(spacesDir)
            .filter((n) => n.endsWith('.db'))
            .map((n) => [n, rows(path.join(spacesDir, n), 'SELECT name FROM projects ORDER BY name')]),
        )
      : {};
    const directory = detectLegacy(dbPath).kind === 'legacy' ? 'legacy' : rows(dbPath, 'SELECT public_id FROM spaces ORDER BY id');
    return { files, directory, projects };
  }

  function copyOf(dir: string): { dataDir: string; cfg: Config } {
    const dataDir = path.join(tempDir(), 'data');
    fs.cpSync(dir, dataDir, { recursive: true });
    return { dataDir, cfg: config(dataDir) };
  }

  it.each(['set', 'space', 'legacy'] as const)('%s', async (kind) => {
    const t = await template(kind);
    const clean = copyOf(t.dataDir);
    const steps: RestoreStep[] = [];
    applyPendingRestore({ dbPath: clean.cfg.dbPath, hooks: { afterStep: (s) => steps.push(s), log: () => undefined } });
    const expected = stateOf(clean.dataDir);
    expect(steps[0]).toBe('lock');
    expect(steps).toContain('phase:moving-out');
    expect(steps).toContain('phase:moving-in');
    expect(steps.at(-1)).toBe('ready-removed');
    expect((expected as { files: string[] }).files).not.toContain(PENDING_FOLDER);

    for (const step of steps) {
      const run = copyOf(t.dataDir);
      const crash = () => {
        throw new Error(`crash after ${step}`);
      };
      expect(() =>
        applyPendingRestore({ dbPath: run.cfg.dbPath, hooks: { afterStep: (s) => s === step && crash(), log: () => undefined } }),
      ).toThrow(`crash after ${step}`);
      // The next start: a restore that was still staged is finished; one that was done is not repeated.
      const result = applyPendingRestore({ dbPath: run.cfg.dbPath, hooks: { log: () => undefined } });
      expect(result === null, step).toBe(step === 'ready-removed');
      expect(stateOf(run.dataDir), step).toEqual(expected);
    }
  });
});

describe('two starts at once', () => {
  // Without the apply's lock, the later start (past proveExclusive once the first had let go of DB_PATH)
  // applied the same restore again: on a new server it moved the directory and the spaces the first had
  // just moved in to before-restore, and the next start served an empty install.
  it.each([
    ['on a new server', false],
    ['over current data', true],
  ])('%s: while one applies the restore, the other refuses with STILL_RUNNING and moves nothing', async (_, current) => {
    const live = await liveFolder();
    const set = path.join(tempDir(), 'set.tar');
    writeSet(live.stack, live.cfg, set);
    expect((await live.client.post(`/api/s/${live.own}/projects`, { name: 'Later', key: 'LAT' })).status).toBe(201);
    live.stack.close();
    const cfg = current ? live.cfg : config(path.join(tempDir(), 'data'));
    stageRestore({ dbPath: cfg.dbPath, source: set, nowMs: NOW });
    const other = () => applyPendingRestore({ dbPath: cfg.dbPath, hooks: { busyTimeoutMs: 0, log: () => undefined } });
    const steps: RestoreStep[] = [];
    const lines: string[] = [];
    const applied = applyPendingRestore({
      dbPath: cfg.dbPath,
      hooks: {
        log: (line) => lines.push(line),
        afterStep: (step) => {
          steps.push(step);
          const before = listing(cfg.dataDir);
          if (step === 'ready-removed') {
            // Without READY there is nothing to apply: the folder is what a start removes.
            expect(other()).toBeNull();
            expect(listing(cfg.dataDir)).toEqual(before.filter((n) => !n.startsWith(PENDING_FOLDER)));
          } else {
            expect(other, step).toThrow(new RestoreStopped(STILL_RUNNING));
            expect(listing(cfg.dataDir), step).toEqual(before);
          }
        },
      },
    });
    expect(applied?.kind).toBe('set');
    expect(steps).toEqual(expect.arrayContaining(['lock', 'phase:moving-out', 'phase:moving-in', 'in:directory.db', 'in:spaces']));
    expect(lines).toEqual([expect.stringMatching(/^Restored the backup set made \S+ \(2 spaces\)\./)]);
    expect(fs.existsSync(pendingFolderFor(cfg.dbPath))).toBe(false);
    const stack = openNodeStack(cfg, { mode: 'maintenance' });
    try {
      const cookie = await signIn(stack);
      expect(await projectNames(stack, cookie, live.own)).toEqual(['Original']);
      expect(await projectNames(stack, cookie, live.team)).toEqual(['Team']);
    } finally {
      stack.close();
    }
  });
});

describe('refusals', () => {
  it('data from a newer build, before anything is staged', async () => {
    const live = await liveFolder();
    const dbPath = live.cfg.dbPath;
    live.stack.close();
    const newer = (file: string) => {
      const db = new DatabaseSync(file);
      db.exec("UPDATE _meta SET value = '99' WHERE key IN ('version', 'compatible_from')");
      db.close();
    };
    // A set with a space from a newer build.
    const spaceFile = path.join(live.dataDir, 'spaces', `${live.team}.db`);
    const saved = fs.readFileSync(spaceFile);
    newer(spaceFile);
    const set = path.join(tempDir(), 'set.tar');
    const stack = openNodeStack(live.cfg, { mode: 'maintenance' });
    try {
      writeSet(stack, live.cfg, set);
    } finally {
      stack.close();
    }
    fs.writeFileSync(spaceFile, saved);
    expect(() => stageRestore({ dbPath, source: set, nowMs: NOW })).toThrow(new BackupError(NEWER_BACKUP));
    // A space file, and a 1.x file with a newer user_version.
    const snapshot = path.join(tempDir(), 'space.db');
    fs.copyFileSync(path.join(live.dataDir, 'spaces', `${live.own}.db`), snapshot);
    newer(snapshot);
    expect(() => stageRestore({ dbPath, source: snapshot, nowMs: NOW })).toThrow(new BackupError(NEWER_BACKUP));
    const legacy = path.join(tempDir(), 'old.db');
    await createLegacyDb(legacy);
    const db = new DatabaseSync(legacy);
    db.exec('PRAGMA user_version = 2');
    db.close();
    expect(() => stageRestore({ dbPath, source: legacy, nowMs: NOW })).toThrow(new BackupError(NEWER_BACKUP));
    expect(fs.existsSync(path.join(live.dataDir, PENDING_FOLDER))).toBe(false);
    // Nothing moved at the next start either.
    expect(serveOnce(live.cfg)).toEqual([]);
  });

  it('a backup whose staged copy would not fit on the disk (with 64 MiB to spare), before anything is staged', async () => {
    const MIB = 1024 * 1024;
    const live = await liveFolder();
    const set = path.join(tempDir(), 'set.tar');
    writeSet(live.stack, live.cfg, set);
    live.stack.close();
    const reader = openBackupSet(set);
    const space = path.join(tempDir(), 'space.db');
    fs.copyFileSync(path.join(live.dataDir, 'spaces', `${live.own}.db`), space);
    const cases: Array<[string, number]> = [
      [set, reader.directory.size + [...reader.spaces.values()].reduce((sum, item) => sum + item.size, 0)],
      [space, fs.statSync(space).size],
    ];
    for (const [source, bytes] of cases) {
      const needed = bytes + 64 * MIB;
      const blocks = Math.ceil(needed / 4096);
      const statfs = vi.fn(() => ({ bavail: blocks - 1, bsize: 4096 }));
      expect(() => stageRestore({ dbPath: live.cfg.dbPath, source, nowMs: NOW, statfs })).toThrow(
        new RestoreError(
          `Not enough free disk space to restore this backup: about ${Math.ceil(needed / MIB)} MB are needed in ${live.dataDir}, ` +
            `${Math.floor(((blocks - 1) * 4096) / MIB)} MB are free. Nothing was staged.`,
        ),
      );
      expect(statfs).toHaveBeenCalledWith(live.dataDir);
      expect(fs.readdirSync(live.dataDir).filter((name) => name.startsWith('.restore'))).toEqual([]);
      // Enough room: staged.
      stageRestore({ dbPath: live.cfg.dbPath, source, nowMs: NOW, statfs: () => ({ bavail: BigInt(blocks), bsize: 4096n }) });
      fs.rmSync(path.join(live.dataDir, PENDING_FOLDER), { recursive: true });
    }
  });

  it('every restore while DB_PATH still holds a 1.x database (§3.8: only backup works there), before anything is staged', async () => {
    const live = await liveFolder();
    const set = path.join(tempDir(), 'set.tar');
    writeSet(live.stack, live.cfg, set);
    const snapshot = path.join(tempDir(), 'space.db');
    live.stack.spaces.snapshot(live.own, snapshot);
    live.stack.close();
    const old = path.join(tempDir(), 'old.db');
    await createLegacyDb(old);
    const dataDir = tempDir();
    const dbPath = path.join(dataDir, 'lyren.db');
    await createLegacyDb(dbPath);
    for (const source of [set, snapshot, old]) {
      expect(() => stageRestore({ dbPath, source, nowMs: NOW }), source).toThrow(new RestoreError(LEGACY_NOT_UPGRADED));
    }
    expect(fs.readdirSync(dataDir).filter((n) => !n.startsWith('lyren.db'))).toEqual([]);
  });

  it('a directory file alone, files that are no backup, and a damaged database', async () => {
    const live = await liveFolder();
    const dbPath = live.cfg.dbPath;
    const directory = path.join(tempDir(), 'directory.db');
    live.stack.directoryDb.backupTo(directory);
    const snapshot = path.join(tempDir(), 'space.db');
    live.stack.spaces.snapshot(live.own, snapshot);
    live.stack.close();
    expect(() => stageRestore({ dbPath, source: directory, nowMs: NOW })).toThrow(new RestoreError(DIRECTORY_ONLY));
    const text = path.join(tempDir(), 'notes.txt');
    fs.writeFileSync(text, 'hello');
    const other = path.join(tempDir(), 'other.db');
    new DatabaseSync(other).exec('CREATE TABLE t (x)');
    for (const file of [text, other]) {
      expect(() => stageRestore({ dbPath, source: file, nowMs: NOW })).toThrow(/is not a Lyren Plan backup: a backup set \(\.tar\), /);
    }
    // A page in the middle overwritten: quick_check finds it before anything is staged.
    const big = path.join(tempDir(), 'big.db');
    fs.copyFileSync(snapshot, big);
    const fd = fs.openSync(big, 'r+');
    const size = fs.fstatSync(fd).size;
    fs.writeSync(fd, Buffer.alloc(4096, 0xab), 0, 4096, Math.max(4096, size - 8192));
    fs.closeSync(fd);
    expect(() => stageRestore({ dbPath, source: big, nowMs: NOW })).toThrow(new RestoreError("The backup's big.db is damaged (database disk image is malformed); nothing was staged."));
    expect(fs.existsSync(path.join(live.dataDir, PENDING_FOLDER))).toBe(false);
  });

  it('foreign and malicious archives: ../, absolute paths, links, huge sizes, duplicates', async () => {
    const live = await liveFolder();
    live.stack.close();
    const one = new Uint8Array([1]);
    const archives: Array<[string, Buffer, RegExp]> = [
      ['another program', rawTar([{ name: 'README', data: one }]), /does not start with lyren-backup\.json/],
      ['a .. segment', rawTar([{ name: 'lyren-backup.json', data: one }, { name: 'spaces/../../evil', data: one }]), /not allowed/],
      ['an absolute path', rawTar([{ name: '/etc/cron.d/evil', data: one }]), /not allowed/],
      ['a symlink', rawTar([{ name: 'lyren-backup.json', type: '2' }]), /other than files and folders/],
      ['a hard link', rawTar([{ name: 'lyren-backup.json', type: '1' }]), /other than files and folders/],
      ['a huge size', rawTar([{ name: 'lyren-backup.json', data: one, size: 8 * 1024 ** 3 }]), /too large/],
      ['a duplicate', rawTar([{ name: 'lyren-backup.json', data: one }, { name: 'lyren-backup.json', data: one }]), /twice/],
      ['GNU tar', rawTar([{ name: 'lyren-backup.json', data: one, magic: 'ustar  \0' }]), /not in the ustar format/],
    ];
    for (const [what, bytes, message] of archives) {
      const file = path.join(tempDir(), 'x.tar');
      fs.writeFileSync(file, bytes);
      const run = () => stageRestore({ dbPath: live.cfg.dbPath, source: file, nowMs: NOW });
      expect(run, what).toThrow(BackupError);
      expect(run, what).toThrow(/^This is not a Lyren Plan backup set: /);
      expect(run, what).toThrow(message);
    }
    expect(fs.existsSync(path.join(live.dataDir, PENDING_FOLDER))).toBe(false);
    expect(fs.existsSync(path.join(path.sep, 'etc', 'cron.d', 'evil'))).toBe(false);
  });

  it('a serving start refuses while another connection has DB_PATH open, and moves nothing', async () => {
    const live = await liveFolder();
    const set = path.join(tempDir(), 'set.tar');
    writeSet(live.stack, live.cfg, set);
    live.stack.close();
    stageRestore({ dbPath: live.cfg.dbPath, source: set, nowMs: NOW });
    // A server that still runs on the data: an open connection that has read from it.
    const other = new NodeDb(live.cfg.dbPath, { strict: false });
    other.get('SELECT COUNT(*) AS n FROM users');
    const before = listing(live.dataDir);
    try {
      expect(() => serveOnce(live.cfg, { restoreHooks: { busyTimeoutMs: 50 } })).toThrow(new DataRefusal(STILL_RUNNING));
      expect(() => applyPendingRestore({ dbPath: live.cfg.dbPath, hooks: { busyTimeoutMs: 50 } })).toThrow(new RestoreStopped(STILL_RUNNING));
      expect(listing(live.dataDir)).toEqual(before);
      expect(isRestorePending(live.cfg.dbPath)).toBe(true);
    } finally {
      other.close();
    }
    expect(serveOnce(live.cfg)).toHaveLength(1);
    expect(isRestorePending(live.cfg.dbPath)).toBe(false);
  });

  it('a second restore while one is staged, and a staging folder without READY', async () => {
    const live = await liveFolder();
    const set = path.join(tempDir(), 'set.tar');
    writeSet(live.stack, live.cfg, set);
    live.stack.close();
    stageRestore({ dbPath: live.cfg.dbPath, source: set, nowMs: NOW });
    expect(() => stageRestore({ dbPath: live.cfg.dbPath, source: set, nowMs: NOW })).toThrow(new RestoreError(restoreWaitingMessage(live.cfg.dbPath)));
    // An interrupted staging (no READY) is never applied: staging again replaces it, a start removes it.
    const pending = path.join(live.dataDir, PENDING_FOLDER);
    fs.rmSync(path.join(pending, 'READY'));
    expect(isRestorePending(live.cfg.dbPath)).toBe(false);
    expect(serveOnce(live.cfg)).toEqual([]);
    expect(fs.existsSync(pending)).toBe(false);
  });
});

describe('the staging folder belongs to one database', () => {
  it('a restore staged for work.db is applied by work.db alone; home.db in the same folder neither applies nor waits for it', async () => {
    const live = await liveFolder();
    const set = path.join(tempDir(), 'set.tar');
    writeSet(live.stack, live.cfg, set);
    live.stack.close();
    // Two databases in one folder (§3.1: work.db.spaces/ and home.db.spaces/).
    const folder = tempDir();
    const work = config(folder, { dbPath: path.join(folder, 'work.db') });
    const home = config(folder, { dbPath: path.join(folder, 'home.db') });
    const homeLive = await liveFolder(folder);
    homeLive.stack.close();
    fs.renameSync(path.join(folder, 'lyren.db'), home.dbPath);
    fs.renameSync(path.join(folder, 'spaces'), path.join(folder, 'home.db.spaces'));
    const homeBefore = listing(folder);

    expect(pendingFolderFor(work.dbPath)).toBe(path.join(folder, '.work.db.restore-pending'));
    expect(pendingFolderFor(path.join(folder, 'lyren.db'))).toBe(path.join(folder, PENDING_FOLDER));
    expect(pendingFolderFor(path.join(folder, 'Lyren.DB'), 'win32')).toBe(path.join(folder, PENDING_FOLDER));
    expect(pendingFolderFor(path.join(folder, 'Lyren.DB'), 'linux')).toBe(path.join(folder, '.Lyren.DB.restore-pending'));
    const staged = stageRestore({ dbPath: work.dbPath, source: set, nowMs: NOW });
    expect(staged.movesOut).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(pendingFolderFor(work.dbPath), 'READY'), 'utf8'))).toMatchObject({ dbName: 'work.db' });
    expect(isRestorePending(work.dbPath)).toBe(true);
    expect(isRestorePending(home.dbPath)).toBe(false);
    expect(restoreWaitingMessage(work.dbPath)).toBe(
      `A restore is waiting: restart Lyren Plan to complete it, or delete ${path.join(folder, '.work.db.restore-pending')} to cancel it.`,
    );

    // home.db: its commands run, its start applies nothing and moves nothing.
    openNodeStack(home, { mode: 'maintenance' }).close();
    expect(serveOnce(home)).toEqual([]);
    expect(listing(folder).filter((n) => !n.startsWith('.work.db.restore-pending'))).toEqual(homeBefore);
    // work.db: its start applies it, into work.db and work.db.spaces/.
    expect(serveOnce(work)).toEqual([expect.stringMatching(/^Restored the backup set made \S+ \(2 spaces\)\.$/)]);
    expect(fs.readdirSync(path.join(folder, 'work.db.spaces')).sort()).toEqual([`${live.own}.db`, `${live.team}.db`].sort());
    const stack = openNodeStack(work, { mode: 'maintenance' });
    try {
      expect(await projectNames(stack, await signIn(stack), live.own)).toEqual(['Original']);
    } finally {
      stack.close();
    }
    expect(fs.existsSync(path.join(folder, 'backups'))).toBe(false);
  });

  it('a READY made for another database is not applied', async () => {
    const live = await liveFolder();
    const set = path.join(tempDir(), 'set.tar');
    writeSet(live.stack, live.cfg, set);
    live.stack.close();
    stageRestore({ dbPath: live.cfg.dbPath, source: set, nowMs: NOW });
    // A folder renamed by hand from another database's.
    const ready = path.join(live.dataDir, PENDING_FOLDER, 'READY');
    fs.writeFileSync(ready, JSON.stringify({ ...JSON.parse(fs.readFileSync(ready, 'utf8')), dbName: 'work.db' }));
    const before = listing(live.dataDir);
    expect(() => serveOnce(live.cfg)).toThrow(
      new DataRefusal(
        `The staged restore in ${path.join(live.dataDir, PENDING_FOLDER)} was staged for work.db, not lyren.db. Delete that folder, then run restore again.`,
      ),
    );
    expect(listing(live.dataDir)).toEqual(before);
  });
});

describe('the apply checks what it will move in before anything moves out', () => {
  async function staged() {
    const live = await liveFolder();
    const set = path.join(tempDir(), 'set.tar');
    writeSet(live.stack, live.cfg, set);
    live.stack.close();
    stageRestore({ dbPath: live.cfg.dbPath, source: set, nowMs: NOW });
    return { ...live, pending: path.join(live.dataDir, PENDING_FOLDER) };
  }

  it('a staged set that lost a file: refused, nothing moved', async () => {
    for (const lost of ['directory.db', 'space'] as const) {
      const t = await staged();
      fs.rmSync(path.join(t.pending, lost === 'space' ? path.join('spaces', `${t.team}.db`) : lost));
      const before = listing(t.dataDir);
      const message = `The staged restore in ${t.pending} is incomplete. Delete that folder, then run restore again.`;
      expect(() => serveOnce(t.cfg), lost).toThrow(new DataRefusal(message));
      expect(listing(t.dataDir), lost).toEqual(before);
      // A file that is not what READY says counts as lost, too.
      fs.writeFileSync(path.join(t.pending, 'directory.db'), 'not a database');
      expect(() => serveOnce(t.cfg), lost).toThrow(new DataRefusal(message));
    }
  });

  it('a set staged by a newer build: refused at the apply too, nothing moved (§9.6 step 2)', async () => {
    const t = await staged();
    const db = new DatabaseSync(path.join(t.pending, 'directory.db'));
    db.exec("UPDATE _meta SET value = '99' WHERE key IN ('version', 'compatible_from')");
    db.close();
    const before = listing(t.dataDir);
    expect(() => serveOnce(t.cfg)).toThrow(
      new DataRefusal(
        `The staged restore in ${t.pending} was made by a newer version of Lyren Plan. Install that version, or a newer one, ` +
          'to complete it, or delete that folder to cancel it.',
      ),
    );
    expect(listing(t.dataDir)).toEqual(before);
    expect(restoreWaitingMessage(t.cfg.dbPath)).toMatch(/^A restore is waiting: /);
  });

  it('once the apply has begun, the commands say not to delete the folder', async () => {
    const t = await staged();
    expect(() =>
      applyPendingRestore({
        dbPath: t.cfg.dbPath,
        hooks: {
          afterStep: (step) => {
            if (step === 'out:spaces') throw new Error('crash');
          },
          log: () => undefined,
        },
      }),
    ).toThrow('crash');
    const message =
      `A restore was interrupted while it was being applied: start Lyren Plan to finish it. Do not delete ${t.pending}; ` +
      `the data it replaces is in ${path.join('backups', 'before-restore-2026-10-17T12-00-00-000Z')}/.`;
    expect(restoreWaitingMessage(t.cfg.dbPath)).toBe(message);
    expect(() => openNodeStack(t.cfg, { mode: 'maintenance' })).toThrow(new DataRefusal(message));
    // A staged file lost now: the data that moved out is named.
    fs.rmSync(path.join(t.pending, 'spaces', `${t.own}.db`));
    expect(() => serveOnce(t.cfg)).toThrow(/is incomplete, and the data it replaces is in backups\/before-restore-2026-10-17T12-00-00-000Z\/ already/);
  });
});

describe('staging never shows a half-staged restore', () => {
  it('stages in a .partial folder of its own, renamed once READY is in it; what a killed run left is removed by the next start', async () => {
    const live = await liveFolder();
    const set = path.join(tempDir(), 'set.tar');
    writeSet(live.stack, live.cfg, set);
    live.stack.close();
    // A killed `restore` (its unfinished folder, READY already written) and a killed apply (READY gone).
    const killed = path.join(live.dataDir, '.restore-0123456789abcdef.partial');
    fs.mkdirSync(path.join(killed, 'spaces'), { recursive: true });
    fs.writeFileSync(path.join(killed, 'READY'), '{}');
    const leftover = path.join(live.dataDir, PENDING_FOLDER);
    fs.mkdirSync(path.join(leftover, 'spaces'), { recursive: true });
    fs.writeFileSync(path.join(leftover, 'PHASE'), 'moving-in\n');
    expect(isRestorePending(live.cfg.dbPath)).toBe(false);
    // Staging replaces the leftover and leaves no folder of its own behind.
    stageRestore({ dbPath: live.cfg.dbPath, source: set, nowMs: NOW });
    expect(listing(leftover)).toEqual(['READY', 'directory.db', 'spaces', `spaces/${live.own}.db`, `spaces/${live.team}.db`].sort());
    expect(fs.readdirSync(live.dataDir).filter((n) => n.endsWith('.partial'))).toEqual([path.basename(killed)]);
    // A failed staging leaves nothing either.
    fs.rmSync(leftover, { recursive: true });
    const text = path.join(tempDir(), 'notes.txt');
    fs.writeFileSync(text, 'hello');
    expect(() => stageRestore({ dbPath: live.cfg.dbPath, source: text, nowMs: NOW })).toThrow(RestoreError);
    expect(fs.readdirSync(live.dataDir).filter((n) => n.startsWith('.restore-'))).toEqual([path.basename(killed)]);
    // The next serving start applies nothing and removes the killed run's folder.
    expect(serveOnce(live.cfg)).toEqual([]);
    expect(fs.existsSync(killed)).toBe(false);
  });

  it.runIf(process.platform !== 'win32' && process.getuid?.() !== 0)(
    'a folder without READY that cannot be removed is reported, and the start goes on',
    async () => {
      const live = await liveFolder();
      live.stack.close();
      const leftover = path.join(live.dataDir, PENDING_FOLDER);
      fs.mkdirSync(path.join(leftover, 'spaces'), { recursive: true });
      fs.writeFileSync(path.join(leftover, 'spaces', 'x.db'), 'x');
      fs.chmodSync(path.join(leftover, 'spaces'), 0o500);
      try {
        const lines = serveOnce(live.cfg);
        expect(lines).toEqual([`Could not remove ${leftover} (EACCES); the next start removes it.`]);
      } finally {
        fs.chmodSync(path.join(leftover, 'spaces'), 0o700);
      }
      expect(serveOnce(live.cfg)).toEqual([]);
      expect(fs.existsSync(leftover)).toBe(false);
    },
  );
});

describe('the restore command', () => {
  function cli(dataDir: string, args: string[], input: string | Buffer = '', cwd = ROOT) {
    const res = spawnSync(...tsxCommand(path.join(ROOT, 'server/src/index.ts'), args), {
      cwd,
      input,
      env: tsxEnv({ ...process.env, DATA_DIR: dataDir, DB_PATH: '' }),
      encoding: 'utf8',
      timeout: 60_000,
    });
    return { status: res.status, stdout: res.stdout, stderr: res.stderr };
  }

  it('`restore -` reads the backup from standard input, leaving no copy behind', async () => {
    const live = await liveFolder();
    const set = path.join(tempDir(), 'set.tar');
    writeSet(live.stack, live.cfg, set);
    live.stack.close();
    const res = cli(live.dataDir, ['restore', '-'], fs.readFileSync(set));
    expect(res.status, res.stderr).toBe(0);
    const lines = res.stdout.trim().split('\n');
    expect(lines[0]).toMatch(/^Staged the restore of the backup set made \S+ \(2 spaces\) from standard input\.$/);
    expect(lines[1]).toMatch(/^Restart Lyren Plan to complete the restore \(systemctl restart lyren-plan, or docker restart lyren-plan\)\. The current data will be moved to backups\/before-restore-\S+\/\.$/);
    expect(isRestorePending(live.cfg.dbPath)).toBe(true);
    expect(fs.readdirSync(live.dataDir).filter((n) => n.startsWith('.restore-') && n !== PENDING_FOLDER)).toEqual([]);
  }, 60_000);

  it('`restore -` names standard input when it refuses, not the copy it made', async () => {
    const live = await liveFolder();
    live.stack.close();
    for (const input of ['', 'not a backup at all, but long enough to read a tar header from'.repeat(8)]) {
      const res = cli(live.dataDir, ['restore', '-'], input);
      expect(res.status).toBe(1);
      expect(res.stderr.trim()).toBe(
        "Standard input is not a Lyren Plan backup: a backup set (.tar), a space's database or an old single-file backup (.db).",
      );
    }
    expect(fs.readdirSync(live.dataDir).filter((n) => n.startsWith('.restore-'))).toEqual([]);
  }, 60_000);

  it.runIf(process.platform !== 'win32' && process.getuid?.() !== 0)(
    'a file this user cannot reach: the data folder is tried next, else a plain hint (sudo -u keeps the working folder)',
    async () => {
      const live = await liveFolder();
      fs.mkdirSync(path.join(live.dataDir, 'locked'), { recursive: true });
      live.stack.spaces.snapshot(live.own, path.join(live.dataDir, 'locked', 'mine.db'));
      live.stack.close();
      // The working folder holds a folder of that name this user cannot search.
      const cwd = tempDir();
      const locked = path.join(cwd, 'locked');
      fs.mkdirSync(locked);
      fs.chmodSync(locked, 0o000);
      const unreadable = path.join(tempDir(), 'unreadable.db');
      fs.copyFileSync(path.join(live.dataDir, 'locked', 'mine.db'), unreadable);
      fs.chmodSync(unreadable, 0o000);
      try {
        const res = cli(live.dataDir, ['restore', 'locked/mine.db'], '', cwd);
        expect(res.status, res.stderr).toBe(0);
        expect(res.stdout).toContain(`from ${path.join(live.dataDir, 'locked', 'mine.db')}.`);
        fs.rmSync(path.join(live.dataDir, PENDING_FOLDER), { recursive: true });
        const user = os.userInfo().username;
        const hint = (file: string) => `${file} cannot be read as this user (${user}): pipe it in with \`restore -\` (see the README).`;
        for (const file of ['locked/other.db', path.join(locked, 'mine.db'), unreadable]) {
          const refused = cli(live.dataDir, ['restore', file], '', cwd);
          expect(refused.status, file).toBe(1);
          expect(refused.stderr.trim(), file).toBe(hint(file));
        }
      } finally {
        fs.chmodSync(locked, 0o700);
        fs.chmodSync(unreadable, 0o600);
      }
      expect(isRestorePending(live.cfg.dbPath)).toBe(false);
    },
    120_000,
  );

  it('a relative file that is not in the working folder is looked for in the data folder; a missing one is named', async () => {
    const live = await liveFolder();
    fs.mkdirSync(path.join(live.dataDir, 'backups'), { recursive: true });
    live.stack.spaces.snapshot(live.own, path.join(live.dataDir, 'backups', 'mine.db'));
    live.stack.close();
    const missing = cli(live.dataDir, ['restore', 'backups/nope.db']);
    expect(missing.status).toBe(1);
    expect(missing.stderr.trim()).toBe('No file backups/nope.db.');
    const res = cli(live.dataDir, ['restore', 'backups/mine.db']);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain(`Staged the restore of the space Owner's space (${live.own}) from ${path.join(live.dataDir, 'backups', 'mine.db')}.`);
    expect(cli(live.dataDir, ['restore']).status).toBe(2);
  }, 60_000);

  it('every maintenance command refuses while a restore is waiting, backup included (exit 1)', async () => {
    const live = await liveFolder();
    const set = path.join(tempDir(), 'set.tar');
    writeSet(live.stack, live.cfg, set);
    live.stack.close();
    stageRestore({ dbPath: live.cfg.dbPath, source: set, nowMs: NOW });
    const message = restoreWaitingMessage(live.cfg.dbPath);
    expect(message).toBe(
      `A restore is waiting: restart Lyren Plan to complete it, or delete ${path.join(live.dataDir, '.restore-pending')} to cancel it.`,
    );
    for (const args of [
      ['backup', path.join(tempDir(), 'b.tar')],
      ['restore', set],
      ['reset-password', OWNER],
      ['promote-admin', OWNER],
      ['policy'],
      ['spaces'],
    ]) {
      const res = cli(live.dataDir, args);
      expect(res.status, args.join(' ')).toBe(1);
      expect(res.stderr.trim(), args.join(' ')).toBe(message);
    }
    // The desktop app's commands too.
    const desktop = spawnSync(...tsxCommand('server/src/sea.ts', ['backup', path.join(tempDir(), 'd.tar')]), {
      cwd: ROOT,
      input: '',
      env: tsxEnv({ ...process.env, DATA_DIR: live.dataDir, DB_PATH: '' }),
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(desktop.status).toBe(1);
    expect(desktop.stderr).toContain(message);
  }, 120_000);
});
