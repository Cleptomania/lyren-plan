// The one synchronous database interface (design §2.3). NodeDb (runtime/node/nodeDb.ts, node:sqlite)
// and DoDb (runtime/cloudflare/doDb.ts, a Durable Object's SQLite storage) implement it.
//
// - Named parameters use the :name form in SQL and a plain object in JS:
//     db.get('SELECT * FROM tasks WHERE id = :id', { id })
//   A named parameter that is MISSING from the object throws (catches typos); EXTRA keys are
//   ignored, so one params object may serve several statements. Positional `?` parameters take an
//   array with exactly one value per parameter. The two forms don't mix, and no other form ($name,
//   @name, :1, ?2) is accepted.
// - all/get/run take one statement; exec() takes several, without parameters (DDL).
// - Booleans bind as 0/1 and undefined as NULL. Numbers (bigints too) bind as REAL on both runtimes,
//   so SQL must not concatenate numeric parameters into text (it would read '42.0').
// - Integers must stay within ±(2^53 - 1): node:sqlite throws a RangeError when it reads a larger
//   one, a Durable Object rounds it silently.
// - Rows come back as objects without a prototype, with snake_case column names.
// - tx() nests (savepoint semantics) and must be given a synchronous function.
//
// Also here, because both adapters use them: the SQL scanner (parameters, statements and their
// keywords, pragmas, LIKE patterns and other forms a Durable Object treats differently, outside
// literals and comments), the parameter and value rules, the SQL a Durable Object accepts but then
// gets wrong, and the daily-quota error.

export type SqlValue = null | number | bigint | string | Uint8Array;
/** Booleans bind 0/1, undefined binds NULL. */
export type BindValue = SqlValue | boolean | undefined;
export type SqlParams = Record<string, BindValue> | readonly BindValue[];

export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

export interface Db {
  readonly kind: 'node' | 'durable-object';
  all<T = Record<string, unknown>>(sql: string, params?: SqlParams): T[];
  get<T = Record<string, unknown>>(sql: string, params?: SqlParams): T | undefined;
  run(sql: string, params?: SqlParams): RunResult;
  /** DDL only; no parameters; may hold several statements. */
  exec(sql: string): void;
  /** Nests (savepoint semantics); fn must be synchronous. */
  tx<T>(fn: () => T): T;
  readonly inTransaction: boolean;
  /**
   * Cumulative rows read/written as the platform bills them. DoDb only (sums cursor.rowsRead and
   * rowsWritten); undefined on NodeDb. Used by the space write budget and the cost tests. get()
   * bills every row its statement yields (DoDb drains the cursor), so a lookup that can match many
   * rows says LIMIT 1. A statement that fails at once (a write that breaks a constraint) is not
   * metered; one that fails part way through its rows is, up to there.
   */
  readonly meter?: { rowsRead: number; rowsWritten: number };
}

/** Durable Object SQL limits that a statement can break (workerd's sqlite3_limit settings). */
export const SQL_LIMITS = {
  /** Distinct bound parameters per statement. */
  maxParameters: 100,
  /** Statement text, in UTF-8 bytes. */
  maxStatementBytes: 100_000,
  /** A LIKE or GLOB pattern, in UTF-8 bytes. */
  maxPatternBytes: 50,
} as const;

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

