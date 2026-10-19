// The SQL scanner and the value and quota rules both database adapters share (server/src/core/db.ts).

import { describe, expect, it } from 'vitest';
import {
  bindParams,
  DAILY_LIMIT_MESSAGE,
  DailyQuotaError,
  durableObjectHazard,
  execStatements,
  isDailyQuotaError,
  portableValue,
  refuseAsync,
  scanSql,
  singleStatement,
  wellFormed,
  type BindValue,
} from '../src/core/db';

describe('scanSql', () => {
  it('lists :name parameters by first appearance and numbers them ?N', () => {
    const scan = scanSql('SELECT :b AS b, :a AS a, :b || :a AS ba');
    expect(scan.names).toEqual(['b', 'a']);
    expect(scan.statements).toEqual(['SELECT ?1 AS b, ?2 AS a, ?1 || ?2 AS ba']);
    expect(scan.variables).toBe(2);
    expect(scan.positional).toBe(false);
    expect(scan.otherParameters).toEqual([]);
  });

  it('skips string literals, quoted names, blobs and comments', () => {
    const sql = `SELECT ':a', x':b', "c:d", [e:f], \`g:h\`, strftime('%H:%M', :t) -- :i\n/* :j */`;
    const scan = scanSql(sql);
    expect(scan.names).toEqual(['t']);
    expect(scan.statements).toEqual([sql.replace(':t)', '?1)').replace(/ -- [\s\S]*$/, '')]);
    expect(scanSql("SELECT 'it''s :x' AS v").names).toEqual([]);
    expect(scanSql("SELECT 'unterminated :x").names).toEqual([]);
  });

  it('reads the parameter forms SQLite reads, and binds only :name', () => {
    const scan = scanSql('SELECT $a, @b, #c, :1, :café, :a$b, :x::y, :ok');
    expect(scan.otherParameters).toEqual(['$a', '@b', '#c', ':1', ':café', ':a$b', ':x::y']);
    expect(scan.names).toEqual(['ok']);
    expect(scanSql('SELECT a$b, "$x", \'@y\' FROM t').otherParameters).toEqual([]);
  });

  it('counts SQL variables the way SQLite numbers them', () => {
    expect(scanSql('SELECT ?, ?, ?').variables).toBe(3);
    expect(scanSql('SELECT :a, :b, :a').variables).toBe(2);
    expect(scanSql('SELECT ?').positional).toBe(true);
    // node:sqlite 22 cannot bind ?NNN (it skips parameters with a name, and ?2 has one).
    expect(scanSql('SELECT ?5, ?').otherParameters).toEqual(['?5']);
  });

  it('records the first keyword of every statement, after EXPLAIN [QUERY PLAN]', () => {
    expect(scanSql("EXPLAIN QUERY PLAN SELECT 1; begin immediate; INSERT INTO t VALUES ('BEGIN');").leading).toEqual([
      'SELECT',
      'BEGIN',
      'INSERT',
    ]);
    // A trigger body's BEGIN, its statements and its END belong to the CREATE TRIGGER.
    expect(
      scanSql("CREATE TRIGGER x AFTER INSERT ON t BEGIN SELECT RAISE(ABORT, 'no'); END; INSERT OR ABORT INTO t VALUES (1)")
        .leading,
    ).toEqual(['CREATE', 'INSERT']);
  });

  it('splits statements at semicolons, outside literals and trigger bodies (where CASE … END nests)', () => {
    const trigger = `CREATE TEMP TRIGGER g BEFORE UPDATE ON t WHEN new.end > 0 BEGIN
      UPDATE t SET v = CASE WHEN new.v = ';' THEN 'x' ELSE CASE new.v WHEN 'a' THEN 'b' END END;
      DELETE FROM u;
    END`;
    const scan = scanSql(`-- lead\nCREATE TABLE a (x); ${trigger};\n  ; SELECT 1 /* tail */ ; -- done\n`);
    expect(scan.statements).toEqual(['CREATE TABLE a (x)', trigger, 'SELECT 1']);
    expect(scan.leading).toEqual(['CREATE', 'CREATE', 'SELECT']);
    expect(scanSql('CREATE TABLE trigger (v); END').leading).toEqual(['CREATE', 'END']);
    expect(scanSql('-- nothing\n;').statements).toEqual([]);
  });

  it('records pragmas, schema-qualified and table-valued ones included', () => {
    expect(
      scanSql('PRAGMA main.table_info(t); PRAGMA defer_foreign_keys = ON; PRAGMA foreign_keys; SELECT * FROM pragma_user_version').pragmas,
    ).toEqual([
      { name: 'table_info', hasValue: true },
      { name: 'defer_foreign_keys', hasValue: true },
      { name: 'foreign_keys', hasValue: false },
      { name: 'user_version', hasValue: false },
    ]);
  });

  it('flags what a Durable Object refuses or runs differently', () => {
    const flags = (sql: string) => {
      const { longPattern, conflictRollback, deferredKey, temporary, platformName } = scanSql(sql);
      return { longPattern, conflictRollback, deferredKey, temporary, platformName };
    };
    const none = { longPattern: false, conflictRollback: false, deferredKey: false, temporary: false, platformName: false };
    expect(flags(`SELECT 1 WHERE v LIKE '${'a'.repeat(50)}' OR v GLOB '${'ä'.repeat(25)}'`)).toEqual(none);
    expect(flags(`SELECT 1 WHERE v LIKE '${'a'.repeat(51)}'`)).toEqual({ ...none, longPattern: true });
    expect(flags(`SELECT 1 WHERE v GLOB '${'ä'.repeat(26)}'`)).toEqual({ ...none, longPattern: true });
    expect(flags(`SELECT 1 WHERE v LIKE '${"''".repeat(30)}'`)).toEqual(none);
    for (const sql of [
      "INSERT OR ROLLBACK INTO t VALUES (1)",
      'UPDATE or rollback t SET v = 1',
      'CREATE TABLE t (v UNIQUE ON CONFLICT ROLLBACK)',
      "CREATE TRIGGER g BEFORE INSERT ON t BEGIN SELECT RAISE ( ROLLBACK, 'no'); END",
    ]) {
      expect(flags(sql), sql).toEqual({ ...none, conflictRollback: true });
    }
    expect(flags("INSERT INTO t VALUES (1) ON CONFLICT DO NOTHING; SELECT RAISE(ABORT, 'x')")).toEqual(none);
    expect(flags('CREATE TABLE k (p INTEGER REFERENCES p(id) DEFERRABLE INITIALLY DEFERRED)')).toEqual({ ...none, deferredKey: true });
    expect(flags('CREATE TABLE k (p REFERENCES p NOT DEFERRABLE INITIALLY DEFERRED, q REFERENCES p DEFERRABLE INITIALLY IMMEDIATE)')).toEqual(none);
    expect(flags('CREATE TEMPORARY VIEW v AS SELECT 1')).toEqual({ ...none, temporary: true });
    expect(flags('CREATE TABLE temp_x (v)')).toEqual(none);
    expect(flags('SELECT key FROM _cf_KV')).toEqual({ ...none, platformName: true });
    expect(flags('CREATE TABLE "_CF_mine" (v)')).toEqual({ ...none, platformName: true });
    expect(flags("SELECT '_cf_' AS cf_name")).toEqual(none);
  });

  it('flags LIKE and GLOB patterns that are not one string literal', () => {
    expect(scanSql("SELECT 1 WHERE v LIKE 'a%' ESCAPE '\\' AND w NOT GLOB 'b*'").computedPattern).toBe(false);
    expect(scanSql('SELECT 1 WHERE v LIKE :p').computedPattern).toBe(true);
    expect(scanSql("SELECT 1 WHERE v LIKE '%' || :q || '%'").computedPattern).toBe(true);
    expect(scanSql('SELECT 1 WHERE v GLOB lower(:p)').computedPattern).toBe(true);
    expect(scanSql('SELECT like(:p, v) FROM t').computedPattern).toBe(true);
    expect(scanSql('SELECT t.like, "glob" FROM t').computedPattern).toBe(false);
  });

  it('records function calls, and the statement without trailing comments and semicolons', () => {
    const scan = scanSql('SELECT lyren_lower(name), COUNT(*) FROM t;  -- note\n ;\n');
    expect(scan.functions.has('lyren_lower')).toBe(true);
    expect(scan.functions.has('count')).toBe(true);
    expect(scan.statements).toEqual(['SELECT lyren_lower(name), COUNT(*) FROM t']);
  });

  it('does not take a table, view or CTE name before its column list for a function call', () => {
    const calls = (sql: string) => [...scanSql(sql).functions].sort();
    expect(calls('CREATE TABLE changes (a INTEGER, b TEXT CHECK (b IN (1, 2)))')).toEqual(['check', 'in']);
    expect(calls('CREATE TABLE IF NOT EXISTS main.total_changes (a)')).toEqual([]);
    expect(calls('INSERT INTO changes (a) VALUES (1)')).toEqual(['values']);
    expect(calls('INSERT OR IGNORE INTO main.last_insert_rowid(a) SELECT lower(:v)')).toEqual(['lower']);
    expect(calls('CREATE TABLE t (p INTEGER REFERENCES changes(id))')).toEqual([]);
    expect(calls('CREATE UNIQUE INDEX changes_a ON changes (a) WHERE a > 0')).toEqual([]);
    expect(calls('CREATE INDEX IF NOT EXISTS i ON total_changes (lower(a))')).toEqual(['lower']);
    expect(calls('CREATE VIEW changes (n) AS SELECT 1')).toEqual([]);
    // (Keywords before a parenthesis count, as IN and VALUES do above.)
    expect(calls('WITH changes(n) AS (SELECT 1), total_changes (m) AS NOT MATERIALIZED (SELECT 2) SELECT n FROM changes')).toEqual([
      'as',
      'materialized',
    ]);
    expect(calls('WITH RECURSIVE last_insert_rowid(n) AS MATERIALIZED (SELECT 1) SELECT * FROM last_insert_rowid')).toEqual(['materialized']);
    // Calls stay calls, in every position.
    expect(calls('SELECT changes() AS c, count(*) AS n, cast(x AS TEXT) FROM t')).toEqual(['cast', 'changes', 'count']);
    expect(calls('INSERT INTO t (a) SELECT total_changes()')).toEqual(['total_changes']);
    expect(calls('SELECT * FROM t JOIN json_each(:ids) j ON last_insert_rowid() = j.value')).toEqual(['json_each', 'last_insert_rowid']);
    expect(calls('WITH x AS (SELECT changes() AS n) SELECT n FROM x')).toEqual(['as', 'changes']);
    expect(calls('SELECT changes(')).toEqual(['changes']);
  });

  it('ends a trigger body at the END after its last statement, whatever columns are called', () => {
    const trigger = `CREATE TRIGGER t_h AFTER UPDATE ON t WHEN NEW.end > 0 BEGIN
      INSERT INTO h (end, n) VALUES (NEW.end, CASE WHEN NEW.end > 0 THEN 'pos' ELSE 'neg' END);
      UPDATE h SET end = end + 1 WHERE end IS NOT NULL; -- a comment before the END
    END`;
    const scan = scanSql(`${trigger}; SELECT end FROM h; END`);
    expect(scan.statements).toEqual([trigger, 'SELECT end FROM h', 'END']);
    expect(scan.leading).toEqual(['CREATE', 'SELECT', 'END']);
    expect(scanSql('CREATE TEMP TRIGGER g AFTER INSERT ON t BEGIN SELECT 1; end; SELECT 2').statements).toEqual([
      'CREATE TEMP TRIGGER g AFTER INSERT ON t BEGIN SELECT 1; end',
      'SELECT 2',
    ]);
  });

  it('measures the longest statement in UTF-8 bytes, also in its ?N form', () => {
    expect(scanSql("SELECT 'ä€'").bytes).toBe(14);
    expect(scanSql("SELECT 1; SELECT 'ä€'; SELECT 2").bytes).toBe(14);
    // The tenth name becomes ?10, one character longer than :j.
    const names = 'abcdefghij'.split('');
    const sql = `SELECT ${names.map((n) => `:${n}`).join(', ')}`;
    expect(scanSql(sql).bytes).toBe(sql.length + 1);
  });
});

