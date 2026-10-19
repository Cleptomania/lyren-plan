// The legacy single-file database (design §3.8): what Lyren Plan 1.x kept in DB_PATH, every project and
// account in one file. openNodeStack (stack.ts) recognizes it before it opens the directory, with reads
// only. A serving start (the server, or the desktop app once it holds its instance lock) upgrades it; a
// maintenance command refuses it with LEGACY_NOT_UPGRADED, except `backup`, which writes an old-format
// copy instead (backupSet.ts).
//
// The upgrade makes a directory (DB_PATH) and one space (<spacesDir>/<id>.db) of the file, with every id
// kept. The legacy file stays the writable source of truth until the final rename, so the upgrade is its
// only user: one connection L in exclusive locking mode from step 1 to step 7 (no other connection can
// read or write the file meanwhile), while the new files are written through connections of their own
// and the rows are copied through JS in batches. Every attempt rebuilds both new files from the legacy
// file, so an attempt that was interrupted (a crash, a power loss, another program that still had the
// file open) is redone at the next start, writes made in between included:
//   0. enough free disk space;
//   1. the lock (a file that another start upgraded since it was detected is left to the normal open),
//      then the marker (settings._upgrade_space_id: the space id the first attempt chose);
//   2. first attempt only (no marker): the before-upgrade snapshot, then the marker, in its own transaction;
//   3. no account yet: no space (a never-used install has only the seeds, which are dropped);
//   4. the space file <id>.db.partial, from scratch;
//   5. the directory file <DB_PATH>.upgrade, from scratch;
//   6. space files of an earlier upgrade that was rolled back move to backups/orphaned-<stamp>/;
//   7. the swap: <id>.db.partial → <id>.db; L closed (in exclusive mode SQLite checkpoints the -wal into
//      the file and removes it); <DB_PATH>.upgrade → DB_PATH;
//   8. the log line.
// Interrupted before the last rename, the next start finds the legacy file again and redoes steps 4-7
// (steps 1-7 after a crash between the snapshot and the marker); after it, DB_PATH is the directory.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { userPreferencesSchema, type UserPreferences } from '@shared/schemas';
import type { DirectoryConfig } from '../../core/config';
import { randomToken } from '../../core/crypto';
import { SQL_LIMITS, type SqlValue } from '../../core/db';
import { fold } from '../../core/fold';
import { generateSpaceId, isSpaceId } from '../../core/ids';
import { migrate } from '../../core/migrate';
import { systemClock, type Clock } from '../../core/runtime';
import { APP_VERSION } from '../../core/version';
import { isSnapshotName, logPrune, pruneSnapshots, snapshotStamp } from '../../db/snapshots';
import { DIRECTORY_MIGRATIONS } from '../../directory/schema';
import { seedInstanceSettings, setLegacySpaceId } from '../../directory/settings';
import { defaultSpaceName } from '../../directory/spaces';
import { SPACE_MIGRATIONS } from '../../space/schema';
import { fsyncFile, fsyncFolder, removeDatabaseFiles, renameRetrying, SQLITE_SIDE_FILES, type RenameOptions } from './files';
import { isBusyError, NodeDb, openExclusive, sqlitePath } from './nodeDb';
import { NEW_FORMAT_USER_VERSION, SPACE_FILE_RE, spacesDirFor } from './spaceStore';

/** The legacy schema's PRAGMA user_version (db/schema.ts SCHEMA_VERSION). */
export const LEGACY_SCHEMA_VERSION = 1;

/** What every maintenance command but `backup` says about a 1.x database (§3.8). */
export const LEGACY_NOT_UPGRADED =
  'This data has not been upgraded yet. Start Lyren Plan once with this version, then run the command again.';

/** What `backup` adds when it copies a 1.x database (§3.8). */
export const LEGACY_BACKUP_NOTE =
  'Note: this data has not been upgraded yet, so this is an old-format backup. Lyren Plan upgrades the data the next time it starts.';

/** The upgrade could not go on (see the message); the legacy file is unchanged and the next start tries again. */
export class LegacyUpgradeStopped extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LegacyUpgradeStopped';
  }
}

/**
 * What the file at DB_PATH holds, by §3.8's detection, with reads only:
 *   'none'    no file, a file without tables (a fresh directory), or one with _meta (a new-format file,
 *             or something migrate then refuses);
 *   'legacy'  no _meta, a projects table and user_version 1: a 1.x database;
 *   'newer'   no _meta and user_version above 1: a pre-split build newer than this one (none exists).
 */