export interface SqlScan {
  /** Distinct :name parameters in order of first appearance (SQLite numbers them that way). */
  readonly names: readonly string[];
  /**
   * Parameters in another form than :name and ? ($name, @name, :1, non-ASCII names, and ?NNN, which
   * node:sqlite 22 cannot bind), as written.
   */
  readonly otherParameters: readonly string[];
  /** Number of SQL variables SQLite allocates (distinct :names and ?s). */
  readonly variables: number;
  /** The text uses `?` parameters. */
  readonly positional: boolean;
  /**
   * Each statement as a Durable Object is sent it: every :name replaced by ?N (N being its 1-based
   * position in `names`), without the comments, whitespace and semicolons around it (a DO refuses
   * text that ends in a comment). A CREATE TRIGGER's BEGIN … END body is part of its statement.
   */
  readonly statements: readonly string[];
  /** Upper-cased first keyword of every statement (after EXPLAIN [QUERY PLAN]). */
  readonly leading: readonly string[];
  /**
   * Lower-cased pragma names, from `PRAGMA x` and from `pragma_x` table-valued functions. `hasValue`:
   * followed by `= v` or `(v)` (which sets a flag pragma; table_info(t) and the like take an argument).
   */
  readonly pragmas: ReadonlyArray<{ name: string; hasValue: boolean }>;
  /**
   * Lower-cased names followed by `(` that call a function (and keywords such as IN or VALUES), but
   * not names that name a table with its column list: CREATE TABLE t (…), INSERT INTO t (…),
   * REFERENCES t (…), CREATE INDEX i ON t (…), CREATE VIEW v (…), a CTE's t (…) AS (…), or a
   * schema-qualified name (functions have no schema).
   */
  readonly functions: ReadonlySet<string>;
  /** Some LIKE or GLOB has a pattern that is not one string literal (a parameter, `||`, a call). */
  readonly computedPattern: boolean;
  /** Some LIKE or GLOB has a literal pattern over SQL_LIMITS.maxPatternBytes. */
  readonly longPattern: boolean;
  /** ROLLBACK as a conflict resolution: OR ROLLBACK, ON CONFLICT ROLLBACK or RAISE(ROLLBACK, …). */
  readonly conflictRollback: boolean;
  /** A foreign key declared DEFERRABLE INITIALLY DEFERRED. */
  readonly deferredKey: boolean;
  /** CREATE TEMP or CREATE TEMPORARY. */
  readonly temporary: boolean;
  /** A name that starts with _cf_ (a Durable Object's own tables). */
  readonly platformName: boolean;
  /** UTF-8 length of the longest statement, as written or as sent (?N can be longer than :n). */
  readonly bytes: number;
}

type TokenKind = 'word' | 'quoted' | 'string' | 'number' | 'named' | 'variable' | 'positional' | 'op';

interface Token {
  kind: TokenKind;
  text: string;
  start: number;
  end: number;
}

// One alternative per token class; whitespace and comments are matched and skipped. The blob
// literal (x'…') comes before words so that it is read as one literal. A parameter is read the way
// SQLite reads one: a prefix (: @ $ #) and then identifier characters, `$` and `::` included.
const TOKEN_RE =
  /\s+|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|[xX]?'(?:[^']|'')*(?:'|$)|"(?:[^"]|"")*(?:"|$)|`(?:[^`]|``)*(?:`|$)|\[[^\]]*(?:\]|$)|[:@$#](?:[\w$\u0080-￿]|::)+|\?\d*|0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|[A-Za-z_\u0080-￿][\w$\u0080-￿]*|\|\||[\s\S]/y;

/** The one parameter form both adapters bind: a colon and an ASCII identifier. */
const NAMED_RE = /^:[A-Za-z_]\w*$/;
const PLATFORM_NAME_RE = /^_cf_/i;

function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  TOKEN_RE.lastIndex = 0;
  for (let m = TOKEN_RE.exec(sql); m !== null; m = TOKEN_RE.exec(sql)) {
    const text = m[0];
    const start = m.index;
    const end = start + text.length;
    const c = text[0]!;
    let kind: TokenKind;
    if (/\s/.test(c) || text.startsWith('--') || text.startsWith('/*')) continue;
    else if (c === "'" || ((c === 'x' || c === 'X') && text[1] === "'")) kind = 'string';
    else if (c === '"' || c === '`' || c === '[') kind = 'quoted';
    else if (':@$#'.includes(c) && text.length > 1) kind = NAMED_RE.test(text) ? 'named' : 'variable';
    else if (c === '?') kind = text.length > 1 ? 'variable' : 'positional';
    else if (/[0-9]/.test(c) || (c === '.' && text.length > 1)) kind = 'number';
    else if (/[A-Za-z_\u0080-￿]/.test(c)) kind = 'word';
    else kind = 'op';
    tokens.push({ kind, text, start, end });
  }
  return tokens;
}

