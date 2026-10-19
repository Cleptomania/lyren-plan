// The restore of a backup on Node (design §9.6): `restore <file|->` stages it, and the next serving start
// (the server, or the desktop app once it holds its instance lock) applies it in openNodeStack, before
// anything is opened. Staging never touches the current data, so it works while the server runs; a
// running server keeps using the current data until it restarts.
//
// What can be restored, told apart by the file's bytes, never by its name:
//   a backup set (backupSet.ts)   the directory and every space: everything is replaced
//   one space's database          e.g. a pre-import or space-v<N>-before-upgrade snapshot (§8.8): only that
//                                 space, which the current directory must list and not have purged
//   an old single-file backup     a 1.x database: it becomes DB_PATH, and the legacy upgrade of that same
//                                 start (legacy.ts) turns it into a directory and a space again
// A directory file alone, data from a newer build (§9.6 step 2) and anything else are refused before
// anything is staged, and so is every restore while DB_PATH still holds a 1.x database (§3.8), or when the
// folder of DB_PATH has less free space than the staged copy needs plus 64 MiB (checkDiskSpace; the
// apply only renames).
//
// The staging folder belongs to one database, as its spaces folder does (spacesDirFor): .restore-pending
// next to lyren.db, .<file name>.restore-pending next to any other DB_PATH. Staging extracts (or, for a
// .db, copies with VACUUM INTO) into a folder of its own, .restore-<16 hex>.partial next to it:
// directory.db and spaces/<id>.db, or spaces/<id>.db alone, or legacy.db (without sign-in sessions);
// checks every database (quick_check) and marks each staged space as never synced (_meta.sync_version 0),
// so that its users mirror follows the directory again at its first request; flushes everything to the
// disk, writes READY (the database it is for, the kind, the staging time, the manifest) and only then
// renames the folder to the staging folder, so that a start sees all of a restore or none of it. A
// staging folder without READY (what an apply left once it had deleted READY) is never applied: the next
// serving start removes it, and a .partial folder a killed `restore` left is removed with the backup
// temporaries (backupSet.ts).
//
// Applying holds a lock of its own (APPLYING in the staging folder; another start at the same moment waits
// for it, then refuses), proves that nothing else has DB_PATH open (an exclusive lock, as the legacy upgrade
// takes it), checks that every staged database is there and is one this build can use (another build may
// have staged it), and notes the phase in PHASE before each one, so an interrupted apply finishes at the
// next start:
//   moving-out  what will be replaced moves to backups/before-restore-<stamp>/ (a set or an old backup:
//               DB_PATH with its -wal, -shm and -journal, and the spaces folder; one space: its file and
//               side files), never pruned;
//   moving-in   the staged files move into place;
// then READY is deleted, and with it the folder. Each move skips what an earlier attempt already did.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pipeline } from 'node:stream/promises';
import { isSpaceId } from '../../core/ids';
import { APP_VERSION } from '../../core/version';
import { snapshotStamp } from '../../db/snapshots';
import {
  BackupError,
  extractBackupSet,
  inspectDatabase,
  openBackupSet,
  refuseNewer,
  type BackupManifest,
  type BackupSetReader,
  type DatabaseInfo,
} from './backupSet';
import { fsyncFile, fsyncFolder, renameRetrying, sleepSync, SQLITE_SIDE_FILES, type RenameOptions } from './files';
import { detectLegacy, LEGACY_NOT_UPGRADED } from './legacy';
import { isBusyError, openExclusive, sqlitePath, stripSessions } from './nodeDb';
import { isDefaultDbName, sameFileName, spacesDirFor } from './spaceStore';

/** The staging folder of lyren.db (pendingFolderFor), next to it: the renames of the apply stay on one file system. */
export const PENDING_FOLDER = '.restore-pending';
const READY_FILE = 'READY';
const PHASE_FILE = 'PHASE';
const STAGED_DIRECTORY = 'directory.db';
const STAGED_SPACES = 'spaces';
const STAGED_LEGACY = 'legacy.db';
/** The apply's lock (lockApply), in the staging folder. */
const APPLY_LOCK = 'APPLYING';
const MIB = 1024 * 1024;
/** Free space a restore leaves beyond its staged copy, as the legacy upgrade does (legacy.ts). */
const DISK_MARGIN = 64 * MIB;
/** fs.rmSync's retries (only with `recursive`): Windows refuses to delete a file another program holds open. */
const RM_RETRIES = { recursive: true, maxRetries: 10, retryDelay: 100 } as const;