export function detectLegacy(file: string): { kind: 'none' | 'legacy' | 'newer'; userVersion: number } {
  if (file === ':memory:' || !fs.existsSync(file)) return { kind: 'none', userVersion: 0 };
  // Read-only: closing a read-write connection would checkpoint the -wal a 1.x process that stopped
  // uncleanly left behind into the file it is refusing. (Not immutable=1: it would ignore that -wal and
  // could read a 1.x database as empty.)
  const db = new DatabaseSync(sqlitePath(file), { readOnly: true });
  try {
    return classify(db);
  } finally {
    db.close();
  }
}

/** detectLegacy's rule, on an open connection. */
function classify(db: DatabaseSync): ReturnType<typeof detectLegacy> {
  const tables = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name),
  );
  const userVersion = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  if (tables.size === 0 || tables.has('_meta')) return { kind: 'none', userVersion };
  if (userVersion > LEGACY_SCHEMA_VERSION) return { kind: 'newer', userVersion };
  if (userVersion === LEGACY_SCHEMA_VERSION && tables.has('projects')) return { kind: 'legacy', userVersion };
  return { kind: 'none', userVersion };
}

/** The points after which tests make an upgrade stop, as a crash would (LegacyUpgradeHooks.afterStep). */
export type LegacyUpgradeStep =
  | 'disk'
  | 'lock'
  | 'snapshot'
  | 'marker'
  | 'space'
  | 'directory'
  | 'orphans'
  | 'spaceRename'
  | 'unlock'
  | 'swap';

/** What tests replace. Production code passes none. */
export interface LegacyUpgradeHooks {
  /** Step 0's free space (default fs.statfsSync). */
  statfs?: (folder: string) => { bavail: number | bigint; bsize: number | bigint };
  /** The renames of steps 6 and 7 (default fs.renameSync, retried on Windows: files.ts). */
  rename?: RenameOptions['rename'];
  /** How long step 1 waits for another connection to let go (default 5000 ms). */
  busyTimeoutMs?: number;
  /** Called after each step; a test throws here to simulate a crash. */
  afterStep?: (step: LegacyUpgradeStep) => void;
  /** Step 8 and the other notes (default console.log). */
  log?: (line: string) => void;
}

export interface LegacyUpgradeOptions {
  /** DB_PATH: the 1.x database, and afterwards the directory. */
  dbPath: string;
  /** SNAPSHOT_KEEP: the before-upgrade snapshots kept in backups/. */
  snapshotKeep: number;
  /** The seeds of the new directory's instance settings (§5.3). */
  directory: Pick<DirectoryConfig, 'seed'>;
  clock?: Clock;
  hooks?: LegacyUpgradeHooks;
}

export interface LegacyUpgradeResult {
  /** The space that holds the data; null when the install had no account (step 3). */
  space: { id: string; name: string; file: string } | null;
  /** The before-upgrade snapshot (a file name in backups/), or null when none can be found any more. */
  snapshot: string | null;
  /** The new directory's signupPolicy was seeded now (its startup warning applies). */
  seededPolicy: boolean;
}

const MIB = 1024 * 1024;
/** Rows read from the legacy file at a time. */
const BATCH = 500;
const MARKER = '_upgrade_space_id';
const DEFAULT_BUSY_TIMEOUT_MS = 5000;

/** A table the space gets as it is: the legacy columns, plus fold columns computed while copying (§3.4). */
interface TableCopy {
  table: string;
  columns: readonly string[];
  /** Fold column → the column it folds. */
  folds?: Readonly<Record<string, string>>;
  /** The order the rows are read in (default the id). */
  key?: readonly string[];
}

const NAME_FOLDS = { name_fold: 'name', description_fold: 'description' } as const;