describe('statements and parameters', () => {
  const values = (sql: string, params?: Parameters<typeof bindParams>[1]) =>
    bindParams(scanSql(sql), params, (v: BindValue, label) => `${label}=${String(v)}`);

  it('takes exactly one statement for all/get/run, and several without parameters for exec', () => {
    expect(singleStatement(scanSql('SELECT :a; -- note'))).toBe('SELECT ?1');
    expect(() => singleStatement(scanSql('SELECT 1; SELECT 2'))).toThrow('One statement per call');
    expect(() => singleStatement(scanSql(' -- nothing'))).toThrow('SQL contains no statement');
    expect(execStatements(scanSql('CREATE TABLE a (x); CREATE TABLE b (y)'))).toEqual(['CREATE TABLE a (x)', 'CREATE TABLE b (y)']);
    expect(() => execStatements(scanSql('INSERT INTO a VALUES (:x)'))).toThrow('exec() takes no parameters (found :x');
    expect(() => execStatements(scanSql('INSERT INTO a VALUES (?)'))).toThrow('found ?');
    expect(() => execStatements(scanSql('INSERT INTO a VALUES ($x)'))).toThrow('found $x');
  });

  it('binds :name parameters from own properties in ?N order, ignoring extra keys', () => {
    expect(values('SELECT :b, :a, :b', { a: 1, b: 2, c: 3 })).toEqual([':b=2', ':a=1']);
    expect(values('SELECT :a', { a: undefined })).toEqual([':a=undefined']);
    expect(() => values('SELECT :a', {})).toThrow('SQL parameter :a missing');
    expect(() => values('SELECT :a')).toThrow('SQL parameter :a missing');
    expect(() => values('SELECT :constructor', {})).toThrow('SQL parameter :constructor missing');
    expect(() => values('SELECT :a', Object.create({ a: 9 }) as Record<string, number>)).toThrow('SQL parameter :a missing');
    expect(() => values('SELECT :a', [1])).toThrow('takes an object, not an array');
  });

  it('binds ? parameters from an array of exactly one value each', () => {
    expect(values('SELECT ?, ?', ['x', 'y'])).toEqual(['?1=x', '?2=y']);
    expect(() => values('SELECT ?, ?', ['x'])).toThrow('SQL with 2 ? parameter(s) takes an array of 2 value(s)');
    expect(() => values('SELECT ?', ['x', 'y'])).toThrow('takes an array of 1 value(s)');
    expect(() => values('SELECT ?')).toThrow('takes an array');
    expect(() => values('SELECT ?', { a: 1 })).toThrow('takes an array');
    // A hole is not undefined: a DO would bind it as NULL, node:sqlite refuse it.
    expect(() => values('SELECT ?, ?', [, 1])).toThrow('SQL parameter ?1 missing');
  });

  it('refuses mixed and other parameter forms, and values for SQL without parameters', () => {
    expect(() => values('SELECT :a, ?', { a: 1 })).toThrow('SQL mixes :name and ? parameters');
    expect(() => values('SELECT $a', { a: 1 })).toThrow('SQL parameter $a: use the :name form');
    expect(() => values('SELECT :1', { 1: 1 })).toThrow('SQL parameter :1: use the :name form');
    expect(() => values('SELECT ?2, ?1', ['x', 'y'])).toThrow('SQL parameter ?2: use the :name form (or ?)');
    expect(values('SELECT 1')).toEqual([]);
    expect(values('SELECT 1', [])).toEqual([]);
    expect(values('SELECT 1', { unused: 1 })).toEqual([]);
    expect(() => values('SELECT 1', [1])).toThrow('SQL without parameters was given 1 value(s)');
  });
});