/**
 * The staging folder of DB_PATH, named after it as its spaces folder is: .restore-pending for lyren.db
 * (any case on Windows and macOS), .<file name>.restore-pending otherwise (two databases in one folder
 * never share a restore).
 */
export function pendingFolderFor(dbPath: string, platform: NodeJS.Platform = process.platform): string {
  const name = isDefaultDbName(dbPath, platform) ? PENDING_FOLDER : `.${path.basename(dbPath)}${PENDING_FOLDER}`;
  return path.join(path.dirname(dbPath), name);
}

/**
 * What every maintenance command says while a restore is staged for DB_PATH (§9.6); once its apply has
 * begun (PHASE exists) the folder must not be deleted any more, since part of the current data may have
 * moved out already.
 */
export function restoreWaitingMessage(dbPath: string): string {
  const pending = pendingFolderFor(dbPath);
  if (!fs.existsSync(path.join(pending, PHASE_FILE))) {
    return `A restore is waiting: restart Lyren Plan to complete it, or delete ${pending} to cancel it.`;
  }
  return (
    `A restore was interrupted while it was being applied: start Lyren Plan to finish it. Do not delete ${pending}; ` +
    `the data it replaces is in ${beforeRestoreOf(stampIn(pending))}/.`
  );
}

/** §9.6 step 5: the server could not prove that it is the only user of the data. */
export const STILL_RUNNING = 'Lyren Plan is still running with this data folder. Stop it, then start it again to complete the restore.';

/** A new-format directory file on its own (§9.6 step 1). */
export const DIRECTORY_ONLY = 'This is only the directory of a backup; restore the .tar backup set';

/** One space's database whose space the current directory does not list (or has purged). */
export const SPACE_GONE = 'This space no longer exists here';

/**
 * What `restore` prints once a restore is staged, by audience (§9.6 step 4); the server's second sentence
 * only when there is current data to move out.
 */
export function restoreNextStep(audience: 'server' | 'desktop', staged: Pick<StagedRestore, 'stamp' | 'movesOut'>): string {
  if (audience === 'desktop') return 'Quit Lyren Plan and start it again to complete the restore.';
  const next = 'Restart Lyren Plan to complete the restore (systemctl restart lyren-plan, or docker restart lyren-plan).';
  return staged.movesOut ? `${next} The current data will be moved to backups/before-restore-${staged.stamp}/.` : next;
}

/** The file cannot be restored here (see the message); nothing was staged or changed. */
export class RestoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RestoreError';
  }
}

/** A staged restore cannot be applied now (see the message); the data is unchanged where the apply had not begun. */
export class RestoreStopped extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RestoreStopped';
  }
}

export type RestoreKind = 'set' | 'space' | 'legacy';

/** READY: what is staged. */
interface ReadyFile {
  /** The file name of the DB_PATH it was staged for. */
  dbName: string;
  /** The build that staged it. */
  appVersion: string;
  kind: RestoreKind;
  stagedAt: string;
  /** The name of the folder the replaced data moves to: backups/before-restore-<stamp>/. */
  stamp: string;
  /** A set's manifest. */
  manifest?: BackupManifest;
  /** One space's id and name. */
  space?: { id: string; name: string };
}

type Phase = 'moving-out' | 'moving-in';

const STAMP_RE = /^[0-9TZ-]+$/;

/** Whether a restore is staged for DB_PATH: its staging folder holds READY. */
export function isRestorePending(dbPath: string): boolean {
  return fs.existsSync(path.join(pendingFolderFor(dbPath), READY_FILE));
}

/** backups/before-restore-<stamp>, relative to the data folder (backups/ when the stamp is unknown). */
const beforeRestoreOf = (stamp: string | null) => (stamp === null ? 'backups' : path.join('backups', `before-restore-${stamp}`));

/** The stamp in a staging folder's READY, or null when it cannot be read. */
function stampIn(pending: string): string | null {
  try {
    const stamp: unknown = (JSON.parse(fs.readFileSync(path.join(pending, READY_FILE), 'utf8')) as { stamp?: unknown }).stamp;
    return typeof stamp === 'string' && STAMP_RE.test(stamp) ? stamp : null;
  } catch {
    return null;
  }
}

