// Calendar-date helpers operating on 'YYYY-MM-DD' strings.
//
// Task due/start dates are *calendar dates* without a time zone. All math here
// is done in UTC on those strings so results never shift with the host's zone.
// "Today" is always supplied by the caller: the web client passes its local
// date to the API so presets like "overdue" match what the user sees.

import type { DueBucket, DuePreset } from './constants';

export type ISODate = string;
export type WeekStart = 0 | 1; // 0 = Sunday, 1 = Monday

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

export function isValidISODate(value: unknown): value is ISODate {
  if (typeof value !== 'string') return false;
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1 || mo < 1 || mo > 12 || d < 1) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function toUTCms(date: ISODate): number {
  const m = DATE_RE.exec(date);
  if (!m) throw new Error(`Invalid date: ${date}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function fromUTCms(ms: number): ISODate {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The local calendar date of `now` in the runtime's time zone (use on the client). */
export function localToday(now: Date = new Date()): ISODate {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addDays(date: ISODate, days: number): ISODate {
  return fromUTCms(toUTCms(date) + days * DAY_MS);
}

/** Whole days from `a` to `b` (positive when b is later). */
export function diffDays(a: ISODate, b: ISODate): number {
  return Math.round((toUTCms(b) - toUTCms(a)) / DAY_MS);
}

/** 0 = Sunday ... 6 = Saturday */
export function dayOfWeek(date: ISODate): number {
  return new Date(toUTCms(date)).getUTCDay();
}

export function startOfWeek(date: ISODate, weekStartsOn: WeekStart): ISODate {
  const offset = (dayOfWeek(date) - weekStartsOn + 7) % 7;
  return addDays(date, -offset);
}

export function endOfWeek(date: ISODate, weekStartsOn: WeekStart): ISODate {
  return addDays(startOfWeek(date, weekStartsOn), 6);
}

/** Inclusive date range a due-date preset matches; see DUE_PRESETS docs. */
export type DueRange =
  | { kind: 'range'; from: ISODate | null; to: ISODate | null }
  | { kind: 'overdue'; before: ISODate }
  | { kind: 'none' }
  | { kind: 'any' };

export function resolveDuePreset(preset: DuePreset, today: ISODate, weekStartsOn: WeekStart): DueRange {
  switch (preset) {
    case 'overdue':
      return { kind: 'overdue', before: today };
    case 'today':
      return { kind: 'range', from: today, to: today };
    case 'tomorrow': {
      const t = addDays(today, 1);
      return { kind: 'range', from: t, to: t };
    }
    case 'this_week':
      return { kind: 'range', from: startOfWeek(today, weekStartsOn), to: endOfWeek(today, weekStartsOn) };
    case 'next_week': {
      const start = addDays(startOfWeek(today, weekStartsOn), 7);
      return { kind: 'range', from: start, to: addDays(start, 6) };
    }
    case 'next_7_days':
      return { kind: 'range', from: today, to: addDays(today, 6) };
    case 'next_30_days':
      return { kind: 'range', from: today, to: addDays(today, 29) };
    case 'no_date':
      return { kind: 'none' };
    case 'has_date':
      return { kind: 'any' };
  }
}

/**
 * Bucket for grouping by due date. Rules are applied in order:
 * null -> no_date; < today -> 'past' if the task is closed, else 'overdue'; == today -> today;
 * == today+1 -> tomorrow; <= endOfWeek(today) -> this_week; <= endOfWeek(today)+7 -> next_week; else later.
 */
export function dueBucket(dueDate: ISODate | null, today: ISODate, weekStartsOn: WeekStart, closed = false): DueBucket {
  if (!dueDate) return 'no_date';
  if (dueDate < today) return closed ? 'past' : 'overdue';
  if (dueDate === today) return 'today';
  if (dueDate === addDays(today, 1)) return 'tomorrow';
  const eow = endOfWeek(today, weekStartsOn);
  if (dueDate <= eow) return 'this_week';
  if (dueDate <= addDays(eow, 7)) return 'next_week';
  return 'later';
}

/**
 * Date a task gets when dropped into a due bucket on a board.
 * Returns undefined when the bucket is not a valid drop target
 * (past / overdue / later, or this_week when no day of this week remains after tomorrow).
 * Returns null for no_date (clears the due date).
 */
export function dueBucketDropDate(bucket: DueBucket, today: ISODate, weekStartsOn: WeekStart): ISODate | null | undefined {
  switch (bucket) {
    case 'today':
      return today;
    case 'tomorrow':
      return addDays(today, 1);
    case 'this_week': {
      const eow = endOfWeek(today, weekStartsOn);
      return eow > addDays(today, 1) ? eow : undefined;
    }
    case 'next_week': {
      const start = addDays(endOfWeek(today, weekStartsOn), 1);
      const minDate = addDays(today, 2);
      return start >= minDate ? start : minDate;
    }
    case 'no_date':
      return null;
    case 'past':
    case 'overdue':
    case 'later':
      return undefined;
  }
}

/** ISO timestamp (UTC) for "now"; used for createdAt/updatedAt etc. */
export function nowISO(now: Date = new Date()): string {
  return now.toISOString();
}