describe('durableObjectHazard', () => {
  const hazard = (sql: string, deferring = false) => durableObjectHazard(scanSql(sql), deferring);

  it('names SQL that a Durable Object accepts but then gets wrong', () => {
    expect(hazard('END TRANSACTION')).toMatch(/^END \(transactions use db.tx\(\)/);
    expect(hazard('SELECT 1; commit')).toMatch(/^COMMIT/);
    expect(hazard("INSERT OR ROLLBACK INTO t VALUES ('a')")).toMatch(/^ROLLBACK as a conflict resolution/);
    expect(hazard('CREATE TABLE k (p REFERENCES p DEFERRABLE INITIALLY DEFERRED)')).toMatch(/^DEFERRABLE INITIALLY DEFERRED/);
    expect(hazard('PRAGMA defer_foreign_keys = ON')).toMatch(/outside withDeferredForeignKeys/);
    expect(hazard('PRAGMA defer_foreign_keys = ON', true)).toBeNull();
    expect(hazard('PRAGMA foreign_keys = OFF')).toMatch(/^setting PRAGMA foreign_keys/);
    expect(hazard('SELECT last_insert_rowid() AS id')).toMatch(/^last_insert_rowid\(\)/);
    expect(hazard('SELECT changes(), total_changes()')).toMatch(/^changes\(\)/);
    expect(hazard('INSERT INTO changes (a) SELECT total_changes()')).toMatch(/^total_changes\(\)/);
  });

  it('passes what both runtimes run the same way', () => {
    for (const sql of [
      'PRAGMA foreign_keys',
      'PRAGMA defer_foreign_keys',
      "CREATE TRIGGER g BEFORE INSERT ON t BEGIN SELECT CASE WHEN 1 THEN RAISE(ABORT, 'no') END; END",
      'INSERT OR IGNORE INTO t VALUES (1) ON CONFLICT DO NOTHING',
      'SELECT v AS rollback_count, "end" FROM t',
      'CREATE TABLE changes (a)',
      'INSERT INTO total_changes (a) VALUES (1)',
      'WITH last_insert_rowid(n) AS (SELECT 1) SELECT n FROM last_insert_rowid',
    ]) {
      expect(hazard(sql), sql).toBeNull();
    }
  });
});

describe('refuseAsync', () => {
  it('throws for a Promise and handles its rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      expect(() => refuseAsync(Promise.reject(new Error('async failure')), 'must be synchronous')).toThrow('must be synchronous');
      expect(() => refuseAsync(42, 'must be synchronous')).not.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('portableValue', () => {
  it('binds booleans as 0/1, undefined as NULL and bigints as numbers, and passes the rest through', () => {
    expect(portableValue(true, ':a')).toBe(1);
    expect(portableValue(false, ':a')).toBe(0);
    expect(portableValue(undefined, ':a')).toBeNull();
    expect(portableValue(42n, ':a')).toBe(42);
    const bytes = new Uint8Array([1]);
    for (const v of [null, 0, 1.5, 'x', bytes]) expect(portableValue(v, ':a')).toBe(v);
  });

  it('replaces lone surrogates with U+FFFD, as node:sqlite stores them', () => {
    expect(portableValue('x\ud800y', ':a')).toBe('x\ufffdy');
    expect(wellFormed('a\udc00\ud83d\ude00\ud83d')).toBe('a\ufffd\ud83d\ude00\ufffd');
    const text = 'plain ä 😀';
    expect(wellFormed(text)).toBe(text);
  });

  it('refuses bigints outside the safe range and objects, naming the parameter', () => {
    expect(portableValue(BigInt(Number.MIN_SAFE_INTEGER), ':a')).toBe(Number.MIN_SAFE_INTEGER);
    expect(() => portableValue(BigInt(Number.MAX_SAFE_INTEGER) + 1n, ':big')).toThrow(new RangeError('SQL parameter :big is a bigint outside the safe integer range'));
    expect(() => portableValue({} as never, '?2')).toThrow(TypeError);
    expect(() => portableValue(new ArrayBuffer(1) as never, '?2')).toThrow(/SQL parameter \?2 cannot be bound/);
  });
});

describe('daily quota errors', () => {
  it('recognizes the platform\'s "exceeded" quota messages and nothing else', () => {
    expect(isDailyQuotaError(new Error('Exceeded allowed rows read in Durable Objects free tier.'))).toBe(true);
    expect(isDailyQuotaError(new Error('Exceeded allowed rows written in Durable Objects free tier.'))).toBe(true);
    expect(isDailyQuotaError('Daily quota exceeded')).toBe(true);
    expect(isDailyQuotaError(new Error('database or disk is full: SQLITE_FULL'))).toBe(false);
    expect(isDailyQuotaError(new Error('Worker exceeded resource limits'))).toBe(false);
    expect(isDailyQuotaError(new Error('rows read: 5'))).toBe(false);
    expect(isDailyQuotaError(undefined)).toBe(false);
  });

  it('DailyQuotaError carries the user-facing message and the original error', () => {
    const cause = new Error('Exceeded allowed rows written in Durable Objects free tier.');
    const err = new DailyQuotaError(cause);
    expect(err.name).toBe('DailyQuotaError');
    expect(err.message).toBe(DAILY_LIMIT_MESSAGE);
    expect(err.cause).toBe(cause);
  });
});
