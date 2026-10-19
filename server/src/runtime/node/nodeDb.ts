// The database on Node: a thin synchronous wrapper around Node's built-in SQLite (node:sqlite) that
// implements Db (core/db.ts, which describes the parameter, value and transaction rules), plus what
// only Node has: `filename`, `raw` (the DatabaseSync), `backupTo` (VACUUM INTO) and `close`.
//
// Portability checks (design §9.4), on when VITEST is set (the test suite) or LYREN_DB_STRICT=1: a
// statement a Durable Object would reject, or run differently, throws here instead, so the fast
// Node suite catches what would break on Cloudflare:
//   1. more than 100 parameters;
//   2. a statement over 100,000 bytes (also in the ?N form a DO is sent);
//   3. BEGIN, COMMIT, END, ROLLBACK, SAVEPOINT, RELEASE, VACUUM, ATTACH or DETACH as a statement (use
//      tx()), ROLLBACK as a conflict resolution (OR ROLLBACK, ON CONFLICT ROLLBACK, RAISE(ROLLBACK)), and
//      the lyren_lower() function the fold columns replaced (design §3.4; it is no longer registered);
//   4. a PRAGMA outside the Durable Object allowlist (e.g. user_version, journal_mode), and setting
//      PRAGMA foreign_keys (always on in a DO);
//   5. a value that is an object (other than Uint8Array), or a bigint outside the safe integer range;
//   6. LIKE or GLOB with a bound or computed pattern, or a literal one over 50 bytes (a DO refuses
//      patterns over 50 bytes);
//   7. setting PRAGMA defer_foreign_keys outside withDeferredForeignKeys() (core/migrate.ts), and a
//      DEFERRABLE INITIALLY DEFERRED foreign key;
//   8. last_insert_rowid(), changes() and total_changes() (a DO's own writes move them);
//   9. CREATE TEMP, and names that start with _cf_ (a DO's own tables);
//  10. on Node 24.15 and later, the DO's own SQLite limits (5 compound SELECT terms, expression depth
//      100, 100 columns, …) and its authorizer (its SQL functions only, no temporary objects,
//      transaction statements or virtual tables other than FTS5 and R*Tree), while checked SQL runs.
// Checks 3, 4 (foreign_keys), 7 and 8 are also DoDb's (durableObjectHazard in core/db.ts), and both
// adapters always apply the statement and parameter rules of core/db.ts. Node-only maintenance
// (VACUUM INTO, user_version, journal_mode, the legacy runner in db/schema.ts) goes through `raw`,
// which the checks don't see.

import fs from 'node:fs';
import path from 'node:path';
import { constants, DatabaseSync, type StatementSync } from 'node:sqlite';
import {
  bindParams,
  durableObjectHazard,
  execStatements,
  portableValue,
  refuseAsync,
  scanSql,
  singleStatement,
  SQL_LIMITS,
  wellFormed,
  type BindValue,
  type Db,
  type RunResult,
  type SqlParams,
  type SqlScan,
  type SqlValue,
} from '../../core/db';
import { isDeferringForeignKeys } from '../../core/migrate';
import { runMigrations, type MigrateOptions } from '../../db/schema';
import { sleepSync } from './files';

interface CachedStatement {
  stmt: StatementSync;
  scan: SqlScan;
}

const STATEMENT_CACHE_MAX = 500;

/** The pragmas a Durable Object allows (check 4; research/platform.md §3, "PRAGMA allowlist"). */
const DO_PRAGMAS = new Set([
  'table_info',
  'table_xinfo',
  'table_list',
  'index_list',
  'index_info',
  'index_xinfo',
  'foreign_key_list',
  'foreign_key_check',
  'quick_check',
  'optimize',
  'foreign_keys',
  'defer_foreign_keys',
  'case_sensitive_like',
  'ignore_check_constraints',
  'legacy_alter_table',
  'recursive_triggers',
  'reverse_unordered_selects',
]);

type Limits = DatabaseSync['limits'];

/**
 * A Durable Object's SQLite limits (check 10; workerd's setupSecurity in src/workerd/util/sqlite.c++).
 * They apply while checked SQL runs; `raw` keeps Node's own, which VACUUM INTO (backupTo) needs.
 */
