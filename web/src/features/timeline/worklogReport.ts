// Work-log report helpers (pure, unit-tested): date-range presets honouring the week start,
// URL param resolution, and day / project totals for the report page.

import { addDays, endOfWeek, isValidISODate, startOfWeek, type ISODate, type WeekStart } from '@shared/dates';
import type { WorklogReportDTO } from '@shared/types';
import { formatDate } from '../../lib/format';
import { groupByDay } from './activityGroups';

export const RANGE_PRESETS = ['this_week', 'last_week', 'this_month', 'last_30', 'custom'] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];
export type PresetWithRange = Exclude<RangePreset, 'custom'>;
export const DEFAULT_RANGE_PRESET: PresetWithRange = 'this_week';

export const RANGE_PRESET_LABELS: Record<RangePreset, string> = {
  this_week: 'This week',
  last_week: 'Last week',
  this_month: 'This month',
  last_30: 'Last 30 days',
  custom: 'Custom range',
};

export interface DateRange {
  from: ISODate;
  to: ISODate;
}

export function isRangePreset(value: unknown): value is RangePreset {
  return typeof value === 'string' && (RANGE_PRESETS as readonly string[]).includes(value);
}

/** Inclusive range of a preset relative to `today`. */
export function presetRange(preset: PresetWithRange, today: ISODate, weekStartsOn: WeekStart): DateRange {
  switch (preset) {
    case 'this_week':
      return { from: startOfWeek(today, weekStartsOn), to: endOfWeek(today, weekStartsOn) };
    case 'last_week': {
      const from = addDays(startOfWeek(today, weekStartsOn), -7);
      return { from, to: addDays(from, 6) };
    }
    case 'this_month': {
      const from = `${today.slice(0, 8)}01`;
      const nextMonth = addDays(from, 31).slice(0, 8) + '01';
      return { from, to: addDays(nextMonth, -1) };
    }
    case 'last_30':
      return { from: addDays(today, -29), to: today };
  }
}

export interface ResolvedRange {
  preset: RangePreset;
  range: DateRange;
}

/**
 * The range from URL params (?range=&from=&to=). A custom range needs two valid dates
 * (swapped when reversed); anything else falls back to the default preset.
 */
export function resolveRange(
  params: { range?: string | null; from?: string | null; to?: string | null },
  today: ISODate,
  weekStartsOn: WeekStart,
): ResolvedRange {
  const preset = isRangePreset(params.range) ? params.range : DEFAULT_RANGE_PRESET;
  if (preset === 'custom') {
    const { from, to } = params;
    if (isValidISODate(from) && isValidISODate(to)) {
      return { preset, range: from <= to ? { from, to } : { from: to, to: from } };
    }
    return { preset: DEFAULT_RANGE_PRESET, range: presetRange(DEFAULT_RANGE_PRESET, today, weekStartsOn) };
  }
  return { preset, range: presetRange(preset, today, weekStartsOn) };
}

/** "Oct 6 – Oct 12" / "Oct 13" (years shown when not the current one). */
export function formatRange(range: DateRange, today: ISODate): string {
  if (range.from === range.to) return formatDate(range.from, today);
  return `${formatDate(range.from, today)} – ${formatDate(range.to, today)}`;
}

export type ReportItem = WorklogReportDTO['items'][number];

export interface ReportDay {
  date: ISODate;
  minutes: number;
  items: ReportItem[];
}

export interface ReportProjectTotal {
  projectId: number;
  minutes: number;
  entries: number;
}

/** Days (in the report's newest-first order) with their totals. */
export function reportDays(items: readonly ReportItem[]): ReportDay[] {
  return groupByDay(items, (i) => i.date).map((d) => ({
    date: d.date,
    items: d.items,
    minutes: d.items.reduce((sum, i) => sum + (i.minutes ?? 0), 0),
  }));
}

/** Per-project totals, most time first (ties: more entries, then project id). */
export function reportProjects(items: readonly ReportItem[]): ReportProjectTotal[] {
  const totals = new Map<number, ReportProjectTotal>();
  for (const item of items) {
    const t = totals.get(item.task.projectId) ?? { projectId: item.task.projectId, minutes: 0, entries: 0 };
    t.minutes += item.minutes ?? 0;
    t.entries += 1;
    totals.set(item.task.projectId, t);
  }
  return [...totals.values()].sort((a, b) => b.minutes - a.minutes || b.entries - a.entries || a.projectId - b.projectId);
}
