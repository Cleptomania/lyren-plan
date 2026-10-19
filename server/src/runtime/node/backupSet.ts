// Backup sets on Node (design §9.5): one uncompressed ustar file (tar.ts) with the directory and every
// space it holds, written by the CLI's `backup` and by the instance admins' download (GET
// /api/admin/backup), and read back by `restore`:
//
//   lyren-backup.json   the manifest (first entry): format, formatVersion, createdAt, appVersion, the
//                       directory's file and schema version, and per space its id, name, file, schema
//                       version and size
//   directory.db        a VACUUM INTO snapshot of the directory, without sessions, device tokens, passkey
//                       challenges, email tokens, throttle counters and open invitations (bearer tokens,
//                       and lock-outs that would outlive their reason), secure_delete on, journal_mode DELETE
//   spaces/             a folder entry
//   spaces/<id>.db      a VACUUM INTO snapshot of each space the directory snapshot lists: active and
//                       importing ones, and deleted ones still within their grace period
//
// What a set promises (it is written while the server runs): every database in it is a transactionally
// consistent snapshot of that file at one moment, and holds every transaction that was committed when its
// snapshot began. The directory is taken first, and the spaces are exactly those the directory snapshot
// lists, each taken afterwards, one after another. The set is not atomic across files: a space can hold
// writes made after the directory snapshot (a task by a member whose membership the directory snapshot
// does not have yet, an author the directory snapshot does not know), which is harmless, since a space's
// members and mirror always follow the directory (§3.5). A space created after the directory snapshot is
// not in the set; a space the directory snapshot lists whose file is missing fails the backup instead of
// leaving it out silently.
//
// Writing refuses an existing target, takes the snapshots in DATA_DIR/.backup-<16 hex>/ (0700, always
// removed), writes the tar to <target>.partial and renames it. Entries are 0600 (the folder 0700), owned
// by uid and gid 0, dated createdAt. A start removes the temporaries a killed process left behind.
//
// Reading (for restore) accepts only a set of this format: the manifest first, exactly the files it
// names and nothing else, each database starting with the SQLite header; extracting checks each
// database's _meta (kind, space id, and the versions of §9.6 step 2).

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { SPACE_ID_RE } from '../../core/ids';
import { APP_VERSION } from '../../core/version';
import { DIRECTORY_MIGRATIONS } from '../../directory/schema';
import { SPACE_MIGRATIONS } from '../../space/schema';
import { fsyncFolder, renameRetrying } from './files';
import { LEGACY_SCHEMA_VERSION } from './legacy';
import { sqlitePath, stripSessions, type NodeDb } from './nodeDb';
import type { NodeSpaceStore } from './spaceStore';
import { extractTarItem, listTar, readTarItem, TAR_MAX_FILE_BYTES, TarError, writeTar, type TarEntry, type TarItem } from './tar';

/**
 * Temporary files and folders of a backup (DATA_DIR/.backup-<16 hex>…), and of a restore: the copy of
 * standard input of `restore -` (DATA_DIR/.restore-<16 hex>.in) and the folder it is staged in
 * (DATA_DIR/.restore-<16 hex>.partial, restore.ts). A serving start removes them when it finds them.
 */
export const BACKUP_TEMP_RE = /^\.(?:backup-[0-9a-f]{16}(?:\.db(?:-journal)?|\.tar(?:\.partial)?)?|restore-[0-9a-f]{16}\.(?:in|partial))$/;

export const MANIFEST_FILE = 'lyren-backup.json';
export const DIRECTORY_FILE = 'directory.db';
const SPACES_FOLDER = 'spaces';
const FORMAT = 'lyren-plan-backup';
const FORMAT_VERSION = 1;
const MANIFEST_MAX_BYTES = 16 * 1024 * 1024;
const MAX_SPACES = 100_000;
const SQLITE_HEADER = 'SQLite format 3\0';