/** In foreign key order: a row's parents are always copied before it. */
export const LEGACY_SPACE_TABLES: readonly TableCopy[] = [
  { table: 'statuses', columns: ['id', 'name', 'category', 'color', 'position', 'created_at', 'updated_at'], folds: { name_fold: 'name' } },
  { table: 'tags', columns: ['id', 'name', 'color', 'created_at', 'updated_at'], folds: { name_fold: 'name' } },
  {
    table: 'projects',
    columns: ['id', 'key', 'name', 'description', 'color', 'status', 'position', 'task_counter', 'created_at', 'updated_at'],
    folds: NAME_FOLDS,
  },
  {
    table: 'milestones',
    columns: ['id', 'project_id', 'name', 'description', 'status', 'start_date', 'due_date', 'position', 'completed_at', 'created_at',
      'updated_at'],
    folds: NAME_FOLDS,
  },
  {
    table: 'epics',
    columns: ['id', 'project_id', 'milestone_id', 'name', 'description', 'color', 'status', 'start_date', 'due_date', 'position',
      'completed_at', 'created_at', 'updated_at'],
    folds: NAME_FOLDS,
  },
  {
    table: 'tasks',
    columns: ['id', 'project_id', 'number', 'epic_id', 'status_id', 'title', 'description', 'priority', 'start_date', 'due_date',
      'estimate', 'rank', 'completed_at', 'archived_at', 'created_by', 'created_at', 'updated_at'],
    folds: { title_fold: 'title', description_fold: 'description' },
  },
  { table: 'task_tags', columns: ['task_id', 'tag_id'], key: ['task_id', 'tag_id'] },
  { table: 'comments', columns: ['id', 'task_id', 'user_id', 'body', 'created_at', 'updated_at', 'edited_at'] },
  { table: 'work_logs', columns: ['id', 'task_id', 'user_id', 'date', 'minutes', 'note', 'created_at', 'updated_at'] },
  { table: 'activity', columns: ['id', 'user_id', 'project_id', 'task_id', 'entity_type', 'entity_id', 'action', 'data', 'created_at'] },
  { table: 'boards', columns: ['id', 'project_id', 'name', 'description', 'config', 'position', 'created_at', 'updated_at'] },
];

/** The legacy settings that stay with the data (§3.6); every '_' key but the marker too. */
const SPACE_SETTING_KEYS = ['estimateUnit', 'defaultBoardId'];
/** The legacy settings that become the owner's preferences. */
const PREFERENCE_KEYS = ['weekStartsOn', 'homePage'] as const;

const META_SET = 'INSERT INTO _meta (key, value) VALUES (:key, :value) ON CONFLICT (key) DO UPDATE SET value = excluded.value';

type Row = Record<string, SqlValue>;

/** Another connection holds the file exclusively (step 1's stop; openNodeStack's open of the directory too). */
export const stillOpen = (dbPath: string) =>
  `Lyren Plan or another program still has ${dbPath} open. Stop it and start Lyren Plan again.`;

/** Step 0: free space ≥ 2 × (the file and its -wal) + 64 MiB. */
function checkDiskSpace(dbPath: string, statfs: NonNullable<LegacyUpgradeHooks['statfs']>): void {
  const folder = path.dirname(dbPath);
  const size = (file: string) => (fs.existsSync(file) ? fs.statSync(file).size : 0);
  const needed = 2 * (size(dbPath) + size(`${dbPath}-wal`)) + 64 * MIB;
  const stats = statfs(folder);
  if (Number(stats.bavail) * Number(stats.bsize) < needed) {
    throw new LegacyUpgradeStopped(
      `Not enough free disk space to upgrade the database: about ${Math.ceil(needed / MIB)} MB are needed in ${folder}.`,
    );
  }
}

/** Step 1: the connection L, holding the lock until it is closed. Stops, writing nothing, while another has the file open. */
function lockLegacy(dbPath: string, busyTimeoutMs: number): NodeDb {
  const db = openExclusive(dbPath, busyTimeoutMs);
  if (!db) throw new LegacyUpgradeStopped(stillOpen(dbPath));
  return db;
}

function readMarker(legacy: NodeDb): string | null {
  const row = legacy.get<{ value: string }>('SELECT value FROM settings WHERE key = :key', { key: MARKER });
  if (!row) return null;
  try {
    const id: unknown = JSON.parse(row.value);
    return isSpaceId(id) ? id : null;
  } catch {
    return null;
  }
}

/** The before-upgrade snapshot an earlier attempt wrote: the newest in backups/. */
function newestSnapshot(backups: string): string | null {
  let names: string[];
  try {
    names = fs.readdirSync(backups);
  } catch {
    return null;
  }
  const prefix = `lyren-v${LEGACY_SCHEMA_VERSION}-`;
  // The stamp sorts chronologically, and the names differ only there.
  const snapshots = names.filter((n) => n.startsWith(prefix) && isSnapshotName('before-upgrade', n)).sort();
  return snapshots.at(-1) ?? null;
}

