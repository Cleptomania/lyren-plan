// Display formatting for dates, times and numbers. Dates are 'YYYY-MM-DD'.

import { addDays, diffDays, type ISODate } from '@shared/dates';

const monthDay = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
const monthDayYear = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const weekdayMonthDay = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const fullDate = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const dateTime = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

function utcDate(date: ISODate): Date {
  return new Date(`${date}T00:00:00Z`);
}

/** 'Oct 13' (current year) or 'Oct 13, 2025'. */
export function formatDate(date: ISODate | null | undefined, today?: ISODate): string {
  if (!date) return '';
  const sameYear = today ? date.slice(0, 4) === today.slice(0, 4) : date.slice(0, 4) === String(new Date().getFullYear());
  return (sameYear ? monthDay : monthDayYear).format(utcDate(date));
}

/** 'Tuesday, October 13, 2026' */
export function formatDateLong(date: ISODate | null | undefined): string {
  return date ? fullDate.format(utcDate(date)) : '';
}

/**
 * Due-date label relative to today: 'Today', 'Tomorrow', 'Yesterday', weekday within
 * the next 6 days ('Fri, Oct 16'), otherwise formatDate().
 */
export function formatDueDate(date: ISODate | null | undefined, today: ISODate): string {
  if (!date) return '';
  const d = diffDays(today, date);
  if (d === 0) return 'Today';
  if (d === 1) return 'Tomorrow';
  if (d === -1) return 'Yesterday';
  if (d > 1 && d < 7) return weekdayMonthDay.format(utcDate(date));
  return formatDate(date, today);
}

/** 'Oct 13, 2026, 4:05 PM' in the viewer's time zone. */
export function formatDateTime(iso: string | null | undefined): string {
  return iso ? dateTime.format(new Date(iso)) : '';
}

/** '5 minutes ago', 'yesterday', 'in 2 days' ... */
export function formatRelativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '';
  const diffSec = Math.round((Date.parse(iso) - now) / 1000);
  const abs = Math.abs(diffSec);
  if (abs < 45) return 'just now';
  if (abs < 3600) return relative.format(Math.round(diffSec / 60), 'minute');
  if (abs < 86_400) return relative.format(Math.round(diffSec / 3600), 'hour');
  if (abs < 86_400 * 30) return relative.format(Math.round(diffSec / 86_400), 'day');
  if (abs < 86_400 * 365) return relative.format(Math.round(diffSec / (86_400 * 30)), 'month');
  return relative.format(Math.round(diffSec / (86_400 * 365)), 'year');
}

/** Local calendar date of an ISO timestamp ('YYYY-MM-DD'). */
export function isoToLocalDate(iso: string): ISODate {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Group label for a day relative to today: 'Today', 'Yesterday', or a long date. */
export function dayHeading(date: ISODate, today: ISODate): string {
  if (date === today) return 'Today';
  if (date === addDays(today, -1)) return 'Yesterday';
  return formatDateLong(date);
}

/** Format an estimate value with its unit: 3 -> '3 pts' / '3h'. */
export function formatEstimate(value: number | null | undefined, unit: 'points' | 'hours'): string {
  if (value === null || value === undefined) return '';
  const n = Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, '');
  return unit === 'hours' ? `${n}h` : `${n} ${value === 1 ? 'pt' : 'pts'}`;
}

/** Percentage 0..100 (rounded), 0 when total is 0. */
export function percent(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 100) : 0;
}

export function pluralize(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}