/** What restore says about data from a newer version (§9.6 step 2). */
export const NEWER_BACKUP =
  'This backup was made by a newer version of Lyren Plan. Install that version, or a newer one, to restore it.';

/** What `backup` adds for a target named .db (§9.6). */
export const BACKUP_SET_NAME_NOTE = 'Note: the backup is a .tar backup set; name it .tar';

/** A backup cannot be written, or a file is not one restore can use; the message says why. */
export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupError';
  }
}

const spaceFile = (id: string) => `${SPACES_FOLDER}/${id}.db`;
const partialExists = (partial: string) =>
  new BackupError(`${partial} already exists (an interrupted backup?); delete it, or choose a new file name.`);

const manifestSchema = z
  .object({
    format: z.literal(FORMAT),
    formatVersion: z.literal(FORMAT_VERSION),
    createdAt: z.iso.datetime(),
    appVersion: z.string().min(1).max(100),
    directory: z.object({ file: z.literal(DIRECTORY_FILE), schemaVersion: z.number().int().min(1) }).strict(),
    spaces: z
      .array(
        z
          .object({
            id: z.string().regex(SPACE_ID_RE),
            name: z.string().max(1000),
            file: z.string(),
            schemaVersion: z.number().int().min(1),
            bytes: z.number().int().min(0).max(TAR_MAX_FILE_BYTES - 1),
          })
          .strict()
          .refine((s) => s.file === spaceFile(s.id), { message: 'a space file must be spaces/<id>.db' }),
      )
      .max(MAX_SPACES),
  })
  .strict();

/** lyren-backup.json (§9.5). */
export type BackupManifest = z.infer<typeof manifestSchema>;

/**
 * Delete temporary backup files left in `dataDir` by a process that was killed while it was writing
 * one: the snapshots' folder (.backup-<hex>/), the download's tar (.backup-<hex>.tar and its .partial),
 * the copies of earlier versions (.backup-<hex>.db), the standard input of `restore -` (.restore-<hex>.in)
 * and a restore's unfinished staging folder (.restore-<hex>.partial). Normally they are deleted at once; on
 * Windows a file that another program (a virus scanner) holds open cannot be deleted then. Only a serving
 * start calls it (stack.ts): a maintenance command may run beside a backup that is still writing its
 * temporaries.
 */
export function removeStaleBackupTemps(dataDir: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(dataDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!BACKUP_TEMP_RE.test(name)) continue;
    try {
      fs.rmSync(path.join(dataDir, name), { recursive: true, force: true });
    } catch {
      // Still held open by another program: try again at the next start.
    }
  }
}

// ---------------------------------------------------------------------------
// Database files: what one holds, and whether this build can use it
// ---------------------------------------------------------------------------

/** What a database file is (inspectDatabase). */
export interface DatabaseInfo {
  /** A directory or space (_meta.schema), a 1.x database, or null: not SQLite, or nothing of ours. */
  kind: 'directory' | 'space' | 'legacy' | null;
  /** _meta.version, or a 1.x database's user_version. */
  version: number;
  /** _meta.compatible_from (§3.7); a 1.x database's user_version. */
  compatibleFrom: number;
  /** A space's _meta.space_id. */
  spaceId: string | null;
  /** Made by a newer build than this one can use (§9.6 step 2): restore refuses it with NEWER_BACKUP. */
  newer: boolean;
}

const NOT_OURS: DatabaseInfo = { kind: null, version: 0, compatibleFrom: 0, spaceId: null, newer: false };

function startsWithSqliteHeader(bytes: Uint8Array): boolean {
  return Buffer.from(bytes.subarray(0, SQLITE_HEADER.length)).toString('latin1') === SQLITE_HEADER;
}

/**
 * What the database `file` is, read without writing to it (a file from a backup or another machine is
 * not trusted: its schema runs no functions, and only plain tables are read). Never throws for a file
 * that is not a database: its kind is null.
 */
