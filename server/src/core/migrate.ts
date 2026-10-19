// Portable schema migrations (design §3.7). Both runtimes run exactly this code. The state lives in
// the _meta table, never in PRAGMA user_version (not authorized in a Durable Object):
//   schema           which kind of database this is ('directory' or 'space')
//   version          number of migrations applied
//   compatible_from  the lowest migration count a build may know and still use the database
//   app_version      the app version that last migrated it
//   created_at       when its first migration ran
//
// Each migration runs in its own transaction and must leave no foreign key violation: in a Durable
// Object a violation that survives to the implicit commit resets the object and drops the
// invocation's other writes. What a migration may contain: §3.7 rule 6 (no PRAGMA foreign_keys,
// BEGIN/SAVEPOINT, user_version, VACUUM, ATTACH, UDFs, or rebuilds of tables that others reference).

import { refuseAsync, type Db } from './db';

export type Migration = {
  up: (db: Db) => void;
  /**
   * Builds that know at least this many migrations can still use a database this one produced (an
   * additive change, such as a new table, lets a rolled-back build run). Default: its own number.
   */
  compatibleFrom?: number;
};

export interface MigrationSet {
  schema: 'directory' | 'space';
  migrations: ReadonlyArray<Migration>;
}

export interface MigrateHooks {
  /** Called once before an existing database (version ≥ 1) is upgraded; Node writes a snapshot. */
  beforeUpgrade?: (from: number, to: number) => void;
  /** ISO time for created_at (default: now). */
  now?: () => string;
  /** Recorded as _meta.app_version. */
  appVersion: string;
}

export interface SchemaState {
  /** _meta.schema; null when the database is empty or not one of ours. */
  schema: string | null;
  version: number;
  compatibleFrom: number;
  /** No table besides the platform's own (_cf_*, __cf_kv, sqlite_*, the local __miniflare_do_name). */
  empty: boolean;
}

const PLATFORM_TABLE_RE = /^(?:_cf_|__cf_kv$|sqlite_|__miniflare_do_name$)/i;

const META_DDL = 'CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID';

// Values are bound as text: a number would be stored as REAL text ('1.0').
const META_UPSERT =
  'INSERT INTO _meta (key, value) VALUES (:key, :value) ON CONFLICT (key) DO UPDATE SET value = excluded.value';

function metaCount(meta: Map<string, string>, key: string, fallback: number): number {
  const raw = meta.get(key);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`_meta.${key} is not a migration count: ${raw}`);
  return n;
}

export function readSchemaState(db: Db): SchemaState {
  const tables = db
    .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
    .map((r) => r.name)
    .filter((name) => !PLATFORM_TABLE_RE.test(name));
  if (tables.length === 0) return { schema: null, version: 0, compatibleFrom: 0, empty: true };
  if (!tables.includes('_meta')) return { schema: null, version: 0, compatibleFrom: 0, empty: false };
  const rows = db.all<{ key: string; value: string }>('SELECT key, value FROM _meta');
  const meta = new Map(rows.map((r) => [r.key, r.value]));
  const version = metaCount(meta, 'version', 0);
  return {
    schema: meta.get('schema') ?? null,
    version,
    compatibleFrom: metaCount(meta, 'compatible_from', version),
    empty: false,
  };
}

/** Bring `db` to the newest migration of `set`. Returns the version before and after. */
export function migrate(db: Db, set: MigrationSet, hooks: MigrateHooks): { from: number; to: number } {
  // A mistake in the set is found before anything runs, not after the migrations before it committed.
  set.migrations.forEach((migration, i) => {
    const compatibleFrom = migration.compatibleFrom ?? i + 1;
    if (!Number.isSafeInteger(compatibleFrom) || compatibleFrom < 1 || compatibleFrom > i + 1) {
      throw new Error(`Migration ${i + 1}: compatibleFrom must be between 1 and ${i + 1}`);
    }
  });
  const state = readSchemaState(db);
  if (!state.empty && state.schema !== set.schema) {
    throw new Error(
      state.schema === null
        ? `This database is not a ${set.schema} database (it has no _meta schema record)`
        : `This database is a ${state.schema} database, not a ${set.schema} database`,
    );
  }
  const n = set.migrations.length;
  const from = state.version;
  if (from > n) {
    if (state.compatibleFrom > n) {
      throw new Error(`Database schema version ${from} is newer than this build supports (${n}). Upgrade the app.`);
    }
    // A rolled-back build on a newer schema whose migrations since are additive (§10.11).
    return { from, to: from };
  }
  if (from === n) return { from, to: n };
  if (from > 0) hooks.beforeUpgrade?.(from, n);
  const now = hooks.now ?? (() => new Date().toISOString());

  for (let v = from; v < n; v++) {
    const migration = set.migrations[v]!;
    const compatibleFrom = migration.compatibleFrom ?? v + 1;
    db.tx(() => {
      refuseAsync(migration.up(db), `Migration ${v + 1}: up() must be synchronous`);
      const bad = db.all('PRAGMA foreign_key_check');
      if (bad.length > 0) throw new Error(`Migration ${v + 1} left ${bad.length} foreign key violation(s)`);
      if (v === 0) db.exec(META_DDL);
      for (const [key, value] of [
        ['schema', set.schema],
        ['version', String(v + 1)],
        ['compatible_from', String(compatibleFrom)],
        ['app_version', hooks.appVersion],
      ]) {
        db.run(META_UPSERT, { key, value });
      }
      db.run("INSERT OR IGNORE INTO _meta (key, value) VALUES ('created_at', :now)", { now: now() });
    });
  }
  return { from, to: n };
}

const deferring = new WeakSet<Db>();

/** True while `db` runs the callback of withDeferredForeignKeys (NodeDb allows the pragma only then). */
export function isDeferringForeignKeys(db: Db): boolean {
  return deferring.has(db);
}

/**
 * Run fn with foreign key checks deferred to its end (e.g. rows inserted before their parents),
 * inside a transaction: PRAGMA defer_foreign_keys = ON, fn(), PRAGMA foreign_key_check (throws on
 * violations, rolling back), PRAGMA defer_foreign_keys = OFF, all before the transaction ends. In a
 * Durable Object the pragma lasts for the whole invocation, not just transactionSync, so leaving it
 * on would defer every later violation of the request to the implicit commit, which resets the
 * object. This is the only place that may set the pragma (§3.7 rule 9).
 */
export function withDeferredForeignKeys<T>(db: Db, fn: () => T): T {
  // Nested: the outer call defers already, and checks at its end.
  if (deferring.has(db)) return db.tx(fn);
  return db.tx(() => {
    deferring.add(db);
    try {
      db.run('PRAGMA defer_foreign_keys = ON');
      try {
        const result = fn();
        const bad = db.all('PRAGMA foreign_key_check');
        if (bad.length > 0) throw new Error(`Deferred foreign key check failed: ${bad.length} violation(s)`);
        return result;
      } finally {
        db.run('PRAGMA defer_foreign_keys = OFF');
      }
    } finally {
      deferring.delete(db);
    }
  });
}
