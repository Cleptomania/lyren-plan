// Small SQL helpers shared by the services. Only trusted fragments are built here;
// values always travel as bound parameters. Also the JS twins of SQLite's text order and SUM(),
// for code that aggregates rows in JS instead of SQL (services/stats.ts, routes/dashboard.ts).

import { CLOSED_STATUS_CATEGORIES } from '@shared/constants';

/** `('completed', 'cancelled')` — for `s.category IN ${CLOSED_CATEGORIES_SQL}` (constant, trusted). */
export const CLOSED_CATEGORIES_SQL = `(${CLOSED_STATUS_CATEGORIES.map((c) => `'${c}'`).join(', ')})`;

/** Deduplicated JSON array for `IN (SELECT value FROM json_each(:param))`. */
export function jsonList<T extends number | string>(values: Iterable<T>): string {
  return JSON.stringify([...new Set(values)]);
}

/** `column IN (SELECT value FROM json_each(:param))` */
export function inJson(column: string, param: string): string {
  return `${column} IN (SELECT value FROM json_each(:${param}))`;
}

/**
 * FROM clause for the rows of `table` (as `alias`) whose ids are in the JSON list bound to :param, looked up
 * one by one: two billed rows an id (the list item and the row), where `id IN (SELECT value FROM json_each(…))`
 * reads three, since it fills a temporary index first (Appendix D 47). CROSS JOIN keeps the list the outer
 * loop. Each id once: bind jsonList(), which drops repeats.
 */
export function byJsonIds(table: string, alias: string, param: string): string {
  return `json_each(:${param}) j CROSS JOIN ${table} ${alias} ON ${alias}.id = j.value`;
}

/**
 * Optional id scope for aggregate queries: no ids = every row ('1'), otherwise an
 * IN-list over `column` bound to :scopeIds.
 */
export function idScope(column: string, ids: readonly number[] | undefined): { sql: string; params: { scopeIds?: string } } {
  if (ids === undefined) return { sql: '1', params: {} };
  return { sql: inJson(column, 'scopeIds'), params: { scopeIds: jsonList(ids) } };
}

/** ISO-8601 UTC timestamp for created_at/updated_at columns. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** The server's UTC calendar date — only a fallback when the client sends no `today`. */
export function serverToday(): string {
  return new Date().toISOString().slice(0, 10);
}

/** A UTF-16 code unit's place in code point order: surrogates (supplementary characters) after U+FFFF. */
const codePointRank = (unit: number): number =>
  unit >= 0xd800 && unit <= 0xdfff ? unit + 0x2000 : unit >= 0xe000 ? unit - 0x800 : unit;

/**
 * SQLite's BINARY order of two strings (their UTF-8 bytes, which is code point order), for comparisons JS
 * makes in place of SQL. JS's `<` compares UTF-16 code units, which differs for a supplementary character
 * against one in U+E000–U+FFFF.
 */
export function compareText(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x !== y) return codePointRank(x) - codePointRank(y);
  }
  return a.length - b.length;
}

/**
 * SUM() of REAL values as SQLite computes it (Kahan-Babuska-Neumaier summation, SQLite 3.43 and later), for
 * sums JS makes in place of SQL; `value` is COALESCE(SUM(…), 0). NULLs are skipped, as SUM skips them.
 */
export class RealSum {
  private sum = 0;
  private err = 0;

  add(r: number | null): void {
    if (r === null) return;
    const s = this.sum;
    const t = s + r;
    this.err += Math.abs(s) > Math.abs(r) ? s - t + r : r - t + s;
    this.sum = t;
  }

  get value(): number {
    return Number.isFinite(this.err) ? this.sum + this.err : this.sum;
  }
}