const isKeyword = (t: Token | undefined, upper: string): boolean =>
  t?.kind === 'word' && t.text.toUpperCase() === upper;
const isOp = (t: Token | undefined, op: string): boolean => t?.kind === 'op' && t.text === op;

/** Keywords after which a name followed by `(` is a table or view and its column list. */
const NAME_BEFORE_COLUMNS = ['TABLE', 'VIEW', 'INTO', 'REFERENCES', 'EXISTS'];

/**
 * Whether the word at `i`, which is followed by `(`, names a table, view or CTE with its column
 * list instead of calling a function. `creating`: the kind of object the statement creates
 * (CREATE [UNIQUE] INDEX i ON t (…) names the table after ON).
 */
function namesColumns(tokens: readonly Token[], i: number, creating: string | null): boolean {
  const prev = tokens[i - 1];
  if (isOp(prev, '.')) return true;
  if (NAME_BEFORE_COLUMNS.some((keyword) => isKeyword(prev, keyword))) return true;
  if (creating === 'INDEX' && isKeyword(prev, 'ON')) return true;
  // WITH t (a, b) AS [NOT] [MATERIALIZED] (…): no call is followed by AS and then a parenthesis.
  let depth = 0;
  let close = i + 1;
  for (; close < tokens.length; close++) {
    if (isOp(tokens[close], '(')) depth++;
    else if (isOp(tokens[close], ')') && --depth === 0) break;
  }
  const after = tokens[close + 2];
  if (!isKeyword(tokens[close + 1], 'AS')) return false;
  return isOp(after, '(') || isKeyword(after, 'NOT') || isKeyword(after, 'MATERIALIZED');
}

const utf8 = new TextEncoder();
const utf8Length = (text: string): number => utf8.encode(text).length;

/** The value of a string literal token ('it''s' → it's). */
const literalValue = (t: Token): string => (t.text.startsWith("'") ? t.text.slice(1, -1).replaceAll("''", "'") : '');

/**
 * Read a statement text once: its parameters and statements (with the ?N rewrite a positional
 * engine needs), the keyword each statement starts with, its pragmas and function calls, and the
 * forms a Durable Object refuses or runs differently. String literals, quoted names and comments
 * are skipped, so ':x' or 'BEGIN' inside them count for nothing.
 */
