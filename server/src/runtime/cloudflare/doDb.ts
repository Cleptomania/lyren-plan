// The database in a Durable Object: Db (core/db.ts) over ctx.storage.sql (design §10.4). Strict: it
// rewrites nothing but the parameters, and refuses what the platform would silently get wrong.
//
// - :name parameters become ?N by first appearance (the scanner NodeDb uses; a DO numbers named
//   parameters the same way), cached per SQL text, and the values are passed positionally. The
//   statement and parameter rules are those of core/db.ts, the same as NodeDb's.
// - Values: booleans bind 0/1 (a DO would store the text 'true'), undefined NULL, a safe bigint as a
//   number; objects other than Uint8Array throw (a DO would store '[object Object]').
// - SQL that a DO accepts but then gets wrong is refused (durableObjectHazard in core/db.ts): ROLLBACK
//   as a conflict resolution, DEFERRABLE INITIALLY DEFERRED keys, PRAGMA defer_foreign_keys outside
//   withDeferredForeignKeys(), PRAGMA foreign_keys, last_insert_rowid() and the like.
// - Every cursor is drained at once: an undrained INSERT … RETURNING makes the next transactionSync
//   fail with an opaque internal error, and a half-read cursor blocks DROP TABLE. Rows have no
//   prototype and BLOBs come back as Uint8Array, as on Node. Each cursor's billed rows are added to
//   `meter`, also when it fails part way; exec() runs, and meters, one statement at a time.
// - run() reads changes() and last_insert_rowid(): cursor.rowsWritten counts index entries too.
// - tx() is ctx.storage.transactionSync, which nests with savepoint semantics, rolls back on throw
//   and rethrows the same error.
// - A daily-quota error from the SQL API becomes a DailyQuotaError (answered 503, §11.3); tests stand in
//   for one through doDbTestHooks.
//
// What a DO does differently even so (all measured): PRAGMA foreign_keys is always on; a deferred
// foreign key violation left at the end of an invocation resets the object; defer_foreign_keys stays
// on after transactionSync returns (use withDeferredForeignKeys); lower() and NOCASE fold ASCII only;
// integers beyond 2^53 are rounded; no VACUUM, ATTACH, temp tables or UDFs.

import {
  bindParams,
  DailyQuotaError,
  durableObjectHazard,
  execStatements,
  isDailyQuotaError,
  portableValue,
  refuseAsync,
  scanSql,
  singleStatement,
  SQL_LIMITS,
  type Db,
  type RunResult,
  type SqlParams,
  type SqlScan,
} from '../../core/db';
import { isDeferringForeignKeys } from '../../core/migrate';

const STATEMENT_CACHE_MAX = 500;

/** Pragmas exec() refuses with a clear error (the platform's own is SQLITE_AUTH, after the statements before). */
const EXEC_FORBIDDEN_PRAGMAS = new Set(['user_version', 'journal_mode']);

/**
 * Tests only (server/test-workers; production never sets it): called with every statement's text right
 * before the SQL API runs it, inside that call's error handling, so a hook that throws the platform's
 * quota error stands in for a used-up daily limit (§11.3), which cannot be reached locally.
 */
export const doDbTestHooks: { beforeExec: ((sql: string) => void) | null } = { beforeExec: null };

function quotaAware(err: unknown): unknown {
  return isDailyQuotaError(err) ? new DailyQuotaError(err) : err;
}

export class DoDb implements Db {
  readonly kind = 'durable-object' as const;
  readonly meter = { rowsRead: 0, rowsWritten: 0 };
  private readonly sql: SqlStorage;
  /** LRU scan cache (Map iteration order = recency). */
  private readonly cache = new Map<string, SqlScan>();
  private depth = 0;

  constructor(private readonly storage: DurableObjectStorage) {
    this.sql = storage.sql;
  }

  private scan(sql: string): SqlScan {
    let scan = this.cache.get(sql);
    if (scan) {
      this.cache.delete(sql);
    } else {
      scan = scanSql(sql);
      singleStatement(scan);
    }
    this.cache.set(sql, scan);
    if (this.cache.size > STATEMENT_CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    return scan;
  }

  /** Refuse what the platform accepts but gets wrong (checked every time: it depends on withDeferredForeignKeys). */
  private refuseHazards(scan: SqlScan): void {
    const hazard = durableObjectHazard(scan, isDeferringForeignKeys(this));
    if (hazard !== null) throw new Error(`Not supported in a Durable Object: ${hazard}`);
  }

  /** Run one call of the SQL API, drain its cursor and meter it. */
  private drain(text: string, values: readonly unknown[] = []): Record<string, unknown>[] {
    let cursor: SqlStorageCursor<Record<string, SqlStorageValue>> | undefined;
    let rows: Record<string, SqlStorageValue>[];
    try {
      doDbTestHooks.beforeExec?.(text);
      cursor = this.sql.exec(text, ...values);
      rows = cursor.toArray();
    } catch (err) {
      throw quotaAware(err);
    } finally {
      if (cursor !== undefined) {
        this.meter.rowsRead += cursor.rowsRead;
        this.meter.rowsWritten += cursor.rowsWritten;
      }
    }
    return rows.map((row) => {
      const out: Record<string, unknown> = Object.create(null);
      for (const key in row) {
        const value = row[key];
        out[key] = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
      }
      return out;
    });
  }

  private rows(sql: string, params: SqlParams | undefined): Record<string, unknown>[] {
    const scan = this.scan(sql);
    this.refuseHazards(scan);
    if (scan.variables > SQL_LIMITS.maxParameters) {
      throw new Error(
        `SQL binds ${scan.variables} parameters; at most ${SQL_LIMITS.maxParameters} are allowed (pass a list as one json_each parameter)`,
      );
    }
    return this.drain(singleStatement(scan), bindParams(scan, params, portableValue));
  }

  all<T = Record<string, unknown>>(sql: string, params?: SqlParams): T[] {
    return this.rows(sql, params) as T[];
  }

  get<T = Record<string, unknown>>(sql: string, params?: SqlParams): T | undefined {
    return this.rows(sql, params)[0] as T | undefined;
  }

  run(sql: string, params?: SqlParams): RunResult {
    this.rows(sql, params);
    let r: { c: number; id: number };
    try {
      r = this.sql.exec<{ c: number; id: number }>('SELECT changes() AS c, last_insert_rowid() AS id').one();
    } catch (err) {
      throw quotaAware(err);
    }
    return { changes: Number(r.c), lastInsertRowid: Number(r.id) };
  }

  /**
   * Execute one or more statements without parameters (DDL), one call of the SQL API each, so that
   * each is metered. Each is sent without the comments around it: a DO refuses text that ends in a
   * comment ("SQL code did not contain a statement").
   */
  exec(sql: string): void {
    const scan = scanSql(sql);
    const statements = execStatements(scan);
    this.refuseHazards(scan);
    for (const pragma of scan.pragmas) {
      if (EXEC_FORBIDDEN_PRAGMAS.has(pragma.name)) {
        throw new Error(`PRAGMA ${pragma.name} is not available in a Durable Object`);
      }
    }
    for (const statement of statements) this.drain(statement);
  }

  /** Run fn inside a transaction (nested calls are savepoints). fn must be synchronous. */
  tx<T>(fn: () => T): T {
    this.depth++;
    try {
      return this.storage.transactionSync(() => {
        const result = fn();
        refuseAsync(result, 'Db.tx() callback must be synchronous');
        return result;
      });
    } finally {
      this.depth--;
    }
  }

  get inTransaction(): boolean {
    return this.depth > 0;
  }
}