/** What a restore holds, for the messages ("Staged the restore of …", the apply's log line). */
function describe(ready: Pick<ReadyFile, 'kind' | 'manifest' | 'space'>): string {
  if (ready.kind === 'set') {
    const n = ready.manifest!.spaces.length;
    return `the backup set made ${ready.manifest!.createdAt} (${n} space${n === 1 ? '' : 's'})`;
  }
  if (ready.kind === 'space') return `the space ${ready.space!.name} (${ready.space!.id})`;
  return 'an old single-file backup (Lyren Plan 1.x)';
}

/** A database file, or any of its -wal, -shm and -journal, exists. */
const anyDatabaseFile = (file: string) => ['', ...SQLITE_SIDE_FILES].some((suffix) => fs.existsSync(`${file}${suffix}`));

/** Write `data` to `dir/name` atomically (a temporary file, flushed, renamed; retried on Windows). */
function writeAtomically(dir: string, name: string, data: string): void {
  const temp = path.join(dir, `${name}.partial`);
  fs.writeFileSync(temp, data, { mode: 0o600 });
  fsyncFile(temp);
  renameRetrying(temp, path.join(dir, name));
  fsyncFolder(dir);
}

/** Remove a staging folder that is never applied (no READY); when that fails, the next start tries again. */
function removeUnready(pending: string, log: (line: string) => void): void {
  try {
    fs.rmSync(pending, { ...RM_RETRIES, force: true });
  } catch (err) {
    // Windows: another program (a virus scanner) still holds a file in it open.
    log(`Could not remove ${pending} (${(err as NodeJS.ErrnoException).code ?? (err as Error).message}); the next start removes it.`);
  }
}

// ---------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------

/** The ustar magic at offset 257 (POSIX "ustar\0", GNU "ustar "); openBackupSet checks the rest. */
function looksLikeTar(file: string): boolean {
  const head = new Uint8Array(263);
  const fd = fs.openSync(file, 'r');
  try {
    if (fs.readSync(fd, head, 0, head.length, 0) < head.length) return false;
  } finally {
    fs.closeSync(fd);
  }
  return Buffer.from(head.subarray(257, 262)).toString('latin1') === 'ustar';
}