export function scanSql(sql: string): SqlScan {
  const tokens = tokenize(sql);
  const names: string[] = [];
  const otherParameters: string[] = [];
  const statements: string[] = [];
  const leading: string[] = [];
  const pragmas: Array<{ name: string; hasValue: boolean }> = [];
  const functions = new Set<string>();
  let variables = 0;
  let positional = false;
  let computedPattern = false;
  let longPattern = false;
  let conflictRollback = false;
  let deferredKey = false;
  let temporary = false;
  let platformName = false;
  let bytes = 0;

  // The statement being read: where it starts (-1 between statements) and ends so far, its ?N form
  // up to `copied`, whether its keyword is still to come, what a CREATE statement creates, and for a
  // CREATE TRIGGER where the reading is: before its BEGIN, in its body (whose `;` don't end the
  // statement) or after the END that closes the body. That END is the one right after a `;`: every
  // statement of a body ends with one, and no statement starts with END, so neither CASE … END nor
  // a column named end (INSERT INTO h (end) VALUES (NEW.end)) can close it.
  let start = -1;
  let end = 0;
  let numbered = '';
  let copied = 0;
  let keyword: string | null = null;
  let creating: string | null = null;
  let trigger: 'none' | 'header' | 'body' | 'done' = 'none';

  const finish = () => {
    if (start < 0) return;
    const text = numbered + sql.slice(copied, end);
    statements.push(text);
    bytes = Math.max(bytes, utf8Length(sql.slice(start, end)), utf8Length(text));
    start = -1;
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (isOp(t, ';') && trigger !== 'body') {
      finish();
      continue;
    }
    if (start < 0) {
      start = t.start;
      numbered = '';
      copied = t.start;
      keyword = null;
      creating = null;
      trigger = 'none';
    }
    end = t.end;
    const prev = tokens[i - 1];
    const next = tokens[i + 1];
    const upper = t.kind === 'word' ? t.text.toUpperCase() : '';

    if (keyword === null) {
      // EXPLAIN [QUERY PLAN] <statement>: the statement's own keyword decides.
      if (
        upper === 'EXPLAIN' ||
        (upper === 'QUERY' && isKeyword(prev, 'EXPLAIN')) ||
        (upper === 'PLAN' && isKeyword(prev, 'QUERY'))
      ) {
        continue;
      }
      keyword = upper;
      leading.push(upper);
      if (upper === 'PRAGMA') {
        // PRAGMA [schema.]name [= value | (value)]
        let at = i + 1;
        if (isOp(tokens[at + 1], '.')) at += 2;
        const nameToken = tokens[at];
        if (nameToken && (nameToken.kind === 'word' || nameToken.kind === 'quoted')) {
          const name = (nameToken.kind === 'quoted' ? nameToken.text.slice(1, -1) : nameToken.text).toLowerCase();
          pragmas.push({ name, hasValue: isOp(tokens[at + 1], '=') || isOp(tokens[at + 1], '(') });
        }
      }
    }

    switch (t.kind) {
      case 'named': {
        const name = t.text.slice(1);
        let index = names.indexOf(name);
        if (index < 0) {
          index = names.push(name) - 1;
          variables++;
        }
        numbered += `${sql.slice(copied, t.start)}?${index + 1}`;
        copied = t.end;
        break;
      }
      case 'variable':
        if (!otherParameters.includes(t.text)) otherParameters.push(t.text);
        break;
      case 'positional':
        positional = true;
        variables++;
        break;
      case 'quoted':
        if (PLATFORM_NAME_RE.test(t.text.slice(1))) platformName = true;
        break;
      case 'word': {
        const lower = t.text.toLowerCase();
        const qualified = isOp(prev, '.');
        if (isOp(next, '(') && !namesColumns(tokens, i, creating)) functions.add(lower);
        if (PLATFORM_NAME_RE.test(t.text)) platformName = true;
        if (lower.startsWith('pragma_') && !qualified) pragmas.push({ name: lower.slice(7), hasValue: false });
        if ((lower === 'like' || lower === 'glob') && !qualified) {
          // Only `LIKE 'literal'` is checkable: a DO refuses patterns over 50 bytes at run time.
          if (next?.kind !== 'string' || isOp(tokens[i + 2], '||')) computedPattern = true;
          else if (utf8Length(literalValue(next)) > SQL_LIMITS.maxPatternBytes) longPattern = true;
        }
        if (
          lower === 'rollback' &&
          (isKeyword(prev, 'OR') || isKeyword(prev, 'CONFLICT') || (isOp(prev, '(') && isKeyword(tokens[i - 2], 'RAISE')))
        ) {
          conflictRollback = true;
        }
        if (
          lower === 'deferred' &&
          isKeyword(prev, 'INITIALLY') &&
          isKeyword(tokens[i - 2], 'DEFERRABLE') &&
          !isKeyword(tokens[i - 3], 'NOT')
        ) {
          deferredKey = true;
        }
        // CREATE [TEMP | TEMPORARY] [UNIQUE | VIRTUAL] TABLE | INDEX | VIEW | TRIGGER …, and a
        // trigger's BEGIN <statements> END
        if (keyword === 'CREATE' && creating === null && ['TABLE', 'INDEX', 'VIEW', 'TRIGGER'].includes(upper)) {
          creating = upper;
          if (upper === 'TRIGGER') trigger = 'header';
        }
        if (keyword === 'CREATE' && (upper === 'TEMP' || upper === 'TEMPORARY') && isKeyword(prev, 'CREATE')) temporary = true;
        if (trigger === 'header' && upper === 'BEGIN' && !qualified) trigger = 'body';
        else if (trigger === 'body' && upper === 'END' && isOp(prev, ';')) trigger = 'done';
        break;
      }
      default:
        break;
    }
  }
  finish();

  return {
    names,
    otherParameters,
    variables,
    positional,
    statements,
    leading,
    pragmas,
    functions,
    computedPattern,
    longPattern,
    conflictRollback,
    deferredKey,
    temporary,
    platformName,
    bytes,
  };
}

