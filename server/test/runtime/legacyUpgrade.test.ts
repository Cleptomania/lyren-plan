// The legacy single-file upgrade (runtime/node/legacy.ts, design §3.8, §14.3) on a 1.x database built from
// 1.x's own schema (fixtures/legacyV1.ts): what the directory and the space hold afterwards (ids, refs,
// sessions, preferences, legacySpaceId, the snapshot), signing in with the old password and the old
// session cookie, a crash after each step, a second connection, a write between two attempts, orphans,
// the disk-space check, a custom DB_PATH, a -wal left by a crash, an install without accounts, the
// renames that retry on Windows, and what the maintenance commands do with a 1.x database.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { CSRF_HEADER } from '@shared/constants';
import type { AuthStatusDTO, BootstrapDTO, TaskDTO } from '@shared/types';
import { loadConfig, type Config } from '../../src/config';
import { sha256Hex } from '../../src/core/crypto';
import { inspectDatabase } from '../../src/runtime/node/backupSet';
import { renameRetrying, RENAME_RETRY_MS } from '../../src/runtime/node/files';
import {
  LEGACY_BACKUP_NOTE,
  LEGACY_NOT_UPGRADED,
  LEGACY_SPACE_TABLES,
  LegacyUpgradeStopped,
  upgradeLegacy,
  upgradeLegacyIfNeeded,
  type LegacyUpgradeHooks,
  type LegacyUpgradeStep,
} from '../../src/runtime/node/legacy';
import { DataRefusal, openNodeStack, type NodeStack } from '../../src/runtime/node/stack';
import {
  createLegacyDb,
  DEFAULT_BOARD_ID,
  dumpLegacy,
  EXPIRED_TOKEN,
  HELPER_ID,
  HELPER_TOKEN,
  LEGACY_PASSWORD,
  LIVE_TOKEN,
  OWNER_ID,
  OWNER_NAME,
  type LegacyFixtureOptions,
} from '../fixtures/legacyV1';
import { assertFoldsConsistent, assertTagListsConsistent, assertTaskCountsConsistent } from '../support/folds';
import { ROOT, tsxCommand, tsxEnv } from '../tsxNode';

const posix = process.platform !== 'win32';
const SNAPSHOT_RE = /^lyren-v1-before-upgrade-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z\.db$/;
const SPACE_NAME = `${OWNER_NAME}'s space`;

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyren-legacy-'));
  dirs.push(dir);
  return dir;
}

interface LegacyFolder {
  dataDir: string;
  cfg: Config;
  /** A copy of the 1.x database as the fixture made it. */
  original: string;
}

/** A data folder holding a 1.x database at DB_PATH (default lyren.db). */
async function legacyFolder(o: LegacyFixtureOptions & { dbName?: string } = {}): Promise<LegacyFolder> {
  const dataDir = tempDir();
  const cfg = loadConfig({ dbPath: path.join(dataDir, o.dbName ?? 'lyren.db'), webDir: null, setupToken: 'legacy-code', logRequests: false });
  await createLegacyDb(cfg.dbPath, o);
  const original = path.join(tempDir(), 'original.db');
  fs.copyFileSync(cfg.dbPath, original);
  return { dataDir, cfg, original };
}

/** The upgrade as a serving start runs it, with the log lines collected. */
function upgrade(cfg: Config, hooks: LegacyUpgradeHooks = {}, lines: string[] = []) {
  return upgradeLegacyIfNeeded({
    dbPath: cfg.dbPath,
    snapshotKeep: cfg.snapshotKeep,
    directory: cfg.directory,
    hooks: { log: (line) => lines.push(line), ...hooks },
  });
}

/** Opens the upgraded data the way a maintenance command does, runs fn, closes it. */
async function withStack<T>(cfg: Config, fn: (stack: NodeStack) => T | Promise<T>): Promise<T> {
  const stack = openNodeStack(cfg, { mode: 'maintenance' });
  try {
    return await fn(stack);
  } finally {
    stack.close();
  }
}

const fileHash = (file: string) => sha256Hex(fs.readFileSync(file).toString('base64'));

const backupsOf = (dataDir: string) => (fs.existsSync(path.join(dataDir, 'backups')) ? fs.readdirSync(path.join(dataDir, 'backups')).sort() : []);

/** Rows of a database file, read-only. */
function rows(file: string, sql: string): Array<Record<string, unknown>> {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(sql).all().map((r) => ({ ...r }));
  } finally {
    db.close();
  }
}