/** A database from a backup, opened read-only without trusting its schema (it may come from anywhere). */
function openUntrusted(file: string): DatabaseSync {
  const db = new DatabaseSync(sqlitePath(file), { readOnly: true });
  try {
    db.exec('PRAGMA trusted_schema = OFF');
    db.exec('PRAGMA busy_timeout = 5000');
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

const damaged = (what: string, why: string) => new RestoreError(`${what} is damaged (${why}); nothing was staged.`);

/** SQLite found the file damaged (SQLITE_CORRUPT) or no database (SQLITE_NOTADB). */
const isDamageError = (err: unknown) => [11, 26].includes((err as { errcode?: number }).errcode ?? 0);

/** A staged database must be intact: a damaged one would only be found once the current data had moved out. */
function checkIntact(file: string, what: string): void {
  let result: string;
  try {
    const db = openUntrusted(file);
    try {
      result = (db.prepare('PRAGMA quick_check(1)').get() as { quick_check: string }).quick_check;
    } finally {
      db.close();
    }
  } catch (err) {
    result = (err as Error).message;
  }
  if (result !== 'ok') throw damaged(what, result);
}

/** A consistent copy of the database `from` (with its -wal) in the new file `to` (0600), flushed to the disk. */
function copyDatabase(from: string, to: string, what: string): void {
  fs.closeSync(fs.openSync(to, 'wx', 0o600));
  const db = openUntrusted(from);
  try {
    db.prepare('VACUUM INTO ?').run(sqlitePath(to));
  } catch (err) {
    if (isDamageError(err)) throw damaged(what, (err as Error).message);
    throw err;
  } finally {
    db.close();
  }
  fsyncFile(to);
}

/**
 * Mark a staged space as never synced: its users mirror is then pulled from the directory at its first
 * request (§3.5), whichever sync_version the directory it is restored next to has reached. One file
 * (journal_mode DELETE), so the move into place takes everything.
 */
function markUnsynced(file: string): void {
  const db = new DatabaseSync(sqlitePath(file));
  try {
    db.exec('PRAGMA trusted_schema = OFF');
    db.exec('PRAGMA journal_mode = DELETE');
    db.prepare("UPDATE _meta SET value = '0' WHERE key = 'sync_version'").run();
  } finally {
    db.close();
  }
  fsyncFile(file);
}

/** DB_PATH holds a 1.x database (§3.8). One that cannot be read (being restored because it is damaged) does not. */
function holdsLegacyDatabase(dbPath: string): boolean {
  try {
    return detectLegacy(dbPath).kind === 'legacy';
  } catch {
    return false;
  }
}

/** The space the current directory lists under `spaceId` and has not purged (nor is about to), or null. */
function currentSpace(dbPath: string, spaceId: string, nowMs: number): { name: string } | null {
  if (!fs.existsSync(dbPath) || detectLegacy(dbPath).kind === 'newer') return null;
  const db = new DatabaseSync(sqlitePath(dbPath), { readOnly: true });
  let row: { name: string; purge_after: string | null } | undefined;
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const hasSpaces = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'spaces'").get() !== undefined;
    row = hasSpaces
      ? (db.prepare('SELECT name, purge_after FROM spaces WHERE public_id = ?').get(spaceId) as typeof row)
      : undefined;
  } finally {
    db.close();
  }
  // Past its grace period the space can no longer be restored (Appendix D 20): maintenance purges it.
  if (!row || (row.purge_after !== null && row.purge_after <= new Date(nowMs).toISOString())) return null;
  return { name: row.name };
}

/** fsyncFolder, for a folder that may not exist (nothing moved into it). */
function fsyncIfThere(dir: string): void {
  if (fs.existsSync(dir)) fsyncFolder(dir);
}

/**
 * The finished staging folder becomes DB_PATH's staging folder, READY and all, in one rename: a start
 * sees all of the restore or none of it. A restore staged meanwhile by another `restore` wins.
 */
function publish(staging: string, dbPath: string): void {
  const pending = pendingFolderFor(dbPath);
  const waiting = () => new RestoreError(restoreWaitingMessage(dbPath));
  if (fs.existsSync(pending)) {
    if (isRestorePending(dbPath)) throw waiting();
    // What an apply left once it had deleted READY: never applied again.
    fs.rmSync(pending, { ...RM_RETRIES, force: true });
  }
  try {
    renameRetrying(staging, pending);
  } catch (err) {
    if (isRestorePending(dbPath)) throw waiting();
    throw err;
  }
  fsyncFolder(path.dirname(pending));
}

export interface StageRestoreOptions {
  /** DB_PATH: the directory file; its staging folder goes next to it (pendingFolderFor). */
  dbPath: string;
  /** The file to restore. */
  source: string;
  /** `source` is copyToTemp's copy of standard input: the messages say so instead of naming the copy. */
  stdin?: boolean;
  nowMs: number;
  /** The free space of the folder of DB_PATH (default fs.statfsSync; tests). */
  statfs?: (folder: string) => { bavail: number | bigint; bsize: number | bigint };
}

export interface StagedRestore {
  kind: RestoreKind;
  /** "the backup set made … (2 spaces)", "the space … (<id>)", "an old single-file backup (Lyren Plan 1.x)". */
  description: string;
  /** backups/before-restore-<stamp>/ */
  stamp: string;
  /** There is current data that the apply will move to backups/before-restore-<stamp>/. */
  movesOut: boolean;
}

/** Stage `source` for the next serving start (see the header). Throws RestoreError (or BackupError) with the reason. */
export function stageRestore(o: StageRestoreOptions): StagedRestore {
  if (isRestorePending(o.dbPath)) throw new RestoreError(restoreWaitingMessage(o.dbPath));
  if (holdsLegacyDatabase(o.dbPath)) throw new RestoreError(LEGACY_NOT_UPGRADED);
  const stamp = snapshotStamp(new Date(o.nowMs));
  const ready: ReadyFile = {
    dbName: path.basename(o.dbPath),
    appVersion: APP_VERSION,
    kind: 'legacy',
    stagedAt: new Date(o.nowMs).toISOString(),
    stamp,
  };
  const notABackup = () =>
    new RestoreError(
      `${o.stdin ? 'Standard input' : o.source} is not a Lyren Plan backup: a backup set (.tar), a space's database or an old single-file backup (.db).`,
    );
  const fileName = o.stdin ? 'The backup from standard input' : `The backup's ${path.basename(o.source)}`;

  // Step 1, the kind, and step 2, the versions: both before anything is written.
  let set: BackupSetReader | null = null;
  if (looksLikeTar(o.source)) {
    set = openBackupSet(o.source);
    ready.kind = 'set';
    ready.manifest = set.manifest;
  } else {
    const info = inspectDatabase(o.source);
    if (info.kind === 'directory') throw new RestoreError(DIRECTORY_ONLY);
    if (info.kind === null || (info.kind === 'space' && !isSpaceId(info.spaceId))) throw notABackup();
    refuseNewer(info);
    if (info.kind === 'space') {
      const space = currentSpace(o.dbPath, info.spaceId!, o.nowMs);
      if (!space) throw new RestoreError(SPACE_GONE);
      ready.kind = 'space';
      ready.space = { id: info.spaceId!, name: space.name };
    }
  }

  // Room for what step 3 copies: the set's files as they are in the archive, or the database with its -wal
  // (VACUUM INTO writes what both hold).
  const size = (file: string) => fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0;
  const bytes = set
    ? set.directory.size + [...set.spaces.values()].reduce((sum, item) => sum + item.size, 0)
    : size(o.source) + size(`${o.source}-wal`);
  checkDiskSpace(path.dirname(o.dbPath), bytes, o.statfs ?? fs.statfsSync);

  // Step 3, in a folder of its own (see the header).
  const staging = path.join(path.dirname(o.dbPath), `.restore-${randomBytes(8).toString('hex')}.partial`);
  fs.mkdirSync(path.join(staging, STAGED_SPACES), { recursive: true, mode: 0o700 });
  try {
    if (set) {
      const extracted = extractBackupSet(set, staging);
      checkIntact(path.join(staging, STAGED_DIRECTORY), `The backup's ${STAGED_DIRECTORY}`);
      for (const space of extracted.spaces) {
        const file = path.join(staging, STAGED_SPACES, `${space.id}.db`);
        checkIntact(file, `The backup's spaces/${space.id}.db`);
        markUnsynced(file);
      }
    } else if (ready.kind === 'space') {
      const file = path.join(staging, STAGED_SPACES, `${ready.space!.id}.db`);
      copyDatabase(o.source, file, fileName);
      checkIntact(file, fileName);
      // The copy, read again: VACUUM INTO took the file as it was then.
      const copied = inspectDatabase(file);
      if (copied.kind !== 'space' || copied.spaceId !== ready.space!.id) throw notABackup();
      refuseNewer(copied);
      markUnsynced(file);
    } else {
      const file = path.join(staging, STAGED_LEGACY);
      copyDatabase(o.source, file, fileName);
      checkIntact(file, fileName);
      const copied = inspectDatabase(file);
      if (copied.kind !== 'legacy') throw notABackup();
      refuseNewer(copied);
      // A 1.x file (a before-upgrade snapshot, a copy) may hold sign-in sessions, revoked ones too, which the
      // upgrade would carry over: a restore never brings back bearer tokens (§9.5).
      stripSessions(file);
      fsyncFile(file);
    }
    fsyncFolder(path.join(staging, STAGED_SPACES));
    fsyncFolder(staging);
    writeAtomically(staging, READY_FILE, `${JSON.stringify(ready, null, 2)}\n`);
    publish(staging, o.dbPath);
  } catch (err) {
    try {
      fs.rmSync(staging, { ...RM_RETRIES, force: true });
    } catch {
      // Removed with the backup temporaries at the next serving start.
    }
    throw err;
  }
  const spacesDir = spacesDirFor(o.dbPath);
  const movesOut =
    ready.kind === 'space'
      ? anyDatabaseFile(path.join(spacesDir, `${ready.space!.id}.db`))
      : anyDatabaseFile(o.dbPath) || fs.existsSync(spacesDir);
  return { kind: ready.kind, description: describe(ready), stamp, movesOut };
}

/** Refuses, before anything is written, a restore whose staged copy would not fit in `folder` with DISK_MARGIN to spare. */
function checkDiskSpace(folder: string, bytes: number, statfs: NonNullable<StageRestoreOptions['statfs']>): void {
  const needed = bytes + DISK_MARGIN;
  // On a new server the folder is made by the staging: its file system is that of the nearest folder above.
  let existing = folder;
  while (!fs.existsSync(existing) && path.dirname(existing) !== existing) existing = path.dirname(existing);
  const stats = statfs(existing);
  const free = Number(stats.bavail) * Number(stats.bsize);
  if (free < needed) {
    throw new RestoreError(
      `Not enough free disk space to restore this backup: about ${Math.ceil(needed / MIB)} MB are needed in ${folder}, ` +
        `${Math.floor(free / MIB)} MB are free. Nothing was staged.`,
    );
  }
}

/**
 * `restore -`: standard input copied into a new file in `dataFolder` (0600), for a backup the service
 * user cannot read itself (`sudo cat … | sudo -u lyren … restore -`). The caller removes it.
 */
export async function copyToTemp(input: NodeJS.ReadableStream, dataFolder: string): Promise<string> {
  fs.mkdirSync(dataFolder, { recursive: true, mode: 0o700 });
  const file = path.join(dataFolder, `.restore-${randomBytes(8).toString('hex')}.in`);
  try {
    await pipeline(input, fs.createWriteStream(file, { flags: 'wx', mode: 0o600 }));
  } catch (err) {
    fs.rmSync(file, { force: true });
    throw err;
  }
  return file;
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

/** The points after which tests make an apply stop, as a crash would (ApplyRestoreHooks.afterStep). */
export type RestoreStep = 'lock' | `phase:${Phase}` | `out:${string}` | `in:${string}` | 'ready-removed';

export interface ApplyRestoreHooks {
  /** How long each exclusive lock (the apply's, DB_PATH's) waits for another connection to let go (default 5000 ms). */
  busyTimeoutMs?: number;
  rename?: RenameOptions['rename'];
  /** Called after each step; a test throws here to simulate a crash. */
  afterStep?: (step: RestoreStep) => void;
  /** The log line (default console.log). */
  log?: (line: string) => void;
}

export interface AppliedRestore {
  kind: RestoreKind;
  /** backups/before-restore-<stamp>, relative to the data folder; null when nothing had to move out. */
  movedOut: string | null;
}

function readReady(pending: string, dbPath: string): ReadyFile {
  let ready: ReadyFile | null = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(pending, READY_FILE), 'utf8')) as ReadyFile;
    const known =
      parsed.kind === 'set' ? parsed.manifest !== undefined : parsed.kind === 'space' ? isSpaceId(parsed.space?.id) : parsed.kind === 'legacy';
    if (known && typeof parsed.dbName === 'string' && STAMP_RE.test(parsed.stamp)) ready = parsed;
  } catch {
    // Reported below.
  }
  if (ready === null) throw new RestoreStopped(`The staged restore in ${pending} cannot be read. Delete that folder, then run restore again.`);
  if (!sameFileName(ready.dbName, path.basename(dbPath))) {
    throw new RestoreStopped(
      `The staged restore in ${pending} was staged for ${ready.dbName}, not ${path.basename(dbPath)}. Delete that folder, then run restore again.`,
    );
  }
  return ready;
}