// ---------------------------------------------------------------------------
// Statements and parameters (both adapters, always)
// ---------------------------------------------------------------------------

/**
 * The one statement of an all/get/run call, as a Durable Object is sent it. Text with several
 * statements is refused: node:sqlite would run only the first, a DO all of them.
 */
export function singleStatement(scan: SqlScan): string {
  const [statement] = scan.statements;
  if (statement === undefined) throw new Error('SQL contains no statement');
  if (scan.statements.length > 1) throw new Error('One statement per call: exec() runs several (DDL, without parameters)');
  return statement;
}

/**
 * The statements of an exec() text, which takes no parameters: node:sqlite would bind them as
 * NULL, a DO would throw after running the statements before.
 */
export function execStatements(scan: SqlScan): readonly string[] {
  const parameter = scan.names.length > 0 ? `:${scan.names[0]}` : scan.positional ? '?' : scan.otherParameters[0];
  if (parameter !== undefined) throw new Error(`exec() takes no parameters (found ${parameter}; run() binds them)`);
  return scan.statements;
}

/**
 * The values of one all/get/run call, in SQLite's parameter order (the Nth :name is ?N), each
 * passed through `bind` with its label (':name' or '?2'). Both adapters apply the same rules, so
 * that SQL which runs on one runs the same way on the other (node:sqlite would otherwise bind what
 * is missing as NULL, a DO throw):
 * - parameters are :name or ?, not both, and no other form;
 * - ? parameters take an array with exactly one value per parameter;
 * - :name parameters take an object with each name as an own property (extra keys are ignored).
 */
export function bindParams<T>(
  scan: SqlScan,
  params: SqlParams | undefined,
  bind: (v: BindValue, label: string) => T,
): T[] {
  const other = scan.otherParameters[0];
  if (other !== undefined) throw new Error(`SQL parameter ${other}: use the :name form (or ?)`);
  if (scan.positional) {
    if (scan.names.length > 0) throw new Error('SQL mixes :name and ? parameters');
    const values = params as readonly BindValue[] | undefined;
    if (!Array.isArray(values) || values.length !== scan.variables) {
      throw new Error(`SQL with ${scan.variables} ? parameter(s) takes an array of ${scan.variables} value(s)`);
    }
    return Array.from({ length: values.length }, (_, i) => {
      if (!(i in values)) throw new Error(`SQL parameter ?${i + 1} missing`);
      return bind(values[i], `?${i + 1}`);
    });
  }
  if (Array.isArray(params)) {
    if (scan.names.length > 0) throw new Error('SQL with :name parameters takes an object, not an array');
    if (params.length > 0) throw new Error(`SQL without parameters was given ${params.length} value(s)`);
    return [];
  }
  const obj = params as Record<string, BindValue> | undefined;
  return scan.names.map((name) => {
    if (obj === undefined || !Object.hasOwn(obj, name)) throw new Error(`SQL parameter :${name} missing`);
    return bind(obj[name], `:${name}`);
  });
}

// ---------------------------------------------------------------------------
// What a Durable Object accepts but gets wrong
// ---------------------------------------------------------------------------