/** The space's rows of every copied table, in the legacy columns (what the original must equal). */
function spaceTables(spaceFile: string): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const copy of LEGACY_SPACE_TABLES) {
    out[copy.table] = rows(spaceFile, `SELECT ${copy.columns.join(', ')} FROM ${copy.table} ORDER BY ${(copy.key ?? ['id']).join(', ')}`);
  }
  return out;
}

/** The checks every complete upgrade of the standard fixture must pass. */
async function expectUpgraded(f: LegacyFolder, o: { snapshots?: number } = {}): Promise<string> {
  const { cfg, dataDir, original } = f;
  const source = dumpLegacy(original);
  // Files: the directory at DB_PATH, the space, the snapshot(s); nothing half-done.
  const spaces = fs.readdirSync(path.join(dataDir, 'spaces'));
  expect(spaces).toHaveLength(1);
  const spaceId = /^([0-9a-z]{16})\.db$/.exec(spaces[0]!)![1]!;
  expect(fs.readdirSync(dataDir).filter((n) => /\.(?:upgrade|partial)$/.test(n))).toEqual([]);
  const snapshots = backupsOf(dataDir).filter((n) => SNAPSHOT_RE.test(n));
  expect(snapshots).toHaveLength(o.snapshots ?? 1);
  for (const snapshot of snapshots) {
    // The snapshot is the 1.x database before the upgrade (no marker, every row).
    expect(dumpLegacy(path.join(dataDir, 'backups', snapshot))).toEqual(source);
  }

  await withStack(cfg, (stack) => {
    const dir = stack.directoryDb;
    // Accounts: the same ids, names and password hashes; no email; a passkey handle each; the lowest id is the admin.
    const users = dir.all<Record<string, unknown>>(
      `SELECT id, username, display_name, password_hash, email, email_key, email_verified_at, is_instance_admin, auth_epoch,
         preferences, webauthn_user_id, created_at, updated_at
       FROM users ORDER BY id`,
    );
    const shown = users.map((u) => [u.id, u.username, u.display_name, u.is_instance_admin, u.auth_epoch, u.email, u.email_key, u.email_verified_at]);
    expect(shown).toEqual([
      [OWNER_ID, 'owner', OWNER_NAME, 1, 0, null, null, null],
      [HELPER_ID, 'Helper', 'Helper', 0, 0, null, null, null],
    ]);
    const legacyUsers = source.users as Array<Record<string, unknown>>;
    const kept = (u: Record<string, unknown>) => [u.password_hash, u.created_at, u.updated_at];
    expect(users.map(kept)).toEqual(legacyUsers.map(kept));
    expect(new Set(users.map((u) => u.webauthn_user_id)).size).toBe(2);
    for (const u of users) expect(u.webauthn_user_id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Preferences from the legacy settings, the owner's only.
    expect(JSON.parse(users[0]!.preferences as string)).toEqual({ weekStartsOn: 0, homePage: 'default_board' });
    expect(users[1]!.preferences).toBe('{}');
    // Live sessions, as 'legacy'; the expired one is gone.
    const sessions = dir.all<Record<string, unknown>>('SELECT * FROM sessions ORDER BY id');
    const legacySessions = (source.sessions as Array<Record<string, unknown>>).filter((s) => s.id !== 4);
    expect(sessions).toEqual(
      legacySessions.map((s) => ({ ...s, auth_method: 'legacy', reauth_at: s.created_at, absolute_expires_at: null })),
    );
    expect(sessions.map((s) => s.token_hash)).toEqual([sha256Hex(LIVE_TOKEN), sha256Hex(HELPER_TOKEN)]);
    expect(dir.all('SELECT name, seq FROM sqlite_sequence WHERE name IN (\'users\', \'sessions\') ORDER BY name')).toEqual([
      { name: 'sessions', seq: 12 },
      { name: 'users', seq: 9 },
    ]);
    // The space, its memberships and space_people, legacySpaceId, the seeded instance settings.
    expect(dir.all('SELECT public_id, name, status, sync_version, created_by, deleted_at FROM spaces')).toEqual([
      { public_id: spaceId, name: SPACE_NAME, status: 'active', sync_version: 1, created_by: OWNER_ID, deleted_at: null },
    ]);
    expect(dir.all('SELECT user_id, role, added_by FROM memberships ORDER BY user_id')).toEqual([
      { user_id: OWNER_ID, role: 'owner', added_by: OWNER_ID },
      { user_id: HELPER_ID, role: 'member', added_by: OWNER_ID },
    ]);
    expect(dir.all('SELECT user_id FROM space_people ORDER BY user_id')).toEqual([{ user_id: OWNER_ID }, { user_id: HELPER_ID }]);
    const settings = new Map(dir.all<{ key: string; value: string }>('SELECT key, value FROM instance_settings').map((s) => [s.key, s.value]));
    expect(settings.get('legacySpaceId')).toBe(JSON.stringify(spaceId));
    expect(JSON.parse(settings.get('signupPolicy')!)).toBe('invite_only');
    expect(JSON.parse(settings.get('passwordMinLength')!)).toBe(8);
    expect(settings.get('ceremonyKey')).toMatch(/^"[A-Za-z0-9_-]{43}"$/);
    expect(dir.all('PRAGMA foreign_key_check')).toEqual([]);

    // The space: every domain row with its id, folds, tag lists and task counts computed, the settings that stay
    // with the data.
    const db = stack.spaces.database(spaceId)!;
    assertFoldsConsistent(db);
    assertTagListsConsistent(db);
    assertTaskCountsConsistent(db);
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE tag_ids <> '[]'")!.n).toBeGreaterThan(0);
    expect(db.all('PRAGMA foreign_key_check')).toEqual([]);
  });
  const spaceFile = path.join(dataDir, 'spaces', `${spaceId}.db`);
  const copied = spaceTables(spaceFile);
  for (const copy of LEGACY_SPACE_TABLES) expect(copied[copy.table], copy.table).toEqual(source[copy.table]);
  expect(rows(spaceFile, 'SELECT id, kind, display_name, email, is_member, deleted FROM users ORDER BY id')).toEqual([
    { id: OWNER_ID, kind: 'account', display_name: OWNER_NAME, email: null, is_member: 1, deleted: 0 },
    { id: HELPER_ID, kind: 'account', display_name: 'Helper', email: null, is_member: 1, deleted: 0 },
  ]);
  expect(rows(spaceFile, 'SELECT key, value FROM settings ORDER BY key')).toEqual([
    { key: '_note', value: '"an internal key"' },
    { key: '_seeded', value: 'true' },
    { key: 'defaultBoardId', value: String(DEFAULT_BOARD_ID) },
    { key: 'estimateUnit', value: '"hours"' },
  ]);
  const legacySeqs = (source.sqlite_sequence as Array<{ name: string; seq: number }>).filter((s) => !['users', 'sessions'].includes(s.name));
  expect(rows(spaceFile, 'SELECT name, seq FROM sqlite_sequence ORDER BY name')).toEqual(
    legacySeqs.sort((a, b) => (a.name < b.name ? -1 : 1)).map((s) => ({ name: s.name, seq: s.seq })),
  );
  const meta = new Map(rows(spaceFile, 'SELECT key, value FROM _meta').map((r) => [r.key, r.value]));
  expect(meta.get('schema')).toBe('space');
  expect(meta.get('space_id')).toBe(spaceId);
  expect(meta.get('space_name')).toBe(SPACE_NAME);
  expect(meta.get('sync_version')).toBe('1');
  expect(meta.get('legacy_source')).toMatch(new RegExp(`^${path.basename(cfg.dbPath).replace('.', '\\.')} v1 \\d{4}-\\d\\d-\\d\\dT[\\d-]+Z$`));
  expect(JSON.parse(meta.get('write_state') as string)).toMatchObject({ rows: 0 });
  for (const file of [cfg.dbPath, spaceFile]) expect(rows(file, 'PRAGMA user_version')).toEqual([{ user_version: 100 }]);
  return spaceId;
}

const STEPS: LegacyUpgradeStep[] = ['disk', 'lock', 'snapshot', 'marker', 'space', 'directory', 'orphans', 'spaceRename', 'unlock', 'swap'];

class Crash extends Error {}

describe('the upgrade of a 1.x database', () => {
  it('a serving start upgrades it: ids, refs, sessions, preferences, legacySpaceId and the snapshot; the log line says where', async () => {
    const f = await legacyFolder();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let stack: NodeStack;
    let logged: unknown[];
    try {
      stack = openNodeStack(f.cfg, { mode: 'serve' });
    } finally {
      logged = log.mock.calls.map((c) => c[0]);
      log.mockRestore();
    }
    expect(stack.firstRun).toBe(false);
    stack.close();
    // Closed: no -wal, -shm or -journal of the legacy file is left.
    expect(fs.readdirSync(f.dataDir).sort()).toEqual(['backups', 'lyren.db', 'spaces']);
    const spaceId = await expectUpgraded(f);
    const snapshot = backupsOf(f.dataDir).find((n) => SNAPSHOT_RE.test(n))!;
    expect(logged).toContain(
      `Upgraded the database for multi-user spaces: your data is now in the space "${SPACE_NAME}" (${path.join('spaces', `${spaceId}.db`)}). ` +
        `The old database was saved as ${path.join('backups', snapshot)}.`,
    );

    await withStack(f.cfg, async (stack) => {
      // The browser that was signed in to 1.x still is (the unprefixed cookie of a legacy session).
      const cookie = `lyren_session=${LIVE_TOKEN}`;
      const status = (await (await stack.app.request('/api/auth/status', { headers: { Cookie: cookie } })).json()) as AuthStatusDTO;
      expect(status.user?.id).toBe(OWNER_ID);
      expect(status.spaces.map((s) => [s.id, s.name, s.role])).toEqual([[spaceId, SPACE_NAME, 'owner']]);
      expect(status.legacySpaceId).toBe(spaceId);
      // The upgraded space keeps the data's refs and ids. (Old links without a space are redirected there by
      // the web client, app/legacyRedirect.ts, through legacySpaceId; the API has no unprefixed space paths.)
      const boot = (await (await stack.app.request(`/api/s/${spaceId}/bootstrap`, { headers: { Cookie: cookie } })).json()) as BootstrapDTO;
      expect(boot.space.id).toBe(spaceId);
      expect((await stack.app.request('/api/bootstrap', { headers: { Cookie: cookie } })).status).toBe(404);
      const byRef = await stack.app.request(`/api/s/${spaceId}/tasks/ref/WEB-3`, { headers: { Cookie: cookie } });
      expect(byRef.status).toBe(200);
      expect(((await byRef.json()) as TaskDTO).id).toBe(11);
      const task = (await (await stack.app.request(`/api/s/${spaceId}/tasks/10`, { headers: { Cookie: cookie } })).json()) as TaskDTO;
      expect(task.title).toBe('Straße prüfen');
      // The expired session is not.
      const expired = await stack.app.request('/api/auth/status', { headers: { Cookie: `lyren_session=${EXPIRED_TOKEN}` } });
      expect(((await expired.json()) as AuthStatusDTO).user).toBeNull();
      // The old username and password sign in.
      const login = await stack.app.request('/api/auth/login', {
        method: 'POST',
        headers: { [CSRF_HEADER]: '1', 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: 'owner', password: LEGACY_PASSWORD }),
      });
      expect(login.status).toBe(200);
      expect(((await login.json()) as { user: { id: number } }).user.id).toBe(OWNER_ID);
    });
  });

  it('copies every column of every 1.x table it keeps, and reads them in batches of 500', async () => {
    const f = await legacyFolder({ extraTasks: 1234 });
    upgrade(f.cfg);
    const spaceFile = path.join(f.dataDir, 'spaces', fs.readdirSync(path.join(f.dataDir, 'spaces'))[0]!);
    const legacyColumns = (table: string) => rows(f.original, `PRAGMA table_info(${table})`).map((c) => c.name);
    for (const copy of LEGACY_SPACE_TABLES) expect([...copy.columns].sort(), copy.table).toEqual(legacyColumns(copy.table).sort());
    expect(spaceTables(spaceFile)).toEqual(Object.fromEntries(LEGACY_SPACE_TABLES.map((c) => [c.table, dumpLegacy(f.original)[c.table]])));
    expect(rows(spaceFile, 'SELECT COUNT(*) AS n FROM tasks')).toEqual([{ n: 1237 }]);
    expect(rows(spaceFile, 'SELECT COUNT(*) AS n FROM task_tags')).toEqual([{ n: 1237 }]);
  });

  it('drops preferences that are not valid, and settings 1.x never had', async () => {
    const f = await legacyFolder({ settings: { weekStartsOn: '3', homePage: '"default_board"', estimateUnit: '"hours"' } });
    upgrade(f.cfg);
    await withStack(f.cfg, (stack) => {
      expect(JSON.parse(stack.directoryDb.get<{ p: string }>('SELECT preferences AS p FROM users WHERE id = :id', { id: OWNER_ID })!.p)).toEqual({
        homePage: 'default_board',
      });
    });
  });

  it('a crash after any step resumes at the next start, from the legacy file', async () => {
    for (const step of STEPS) {
      const f = await legacyFolder();
      expect(
        () => upgrade(f.cfg, {
          afterStep: (s) => {
            if (s === step) throw new Crash(step);
          },
        }),
        step,
      ).toThrow(Crash);
      const lines: string[] = [];
      const result = upgrade(f.cfg, {}, lines);
      if (step === 'swap') {
        // The directory is in place: a normal open, nothing to redo.
        expect(result, step).toBeNull();
      } else {
        expect(result?.space?.name, step).toBe(SPACE_NAME);
        expect(lines.at(-1), step).toMatch(/^Upgraded the database for multi-user spaces: /);
      }
      // A crash between the snapshot and the marker takes a second snapshot; nothing else does.
      await expectUpgraded(f, { snapshots: step === 'snapshot' ? 2 : 1 });
    }
  });

  it('a resumed upgrade keeps the space id of the first attempt and names its snapshot', async () => {
    const f = await legacyFolder();
    expect(() =>
      upgrade(f.cfg, {
        afterStep: (s) => {
          if (s === 'directory') throw new Crash(s);
        },
      }),
    ).toThrow(Crash);
    const firstId = rows(f.cfg.dbPath, "SELECT value FROM settings WHERE key = '_upgrade_space_id'")[0]?.value;
    const lines: string[] = [];
    const result = upgrade(f.cfg, {}, lines)!;
    expect(JSON.stringify(result.space!.id)).toBe(firstId);
    const snapshot = backupsOf(f.dataDir).find((n) => SNAPSHOT_RE.test(n))!;
    expect(result.snapshot).toBe(snapshot);
    expect(lines.at(-1)).toContain(`The old database was saved as ${path.join('backups', snapshot)}.`);
  });

  it('a write made between two attempts (by a 1.x server still running) is in the upgraded space', async () => {
    const f = await legacyFolder();
    expect(() =>
      upgrade(f.cfg, {
        afterStep: (s) => {
          if (s === 'directory') throw new Crash(s);
        },
      }),
    ).toThrow(Crash);
    const old = new DatabaseSync(f.cfg.dbPath);
    const t = '2026-10-17T00:00:00.000Z';
    old.exec(`INSERT INTO tasks (id, project_id, number, status_id, title, rank, created_by, created_at, updated_at)
      VALUES (150, 1, 4, 2, 'Written by 1.x meanwhile', 'b0', ${OWNER_ID}, '${t}', '${t}');
      UPDATE projects SET task_counter = 4 WHERE id = 1;
      INSERT INTO comments (task_id, user_id, body, created_at, updated_at) VALUES (150, ${HELPER_ID}, 'And a comment', '${t}', '${t}');`);
    old.close();
    upgrade(f.cfg);
    await withStack(f.cfg, (stack) => {
      const db = stack.spaces.database(stack.spaces.list()[0]!)!;
      expect(db.get('SELECT title, title_fold FROM tasks WHERE id = 150')).toEqual({
        title: 'Written by 1.x meanwhile',
        title_fold: 'written by 1.x meanwhile',
      });
      expect(db.get('SELECT body FROM comments WHERE task_id = 150')).toEqual({ body: 'And a comment' });
      expect(db.get<{ n: number }>('SELECT task_counter AS n FROM projects WHERE id = 1')!.n).toBe(4);
    });
  });

  it('stops before writing anything while another connection has the file open, and goes on once it is closed', async () => {
    const f = await legacyFolder();
    // A 1.x server that is still running: a connection that has read the file.
    const other = new DatabaseSync(f.cfg.dbPath);
    other.prepare('SELECT COUNT(*) FROM tasks').get();
    const before = { db: fileHash(f.cfg.dbPath), wal: fileHash(`${f.cfg.dbPath}-wal`) };
    let error: unknown;
    try {
      upgrade(f.cfg, { busyTimeoutMs: 50 });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(LegacyUpgradeStopped);
    expect((error as Error).message).toBe(`Lyren Plan or another program still has ${f.cfg.dbPath} open. Stop it and start Lyren Plan again.`);
    expect({ db: fileHash(f.cfg.dbPath), wal: fileHash(`${f.cfg.dbPath}-wal`) }).toEqual(before);
    expect(fs.readdirSync(f.dataDir).filter((n) => !n.startsWith('lyren.db'))).toEqual([]);
    expect(fs.readdirSync(f.dataDir).filter((n) => n.endsWith('.upgrade'))).toEqual([]);
    other.close();
    upgrade(f.cfg);
    await expectUpgraded(f);
  });

  it('a second start while one upgrades stops with the same message', async () => {
    const f = await legacyFolder();
    let second: unknown;
    upgrade(f.cfg, {
      afterStep: (s) => {
        if (s !== 'space') return;
        try {
          upgrade(f.cfg, { busyTimeoutMs: 50 });
        } catch (err) {
          second = err;
        }
      },
    });
    expect(second).toEqual(new LegacyUpgradeStopped(`Lyren Plan or another program still has ${f.cfg.dbPath} open. Stop it and start Lyren Plan again.`));
    await expectUpgraded(f);
  });

  it('a start that gets the lock only after another one upgraded the file leaves it to the normal open', async () => {
    const f = await legacyFolder();
    upgrade(f.cfg);
    // (Its lock switches the directory to WAL, as every open of it does.)
    const hashes = () => fs.readdirSync(path.join(f.dataDir, 'spaces')).map((n) => fileHash(path.join(f.dataDir, 'spaces', n)));
    const before = { files: fs.readdirSync(f.dataDir).sort(), hashes: hashes() };
    // What a start finds that detected the 1.x file and then waited for the lock.
    const lines: string[] = [];
    expect(upgradeLegacy({ dbPath: f.cfg.dbPath, snapshotKeep: 10, directory: f.cfg.directory, hooks: { log: (l) => lines.push(l) } })).toBeNull();
    expect(lines).toEqual([]);
    expect({ files: fs.readdirSync(f.dataDir).sort(), hashes: hashes() }).toEqual(before);
    await expectUpgraded(f);
  });

  it('openNodeStack refuses with the same message (exit 1 through the CLI) while the file is in use', async () => {
    const f = await legacyFolder();
    const other = new DatabaseSync(f.cfg.dbPath);
    other.prepare('SELECT 1 FROM users').get();
    try {
      const res = spawnSync(...tsxCommand('server/src/index.ts', ['serve']), {
        cwd: ROOT,
        env: tsxEnv({ ...process.env, DATA_DIR: f.dataDir, DB_PATH: '', PORT: '19601', HOST: '127.0.0.1', WEB_DIR: '' }),
        encoding: 'utf8',
        timeout: 60_000,
      });
      expect(res.status, res.stderr).toBe(1);
      expect(res.stderr.trim()).toBe(`Lyren Plan or another program still has ${f.cfg.dbPath} open. Stop it and start Lyren Plan again.`);
    } finally {
      other.close();
    }
    expect(backupsOf(f.dataDir)).toEqual([]);
  }, 60_000);

  it('a 1.x database whose last run ended uncleanly (its data in the -wal) is upgraded with that data', async () => {
    const dataDir = tempDir();
    const live = path.join(tempDir(), 'lyren.db');
    const running = (await createLegacyDb(live, { keepOpen: true }))!;
    running.exec('PRAGMA wal_autocheckpoint = 0');
    running.exec("UPDATE tasks SET title = 'Only in the -wal' WHERE id = 12");
    // Copied while 1.x still has it open: what a crash (kill -9, power loss) leaves behind.
    const file = path.join(dataDir, 'lyren.db');
    for (const suffix of ['', '-wal', '-shm']) fs.copyFileSync(`${live}${suffix}`, `${file}${suffix}`);
    running.close();
    expect(fs.statSync(`${file}-wal`).size).toBeGreaterThan(0);
    const cfg = loadConfig({ dbPath: file, webDir: null, logRequests: false });
    upgrade(cfg);
    expect(fs.readdirSync(dataDir).sort()).toEqual(['backups', 'lyren.db', 'spaces']);
    await withStack(cfg, (stack) => {
      const db = stack.spaces.database(stack.spaces.list()[0]!)!;
      expect(db.get('SELECT title FROM tasks WHERE id = 12')).toEqual({ title: 'Only in the -wal' });
    });
    const snapshot = backupsOf(dataDir).find((n) => SNAPSHOT_RE.test(n))!;
    expect(rows(path.join(dataDir, 'backups', snapshot), 'SELECT title FROM tasks WHERE id = 12')).toEqual([{ title: 'Only in the -wal' }]);
  });

  it('moves the space files of an earlier upgrade that was rolled back to backups/orphaned-<stamp>/', async () => {
    const f = await legacyFolder();
    const spacesDir = path.join(f.dataDir, 'spaces');
    fs.mkdirSync(spacesDir);
    const orphan = 'zzzzzzzzzzzzzzzz';
    fs.writeFileSync(path.join(spacesDir, `${orphan}.db`), 'an old space');
    fs.writeFileSync(path.join(spacesDir, `${orphan}.db-wal`), 'its wal');
    fs.writeFileSync(path.join(spacesDir, 'notes.txt'), 'not a space');
    const lines: string[] = [];
    const result = upgrade(f.cfg, {}, lines)!;
    expect(fs.readdirSync(spacesDir).sort()).toEqual([`${result.space!.id}.db`, 'notes.txt'].sort());
    const folder = backupsOf(f.dataDir).find((n) => n.startsWith('orphaned-'))!;
    expect(folder).toMatch(/^orphaned-\d{4}-\d\d-\d\dT[\d-]+Z$/);
    expect(fs.readdirSync(path.join(f.dataDir, 'backups', folder)).sort()).toEqual([`${orphan}.db`, `${orphan}.db-wal`]);
    expect(fs.readFileSync(path.join(f.dataDir, 'backups', folder, `${orphan}.db`), 'utf8')).toBe('an old space');
    expect(lines).toContain(`Moved 1 space file of an earlier upgrade to ${path.join('backups', folder)}.`);
  });

  it('checks the free disk space first, and writes nothing without enough', async () => {
    const f = await legacyFolder();
    const size = fs.statSync(f.cfg.dbPath).size + (fs.existsSync(`${f.cfg.dbPath}-wal`) ? fs.statSync(`${f.cfg.dbPath}-wal`).size : 0);
    const needed = 2 * size + 64 * 1024 * 1024;
    const statfs = vi.fn(() => ({ bavail: needed / 4096 - 1, bsize: 4096 }));
    expect(() => upgrade(f.cfg, { statfs })).toThrow(
      new LegacyUpgradeStopped(
        `Not enough free disk space to upgrade the database: about ${Math.ceil(needed / 1024 / 1024)} MB are needed in ${f.dataDir}.`,
      ),
    );
    expect(statfs).toHaveBeenCalledWith(f.dataDir);
    expect(fs.readdirSync(f.dataDir).filter((n) => !n.startsWith('lyren.db'))).toEqual([]);
    expect(dumpLegacy(f.cfg.dbPath)).toEqual(dumpLegacy(f.original));
    upgrade(f.cfg, { statfs: () => ({ bavail: needed / 4096 + 1, bsize: 4096 }) });
    await expectUpgraded(f);
  });

  it('a custom DB_PATH name keeps its spaces in <file name>.spaces/', async () => {
    const f = await legacyFolder({ dbName: 'work.db' });
    const lines: string[] = [];
    const result = upgrade(f.cfg, {}, lines)!;
    expect(fs.readdirSync(f.dataDir).sort()).toEqual(['backups', 'work.db', 'work.db.spaces']);
    expect(fs.readdirSync(path.join(f.dataDir, 'work.db.spaces'))).toEqual([`${result.space!.id}.db`]);
    expect(lines.at(-1)).toContain(`(${path.join('work.db.spaces', `${result.space!.id}.db`)})`);
    await withStack(f.cfg, (stack) => {
      expect(stack.spaces.list()).toEqual([result.space!.id]);
    });
  });

  it('an install that was never set up becomes a directory without accounts or spaces (setup is next)', async () => {
    const f = await legacyFolder({ noUsers: true });
    const lines: string[] = [];
    const result = upgrade(f.cfg, {}, lines)!;
    expect(result.space).toBeNull();
    expect(lines.at(-1)).toBe(
      'Upgraded the database for multi-user spaces (it held no account yet, so no space was made). ' +
        `The old database was saved as ${path.join('backups', result.snapshot!)}.`,
    );
    expect(fs.existsSync(path.join(f.dataDir, 'spaces'))).toBe(false);
    await withStack(f.cfg, (stack) => {
      expect(stack.firstRun).toBe(true);
      expect(stack.directoryDb.all('SELECT key FROM instance_settings WHERE key = :k', { k: 'legacySpaceId' })).toEqual([]);
      expect(stack.directoryDb.get<{ n: number }>('SELECT COUNT(*) AS n FROM spaces')!.n).toBe(0);
    });
  });

  it('a 1.x database a pre-split build marked newer is still refused, by every start', async () => {
    const dataDir = tempDir();
    const file = path.join(dataDir, 'lyren.db');
    const newer = new DatabaseSync(file);
    newer.exec('CREATE TABLE projects (id INTEGER PRIMARY KEY); PRAGMA user_version = 2');
    newer.close();
    const cfg = loadConfig({ dbPath: file, webDir: null, logRequests: false });
    for (const mode of ['serve', 'maintenance'] as const) {
      expect(() => openNodeStack(cfg, { mode }).close()).toThrow(
        new DataRefusal('Database schema version 2 is newer than this build supports (1). Upgrade the app.'),
      );
    }
    expect(fs.readdirSync(dataDir)).toEqual(['lyren.db']);
  });

  it('the swap stops when another program opened the file after the lock was released (the next start redoes it)', async () => {
    const f = await legacyFolder();
    let intruder: DatabaseSync | null = null;
    expect(() =>
      upgrade(f.cfg, {
        afterStep: (s) => {
          if (s !== 'unlock') return;
          intruder = new DatabaseSync(f.cfg.dbPath);
          intruder.prepare('SELECT 1 FROM users').get();
        },
      }),
    ).toThrow(new LegacyUpgradeStopped(`Another program has ${f.cfg.dbPath} open; stop it and start Lyren Plan again`));
    intruder!.close();
    upgrade(f.cfg);
    await expectUpgraded(f);
  });
});

describe('renames on Windows retry while another program holds a file (§3.8 step 7)', () => {
  const busy = (code: string) => Object.assign(new Error(code), { code });

  it('retries EPERM, EBUSY and EACCES for up to 10 s, and nothing else', () => {
    let clock = 0;
    const timing = { now: () => clock, sleep: (ms: number) => (clock += ms) };
    let failures = ['EBUSY', 'EPERM', 'EACCES'];
    const rename = vi.fn(() => {
      const code = failures.shift();
      if (code) throw busy(code);
    });
    renameRetrying('a', 'b', { rename, platform: 'win32', ...timing });
    expect(rename).toHaveBeenCalledTimes(4);

    clock = 0;
    const always = vi.fn(() => {
      throw busy('EBUSY');
    });
    expect(() => renameRetrying('a', 'b', { rename: always, platform: 'win32', ...timing })).toThrow('EBUSY');
    expect(clock).toBeGreaterThanOrEqual(RENAME_RETRY_MS);
    expect(clock).toBeLessThan(RENAME_RETRY_MS + 1000);

    failures = ['ENOENT'];
    expect(() => renameRetrying('a', 'b', { rename, platform: 'win32', ...timing })).toThrow('ENOENT');
    failures = ['EBUSY'];
    expect(() => renameRetrying('a', 'b', { rename, platform: 'linux', ...timing })).toThrow('EBUSY');
  });

  it('the upgrade renames through it', async () => {
    const f = await legacyFolder();
    let failures = 2;
    const rename = vi.fn((from: string, to: string) => {
      if (from.endsWith('.upgrade') && failures-- > 0) throw busy('EBUSY');
      fs.renameSync(from, to);
    });
    if (process.platform === 'win32') {
      upgrade(f.cfg, { rename });
      expect(rename.mock.calls.filter(([from]) => from.endsWith('.upgrade'))).toHaveLength(3);
    } else {
      // Not retried on POSIX: rename(2) has no such failures; the next start finishes it.
      expect(() => upgrade(f.cfg, { rename })).toThrow('EBUSY');
      failures = 0;
      upgrade(f.cfg, { rename });
    }
    await expectUpgraded(f);
  });
});

describe('maintenance commands on a 1.x database', () => {
  function cli(dataDir: string, args: string[], input = '') {
    const res = spawnSync(...tsxCommand('server/src/index.ts', args), {
      cwd: ROOT,
      input,
      env: tsxEnv({ ...process.env, DATA_DIR: dataDir, DB_PATH: '' }),
      encoding: 'utf8',
      timeout: 60_000,
    });
    return { status: res.status, stdout: res.stdout, stderr: res.stderr };
  }

  it('refuse it, except backup, which writes an old-format copy without sessions; the data is not touched', async () => {
    const f = await legacyFolder();
    const before = dumpLegacy(f.cfg.dbPath);
    const reset = cli(f.dataDir, ['reset-password', 'owner'], 'a new password\n');
    expect(reset.status, reset.stderr).toBe(1);
    expect(reset.stderr.trim()).toBe(LEGACY_NOT_UPGRADED);
    // restore too, whatever it is given (here: the 1.x file's own copy).
    const restore = cli(f.dataDir, ['restore', f.original]);
    expect(restore.status, restore.stderr).toBe(1);
    expect(restore.stderr.trim()).toBe(LEGACY_NOT_UPGRADED);
    expect(() => openNodeStack(f.cfg, { mode: 'maintenance' })).toThrow(new DataRefusal(LEGACY_NOT_UPGRADED));

    const target = path.join(tempDir(), 'nested', 'lyren-old.tar');
    const res = cli(f.dataDir, ['backup', target]);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout.trim().split('\n')).toEqual([`Backup written to ${target}`, LEGACY_BACKUP_NOTE]);
    expect(inspectDatabase(target)).toMatchObject({ kind: 'legacy', version: 1, newer: false });
    const copy = dumpLegacy(target);
    expect(copy.sessions).toEqual([]);
    expect({ ...copy, sessions: before.sessions }).toEqual(before);
    if (posix) {
      expect(fs.statSync(target).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(target)).mode & 0o777).toBe(0o700);
    }
    expect(rows(target, 'PRAGMA journal_mode')).toEqual([{ journal_mode: 'delete' }]);
    // Nothing was upgraded or written next to the data.
    expect(dumpLegacy(f.cfg.dbPath)).toEqual(before);
    expect(fs.readdirSync(f.dataDir).filter((n) => !n.startsWith('lyren.db'))).toEqual([]);
    // An existing target is refused.
    const again = cli(f.dataDir, ['backup', target]);
    expect(again.status).toBe(1);
    expect(again.stderr.trim()).toBe(`${target} already exists; choose a new file name.`);
  }, 60_000);
});
