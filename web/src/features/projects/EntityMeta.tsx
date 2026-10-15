// Small display pieces shared by the overview, milestone and epic pages.

import { clsx } from 'clsx';
import type { ReactNode } from 'react';
import type { ProgressStats } from '@shared/types';
import { DueDateLabel, StartDateLabel } from '../../components/domain';
import { ProgressBar } from '../../components/ui';
import { percent } from '../../lib/format';

/** "▸ Oct 1 → ⚑ Oct 30" (due date red with "Overdue" when past and not closed). */
export function DateRange({
  start,
  due,
  closed,
  className,
}: {
  start: string | null;
  due: string | null;
  closed: boolean;
  className?: string;
}) {
  if (!start && !due) return null;
  return (
    <span className={clsx('inline-flex shrink-0 items-center gap-1 whitespace-nowrap', className)}>
      {start && <StartDateLabel date={start} plain />}
      {start && due && (
        <span aria-hidden className="text-fg-subtle">
          →
        </span>
      )}
      {due && <DueDateLabel date={due} closed={closed} verbose plain />}
    </span>
  );
}

/** Compact progress: a bar plus "3/5 · 60%" (or "No tasks"). */
export function InlineProgress({
  stats,
  label,
  color,
  className,
  barClassName = 'w-16 sm:w-24',
}: {
  stats: ProgressStats;
  /** Accessible name of the bar, e.g. "Design system progress". */
  label: string;
  color?: string;
  className?: string;
  barClassName?: string;
}) {
  const total = stats.tasksTotal;
  return (
    <span className={clsx('inline-flex items-center gap-2', className)}>
      <ProgressBar value={stats.tasksClosed} total={total} color={color} aria-label={label} className={barClassName} />
      <span className="shrink-0 tabular-nums">
        {total > 0 ? `${stats.tasksClosed}/${total} · ${percent(stats.tasksClosed, total)}%` : 'No tasks'}
      </span>
    </span>
  );
}

/** A labelled number tile (summary cards). */
export function StatTile({ label, value, tone, hint }: { label: string; value: ReactNode; tone?: 'danger'; hint?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-md bg-surface-2 px-3 py-2" title={hint}>
      <dt className="truncate text-xs text-fg-muted">{label}</dt>
      <dd className={clsx('text-lg font-semibold tabular-nums leading-6', tone === 'danger' ? 'text-danger' : 'text-fg')}>{value}</dd>
    </div>
  );
}