function readPhase(pending: string): Phase {
  try {
    const phase = fs.readFileSync(path.join(pending, PHASE_FILE), 'utf8').trim();
    if (phase === 'moving-in') return phase;
  } catch {
    // No PHASE yet: the apply begins.
  }
  return 'moving-out';
}

/** inspectDatabase, or null when the file is not there (any more). */
function inspectIfThere(file: string): DatabaseInfo | null {
  try {
    return inspectDatabase(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Before anything moves out (§9.6 step 2 at the apply): every staged database is there, is what READY
 * says, and is one this build can use. Staging checked all of that, but the folder may have lost files
 * since, or have been staged by a newer build (a newer image or desktop app, followed by a start of this
 * one). `begun` is the before-restore folder when an earlier attempt may already have moved data out.
 */
function checkStaged(pending: string, ready: ReadyFile, begun: string | null): void {
  const expected: Array<{ file: string; kind: DatabaseInfo['kind']; spaceId: string | null }> =
    ready.kind === 'set'
      ? [
          { file: path.join(pending, STAGED_DIRECTORY), kind: 'directory', spaceId: null },
          ...ready.manifest!.spaces.map((s) => ({ file: path.join(pending, STAGED_SPACES, `${s.id}.db`), kind: 'space' as const, spaceId: s.id })),
        ]
      : ready.kind === 'space'
        ? [{ file: path.join(pending, STAGED_SPACES, `${ready.space!.id}.db`), kind: 'space', spaceId: ready.space!.id }]
        : [{ file: path.join(pending, STAGED_LEGACY), kind: 'legacy', spaceId: null }];
  let newer = false;
  for (const e of expected) {
    const info = inspectIfThere(e.file);
    if (info === null || info.kind !== e.kind || info.spaceId !== e.spaceId) {
      // Gone because another start is applying the restore right now (it began meanwhile, or is moving in).
      const applying =
        !fs.existsSync(path.join(pending, READY_FILE)) ||
        fs.existsSync(path.join(pending, PHASE_FILE)) !== (begun !== null) ||
        readPhase(pending) === 'moving-in';
      if (applying) throw new RestoreStopped(STILL_RUNNING);
      throw new RestoreStopped(
        begun === null
          ? `The staged restore in ${pending} is incomplete. Delete that folder, then run restore again.`
          : `The staged restore in ${pending} is incomplete, and the data it replaces is in ${begun}/ already. ` +
              'Move that data back, delete the folder, then start Lyren Plan again.',
      );
    }
    newer ||= info.newer;
  }
  if (newer) {
    throw new RestoreStopped(
      `The staged restore in ${pending} was made by a newer version of Lyren Plan. Install that version, or a newer one, ` +
        (begun === null ? 'to complete it, or delete that folder to cancel it.' : `to complete it; the data it replaces is in ${begun}/.`),
    );
  }
}

/**
 * Prove that nothing else has DB_PATH open (§9.6 step 5): an exclusive lock, released at once. A file that
 * SQLite cannot read as a database (being restored because it is damaged, say) nobody can be using either.
 * A file that another start moved away or replaced meanwhile means that it is applying the restore.
 */
function proveExclusive(dbPath: string, busyTimeoutMs: number): void {
  if (!fs.existsSync(dbPath)) return;
  let lock: ReturnType<typeof openExclusive>;
  try {
    lock = openExclusive(dbPath, busyTimeoutMs);
  } catch (err) {
    if (isBusyError(err)) throw new RestoreStopped(STILL_RUNNING);
    const code = (err as { errcode?: number }).errcode;
    if (code === 11 || code === 26) return; // SQLITE_CORRUPT, SQLITE_NOTADB
    throw err;
  }
  if (!lock) throw new RestoreStopped(STILL_RUNNING);
  lock.close();
}

/**
 * The apply's own lock, held until it is closed: an exclusive lock on the SQLite file APPLYING in the staging
 * folder, which the system lets go of when the process ends. proveExclusive's lock cannot be held across the
 * moves (DB_PATH is one of them), so without this one two starts at once could both apply, the later one
 * moving out what the first had just moved in. Tried every 50 ms for busyTimeoutMs, as openExclusive does (two
 * first attempts at the same moment can both fail): 'busy' while another start still holds it then; 'gone'
 * when the folder is (another start has applied the restore).
 */
function lockApply(pending: string, busyTimeoutMs: number): DatabaseSync | 'busy' | 'gone' {
  const deadline = Date.now() + busyTimeoutMs;
  for (;;) {
    const lock = tryLockApply(pending);
    if (lock !== 'busy' || Date.now() >= deadline) return lock;
    sleepSync(50);
  }
}

/** One attempt of lockApply. */
function tryLockApply(pending: string): DatabaseSync | 'busy' | 'gone' {
  let lock: DatabaseSync;
  try {
    lock = new DatabaseSync(sqlitePath(path.join(pending, APPLY_LOCK)));
  } catch (err) {
    if (!fs.existsSync(pending)) return 'gone';
    throw err;
  }
  try {
    lock.exec('PRAGMA locking_mode = EXCLUSIVE');
    lock.exec('BEGIN EXCLUSIVE');
    lock.exec('COMMIT');
  } catch (err) {
    lock.close();
    if (isBusyError(err)) return 'busy';
    throw err;
  }
  return lock;
}

/** One move of the apply: `from` → `to` unless `from` is gone (done before). Never replaces anything. */
function move(from: string, to: string, rename: RenameOptions): void {
  if (!fs.existsSync(from)) return;
  if (fs.existsSync(to)) {
    throw new RestoreStopped(`${to} is in the way of the restore. Move it elsewhere, then start Lyren Plan again.`);
  }
  fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
  renameRetrying(from, to, rename);
}

export interface ApplyRestoreOptions {
  /** DB_PATH: the directory file. */
  dbPath: string;
  hooks?: ApplyRestoreHooks;
}

/** Apply the staged restore (see the header), or null when none is staged. Throws RestoreStopped when it cannot now. */
export function applyPendingRestore(o: ApplyRestoreOptions): AppliedRestore | null {
  const log = o.hooks?.log ?? ((line: string) => console.log(line));
  const pending = pendingFolderFor(o.dbPath);
  if (!fs.existsSync(path.join(pending, READY_FILE))) {
    // The end of an apply that was interrupted once it had deleted READY: never applied again.
    if (fs.existsSync(pending)) removeUnready(pending, log);
    return null;
  }
  const lock = lockApply(pending, o.hooks?.busyTimeoutMs ?? 5000);
  if (lock === 'busy') throw new RestoreStopped(STILL_RUNNING);
  if (lock === 'gone') return null;
  let applied: (AppliedRestore & { line: string }) | null;
  try {
    // A start that held the lock until a moment ago has applied it (it deletes READY first).
    applied = fs.existsSync(path.join(pending, READY_FILE)) ? applyLocked(o, pending) : null;
  } finally {
    lock.close();
  }
  // READY is gone, so whatever of the folder is left is never applied again (the lock is let go of first:
  // Windows deletes no file that is open).
  removeUnready(pending, log);
  if (applied === null) return null;
  log(applied.line);
  return { kind: applied.kind, movedOut: applied.movedOut };
}

/** applyPendingRestore under the apply's lock, up to the deletion of READY; with its log line. */
function applyLocked(o: ApplyRestoreOptions, pending: string): AppliedRestore & { line: string } {
  const { dbPath } = o;
  const hooks = o.hooks ?? {};
  const afterStep = hooks.afterStep ?? (() => undefined);
  const rename: RenameOptions = hooks.rename ? { rename: hooks.rename } : {};
  const dataFolder = path.dirname(dbPath);
  const ready = readReady(pending, dbPath);

  proveExclusive(dbPath, hooks.busyTimeoutMs ?? 5000);
  afterStep('lock');

  const spacesDir = spacesDirFor(dbPath);
  const movedOut = beforeRestoreOf(ready.stamp);
  const before = path.join(dataFolder, movedOut);
  const outs: Array<[string, string]> = [];
  const ins: Array<[string, string]> = [];
  if (ready.kind === 'space') {
    const name = `${ready.space!.id}.db`;
    for (const suffix of ['', ...SQLITE_SIDE_FILES]) {
      outs.push([path.join(spacesDir, `${name}${suffix}`), path.join(before, path.basename(spacesDir), `${name}${suffix}`)]);
    }
    ins.push([path.join(pending, STAGED_SPACES, name), path.join(spacesDir, name)]);
  } else {
    for (const suffix of ['', ...SQLITE_SIDE_FILES]) outs.push([`${dbPath}${suffix}`, path.join(before, `${path.basename(dbPath)}${suffix}`)]);
    outs.push([spacesDir, path.join(before, path.basename(spacesDir))]);
    if (ready.kind === 'set') {
      ins.push([path.join(pending, STAGED_DIRECTORY), dbPath], [path.join(pending, STAGED_SPACES), spacesDir]);
    } else {
      ins.push([path.join(pending, STAGED_LEGACY), dbPath]);
    }
  }

  if (readPhase(pending) === 'moving-out') {
    checkStaged(pending, ready, fs.existsSync(path.join(pending, PHASE_FILE)) ? movedOut : null);
    writeAtomically(pending, PHASE_FILE, 'moving-out\n');
    afterStep('phase:moving-out');
    for (const [from, to] of outs) {
      move(from, to, rename);
      afterStep(`out:${path.basename(from)}`);
    }
    fsyncIfThere(path.join(before, path.basename(spacesDir)));
    fsyncIfThere(before);
    fsyncIfThere(spacesDir);
    fsyncFolder(dataFolder);
    writeAtomically(pending, PHASE_FILE, 'moving-in\n');
    afterStep('phase:moving-in');
  }
  for (const [from, to] of ins) {
    move(from, to, rename);
    afterStep(`in:${path.basename(from)}`);
  }
  fsyncIfThere(spacesDir);
  fsyncFolder(dataFolder);
  const anyMovedOut = fs.existsSync(before);

  // READY first: a folder without it is never applied again, whatever of it is left.
  fs.rmSync(path.join(pending, READY_FILE), RM_RETRIES);
  fsyncFolder(pending);
  afterStep('ready-removed');

  return {
    kind: ready.kind,
    movedOut: anyMovedOut ? movedOut : null,
    line: `Restored ${describe(ready)}.${anyMovedOut ? ` The data it replaced was moved to ${movedOut}/.` : ''}`,
  };
}