/** Each batch of up to BATCH rows of `table`, in key order (keyset pagination: every row exactly once). */
function eachBatch(
  legacy: NodeDb,
  o: { table: string; columns: readonly string[]; key?: readonly string[]; where?: string; params?: Record<string, SqlValue> },
  fn: (rows: Row[]) => void,
): void {
  const key = o.key ?? ['id'];
  const keyList = key.join(', ');
  const after = `(${keyList}) > (${key.map((_, i) => `:k${i}`).join(', ')})`;
  let last: Row | null = null;
  for (;;) {
    const conditions: string[] = [o.where, last ? after : undefined].filter((c) => c !== undefined);
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    const params: Record<string, SqlValue> = { ...o.params };
    if (last) key.forEach((k, i) => (params[`k${i}`] = last![k]!));
    const select = `SELECT ${o.columns.join(', ')} FROM ${o.table}${where} ORDER BY ${keyList} LIMIT ${BATCH}`;
    const rows: Row[] = legacy.all<Row>(select, params);
    if (rows.length > 0) fn(rows);
    if (rows.length < BATCH) return;
    last = rows[rows.length - 1]!;
  }
}

/** Insert rows (values in `columns` order), with at most 100 bound parameters per statement (§3.7). */
function insertRows(db: NodeDb, table: string, columns: readonly string[], rows: readonly SqlValue[][]): void {
  const perStatement = Math.max(1, Math.floor(SQL_LIMITS.maxParameters / columns.length));
  const tuple = `(${columns.map(() => '?').join(', ')})`;
  for (let at = 0; at < rows.length; at += perStatement) {
    const chunk = rows.slice(at, at + perStatement);
    db.run(`INSERT INTO ${table} (${columns.join(', ')}) VALUES ${chunk.map(() => tuple).join(', ')}`, chunk.flat());
  }
}

/** sqlite_sequence of `tables` as in the legacy file: ids deleted there are never issued again. */
function copySequences(legacy: NodeDb, db: NodeDb, tables: readonly string[]): void {
  const seqs = legacy.all<{ name: string; seq: number }>(
    'SELECT name, seq FROM sqlite_sequence WHERE name IN (SELECT value FROM json_each(:tables))',
    { tables: JSON.stringify(tables) },
  );
  for (const { name, seq } of seqs) {
    if (db.run('UPDATE sqlite_sequence SET seq = max(seq, :seq) WHERE name = :name', { name, seq }).changes === 0) {
      db.run('INSERT INTO sqlite_sequence (name, seq) VALUES (:name, :seq)', { name, seq });
    }
  }
}

function assertNoForeignKeyViolations(db: NodeDb, what: string): void {
  const bad = db.all('PRAGMA foreign_key_check');
  if (bad.length > 0) throw new Error(`The upgraded ${what} would have ${bad.length} foreign key violation(s)`);
}