const DO_LIMITS: Partial<Limits> = {
  sqlLength: 100_000,
  column: 100,
  exprDepth: 100,
  compoundSelect: 5,
  vdbeOp: 25_000,
  functionArg: 127,
  attach: 0,
  likePatternLength: 50,
  variableNumber: 100,
  triggerDepth: 10,
};

/** The SQL functions a Durable Object allows (check 10; workerd's ALLOWED_SQLITE_FUNCTIONS). */
const DO_FUNCTIONS = new Set(
  [
    // Core functions (not sqlite_version(), sqlite_source_id() and the like)
    'abs changes char coalesce concat concat_ws format glob hex ifnull iif instr last_insert_rowid length like',
    'likelihood likely load_extension lower ltrim max_scalar min_scalar nullif octet_length printf quote random',
    'randomblob replace round rtrim sign soundex substr substring total_changes trim typeof unhex unicode',
    'unlikely upper zeroblob',
    // Date and time
    'date time datetime julianday unixepoch strftime timediff current_date current_time current_timestamp',
    // Aggregate and window functions
    'avg count group_concat max min string_agg sum total row_number rank dense_rank percent_rank cume_dist',
    'ntile lag lead first_value last_value nth_value',
    // Math
    'acos acosh asin asinh atan atan2 atanh ceil cos cosh degrees exp floor ln log log2 mod pi pow radians',
    'sin sinh sqrt tan tanh trunc',
    // JSON
    'json jsonb json_array jsonb_array json_array_length json_extract jsonb_extract -> ->> json_insert',
    'jsonb_insert json_object jsonb_object json_patch jsonb_patch json_remove jsonb_remove json_replace',
    'jsonb_replace json_set jsonb_set json_type json_valid json_quote json_group_array jsonb_group_array',
    'json_group_object jsonb_group_object json_each json_tree',
    // FTS5, R*Tree, and what ALTER TABLE runs internally
    'match highlight bm25 snippet rtreecheck sqlite_rename_column sqlite_rename_table sqlite_rename_test',
    'sqlite_drop_column sqlite_rename_quotefix',
  ]
    .join(' ')
    .split(' '),
);

/** The virtual table modules a Durable Object allows (check 10). */
const DO_MODULES = new Set(['fts5', 'fts5vocab', 'rtree', 'rtree_i32']);

/** Why a Durable Object's authorizer would deny this action (check 10), or null. */
function deniedAction(action: number, arg1: string | null, arg2: string | null, dbName: string | null): string | null {
  // In the temp database (`CREATE TABLE temp.x`, say), a DO allows reading and updating only.
  if (dbName?.toLowerCase() === 'temp' && action !== constants.SQLITE_READ && action !== constants.SQLITE_UPDATE) {
    return 'temporary tables, views and triggers';
  }
  switch (action) {
    case constants.SQLITE_FUNCTION: {
      const name = (arg2 ?? '').toLowerCase();
      return DO_FUNCTIONS.has(name) ? null : `the SQL function ${arg2}()`;
    }
    case constants.SQLITE_CREATE_TEMP_INDEX:
    case constants.SQLITE_CREATE_TEMP_TABLE:
    case constants.SQLITE_CREATE_TEMP_TRIGGER:
    case constants.SQLITE_CREATE_TEMP_VIEW:
    case constants.SQLITE_DROP_TEMP_INDEX:
    case constants.SQLITE_DROP_TEMP_TABLE:
    case constants.SQLITE_DROP_TEMP_TRIGGER:
    case constants.SQLITE_DROP_TEMP_VIEW:
      return 'temporary tables, views and triggers';
    case constants.SQLITE_TRANSACTION:
    case constants.SQLITE_SAVEPOINT:
      return `${arg1} (transactions use db.tx())`;
    case constants.SQLITE_ATTACH:
    case constants.SQLITE_DETACH:
      return 'ATTACH and DETACH';
    case constants.SQLITE_CREATE_VTABLE:
    case constants.SQLITE_DROP_VTABLE:
      return DO_MODULES.has((arg2 ?? '').toLowerCase()) ? null : `virtual tables using ${arg2}`;
    default:
      return arg1 !== null && /^_cf_/i.test(arg1) ? `${arg1} (a Durable Object's own table)` : null;
  }
}