export function inspectDatabase(file: string): DatabaseInfo {
  const head = new Uint8Array(SQLITE_HEADER.length);
  const fd = fs.openSync(file, 'r');
  try {
    if (fs.readSync(fd, head, 0, head.length, 0) < head.length || !startsWithSqliteHeader(head)) return NOT_OURS;
  } finally {
    fs.closeSync(fd);
  }
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(sqlitePath(file), { readOnly: true });
    db.exec('PRAGMA trusted_schema = OFF');
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name),
    );
    if (tables.has('_meta')) {
      const rows = db.prepare('SELECT key, value FROM _meta').all() as Array<{ key: string; value: string }>;
      const meta = new Map(rows.map((r) => [r.key, r.value]));
      const schema = meta.get('schema');
      const version = Number(meta.get('version'));
      const compatibleFrom = Number(meta.get('compatible_from') ?? version);
      if ((schema !== 'directory' && schema !== 'space') || !Number.isSafeInteger(version) || !Number.isSafeInteger(compatibleFrom)) {
        return NOT_OURS;
      }
      const known = (schema === 'directory' ? DIRECTORY_MIGRATIONS : SPACE_MIGRATIONS).migrations.length;
      const spaceId = schema === 'space' ? (meta.get('space_id') ?? null) : null;
      return { kind: schema, version, compatibleFrom, spaceId, newer: version > known && compatibleFrom > known };
    }
    const userVersion = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    if (tables.has('projects') && userVersion >= LEGACY_SCHEMA_VERSION) {
      const newer = userVersion > LEGACY_SCHEMA_VERSION;
      return { kind: 'legacy', version: userVersion, compatibleFrom: userVersion, spaceId: null, newer };
    }
    return NOT_OURS;
  } catch {
    // Not a database after all (damaged, or encrypted).
    return NOT_OURS;
  } finally {
    db?.close();
  }
}

/** §9.6 step 2: refuse a database (from a backup) that a newer build made and this one cannot use. */
export function refuseNewer(info: DatabaseInfo): void {
  if (info.newer) throw new BackupError(NEWER_BACKUP);
}

// ---------------------------------------------------------------------------
// Writing a set
// ---------------------------------------------------------------------------

/** A space a backup holds. */
export interface BackupSpace {
  id: string;
  name: string;
}

/**
 * Remove from a directory snapshot what a restore must not bring back (see the header), and read from
 * it what the set needs: the spaces it holds (§9.5) and its schema version.
 */
function stripDirectoryCopy(file: string, nowMs: number): { spaces: BackupSpace[]; schemaVersion: number } {
  const copy = new DatabaseSync(sqlitePath(file));
  try {
    copy.exec('PRAGMA journal_mode = DELETE');
    copy.exec('PRAGMA secure_delete = ON');
    copy.exec(`DELETE FROM sessions;
      DELETE FROM device_tokens;
      DELETE FROM webauthn_challenges;
      DELETE FROM email_tokens;
      DELETE FROM auth_throttle;
      DELETE FROM invitations WHERE accepted_at IS NULL AND revoked_at IS NULL;`);
    const spaces = copy
      .prepare(
        `SELECT public_id AS id, name FROM spaces
         WHERE status <> 'provisioning' AND (deleted_at IS NULL OR purge_after > ?)
         ORDER BY spaces.id`,
      )
      .all(new Date(nowMs).toISOString()) as unknown as BackupSpace[];
    const version = copy.prepare("SELECT value FROM _meta WHERE key = 'version'").get() as { value: string };
    return { spaces: spaces.map((s) => ({ id: s.id, name: s.name })), schemaVersion: Number(version.value) };
  } finally {
    copy.close();
  }
}

