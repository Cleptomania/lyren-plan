// The space databases on Node (design §3.1, §9.2, §9.3): one SQLite file per space, <spacesDir>/<id>.db,
// opened when a request (or the directory) needs it and kept open as a SpaceHost in an LRU of at most
// SPACES_OPEN_MAX. A path is only ever built from an id that passes isSpaceId.
//
// Opening a file migrates it (a space-v<N>-before-upgrade snapshot first when it is older, §9.5), sets
// user_version = 100 (§3.1), checks that _meta.space_id names this space, and marks its write generation
// `reopened` (Appendix D 14). An empty file (an interrupted init) is not a space: it is left alone and
// answers as missing, as an uninitialized Durable Object does. The least recently used host is closed
// once its requests have ended (a request for it meanwhile takes it back: a file never has two hosts,
// each with its own write generation); closeIdle closes hosts idle for 10 minutes. Every host shares the
// process-wide import gate (one import parse at a time, §8.4) and gets its own write state.
//
// A file this process cannot open or write (its owner or mode, a read-only disk) answers 503, and the log
// says once what to change (startupErrors.ts#dbOpenFailureMessage) instead of a stack trace per request.
//
// Files: the spaces folder 0700, each file 0600 (its -wal and -shm get the same mode from SQLite);
// pre-import and pre-upgrade snapshots go to backups/spaces/<id>/ next to the directory file (§8.8,
// §9.5). With dir ':memory:' (tests) every space lives in memory until destroy or closeAll; its
// snapshots are still written to backups/.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SpaceAppConfig } from '../../core/config';
import { SPACE_ID_RE, isSpaceId } from '../../core/ids';
import { migrate, readSchemaState } from '../../core/migrate';
import type { SpaceAdminClient, SpaceDirectoryPort, SpaceInit } from '../../core/ports';
import { systemClock, type Clock, type RuntimeInfo } from '../../core/runtime';
import { APP_VERSION } from '../../core/version';
import { writeSnapshot } from '../../db/snapshots';
import type { Deps } from '../../env';
import { unavailable } from '../../http/errors';
import { createSpaceHost, type SpaceHost } from '../../space/host';
import { createImportGate } from '../../space/importGate';
import { initSpaceDb, storedSpaceId } from '../../space/init';
import { restoreCommand, type SpaceSafety } from '../../space/safety';
import { SPACE_MIGRATIONS } from '../../space/schema';
import { createWriteState } from '../../space/writeState';
import { dbOpenFailureMessage, isDbAccessError, type Audience } from '../../startupErrors';
import { NodeDb, sqlitePath } from './nodeDb';

/** What builds from before the multi-user split read as "newer than this build" (§3.1). */
export const NEW_FORMAT_USER_VERSION = 100;

const DEFAULT_DB_NAME = 'lyren.db';
const IDLE_MS = 10 * 60_000;
/** A space's file name in the spaces folder, <id>.db; the id is the first group. */
export const SPACE_FILE_RE = new RegExp(`^(${SPACE_ID_RE.source.slice(1, -1)})\\.db$`);

