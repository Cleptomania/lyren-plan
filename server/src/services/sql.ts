// Small SQL helpers shared by the services. Only trusted fragments are built here;
// values always travel as bound parameters.

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
