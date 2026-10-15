// Thin synchronous wrapper around Node's built-in SQLite (node:sqlite).
//
// - Named parameters use the :name form in SQL and a plain object in JS:
//     db.get('SELECT * FROM tasks WHERE id = :id', { id })
//   A named parameter that is MISSING from the object throws (catches typos);
//   EXTRA keys are ignored, so one params object may serve several statements.
//   An explicit `undefined` value binds NULL.
// - Booleans are bound as 0/1 and undefined as NULL (node:sqlite rejects both).
// - Rows come back as plain objects with snake_case column names.
// - tx() nests via SAVEPOINTs and must be given a synchronous function.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { runMigrations, type MigrateOptions } from './schema';

export type SqlValue = null | number | bigint | string | Uint8Array;
type BindValue = SqlValue | boolean | undefined;
export type SqlParams = Record<string, BindValue> | readonly BindValue[];

export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

interface CachedStatement {
  stmt: StatementSync;
  /** Distinct :name parameters referenced by the SQL text. */
  names: string[];
}

const STATEMENT_CACHE_MAX = 500;
const NAMED_PARAM_RE = /(?<![\w:]):([A-Za-z_]\w*)/g;

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

function normalize(v: BindValue): SqlValue {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

/** Strip string literals and comments so ':x' inside them is not taken for a parameter. */
function sqlWithoutLiterals(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|--[^\n]*|\/\*[\s\S]*?\*\//g, ' ');
}

export class Db {
  readonly raw: DatabaseSync;
  readonly filename: string;
  /** LRU statement cache (Map iteration order = recency). */
  private readonly cache = new Map<string, CachedStatement>();
  private depth = 0;

  constructor(filename: string) {
    this.filename = filename;
    // Owner-only: the directory holds the database, its WAL and the backups (see also the
    // process umask set in index.ts).
    if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.raw = new DatabaseSync(sqlitePath(filename));
    this.raw.exec('PRAGMA foreign_keys = ON');
    this.raw.exec('PRAGMA busy_timeout = 5000');
    if (filename !== ':memory:') {
      this.raw.exec('PRAGMA journal_mode = WAL');
      this.raw.exec('PRAGMA synchronous = NORMAL');
    }
    // Unicode-aware lower-casing identical to JS String#toLowerCase (SQLite's lower()
    // only folds ASCII). Used for search so SQL matches shared/src/filter.ts exactly.
    this.raw.function('lyren_lower', { deterministic: true }, (v: unknown) =>
      typeof v === 'string' ? v.toLowerCase() : (v as SqlValue),
    );
  }

  private prepare(sql: string): CachedStatement {
    const hit = this.cache.get(sql);
    if (hit) {
      this.cache.delete(sql);
      this.cache.set(sql, hit);
      return hit;
    }
    const entry: CachedStatement = {
      stmt: this.raw.prepare(sql),
      names: [...new Set([...sqlWithoutLiterals(sql).matchAll(NAMED_PARAM_RE)].map((m) => m[1]!))],
    };
    this.cache.set(sql, entry);
    if (this.cache.size > STATEMENT_CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    return entry;
  }

  private bind(entry: CachedStatement, params: SqlParams | undefined): SqlValue[] | [Record<string, SqlValue>] {
    if (params === undefined) {
      if (entry.names.length > 0) throw new Error(`SQL parameter :${entry.names[0]} missing`);
      return [];
    }
    if (Array.isArray(params)) return (params as readonly BindValue[]).map(normalize);
    const obj = params as Record<string, BindValue>;
    const out: Record<string, SqlValue> = {};
    for (const name of entry.names) {
      if (!(name in obj)) throw new Error(`SQL parameter :${name} missing`);
      out[name] = normalize(obj[name]);
    }
    return entry.names.length > 0 ? [out] : [];
  }

  all<T = Record<string, unknown>>(sql: string, params?: SqlParams): T[] {
    const e = this.prepare(sql);
    return e.stmt.all(...(this.bind(e, params) as SqlValue[])) as T[];
  }

  get<T = Record<string, unknown>>(sql: string, params?: SqlParams): T | undefined {
    const e = this.prepare(sql);
    return e.stmt.get(...(this.bind(e, params) as SqlValue[])) as T | undefined;
  }

  run(sql: string, params?: SqlParams): RunResult {
    const e = this.prepare(sql);
    const r = e.stmt.run(...(this.bind(e, params) as SqlValue[]));
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  /** Execute one or more statements without parameters (DDL, pragmas). */
  exec(sql: string): void {
    this.raw.exec(sql);
  }

  /** Run fn inside a transaction (nested calls use savepoints). fn must be synchronous. */
  tx<T>(fn: () => T): T {
    const level = this.depth;
    const sp = `sp_${level}`;
    this.raw.exec(level === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
    this.depth = level + 1;
    try {
      const result = fn();
      if (result instanceof Promise) throw new Error('Db.tx() callback must be synchronous');
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

/**
 * Remove sign-in sessions from a backup copy (not the live database) so restoring it can't
 * revive sessions revoked since. secure_delete overwrites the freed pages.
 */
export function stripSessions(file: string): void {
  const copy = new DatabaseSync(sqlitePath(file));
  try {
    copy.exec('PRAGMA journal_mode = DELETE');
    copy.exec('PRAGMA secure_delete = ON');
    copy.exec('DELETE FROM sessions');
  } finally {
    copy.close();
  }
}

/** Open (creating if needed) and migrate the database. */
export function openDb(filename: string, options: MigrateOptions = {}): Db {
  const db = new Db(filename);
  try {
    runMigrations(db, options);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}