/** Whether two file names in one folder name the same file (Windows and macOS compare them without case). */
export function sameFileName(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' || platform === 'darwin' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Whether DB_PATH is the usual lyren.db (the rule of desktop/files.ts). */
export function isDefaultDbName(dbPath: string, platform: NodeJS.Platform = process.platform): boolean {
  return sameFileName(path.basename(dbPath), DEFAULT_DB_NAME, platform);
}

/**
 * The spaces folder of a directory file (§3.1): <folder>/spaces for lyren.db (any case on Windows and
 * macOS), else <folder>/<file name>.spaces (work.db → work.db.spaces). Derived from DB_PATH alone, so a
 * maintenance command with the same DB_PATH always finds it.
 */
export function spacesDirFor(dbPath: string, platform: NodeJS.Platform = process.platform): string {
  const name = path.basename(dbPath);
  return path.join(path.dirname(dbPath), isDefaultDbName(dbPath, platform) ? 'spaces' : `${name}.spaces`);
}

/** The database's size in bytes (SPACE_MAX_BYTES). */
function databaseBytes(db: NodeDb): number {
  const row = db.raw.prepare('SELECT page_count * page_size AS n FROM pragma_page_count(), pragma_page_size()').get() as { n: number };
  return Number(row.n);
}

export interface NodeSpaceStoreOptions {
  /** <spacesDir> (spacesDirFor), or ':memory:'. */
  dir: string;
  /** The directory file's folder: snapshots go to its backups/, and safety points are relative to it. */
  dataDir: string;
  directory: SpaceDirectoryPort;
  config: SpaceAppConfig;
  runtime: RuntimeInfo;
  /** SPACES_OPEN_MAX. */
  maxOpen: number;
  /** Hosts idle this long are closed by closeIdle (default 10 minutes). */
  idleMs?: number;
  clock?: Clock;
  /** Who reads the log's explanation of a file that cannot be opened (default 'server'). */
  audience?: Audience;
}

interface OpenSpace {
  id: string;
  db: NodeDb;
  host: SpaceHost;
  /** clock ms of the last request. */
  lastUsed: number;
}

export class NodeSpaceStore implements SpaceAdminClient {
  readonly dir: string;
  private readonly memory: Map<string, NodeDb> | null;
  /** Open spaces, least recently used first. */
  private readonly open = new Map<string, OpenSpace>();
  /** Spaces the LRU let go that still serve requests: closed when their last one ends. */
  private readonly draining = new Set<OpenSpace>();
  /** One import parse at a time in this process (§8.4); a second one is refused (503). */
  private readonly importGate = createImportGate('Another import is running. Try again in a minute.');
  private readonly clock: Clock;
  private readonly idleMs: number;
  /** Spaces whose file could not be opened, explained in the log already (until it opens again). */
  private readonly unopenable = new Set<string>();

  constructor(private readonly o: NodeSpaceStoreOptions) {
    this.dir = o.dir;
    this.memory = o.dir === ':memory:' ? new Map() : null;
    this.clock = o.clock ?? systemClock;
    this.idleMs = o.idleMs ?? IDLE_MS;
  }

  /** The file of a space (never built from anything but a valid id). */
  file(spaceId: string): string {
    if (!isSpaceId(spaceId)) throw new Error(`Not a space id: ${JSON.stringify(spaceId)}`);
    return this.memory ? ':memory:' : path.join(this.dir, `${spaceId}.db`);
  }

  /**
   * The space's host for one request, opened when needed; null when the space has no database. Call
   * `release()` when the request has ended.
   */
  acquire(spaceId: string): { host: SpaceHost; release(): void } | null {
    const space = this.get(spaceId);
    if (!space) return null;
    return {
      host: space.host,
      release: () => {
        space.lastUsed = this.clock.now();
        // Called once the response exists: safe because no space route streams its body from the database.
        if (this.draining.has(space) && space.host.activeRequests === 0) {
          this.draining.delete(space);
          this.closeDb(space);
        }
      },
    };
  }

  /** The space's database (opened when needed), or null when it has none. For maintenance and tests. */
  database(spaceId: string): NodeDb | null {
    return this.get(spaceId)?.db ?? null;
  }

  /**
   * A consistent copy of the space's database in the new file `target` (VACUUM INTO, §9.5); false when
   * the space has no file. Through a connection of its own that writes nothing: the CLI's `backup` runs
   * beside a server that serves the space, and must not open a host (which moves the write generation).
   */
  snapshot(spaceId: string, target: string): boolean {
    if (this.memory) {
      const db = this.memory.get(spaceId);
      db?.backupTo(target);
      return db !== undefined;
    }
    const file = this.file(spaceId);
    if (!fs.existsSync(file)) return false;
    // Read-write, though it only reads: a read-only connection would leave an empty -wal and -shm behind.
    const db = new DatabaseSync(sqlitePath(file));
    try {
      db.exec('PRAGMA busy_timeout = 5000');
      db.prepare('VACUUM INTO ?').run(sqlitePath(target));
    } finally {
      db.close();
    }
    return true;
  }

  async init(init: SpaceInit): Promise<void> {
    const id = init.spaceId;
    const cached = this.cached(id);
    if (cached) {
      initSpaceDb(cached.db, init);
      return;
    }
    let db: NodeDb | null = null;
    try {
      db = this.openDb(id, true)!;
      this.migrateSpace(id, db);
      initSpaceDb(db, init);
      this.register(id, db);
    } catch (err) {
      if (db) this.discard(db);
      throw this.openFailure(id, err);
    }
  }

  async invalidate(spaceId: string): Promise<void> {
    this.open.get(spaceId)?.host.invalidate();
    for (const evicted of this.draining) if (evicted.id === spaceId) evicted.host.invalidate();
  }

  async destroy(spaceId: string): Promise<void> {
    if (!isSpaceId(spaceId)) return;
    const space = this.open.get(spaceId);
    if (space) {
      this.open.delete(spaceId);
      this.closeDb(space);
    }
    for (const evicted of this.draining) {
      if (evicted.id !== spaceId) continue;
      this.draining.delete(evicted);
      this.closeDb(evicted);
    }
    if (this.memory) {
      this.memory.get(spaceId)?.close();
      this.memory.delete(spaceId);
      return;
    }
    // Closed first: Windows cannot delete an open database file.
    const file = this.file(spaceId);
    for (const suffix of ['', '-wal', '-shm', '-journal']) fs.rmSync(`${file}${suffix}`, { force: true });
  }

  async stats(spaceId: string): Promise<{ bytes: number; tasks: number } | null> {
    const space = this.get(spaceId);
    if (!space) return null;
    const tasks = space.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks')!.n;
    return { bytes: databaseBytes(space.db), tasks };
  }

  /** Close the hosts that served no request for the idle time. */
  closeIdle(nowMs: number): void {
    for (const space of [...this.open.values()]) {
      if (space.host.activeRequests > 0 || nowMs - space.lastUsed < this.idleMs) continue;
      this.open.delete(space.id);
      this.closeDb(space);
    }
  }

  /** Close every database (shutdown). */
  closeAll(): void {
    for (const space of [...this.open.values(), ...this.draining]) this.closeDb(space);
    this.open.clear();
    this.draining.clear();
    for (const db of this.memory?.values() ?? []) db.close();
    this.memory?.clear();
  }

  /** The ids of the space databases that exist (<id>.db files), for the CLI. */
  list(): string[] {
    if (this.memory) return [...this.memory.keys()].sort();
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return [];
    }
    return names
      .map((name) => SPACE_FILE_RE.exec(name)?.[1])
      .filter((id): id is string => id !== undefined)
      .sort();
  }

  /** The open space, or the space opened now; null when it has no database. */
  private get(spaceId: string): OpenSpace | null {
    if (!isSpaceId(spaceId)) return null;
    const cached = this.cached(spaceId);
    if (cached) return cached;
    let db: NodeDb | null = null;
    try {
      db = this.openDb(spaceId, false);
      if (!db) return null;
      if (!readSchemaState(db).empty) {
        this.migrateSpace(spaceId, db);
        if (storedSpaceId(db) !== null) return this.register(spaceId, db);
      }
      // Not a space yet (an init that was interrupted): never create tables here, as an uninitialized DO.
      this.discard(db, spaceId);
      return null;
    } catch (err) {
      if (db) this.discard(db);
      throw this.openFailure(spaceId, err);
    }
  }

  /**
   * What opening a space's file threw, for the request: a file this process cannot open or write becomes
   * 503, and its explanation goes to the log once (until the file opens again). Anything else is a bug and
   * keeps its stack trace.
   */
  private openFailure(spaceId: string, err: unknown): unknown {
    if (this.memory || !isDbAccessError(err)) return err;
    if (!this.unopenable.has(spaceId)) {
      this.unopenable.add(spaceId);
      const [first, ...rest] = dbOpenFailureMessage(this.file(spaceId), err, process.getuid?.(), this.o.audience ?? 'server');
      console.error(`[lyren] ${first}`);
      for (const line of rest) console.error(line);
    }
    return unavailable("The server cannot open this space's data; its log says why.");
  }

  /** The space's database, created when `create`; null when it has none. */
  private openDb(spaceId: string, create: boolean): NodeDb | null {
    const file = this.file(spaceId);
    if (this.memory) {
      let db = this.memory.get(spaceId);
      if (!db && create) this.memory.set(spaceId, (db = new NodeDb(':memory:')));
      return db ?? null;
    }
    if (!fs.existsSync(file)) {
      if (!create) return null;
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      fs.closeSync(fs.openSync(file, 'a', 0o600));
    }
    return new NodeDb(file);
  }

  /** A database that will not be served: closed (a file), or dropped when it is no space (memory). */
  private discard(db: NodeDb, notASpace?: string): void {
    if (!this.memory) db.close();
    else if (notASpace !== undefined) {
      this.memory.delete(notASpace);
      db.close();
    }
  }

  private migrateSpace(spaceId: string, db: NodeDb): void {
    migrate(db, SPACE_MIGRATIONS, {
      appVersion: APP_VERSION,
      beforeUpgrade: (from) => writeSnapshot(db, this.backupsOf(spaceId), 'space-before-upgrade', { keep: this.o.config.snapshotKeep, from }),
    });
    db.raw.exec(`PRAGMA user_version = ${NEW_FORMAT_USER_VERSION}`);
    const stored = storedSpaceId(db);
    // A new file has no space_id until initSpaceDb writes it.
    if (stored !== null && stored !== spaceId) throw new Error(`${this.file(spaceId)} belongs to another space (${stored})`);
  }

  /** backups/spaces/<id>/ next to the directory file. */
  private backupsOf(spaceId: string): string {
    return path.join(this.o.dataDir, 'backups', 'spaces', spaceId);
  }

  private register(spaceId: string, db: NodeDb): OpenSpace {
    this.unopenable.delete(spaceId);
    const { config, runtime, directory } = this.o;
    const clock = this.clock;
    const file = this.file(spaceId);
    const safety: SpaceSafety = {
      beforeReplace: async () => {
        const name = writeSnapshot(db, this.backupsOf(spaceId), 'pre-import', { keep: config.snapshotKeep });
        const snapshot = `backups/spaces/${spaceId}/${name}`;
        return { kind: 'file', path: snapshot, restoreCommand: restoreCommand(snapshot) };
      },
    };
    const deps: Deps = {
      db,
      config,
      space: {
        id: spaceId,
        directory,
        safety,
        runtime,
        readSnapshot: (fn) => (this.memory ? fn(db) : readSnapshot(file, fn)),
        // The process may have handed out generations of this file before (a crash, a restored copy).
        writeState: createWriteState(db, { dailyRowWrites: config.spaceDailyRowWrites, clock, reopened: true }),
        importGate: this.importGate,
        storageBytes: () => databaseBytes(db),
        clock,
      },
    };
    const space: OpenSpace = { id: spaceId, db, host: createSpaceHost({ deps, authCacheTtlMs: 0 }), lastUsed: clock.now() };
    this.open.set(spaceId, space);
    this.trim();
    return space;
  }

  /**
   * The space's host when it has one: open (now the most recently used), or let go by the LRU but still
   * serving a request, which takes it back. A second host on the same file would keep a write
   * generation of its own and answer 304 for what the other one changed (§6.4.2).
   */
  private cached(spaceId: string): OpenSpace | null {
    let space = this.open.get(spaceId);
    if (space) {
      this.open.delete(spaceId);
    } else {
      for (const evicted of this.draining) {
        if (evicted.id !== spaceId) continue;
        this.draining.delete(evicted);
        space = evicted;
        break;
      }
      if (!space) return null;
    }
    // Most recently used last.
    this.open.set(spaceId, space);
    space.lastUsed = this.clock.now();
    this.trim();
    return space;
  }

  /** Let go of the least recently used hosts past SPACES_OPEN_MAX: closed now, or when their requests end. */
  private trim(): void {
    while (this.open.size > this.o.maxOpen) {
      const [oldestId, oldest] = this.open.entries().next().value as [string, OpenSpace];
      this.open.delete(oldestId);
      if (oldest.host.activeRequests > 0) this.draining.add(oldest);
      else this.closeDb(oldest);
    }
  }

  private closeDb(space: OpenSpace): void {
    // In memory the database is the space: it stays until destroy or closeAll.
    if (!this.memory) space.db.close();
  }
}

/**
 * fn on a consistent view of the space across awaits (§8.3): a second connection in a read transaction
 * (in WAL mode it sees the database as of its first read, whatever is written meanwhile).
 */
async function readSnapshot<T>(file: string, fn: (db: NodeDb) => Promise<T>): Promise<T> {
  const reader = new NodeDb(file);
  try {
    reader.raw.exec('BEGIN');
    try {
      reader.raw.prepare("SELECT value FROM _meta WHERE key = 'space_id'").get();
      return await fn(reader);
    } finally {
      reader.raw.exec('COMMIT');
    }
  } finally {
    reader.close();
  }
}