/** A snapshot of one space at `file`; its schema version. Throws, naming the space, when its data is missing. */
function snapshotSpace(store: NodeSpaceStore, space: BackupSpace, file: string): number {
  const where = store.dir === ':memory:' ? 'not in memory' : store.file(space.id);
  const missing = () => new BackupError(`The data of space ${space.id} (${space.name}) is missing: ${where}`);
  if (!store.snapshot(space.id, file)) throw missing();
  const info = inspectDatabase(file);
  // A file without a space's _meta (an init that was interrupted) holds none of the space's data.
  if (info.kind !== 'space' || info.spaceId === null) throw missing();
  if (info.spaceId !== space.id) {
    throw new BackupError(`${where} belongs to another space (${info.spaceId}), not to ${space.id} (${space.name})`);
  }
  return info.version;
}

export interface WriteBackupSetOptions {
  directoryDb: NodeDb;
  store: NodeSpaceStore;
  /** The directory file's folder: the snapshots are taken in its .backup-<hex>/. */
  dataDir: string;
  /** The new file (refused when it exists); its folder is made (0700) when missing. */
  target: string;
  nowMs: number;
}

/** Write a backup set to `target` (see the header). Returns its manifest. Throws BackupError with the reason. */
export function writeBackupSet(o: WriteBackupSetOptions): BackupManifest {
  if (fs.existsSync(o.target)) throw new BackupError(`${o.target} already exists; choose a new file name.`);
  const partial = `${o.target}.partial`;
  const temp = path.join(o.dataDir, `.backup-${randomBytes(8).toString('hex')}`);
  let ownsPartial = false;
  try {
    fs.mkdirSync(path.join(temp, SPACES_FOLDER), { recursive: true, mode: 0o700 });
    const directoryFile = path.join(temp, DIRECTORY_FILE);
    o.directoryDb.backupTo(directoryFile);
    const directory = stripDirectoryCopy(directoryFile, o.nowMs);
    const spaces = directory.spaces.map((space) => {
      const file = path.join(temp, SPACES_FOLDER, `${space.id}.db`);
      const schemaVersion = snapshotSpace(o.store, space, file);
      return { ...space, file: spaceFile(space.id), schemaVersion, bytes: fs.statSync(file).size, source: file };
    });
    const createdAt = new Date(o.nowMs);
    const manifest: BackupManifest = {
      format: FORMAT,
      formatVersion: FORMAT_VERSION,
      createdAt: createdAt.toISOString(),
      appVersion: APP_VERSION,
      directory: { file: DIRECTORY_FILE, schemaVersion: directory.schemaVersion },
      spaces: spaces.map(({ id, name, file, schemaVersion, bytes }) => ({ id, name, file, schemaVersion, bytes })),
    };
    const entries: TarEntry[] = [
      { name: MANIFEST_FILE, data: new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`) },
      { name: DIRECTORY_FILE, file: directoryFile },
      { name: SPACES_FOLDER },
      ...spaces.map((s) => ({ name: s.file, file: s.source })),
    ];
    fs.mkdirSync(path.dirname(path.resolve(o.target)), { recursive: true, mode: 0o700 });
    try {
      writeTar(partial, entries, { mtime: createdAt });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        throw partialExists(partial);
      }
      throw err;
    }
    ownsPartial = true;
    if (fs.existsSync(o.target)) throw new BackupError(`${o.target} already exists; choose a new file name.`);
    renameRetrying(partial, o.target);
    ownsPartial = false;
    fsyncFolder(path.dirname(path.resolve(o.target)));
    return manifest;
  } finally {
    if (ownsPartial) fs.rmSync(partial, { force: true });
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

/**
 * `backup` on a 1.x database (§3.8): its single-file snapshot (VACUUM INTO, without sessions), which
 * restore accepts. Read-only, so a 1.x server that still runs, or its -wal after a crash, is not touched.
 */
export function writeLegacyBackup(dbPath: string, target: string): void {
  if (fs.existsSync(target)) throw new BackupError(`${target} already exists; choose a new file name.`);
  const partial = `${target}.partial`;
  if (fs.existsSync(partial)) throw partialExists(partial);
  fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true, mode: 0o700 });
  try {
    const db = new DatabaseSync(sqlitePath(dbPath), { readOnly: true });
    try {
      db.exec('PRAGMA busy_timeout = 5000');
      db.prepare('VACUUM INTO ?').run(sqlitePath(partial));
    } finally {
      db.close();
    }
    stripSessions(partial);
    if (fs.existsSync(target)) throw new BackupError(`${target} already exists; choose a new file name.`);
    renameRetrying(partial, target);
  } catch (err) {
    fs.rmSync(partial, { force: true });
    throw err;
  }
  fsyncFolder(path.dirname(path.resolve(target)));
}

/**
 * The body of GET /api/admin/backup: a set written to DATA_DIR/.backup-<hex>.tar and streamed from an
 * open handle after the file is unlinked (the data stays readable, and nothing is left behind if the
 * download is aborted or the process dies; where an open file cannot be unlinked, it is removed when
 * closed).
 */
export async function backupDownload(o: Omit<WriteBackupSetOptions, 'target'>): Promise<{
  body: ReadableStream<Uint8Array>;
  size: number;
  filename: string;
}> {
  const tarFile = path.join(o.dataDir, `.backup-${randomBytes(8).toString('hex')}.tar`);
  let handle: fs.promises.FileHandle | undefined;
  let size: number;
  try {
    writeBackupSet({ ...o, target: tarFile });
    handle = await fs.promises.open(tarFile, 'r');
    size = (await handle.stat()).size;
  } catch (err) {
    await handle?.close().catch(() => undefined);
    await removeQuietly(tarFile);
    throw err;
  }
  await removeQuietly(tarFile);
  const stream = fs.createReadStream(tarFile, { fd: handle, autoClose: true });
  stream.once('close', () => void removeQuietly(tarFile));
  const day = new Date(o.nowMs).toISOString().slice(0, 10);
  return { body: Readable.toWeb(stream) as ReadableStream<Uint8Array>, size, filename: `lyren-backup-${day}.tar` };
}

async function removeQuietly(file: string): Promise<void> {
  await fs.promises.rm(file, { recursive: true, force: true }).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Reading a set (restore, §9.6)
// ---------------------------------------------------------------------------

/** A backup set that openBackupSet checked: its manifest and where each database is in the file. */
export interface BackupSetReader {
  file: string;
  manifest: BackupManifest;
  directory: TarItem;
  /** Each space's entry, by space id, in the manifest's order. */
  spaces: Map<string, TarItem>;
}

const notASet = (why: string) => new BackupError(`This is not a Lyren Plan backup set: ${why}`);

/**
 * Open the backup set `file` and check everything that can be checked without extracting it (see the
 * header). Throws BackupError: NEWER_BACKUP for a set of a newer format, else "This is not a Lyren Plan
 * backup set: <why>".
 */
export function openBackupSet(file: string): BackupSetReader {
  let items: TarItem[];
  try {
    items = listTar(file, {
      maxEntries: MAX_SPACES + 3,
      maxBytes: (name) => (name === MANIFEST_FILE ? MANIFEST_MAX_BYTES : TAR_MAX_FILE_BYTES - 1),
    });
  } catch (err) {
    if (err instanceof TarError) throw notASet(`${err.message.charAt(0).toLowerCase()}${err.message.slice(1)}`);
    throw err;
  }
  const first = items[0];
  if (!first || first.name !== MANIFEST_FILE || first.type !== 'file') throw notASet(`it does not start with ${MANIFEST_FILE}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readTarItem(file, first)));
  } catch {
    throw notASet(`${MANIFEST_FILE} is not JSON`);
  }
  const head = (parsed ?? {}) as { format?: unknown; formatVersion?: unknown };
  if (head.format !== FORMAT) throw notASet(`${MANIFEST_FILE} is not a Lyren Plan manifest`);
  if (typeof head.formatVersion === 'number' && head.formatVersion > FORMAT_VERSION) throw new BackupError(NEWER_BACKUP);
  const checked = manifestSchema.safeParse(parsed);
  if (!checked.success) throw notASet(`${MANIFEST_FILE} is not valid (${checked.error.issues[0]?.message ?? 'unknown'})`);
  const manifest = checked.data;

  // Exactly the entries the manifest names, each once.
  const expected = new Map<string, 'file' | 'dir'>([
    [MANIFEST_FILE, 'file'],
    [DIRECTORY_FILE, 'file'],
    [SPACES_FOLDER, 'dir'],
  ]);
  for (const space of manifest.spaces) {
    if (expected.has(space.file)) throw notASet(`the manifest names ${space.file} twice`);
    expected.set(space.file, 'file');
  }
  const byName = new Map<string, TarItem>();
  for (const item of items) {
    const type = expected.get(item.name);
    if (type === undefined) throw notASet(`it holds ${item.name}, which its manifest does not name`);
    if (type !== item.type) throw notASet(`${item.name} is a ${item.type === 'dir' ? 'folder' : 'file'}`);
    byName.set(item.name, item);
  }
  for (const name of expected.keys()) if (!byName.has(name)) throw notASet(`${name} is missing`);
  const directory = byName.get(DIRECTORY_FILE)!;
  const spaces = new Map<string, TarItem>();
  for (const space of manifest.spaces) {
    const item = byName.get(space.file)!;
    if (item.size !== space.bytes) throw notASet(`${space.file} does not have the size its manifest gives`);
    spaces.set(space.id, item);
  }
  for (const item of [directory, ...spaces.values()]) {
    if (!startsWithSqliteHeader(readTarItem(file, { ...item, size: Math.min(item.size, SQLITE_HEADER.length) }))) {
      throw notASet(`${item.name} is not an SQLite database`);
    }
  }
  return { file, manifest, directory, spaces };
}

