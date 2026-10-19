// NodeDb's portability checks (design §9.4): SQL a Durable Object would reject throws on Node too,
// while the test suite runs (VITEST) or with LYREN_DB_STRICT=1. The Db contract
// (contract/db.contract.ts) covers what both adapters share; these are the Node-side details.

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withDeferredForeignKeys } from '../src/core/migrate';
import { DatabaseGone, existingFileUri, NodeDb, openExclusive, uriFilenames } from '../src/runtime/node/nodeDb';

const NOT_PORTABLE = /Not portable to a Durable Object/;

function strictDb(): NodeDb {
  const db = new NodeDb(':memory:', { strict: true });
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  return db;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('NodeDb portability checks', () => {
  it('are on under vitest or with LYREN_DB_STRICT=1, and off otherwise', () => {
    expect(new NodeDb(':memory:').strict).toBe(true);
    vi.stubEnv('VITEST', '');
    vi.stubEnv('LYREN_DB_STRICT', '');
    expect(new NodeDb(':memory:').strict).toBe(false);
    vi.stubEnv('LYREN_DB_STRICT', '1');
    expect(new NodeDb(':memory:').strict).toBe(true);
    expect(new NodeDb(':memory:', { strict: false }).strict).toBe(false);
  });

  it('1: refuse more than 100 parameters', () => {
    const db = strictDb();
    const names = Array.from({ length: 101 }, (_, i) => `p${i}`);
    const sql = `SELECT json_array(${names.map((n) => `:${n}`).join(', ')}) AS v`;
    const params = Object.fromEntries(names.map((n) => [n, 1]));
    expect(() => db.get(sql, params)).toThrow(/101 parameters, at most 100/);
    expect(new NodeDb(':memory:', { strict: false }).get(sql, params)).toBeDefined();
  });

  it('2: refuse a statement over 100,000 bytes', () => {
    const sql = `SELECT '${'ä'.repeat(50_000)}' AS v`;
    expect(() => strictDb().get(sql)).toThrow(/100014 bytes/);
    expect(new NodeDb(':memory:', { strict: false }).get(sql)).toBeDefined();
  });

  it('3: refuse transaction statements, VACUUM, ATTACH and DETACH, also inside exec text', () => {
    const db = strictDb();
    for (const sql of ['BEGIN', 'begin immediate', 'COMMIT', 'END', 'end transaction', 'ROLLBACK', 'SAVEPOINT a', 'RELEASE a', 'VACUUM']) {
      expect(() => db.run(sql), sql).toThrow(NOT_PORTABLE);
    }
    expect(() => db.exec("CREATE TABLE a (x); ATTACH DATABASE ':memory:' AS o")).toThrow(/ATTACH/);
    expect(db.get("SELECT name FROM sqlite_master WHERE name = 'a'")).toBeUndefined();
    // Not statements: a trigger body (its BEGIN and END), a conflict clause and literals.
    db.exec(`CREATE TRIGGER t_guard BEFORE DELETE ON t BEGIN SELECT RAISE(ABORT, 'kept'); END`);
    db.run("INSERT OR ABORT INTO t (v) VALUES ('BEGIN; VACUUM')");
    expect(db.inTransaction).toBe(false);
  });

  it('3: refuse ROLLBACK as a conflict resolution, which a Durable Object applies to the whole invocation', () => {
    const db = strictDb();
    for (const sql of [
      "INSERT OR ROLLBACK INTO t (v) VALUES ('a')",
      "UPDATE OR ROLLBACK t SET v = 'b'",
      'CREATE TABLE u (v TEXT UNIQUE ON CONFLICT ROLLBACK)',
      "CREATE TRIGGER g BEFORE INSERT ON t BEGIN SELECT RAISE(ROLLBACK, 'no'); END",
    ]) {
      expect(() => db.exec(sql), sql).toThrow(/ROLLBACK as a conflict resolution/);
    }
    expect(db.all("SELECT name FROM sqlite_master WHERE name IN ('u', 'g')")).toEqual([]);
  });

  it('4: refuse pragmas outside the Durable Object allowlist; raw is not checked', () => {
    const db = strictDb();
    for (const sql of ['PRAGMA user_version', 'PRAGMA user_version = 2', 'PRAGMA journal_mode', 'PRAGMA busy_timeout = 1', 'PRAGMA integrity_check']) {
      expect(() => db.get(sql), sql).toThrow(NOT_PORTABLE);
    }
    expect(() => db.get('SELECT user_version FROM pragma_user_version')).toThrow(/PRAGMA user_version/);
    expect(() => db.exec('PRAGMA synchronous = OFF')).toThrow(NOT_PORTABLE);
    expect(db.all<{ name: string }>('PRAGMA main.table_info(t)').map((c) => c.name)).toEqual(['id', 'v']);
    expect(db.get('SELECT COUNT(*) AS n FROM pragma_table_info(:t)', { t: 't' })).toEqual({ n: 2 });
    expect(db.raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: 0 });
  });

  it('4: refuse setting PRAGMA foreign_keys (a no-op in a Durable Object), but allow reading it', () => {
    const db = strictDb();
    db.exec('CREATE TABLE c (id INTEGER PRIMARY KEY, t_id INTEGER REFERENCES t(id))');
    for (const sql of ['PRAGMA foreign_keys = OFF', 'PRAGMA foreign_keys(0)', 'PRAGMA main.foreign_keys = ON']) {
      expect(() => db.exec(sql), sql).toThrow(/setting PRAGMA foreign_keys/);
    }
    expect(db.get('PRAGMA foreign_keys')).toEqual({ foreign_keys: 1 });
    expect(() => db.run('INSERT INTO c (t_id) VALUES (99)')).toThrow(/FOREIGN KEY/);
  });

  it('5: refuse objects and unsafe bigints as values', () => {
    const db = strictDb();
    expect(() => db.run('INSERT INTO t (v) VALUES (:v)', { v: { x: 1 } as never })).toThrow(TypeError);
    expect(() => db.run('INSERT INTO t (v) VALUES (?)', [new Date() as never])).toThrow(/SQL parameter \?1/);
    expect(() => db.run('INSERT INTO t (id) VALUES (:id)', { id: 2n ** 62n })).toThrow(RangeError);
    // node:sqlite itself stores a 64-bit integer exactly; only the check refuses it.
    const loose = new NodeDb(':memory:', { strict: false });
    expect(loose.get<{ v: number }>('SELECT :v - 1 AS v', { v: 2n ** 53n })!.v).toBe(2 ** 53 - 1);
  });

  it('6: refuse LIKE and GLOB with a bound or computed pattern', () => {
    const db = strictDb();
    expect(() => db.all('SELECT v FROM t WHERE like(:p, v)', { p: 'a%' })).toThrow(/LIKE or GLOB/);
    expect(db.all("SELECT v FROM t WHERE v LIKE 'a\\_%' ESCAPE '\\'")).toEqual([]);
    // A literal pattern is checkable: a DO refuses one over 50 bytes when it runs.
    expect(() => db.all(`SELECT v FROM t WHERE v LIKE '${'a'.repeat(51)}'`)).toThrow(/LIKE or GLOB pattern over 50 bytes/);
    expect(db.all(`SELECT v FROM t WHERE v GLOB '${'a'.repeat(50)}'`)).toEqual([]);
  });

  it('7: allow setting defer_foreign_keys only inside withDeferredForeignKeys', () => {
    const db = strictDb();
    expect(() => db.run('PRAGMA defer_foreign_keys = ON')).toThrow(/withDeferredForeignKeys/);
    expect(() => db.exec('PRAGMA defer_foreign_keys(1)')).toThrow(/withDeferredForeignKeys/);
    expect(db.get('PRAGMA defer_foreign_keys')).toEqual({ defer_foreign_keys: 0 });
    expect(withDeferredForeignKeys(db, () => db.get('PRAGMA defer_foreign_keys'))).toEqual({ defer_foreign_keys: 1 });
    // The same statement text, cached by the helper's call, is refused again outside it.
    expect(() => db.run('PRAGMA defer_foreign_keys = ON')).toThrow(/withDeferredForeignKeys/);
    expect(() => db.exec('CREATE TABLE k (t_id REFERENCES t(id) DEFERRABLE INITIALLY DEFERRED)')).toThrow(
      /DEFERRABLE INITIALLY DEFERRED/,
    );
  });

  it('8: refuse last_insert_rowid(), changes() and total_changes()', () => {
    const db = strictDb();
    db.run("INSERT INTO t (v) VALUES ('a')");
    expect(() => db.get('SELECT last_insert_rowid() AS id')).toThrow(/last_insert_rowid\(\)/);
    expect(() => db.run('INSERT INTO t (v) SELECT changes()')).toThrow(/changes\(\)/);
    expect(db.run("INSERT INTO t (v) VALUES ('b')").lastInsertRowid).toBe(2);
  });

  it('9: refuse CREATE TEMP and _cf_ names', () => {
    const db = strictDb();
    expect(() => db.exec('CREATE TEMP TABLE tt (x)')).toThrow(/CREATE TEMP/);
    expect(() => db.exec('CREATE TEMPORARY TRIGGER tg AFTER INSERT ON t BEGIN SELECT 1; END')).toThrow(/CREATE TEMP/);
    expect(() => db.exec('CREATE TABLE _cf_mine (x)')).toThrow(/_cf_/);
    expect(() => db.get('SELECT key FROM "_cf_KV"')).toThrow(/_cf_/);
  });

  describe('10: a Durable Object\'s SQLite limits and authorizer, on Node 24.15 and later', () => {
    const emulates = new NodeDb(':memory:', { strict: true }).emulatesDurableObject;
    const union = (n: number) => Array.from({ length: n }, (_, i) => `SELECT ${i} AS v`).join(' UNION ALL ');

    it('are on in strict mode only', () => {
      expect(new NodeDb(':memory:', { strict: false }).emulatesDurableObject).toBe(false);
      expect(new NodeDb(':memory:', { strict: false }).all(union(6))).toHaveLength(6);
      const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
      expect(emulates).toBe(major > 24 || (major === 24 && minor >= 15));
    });

    it.runIf(emulates)('apply while checked SQL runs; raw, tx() and backupTo() keep Node\'s own', () => {
      const db = strictDb();
      expect(() => db.all(union(6))).toThrow('too many terms in compound SELECT');
      expect(() => db.get('SELECT sqlite_version() AS v')).toThrow(
        'Not portable to a Durable Object: the SQL function sqlite_version()',
      );
      expect(() => db.exec('CREATE VIRTUAL TABLE f USING fts4(body)')).toThrow('virtual tables using fts4');
      expect(() => db.exec('CREATE TABLE x (v); CREATE TABLE temp.y (v)')).toThrow('temporary tables, views and triggers');
      expect(db.raw.prepare(union(6)).all()).toHaveLength(6);
      expect(db.raw.prepare('SELECT sqlite_version() AS v').get()).toBeDefined();
      expect(db.raw.limits.compoundSelect).toBeGreaterThan(5);
      db.tx(() => db.tx(() => db.run("INSERT INTO t (v) VALUES ('nested')")));
      expect(db.all('SELECT v FROM t')).toEqual([{ v: 'nested' }]);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyren-nodedb-'));
      try {
        const file = path.join(dir, 'copy.db');
        db.backupTo(file);
        expect(fs.statSync(file).size).toBeGreaterThan(0);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it('refuse lyren_lower(), which the fold columns replaced (design §3.4), and no longer register it', () => {
    expect(() => strictDb().get("SELECT lyren_lower('ÄRGER') AS v")).toThrow(/Not portable.*lyren_lower/);
    expect(() => new NodeDb(':memory:', { strict: false }).get("SELECT lyren_lower('A') AS v")).toThrow(/no such function/);
  });

  it('refuse a statement every time, without caching it', () => {
    const db = strictDb();
    expect(() => db.get('PRAGMA user_version')).toThrow(NOT_PORTABLE);
    expect(() => db.get('PRAGMA user_version')).toThrow(NOT_PORTABLE);
  });
});

describe('openExclusive (design §3.8: the legacy upgrade, a restore\'s apply)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyren-exclusive-'));
    dirs.push(dir);
    return dir;
  }
  function database(file: string, v: string): void {
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE t (v TEXT); INSERT INTO t (v) VALUES ('${v}')`);
    db.close();
  }

  it('opens by URI where node:sqlite takes URI filenames (Node 22.13\'s does not), and asking creates no file', () => {
    const file = path.join(tempDir(), 'a.db');
    database(file, 'a');
    let opens: boolean;
    try {
      new DatabaseSync(`file:${file}?mode=ro`).close();
      opens = true;
    } catch {
      opens = false;
    }
    expect(uriFilenames()).toBe(opens);
    // Read as a plain name, the question is a path below the working folder's "file:".
    expect(fs.existsSync(path.join(process.cwd(), 'file:'))).toBe(false);
  });

  describe.each(uriFilenames() ? [true, false] : [false])('opening by URI: %s', (uri) => {
    it('a missing file gives null and is not created, nor its folder; odd names open as they are', () => {
      const dir = tempDir();
      const file = path.join(dir, 'folder', 'lyren.db');
      expect(openExclusive(file, 50, { uriFilenames: uri })).toBeNull();
      expect(fs.existsSync(path.dirname(file))).toBe(false);
      const odd = path.join(dir, 'a 100%20 ?b#c.db');
      database(odd, 'odd');
      const lock = openExclusive(odd, 50, { uriFilenames: uri })!;
      try {
        expect(lock.get('SELECT v FROM t')).toEqual({ v: 'odd' });
      } finally {
        lock.close();
      }
      expect(fs.readdirSync(dir).sort()).toEqual(['a 100%20 ?b#c.db']);
    });

    it('waits outside SQLite, opening the file anew each time: what is renamed over the name meanwhile is what it locks', async () => {
      const dir = tempDir();
      const file = path.join(dir, 'lyren.db');
      const next = path.join(dir, 'next.db');
      database(file, 'old');
      database(next, 'new');
      // Another process holds the file, then renames another one over its name (as the upgrade's swap does).
      const holder = spawn(
        process.execPath,
        [
          '-e',
          `const { DatabaseSync } = require('node:sqlite');
           const fs = require('node:fs');
           const [file, next] = process.argv.slice(1);
           const db = new DatabaseSync(file);
           db.exec('PRAGMA locking_mode = EXCLUSIVE');
           db.exec('BEGIN EXCLUSIVE');
           console.log('locked');
           setTimeout(() => { fs.renameSync(next, file); db.exec('COMMIT'); db.close(); }, 300);`,
          file,
          next,
        ],
        { stdio: ['ignore', 'pipe', 'inherit'] },
      );
      const exited = once(holder, 'exit');
      await once(holder.stdout!, 'data');
      const lock = openExclusive(file, 5000, { uriFilenames: uri });
      try {
        expect(lock).not.toBeNull();
        expect(lock!.get('SELECT v FROM t')).toEqual({ v: 'new' });
      } finally {
        lock?.close();
      }
      expect((await exited)[0]).toBe(0);
    });
  });

  // Node 22.13's path: SQLite creates the file when the name is gone by the time it opens.
  describe('without URI filenames, a file moved away just before the open', () => {
    /** The name is moved away (and `replace` moved in) right after the `nth` look at it (openExisting's first). */
    function moveAwayAtStat(file: string, away: string, o: { replace?: string; nth?: number } = {}): void {
      const statSync = fs.statSync;
      let calls = 0;
      vi.spyOn(fs, 'statSync').mockImplementation(((p: fs.PathLike, options?: fs.StatSyncOptions) => {
        const stats = statSync(p, options);
        if (++calls === (o.nth ?? 1)) {
          fs.renameSync(file, away);
          if (o.replace) fs.renameSync(o.replace, file);
        }
        return stats;
      }) as typeof fs.statSync);
    }
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('throws DatabaseGone and removes the empty file SQLite created; openExclusive gives null', () => {
      const dir = tempDir();
      const file = path.join(dir, 'lyren.db');
      const away = path.join(dir, 'moved.db');
      database(file, 'mine');
      moveAwayAtStat(file, away);
      expect(() => new NodeDb(file, { create: false, uriFilenames: false })).toThrow(DatabaseGone);
      expect(fs.readdirSync(dir).sort()).toEqual(['moved.db']);
      // The same through openExclusive, whose own look comes first.
      vi.restoreAllMocks();
      fs.renameSync(away, file);
      moveAwayAtStat(file, away, { nth: 2 });
      expect(openExclusive(file, 50, { uriFilenames: false })).toBeNull();
      vi.restoreAllMocks();
      expect(fs.readdirSync(dir).sort()).toEqual(['moved.db']);
      const moved = new DatabaseSync(away, { readOnly: true });
      expect(moved.prepare('SELECT v FROM t').get()).toEqual({ v: 'mine' });
      moved.close();
    });

    it("never removes another start's database that took the name", () => {
      const dir = tempDir();
      const file = path.join(dir, 'lyren.db');
      const restored = path.join(dir, 'restored.db');
      database(file, 'old');
      database(restored, 'restored');
      moveAwayAtStat(file, path.join(dir, 'moved.db'), { replace: restored });
      expect(() => new NodeDb(file, { create: false, uriFilenames: false })).toThrow(DatabaseGone);
      expect(fs.readdirSync(dir).sort()).toEqual(['lyren.db', 'moved.db']);
      const now = new DatabaseSync(file, { readOnly: true });
      expect(now.prepare('SELECT v FROM t').get()).toEqual({ v: 'restored' });
      now.close();
    });
  });

  it('the URI of an existing file: absolute, percent-encoded where SQLite would cut it, \\\\?\\ on Windows', () => {
    expect(existingFileUri('/srv/lyren/a%b?c#d.db', 'linux')).toBe('file:/srv/lyren/a%25b%3Fc%23d.db?mode=rw');
    expect(existingFileUri('C:\\Users\\ann\\Lyren Plan\\lyren.db', 'win32')).toBe('file:\\\\%3F\\C:\\Users\\ann\\Lyren Plan\\lyren.db?mode=rw');
    expect(existingFileUri('\\\\nas\\share\\lyren.db', 'win32')).toBe('file:\\\\%3F\\UNC\\nas\\share\\lyren.db?mode=rw');
  });
});