/**
 * The file name to hand SQLite. On Windows an absolute \\?\ path: SQLite passes names to
 * CreateFileW as they are, so a plain path of 260 characters or more (MAX_PATH, e.g. a snapshot
 * deep inside a long DATA_DIR) fails with "unable to open database file", while Node's fs prefixes
 * \\?\ itself. SQLite derives the -wal / -shm / -journal names from it, so they work too.
 */
export function sqlitePath(file: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32' || file === ':memory:' || file === '') return file;
  return path.win32.toNamespacedPath(path.win32.resolve(file));
}

/**
 * The URI that opens the existing database `file` read-write and never creates it (mode=rw): an open that
 * comes after another process moved the file away fails instead of leaving an empty database in its place.
 * The name is sqlitePath's (absolute), with %, ? and # percent-encoded, which SQLite decodes back to it.
 */
export function existingFileUri(file: string, platform: NodeJS.Platform = process.platform): string {
  const name = platform === 'win32' ? sqlitePath(file, platform) : path.posix.resolve(file);
  return `file:${name.replace(/[%?#]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}?mode=rw`;
}

let uriSupport: boolean | undefined;

/**
 * Whether node:sqlite opens URI filenames (existingFileUri). Node 24's does; Node 22.13's opens "file:…" as a
 * plain name, relative to the working folder (Ubuntu's nodejs 22 does open them: it uses the system SQLite,
 * built with SQLITE_USE_URI). Asked once, of a URI that opens a database in memory and, read as a plain name,
 * lies in a folder that does not exist, so that asking never creates a file.
 */