/** What extractBackupSet wrote. */
export interface ExtractedBackupSet {
  /** <dir>/directory.db */
  directory: DatabaseInfo;
  /** <dir>/spaces/<id>.db, in the manifest's order. */
  spaces: Array<{ id: string; name: string; info: DatabaseInfo }>;
}

/**
 * Extract an opened set into `dir` (directory.db and spaces/<id>.db, each 0600 and flushed to the disk;
 * the folders 0700) and check every database: directory.db must be a directory, each space file that
 * space (its _meta.space_id), and none from a newer build (NEWER_BACKUP, §9.6 step 2). Throws BackupError;
 * the caller removes `dir` then.
 */
export function extractBackupSet(set: BackupSetReader, dir: string): ExtractedBackupSet {
  fs.mkdirSync(path.join(dir, SPACES_FOLDER), { recursive: true, mode: 0o700 });
  const directoryFile = path.join(dir, DIRECTORY_FILE);
  extractTarItem(set.file, set.directory, directoryFile);
  const directory = inspectDatabase(directoryFile);
  if (directory.kind !== 'directory') throw notASet(`${DIRECTORY_FILE} is not a directory database`);
  refuseNewer(directory);
  const spaces: ExtractedBackupSet['spaces'] = [];
  for (const space of set.manifest.spaces) {
    const file = path.join(dir, SPACES_FOLDER, `${space.id}.db`);
    extractTarItem(set.file, set.spaces.get(space.id)!, file);
    const info = inspectDatabase(file);
    if (info.kind !== 'space' || info.spaceId !== space.id) throw notASet(`${space.file} is not the database of space ${space.id}`);
    refuseNewer(info);
    spaces.push({ id: space.id, name: space.name, info });
  }
  fsyncFolder(path.join(dir, SPACES_FOLDER));
  fsyncFolder(dir);
  return { directory, spaces };
}
