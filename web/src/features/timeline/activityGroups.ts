// Grouping helpers for activity lists (pure, unit-tested).

import type { ActivityDTO } from '@shared/types';

export interface DayGroup<T> {
  /** 'YYYY-MM-DD' */
  date: string;
  items: T[];
}

/**
 * Split an already-sorted list into runs of the same calendar day (order preserved, so a
 * newest-first list yields newest-first days).
 */
export function groupByDay<T>(items: readonly T[], dateOf: (item: T) => string): DayGroup<T>[] {
  const groups: DayGroup<T>[] = [];
  for (const item of items) {
    const date = dateOf(item);
    const last = groups[groups.length - 1];
    if (last && last.date === date) last.items.push(item);
    else groups.push({ date, items: [item] });
  }
  return groups;
}

/** Consecutive entries by the same actor within this window read as one burst of edits. */
export const ACTIVITY_RUN_WINDOW_MS = 5 * 60_000;

export interface ActivityRun {
  /** Id of the first entry (stable React key). */
  key: number;
  actor: ActivityDTO['actor'];
  entries: ActivityDTO[];
  /** createdAt of the last entry in the run. */
  lastAt: string;
}

/**
 * Group an oldest-first list into runs: consecutive entries by the same actor where each
 * entry follows the previous one within `windowMs`.
 */
export function groupActivityRuns(entries: readonly ActivityDTO[], windowMs = ACTIVITY_RUN_WINDOW_MS): ActivityRun[] {
  const runs: ActivityRun[] = [];
  for (const entry of entries) {
    const run = runs[runs.length - 1];
    const prev = run?.entries[run.entries.length - 1];
    const sameActor = !!run && (run.actor?.id ?? null) === (entry.actor?.id ?? null);
    const gap = prev ? Date.parse(entry.createdAt) - Date.parse(prev.createdAt) : Infinity;
    if (run && sameActor && gap >= 0 && gap <= windowMs) {
      run.entries.push(entry);
      run.lastAt = entry.createdAt;
    } else {
      runs.push({ key: entry.id, actor: entry.actor, entries: [entry], lastAt: entry.createdAt });
    }
  }
  return runs;
}