export function uriFilenames(): boolean {
  if (uriSupport === undefined) {
    const folder = `.lyren-uri-probe-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      new DatabaseSync(`file:/${folder}/db?mode=memory`).close();
      uriSupport = true;
    } catch {
      uriSupport = false;
    }
  }
  return uriSupport;
}

/** NodeDb with create: false found the file gone, or another file under its name (another process moved it). */
export class DatabaseGone extends Error {
  constructor(file: string) {
    super(`${file} was moved away while it was being opened`);
    this.name = 'DatabaseGone';
  }
}

/** Whether `now` is the file `before` was (a file system without file ids reports 0 for every file). */
function sameFile(before: fs.BigIntStats, now: fs.BigIntStats): boolean {
  return before.ino === 0n || (now.ino === before.ino && now.dev === before.dev);
}

/**
 * NodeDb's open with create: false: existingFileUri where node:sqlite opens URIs, so SQLite never creates the
 * file. Without them the plain name, which SQLite creates (empty) when it is gone by the time it opens: the
 * name is checked right after the open, before anything is written, and when it is gone, holds another file,
 * or holds an empty file where there was a database, the open throws DatabaseGone. An empty file there is
 * what this open (or another one like it) created, and is removed unless it has been replaced meanwhile;
 * another process's database, never empty, stays.
 */
function openExisting(file: string, uri: boolean): DatabaseSync {
  if (uri) return new DatabaseSync(existingFileUri(file));
  const before = fs.statSync(file, { bigint: true, throwIfNoEntry: false });
  if (!before) throw new DatabaseGone(file);
  const db = new DatabaseSync(sqlitePath(file));
  const now = fs.statSync(file, { bigint: true, throwIfNoEntry: false });
  if (now && sameFile(before, now) && (now.size !== 0n || before.size === 0n)) return db;
  db.close();
  if (now?.size === 0n) {
    const still = fs.statSync(file, { bigint: true, throwIfNoEntry: false });
    if (still && still.size === 0n && sameFile(now, still)) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // Windows: another program has it open; it holds no data either way.
      }
    }
  }
  throw new DatabaseGone(file);
}

/** A value as SQLite binds it without the portability checks (unsafe bigints bind exactly). */
function normalize(v: BindValue): SqlValue {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : v;
  if (typeof v === 'string') return wellFormed(v);
  return v;
}

function notPortable(reason: string, cause?: unknown): never {
  throw new Error(`Not portable to a Durable Object: ${reason}`, cause === undefined ? undefined : { cause });
}

export interface NodeDbOptions {
  /** The portability checks (default: on when VITEST is set or LYREN_DB_STRICT=1). */
  strict?: boolean;
  /** PRAGMA busy_timeout, set before the file is first read (default 5000 ms). */
  busyTimeoutMs?: number;
  /**
   * false: open only the file that is there now, never creating its folder, and never leaving a file this
   * open created (openExisting; DatabaseGone when the file was moved away). Default true.
   */
  create?: boolean;
  /** With create: false, whether to open by URI (default uriFilenames(); tests take the other path with false). */
  uriFilenames?: boolean;
}

/** Check 10's state: Node's own limits to restore, and what the authorizer denied. */
interface Emulation {
  nodeLimits: Partial<Limits>;
  active: boolean;
  denied: string | null;
}

export class NodeDb implements Db {
  readonly kind = 'node' as const;
  readonly raw: DatabaseSync;
  readonly filename: string;
  readonly strict: boolean;
  /** LRU statement cache (Map iteration order = recency). */
  private readonly cache = new Map<string, CachedStatement>();
  private depth = 0;
  /** Check 10, when strict on a Node with limits and an authorizer (24.15 and later). */
  private readonly emulation: Emulation | null = null;

  constructor(filename: string, options: NodeDbOptions = {}) {
    this.filename = filename;
    this.strict = options.strict ?? (Boolean(process.env.VITEST) || process.env.LYREN_DB_STRICT === '1');
    // Owner-only: the directory holds the database, its WAL and the backups (see also the
    // process umask set in index.ts).
    const create = options.create ?? true;
    if (filename !== ':memory:' && create) fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.raw =
      create || filename === ':memory:'
        ? new DatabaseSync(sqlitePath(filename))
        : openExisting(filename, options.uriFilenames ?? uriFilenames());
    try {
      this.raw.exec('PRAGMA foreign_keys = ON');
      this.raw.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(options.busyTimeoutMs ?? 5000))}`);
      if (filename !== ':memory:') {
        this.raw.exec('PRAGMA journal_mode = WAL');
        this.raw.exec('PRAGMA synchronous = NORMAL');
      }
    } catch (err) {
      // A busy file (openExclusive tries again) must not stay open until the garbage collector closes it.
      this.raw.close();
      throw err;
    }
    // Node 22 has neither (engines allow 22.13); the scanner's checks still apply there.
    if (this.strict && typeof this.raw.setAuthorizer === 'function' && this.raw.limits !== undefined) {
      const nodeLimits: Partial<Limits> = {};
      for (const key of Object.keys(DO_LIMITS) as Array<keyof Limits>) nodeLimits[key] = this.raw.limits[key];
      const emulation: Emulation = { nodeLimits, active: false, denied: null };
      this.raw.setAuthorizer((action, arg1, arg2, dbName) => {
        const denied = emulation.active ? deniedAction(action, arg1, arg2, dbName) : null;
        if (denied === null) return constants.SQLITE_OK;
        emulation.denied ??= denied;
        return constants.SQLITE_DENY;
      });
      this.emulation = emulation;
    }
  }

  /** Whether strict mode also applies a Durable Object's SQLite limits and authorizer (check 10). */
  get emulatesDurableObject(): boolean {
    return this.emulation !== null;
  }

  /** Checks 1-4 and 6-9 for one statement text (check 5 is in bind). */
  private check(scan: SqlScan): void {
    const hazard = durableObjectHazard(scan, isDeferringForeignKeys(this));
    if (hazard !== null) notPortable(hazard);
    if (scan.variables > SQL_LIMITS.maxParameters) {
      notPortable(
        `${scan.variables} parameters, at most ${SQL_LIMITS.maxParameters} are allowed (pass a list as one json_each parameter)`,
      );
    }
    if (scan.bytes > SQL_LIMITS.maxStatementBytes) {
      notPortable(`a statement of ${scan.bytes} bytes, at most ${SQL_LIMITS.maxStatementBytes} are allowed`);
    }
    if (scan.functions.has('lyren_lower')) notPortable('lyren_lower() (use the fold columns)');
    for (const pragma of scan.pragmas) {
      if (!DO_PRAGMAS.has(pragma.name)) notPortable(`PRAGMA ${pragma.name} (Node-only maintenance uses raw)`);
    }
    if (scan.computedPattern) {
      notPortable('LIKE or GLOB with a bound or computed pattern (patterns are limited to 50 bytes; use instr())');
    }
    if (scan.longPattern) notPortable(`a LIKE or GLOB pattern over ${SQL_LIMITS.maxPatternBytes} bytes`);
    if (scan.temporary) notPortable('CREATE TEMP (a Durable Object has no temporary tables)');
    if (scan.platformName) notPortable("a name starting with _cf_ (a Durable Object's own tables)");
  }

  /**
   * Run fn, which prepares and runs checked SQL, with check 10 on: a Durable Object's limits and
   * authorizer. What the authorizer denied is reported as not portable.
   */
  private checked<T>(fn: () => T): T {
    const emulation = this.emulation;
    if (emulation === null || emulation.active) return fn();
    emulation.active = true;
    emulation.denied = null;
    Object.assign(this.raw.limits, DO_LIMITS);
    try {
      return fn();
    } catch (err) {
      if (emulation.denied !== null) notPortable(emulation.denied, err);
      throw err;
    } finally {
      Object.assign(this.raw.limits, emulation.nodeLimits);
      emulation.active = false;
    }
  }

  private prepare(sql: string): CachedStatement {
    let entry = this.cache.get(sql);
    if (entry) {
      this.cache.delete(sql);
      // Check 7 depends on the moment (inside withDeferredForeignKeys or not).
      if (this.strict && entry.scan.pragmas.length > 0) this.check(entry.scan);
    } else {
      const scan = scanSql(sql);
      singleStatement(scan);
      if (this.strict) this.check(scan);
      entry = { stmt: this.raw.prepare(sql), scan };
    }
    this.cache.set(sql, entry);
    if (this.cache.size > STATEMENT_CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    return entry;
  }

  private bind(scan: SqlScan, params: SqlParams | undefined): SqlValue[] | [Record<string, SqlValue>] {
    const values = bindParams(scan, params, (v, label) => (this.strict ? portableValue(v, label) : normalize(v)));
    if (scan.names.length === 0) return values;
    const named: Record<string, SqlValue> = {};
    scan.names.forEach((name, i) => {
      named[name] = values[i]!;
    });
    return [named];
  }

  all<T = Record<string, unknown>>(sql: string, params?: SqlParams): T[] {
    return this.checked(() => {
      const e = this.prepare(sql);
      return e.stmt.all(...(this.bind(e.scan, params) as SqlValue[])) as T[];
    });
  }

  get<T = Record<string, unknown>>(sql: string, params?: SqlParams): T | undefined {
    return this.checked(() => {
      const e = this.prepare(sql);
      return e.stmt.get(...(this.bind(e.scan, params) as SqlValue[])) as T | undefined;
    });
  }

  run(sql: string, params?: SqlParams): RunResult {
    return this.checked(() => {
      const e = this.prepare(sql);
      const r = e.stmt.run(...(this.bind(e.scan, params) as SqlValue[]));
      return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
    });
  }

  /** Execute one or more statements without parameters (DDL). */
  exec(sql: string): void {
    const scan = scanSql(sql);
    execStatements(scan);
    if (this.strict) this.check(scan);
    this.checked(() => this.raw.exec(sql));
  }

  /** Run fn inside a transaction (nested calls use savepoints). fn must be synchronous. */
  tx<T>(fn: () => T): T {
    const level = this.depth;
    const sp = `sp_${level}`;
    this.raw.exec(level === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
    this.depth = level + 1;
    try {
      const result = fn();
      refuseAsync(result, 'Db.tx() callback must be synchronous');
      this.raw.exec(level === 0 ? 'COMMIT' : `RELEASE ${sp}`);
      return result;
    } catch (err) {
      try {
        this.raw.exec(level === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
      } catch {
        // SQLite may already have rolled back (e.g. SQLITE_FULL); keep the original error.
      }
      throw err;
    } finally {
      this.depth = level;
    }
  }

  get inTransaction(): boolean {
    return this.depth > 0;
  }

  /**
   * Write a consistent snapshot of the database to `file` (VACUUM INTO). Safe while
   * the server is running (includes WAL content). Must not be called inside tx().
   * Fails if `file` already exists.
   */
  backupTo(file: string): void {
    if (this.depth > 0) throw new Error('backupTo() cannot run inside a transaction');
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.raw.prepare('VACUUM INTO ?').run(sqlitePath(file));
  }

  close(): void {
    this.cache.clear();
    this.raw.close();
  }
}

/** Another connection holds the database (SQLITE_BUSY or SQLITE_LOCKED, once busy_timeout has passed). */
export function isBusyError(err: unknown): boolean {
  const e = err as { errcode?: number; message?: string } | null;
  return e?.errcode === 5 || e?.errcode === 6 || /database (?:table )?is locked/i.test(e?.message ?? '');
}

/** The pause between two attempts of openExclusive. */
const EXCLUSIVE_RETRY_MS = 50;

/**
 * A connection to `file` that keeps an exclusive lock until it is closed (PRAGMA locking_mode = EXCLUSIVE,
 * then BEGIN EXCLUSIVE and COMMIT; design §3.8): no other connection can read or write the file meanwhile,
 * which proves that nothing else uses it (the legacy upgrade, a restore's apply). Null, with nothing
 * written, while another connection has the file open (for busyTimeoutMs), and when the file is gone or was
 * replaced meanwhile (another start moved it).
 *
 * Every attempt opens the file anew and never waits inside SQLite (busy_timeout 0, retried here every
 * 50 ms): a connection that waited there would keep the file that another process renames away meanwhile
 * (the swap of §3.8 step 7, a restore's moves) and then read it together with the -wal of the file that
 * took its name. The file is never created, or never left behind where node:sqlite takes no URI filenames
 * (NodeDb's create: false). `options.uriFilenames`: NodeDbOptions'.
 */
export function openExclusive(file: string, busyTimeoutMs = 5000, options: Pick<NodeDbOptions, 'uriFilenames'> = {}): NodeDb | null {
  const deadline = Date.now() + busyTimeoutMs;
  for (;;) {
    const db = tryExclusive(file, options.uriFilenames);
    if (db !== 'busy') return db;
    if (Date.now() >= deadline) return null;
    sleepSync(EXCLUSIVE_RETRY_MS);
  }
}

/** SQLITE_READONLY_DBMOVED: the file was renamed away while the connection had it open. */
const DB_MOVED = 1032;

/** One attempt of openExclusive: the connection, null (gone or replaced), or 'busy'. */
function tryExclusive(file: string, uri: boolean | undefined): NodeDb | null | 'busy' {
  const before = fs.statSync(file, { bigint: true, throwIfNoEntry: false });
  if (!before) return null;
  const errcode = (err: unknown) => (err as { errcode?: number }).errcode;
  let db: NodeDb;
  try {
    db = new NodeDb(file, { busyTimeoutMs: 0, create: false, uriFilenames: uri });
  } catch (err) {
    if (err instanceof DatabaseGone) return null;
    // Switching a file that is not in WAL mode yet needs the lock too.
    if (isBusyError(err)) return 'busy';
    // SQLITE_CANTOPEN once the file is gone: moved away just now.
    if ((errcode(err) === 14 && !fs.existsSync(file)) || errcode(err) === DB_MOVED) return null;
    throw err;
  }
  try {
    db.raw.exec('PRAGMA locking_mode = EXCLUSIVE');
    db.raw.exec('BEGIN EXCLUSIVE');
    db.raw.exec('COMMIT');
  } catch (err) {
    db.close();
    if (isBusyError(err)) return 'busy';
    if (errcode(err) === DB_MOVED) return null;
    throw err;
  }
  // The lock must be on the file that had the name when this attempt began.
  const after = fs.statSync(file, { bigint: true, throwIfNoEntry: false });
  if (!after || !sameFile(before, after)) {
    db.close();
    return null;
  }
  db.raw.exec('PRAGMA busy_timeout = 5000');
  return db;
}

/**
 * Remove sign-in sessions from a backup copy (not the live database) so restoring it can't
 * revive sessions revoked since. secure_delete overwrites the freed pages.
 */
export function stripSessions(file: string): void {
  const copy = new DatabaseSync(sqlitePath(file));
  try {
    // The copy may come from a file restore was given (restore.ts): its schema runs no functions.
    copy.exec('PRAGMA trusted_schema = OFF');
    copy.exec('PRAGMA journal_mode = DELETE');
    copy.exec('PRAGMA secure_delete = ON');
    copy.exec('DELETE FROM sessions');
  } finally {
    copy.close();
  }
}

/** Open (creating if needed) and migrate the database. */
export function openDb(filename: string, options: MigrateOptions = {}): NodeDb {
  const db = new NodeDb(filename);
  try {
    runMigrations(db, options);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}