/** A new database file for the upgrade (0600, its folder 0700), with a rollback journal: one file to rename. */
function createFile(file: string): NodeDb {
  removeDatabaseFiles(file);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.closeSync(fs.openSync(file, 'wx', 0o600));
  const db = new NodeDb(file);
  try {
    db.raw.exec('PRAGMA journal_mode = DELETE');
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

/** Marked as new-format (§3.1), closed and flushed to the disk. */
function finishFile(db: NodeDb): void {
  db.raw.exec(`PRAGMA user_version = ${NEW_FORMAT_USER_VERSION}`);
  db.close();
  fsyncFile(db.filename);
}

/** Step 4: the space with every row of the legacy file but the accounts and sessions. */
function buildSpace(legacy: NodeDb, file: string, o: { id: string; name: string; source: string; nowMs: number }): void {
  const db = createFile(file);
  try {
    migrate(db, SPACE_MIGRATIONS, { appVersion: APP_VERSION });
    const now = new Date(o.nowMs).toISOString();
    db.tx(() => {
      // The users mirror (§3.5): every legacy account, a member.
      eachBatch(legacy, { table: 'users', columns: ['id', 'display_name'] }, (rows) =>
        insertRows(
          db,
          'users',
          ['id', 'kind', 'display_name', 'email', 'is_member', 'deleted', 'updated_at'],
          rows.map((u) => [u.id!, 'account', u.display_name!, null, 1, 0, now]),
        ),
      );
      for (const copy of LEGACY_SPACE_TABLES) {
        const folds = Object.entries(copy.folds ?? {});
        const columns = [...copy.columns, ...folds.map(([target]) => target)];
        eachBatch(legacy, copy, (rows) =>
          insertRows(
            db,
            copy.table,
            columns,
            rows.map((r) => [...copy.columns.map((c) => r[c]!), ...folds.map(([, source]) => fold(String(r[source])))]),
          ),
        );
      }
      const settings = legacy.all<{ key: string; value: string }>(
        `SELECT key, value FROM settings
         WHERE key IN (SELECT value FROM json_each(:keys)) OR (substr(key, 1, 1) = '_' AND key <> :marker) ORDER BY key`,
        { keys: JSON.stringify(SPACE_SETTING_KEYS), marker: MARKER },
      );
      insertRows(db, 'settings', ['key', 'value'], settings.map((s) => [s.key, s.value]));
      copySequences(legacy, db, LEGACY_SPACE_TABLES.map((t) => t.table));
      assertNoForeignKeyViolations(db, 'space');
      const writeState = { gen: o.nowMs, day: now.slice(0, 10), rows: 0 };
      for (const [key, value] of [
        ['space_id', o.id],
        ['space_name', o.name],
        ['sync_version', '1'],
        ['write_state', JSON.stringify(writeState)],
        ['legacy_source', o.source],
      ]) {
        db.run(META_SET, { key, value });
      }
    });
  } catch (err) {
    db.close();
    throw err;
  }
  finishFile(db);
}

/** The owner's preferences from the legacy settings, each checked with the shared schema (invalid ones dropped). */
function ownerPreferences(legacy: NodeDb): Partial<UserPreferences> {
  const preferences: Record<string, unknown> = {};
  const rows = legacy.all<{ key: string; value: string }>(
    'SELECT key, value FROM settings WHERE key IN (SELECT value FROM json_each(:keys))',
    { keys: JSON.stringify(PREFERENCE_KEYS) },
  );
  for (const { key, value } of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      continue;
    }
    const checked = userPreferencesSchema.shape[key as (typeof PREFERENCE_KEYS)[number]].safeParse(parsed);
    if (checked.success) preferences[key] = checked.data;
  }
  return preferences as Partial<UserPreferences>;
}

/** Step 5: the directory with the legacy accounts, their live sessions and (unless step 3 applied) the space. */
function buildDirectory(
  legacy: NodeDb,
  file: string,
  o: { owner: { id: number } | null; space: { id: string; name: string } | null; directory: Pick<DirectoryConfig, 'seed'>; nowMs: number },
): { seededPolicy: boolean } {
  const db = createFile(file);
  let seededPolicy: boolean;
  try {
    migrate(db, DIRECTORY_MIGRATIONS, { appVersion: APP_VERSION });
    const now = new Date(o.nowMs).toISOString();
    const preferences = JSON.stringify(ownerPreferences(legacy));
    seededPolicy = db.tx(() => {
      const accounts = { table: 'users', columns: ['id', 'username', 'display_name', 'password_hash', 'created_at', 'updated_at'] };
      eachBatch(legacy, accounts, (rows) => {
        for (const u of rows) {
          const owner = u.id === o.owner?.id;
          db.run(
            `INSERT INTO users (id, email, email_key, email_verified_at, username, display_name, password_hash, webauthn_user_id,
               is_instance_admin, auth_epoch, preferences, created_at, updated_at)
             VALUES (:id, NULL, NULL, NULL, :username, :displayName, :hash, :handle, :admin, 0, :preferences, :createdAt, :updatedAt)`,
            {
              id: u.id,
              username: u.username,
              displayName: u.display_name,
              hash: u.password_hash,
              handle: randomToken(32),
              admin: owner ? 1 : 0,
              preferences: owner ? preferences : '{}',
              createdAt: u.created_at,
              updatedAt: u.updated_at,
            },
          );
        }
      });
      // Signed-in browsers stay signed in (§5.4.1): reauth_at = created_at, so a re-auth is asked for.
      eachBatch(
        legacy,
        {
          table: 'sessions',
          columns: ['id', 'token_hash', 'user_id', 'created_at', 'last_seen_at', 'expires_at', 'user_agent', 'ip'],
          where: 'expires_at > :now',
          params: { now },
        },
        (rows) =>
          insertRows(
            db,
            'sessions',
            ['id', 'token_hash', 'user_id', 'auth_method', 'reauth_at', 'created_at', 'last_seen_at', 'expires_at', 'absolute_expires_at',
              'user_agent', 'ip'],
            rows.map((s) => [s.id!, s.token_hash!, s.user_id!, 'legacy', s.created_at!, s.created_at!, s.last_seen_at!, s.expires_at!, null,
              s.user_agent!, s.ip!]),
          ),
      );
      copySequences(legacy, db, ['users', 'sessions']);
      if (o.space && o.owner) {
        const owner = o.owner.id;
        const space = db.get<{ id: number }>(
          `INSERT INTO spaces (public_id, name, status, sync_version, created_by, created_at, updated_at)
           VALUES (:publicId, :name, 'active', 1, :owner, :now, :now) RETURNING id`,
          { publicId: o.space.id, name: o.space.name, owner, now },
        )!;
        // Any account besides the owner (only manual edits made one in 1.x) is a member.
        eachBatch(legacy, { table: 'users', columns: ['id'] }, (rows) => {
          insertRows(
            db,
            'memberships',
            ['space_id', 'user_id', 'role', 'added_by', 'created_at', 'updated_at'],
            rows.map((u) => [space.id, u.id!, u.id === owner ? 'owner' : 'member', owner, now, now]),
          );
          insertRows(db, 'space_people', ['space_id', 'user_id'], rows.map((u) => [space.id, u.id!]));
        });
        setLegacySpaceId(db, o.space.id);
      }
      const seeded = seedInstanceSettings(db, o.directory).seededPolicy;
      assertNoForeignKeyViolations(db, 'directory');
      return seeded;
    });
  } catch (err) {
    db.close();
    throw err;
  }
  finishFile(db);
  return { seededPolicy };
}

/**
 * Step 6: <id>.db files in the spaces folder other than `keep` (an earlier upgrade's, rolled back since,
 * §9.9) move with their -wal and -shm to backups/orphaned-<stamp>/. Nothing is deleted. Returns the count.
 */
function moveOrphans(spacesDir: string, backups: string, keep: string | null, stamp: string, rename: RenameOptions): number {
  let names: string[];
  try {
    names = fs.readdirSync(spacesDir);
  } catch {
    return 0;
  }
  const orphans = names.filter((n) => {
    const id = SPACE_FILE_RE.exec(n)?.[1];
    return id !== undefined && id !== keep;
  });
  if (orphans.length === 0) return 0;
  const target = path.join(backups, `orphaned-${stamp}`);
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const name of orphans) {
    for (const suffix of ['', ...SQLITE_SIDE_FILES]) {
      const from = path.join(spacesDir, `${name}${suffix}`);
      if (fs.existsSync(from)) renameRetrying(from, path.join(target, `${name}${suffix}`), rename);
    }
  }
  fsyncFolder(spacesDir);
  return orphans.length;
}