/** Statements SQL must not hold: transactions go through tx(), the rest has no DO equivalent. */
const FORBIDDEN_STATEMENTS = new Set(['BEGIN', 'COMMIT', 'END', 'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'VACUUM', 'ATTACH', 'DETACH']);

/** Functions whose value a DO's own writes change (setAlarm writes a row of its own, kv.put counts as a change). */
const CHANGE_FUNCTIONS = ['last_insert_rowid', 'changes', 'total_changes'];

/**
 * Why a Durable Object would run `scan` wrongly or only partly, or not the way Node does, although
 * it accepts it; null when nothing does. Both adapters refuse these (NodeDb with its portability
 * checks on). `deferring`: the call runs inside withDeferredForeignKeys().
 */
export function durableObjectHazard(scan: SqlScan, deferring: boolean): string | null {
  // A DO refuses these when it prepares them, but in exec() only after running the statements before.
  const keyword = scan.leading.find((k) => FORBIDDEN_STATEMENTS.has(k));
  if (keyword !== undefined) return `${keyword} (transactions use db.tx(); Node-only maintenance uses raw)`;
  if (scan.conflictRollback) {
    return 'ROLLBACK as a conflict resolution (in a Durable Object it rolls back every write of the invocation; use ABORT)';
  }
  if (scan.deferredKey) {
    return 'DEFERRABLE INITIALLY DEFERRED (a violation left at the end of an invocation resets a Durable Object; use withDeferredForeignKeys())';
  }
  for (const pragma of scan.pragmas) {
    if (!pragma.hasValue) continue;
    if (pragma.name === 'defer_foreign_keys' && !deferring) {
      return 'setting PRAGMA defer_foreign_keys outside withDeferredForeignKeys()';
    }
    if (pragma.name === 'foreign_keys') {
      return 'setting PRAGMA foreign_keys (always on in a Durable Object; Node-only code uses raw)';
    }
  }
  const changeFunction = CHANGE_FUNCTIONS.find((name) => scan.functions.has(name));
  if (changeFunction !== undefined) {
    return `${changeFunction}() (a Durable Object's own writes change it; use RETURNING or run()'s result)`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

/**
 * Throw `message` if `result` is a Promise: tx() callbacks and migrations are synchronous. The
 * promise gets a handler first, because its rejection would otherwise surface as an unhandled
 * rejection as well, which ends a Node process.
 */
export function refuseAsync(result: unknown, message: string): void {
  if (result instanceof Promise) {
    result.catch(() => {});
    throw new Error(message);
  }
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

const LONE_SURROGATE_RE = /\p{Cs}/u;

/**
 * `text` with each lone surrogate replaced by U+FFFD (String#toWellFormed): node:sqlite stores
 * U+FFFD, a DO invalid UTF-8 that reads back as three of them.
 */
export function wellFormed(text: string): string {
  return LONE_SURROGATE_RE.test(text) ? text.replace(/\p{Cs}/gu, '�') : text;
}

/**
 * A value as both runtimes bind it (booleans as 0/1, undefined as NULL, a bigint as a number like a
 * DO, a string well-formed), refusing what a Durable Object would store wrongly: an object other
 * than Uint8Array (it would store '[object Object]') and a bigint outside the safe integer range.
 * `label` names the parameter in the error (':name' or '?2').
 */
export function portableValue(v: BindValue, label: string): SqlValue {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'bigint') {
    if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new RangeError(`SQL parameter ${label} is a bigint outside the safe integer range`);
    }
    return Number(v);
  }
  if (typeof v === 'string') return wellFormed(v);
  if (v === null || typeof v === 'number' || v instanceof Uint8Array) return v;
  throw new TypeError(
    `SQL parameter ${label} cannot be bound: use a string, number, bigint, boolean, null or Uint8Array`,
  );
}

// ---------------------------------------------------------------------------
// Daily quota
// ---------------------------------------------------------------------------

/** Shown to users when a Durable Object daily limit (rows read or written) is used up (§11.3). */
export const DAILY_LIMIT_MESSAGE =
  'This Lyren Plan instance has reached its daily usage limit. It resets at 00:00 UTC.';

/**
 * An error raised by a Durable Object's SQL because a daily free-tier limit is used up. The exact
 * wording is the platform's (runbook step 12 records it): it says the allowance was "exceeded" and
 * names rows read or written, the free tier or a daily quota.
 */
export function isDailyQuotaError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return /\bexceeded\b/i.test(message) && /\b(?:free tier|daily|quota|rows? (?:read|written))\b/i.test(message);
}

/**
 * Thrown by DoDb instead of the platform's quota error, so the error handler answers 503 with
 * DAILY_LIMIT_MESSAGE rather than 500. `cause` keeps the original (it is logged).
 */
export class DailyQuotaError extends Error {
  constructor(cause: unknown) {
    super(DAILY_LIMIT_MESSAGE, { cause });
    this.name = 'DailyQuotaError';
  }
}