/**
 * The upgrade of §3.8 (see the header). Throws LegacyUpgradeStopped when it cannot go on now. Null when,
 * once locked, DB_PATH no longer holds a 1.x database: another start upgraded it since it was detected.
 */
export function upgradeLegacy(o: LegacyUpgradeOptions): LegacyUpgradeResult | null {
  const hooks = o.hooks ?? {};
  const afterStep = hooks.afterStep ?? (() => undefined);
  const log = hooks.log ?? ((line: string) => console.log(line));
  const rename: RenameOptions = hooks.rename ? { rename: hooks.rename } : {};
  const clock = o.clock ?? systemClock;
  const { dbPath } = o;
  const folder = path.dirname(dbPath);
  const backups = path.join(folder, 'backups');
  const spacesDir = spacesDirFor(dbPath);
  const directoryFile = `${dbPath}.upgrade`;

  // Steps 0 and 1: nothing is written before both passed.
  checkDiskSpace(dbPath, hooks.statfs ?? fs.statfsSync);
  afterStep('disk');

  const legacy = lockLegacy(dbPath, hooks.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS);
  let locked = true;
  try {
    if (classify(legacy.raw).kind !== 'legacy') return null;
    afterStep('lock');
    const nowMs = clock.now();
    const stamp = snapshotStamp(new Date(nowMs));
    let spaceId = readMarker(legacy);
    let snapshot: string | null;
    // Step 2. A crash between the snapshot and the marker just means another snapshot next time.
    if (spaceId === null) {
      snapshot = `lyren-v${LEGACY_SCHEMA_VERSION}-before-upgrade-${stamp}.db`;
      legacy.backupTo(path.join(backups, snapshot));
      logPrune('before-upgrade', backups, o.snapshotKeep, pruneSnapshots(backups, 'before-upgrade', o.snapshotKeep, snapshot));
      afterStep('snapshot');
      spaceId = generateSpaceId();
      const marker = JSON.stringify(spaceId);
      legacy.tx(() =>
        legacy.run('INSERT INTO settings (key, value) VALUES (:key, :value) ON CONFLICT (key) DO UPDATE SET value = excluded.value', {
          key: MARKER,
          value: marker,
        }),
      );
      afterStep('marker');
    } else {
      snapshot = newestSnapshot(backups);
    }

    // Steps 3-5: the new files, from scratch on every attempt.
    const owner = legacy.get<{ id: number; display_name: string }>('SELECT id, display_name FROM users ORDER BY id LIMIT 1') ?? null;
    const space = owner ? { id: spaceId, name: defaultSpaceName(owner.display_name), file: path.join(spacesDir, `${spaceId}.db`) } : null;
    const partial = `${path.join(spacesDir, spaceId)}.db.partial`;
    if (space) {
      removeDatabaseFiles(space.file);
      buildSpace(legacy, partial, { ...space, source: `${path.basename(dbPath)} v${LEGACY_SCHEMA_VERSION} ${stamp}`, nowMs });
      afterStep('space');
    }
    const { seededPolicy } = buildDirectory(legacy, directoryFile, { owner, space, directory: o.directory, nowMs });
    afterStep('directory');
    const orphans = moveOrphans(spacesDir, backups, space?.id ?? null, stamp, rename);
    if (orphans > 0) {
      log(`Moved ${orphans} space file${orphans === 1 ? '' : 's'} of an earlier upgrade to ${path.join('backups', `orphaned-${stamp}`)}.`);
    }
    afterStep('orphans');

    // Step 7. Until the last rename, the legacy file is still what DB_PATH holds, and the next start redoes 4-7.
    if (space) {
      renameRetrying(partial, space.file, rename);
      fsyncFolder(spacesDir);
    }
    afterStep('spaceRename');
    legacy.close();
    locked = false;
    afterStep('unlock');
    // The lock just released proves that a -shm left now is stale; a -wal or -journal means that another
    // connection opened the file meanwhile (as does a -shm that Windows cannot delete, being in use).
    const openedMeanwhile = new LegacyUpgradeStopped(`Another program has ${dbPath} open; stop it and start Lyren Plan again`);
    try {
      fs.rmSync(`${dbPath}-shm`, { force: true });
    } catch {
      throw openedMeanwhile;
    }
    if (fs.existsSync(`${dbPath}-wal`) || fs.existsSync(`${dbPath}-journal`)) throw openedMeanwhile;
    renameRetrying(directoryFile, dbPath, rename);
    fsyncFolder(folder);
    afterStep('swap');

    const saved = snapshot ? ` The old database was saved as ${path.join('backups', snapshot)}.` : '';
    log(
      space
        ? `Upgraded the database for multi-user spaces: your data is now in the space "${space.name}" ` +
            `(${path.join(path.relative(folder, spacesDir), `${space.id}.db`)}).${saved}`
        : `Upgraded the database for multi-user spaces (it held no account yet, so no space was made).${saved}`,
    );
    return { space, snapshot, seededPolicy };
  } finally {
    if (locked) legacy.close();
  }
}

/**
 * openNodeStack's call (mode 'serve'): the upgrade when DB_PATH holds a 1.x database, else null. A file
 * that another start is upgrading right now (its exclusive lock refuses even reads) stops like step 1.
 */
export function upgradeLegacyIfNeeded(o: LegacyUpgradeOptions): LegacyUpgradeResult | null {
  let kind: ReturnType<typeof detectLegacy>['kind'];
  try {
    kind = detectLegacy(o.dbPath).kind;
  } catch (err) {
    if (isBusyError(err)) throw new LegacyUpgradeStopped(stillOpen(o.dbPath));
    throw err;
  }
  return kind === 'legacy' ? upgradeLegacy(o) : null;
}
