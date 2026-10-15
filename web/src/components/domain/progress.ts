// Progress summaries for milestones / epics (ProgressStats from the API).

import type { EstimateUnit } from '@shared/constants';
import type { ProgressStats } from '@shared/types';
import { formatEstimate, percent } from '../../lib/format';

export type ProgressBasis = 'tasks' | 'estimate';

export interface ProgressSummary {
  done: number;
  total: number;
  /** 0..100, rounded. */
  percent: number;
  /** "12/20 done · 60%", "8/20 pts done · 40%", or "No tasks" / "No estimates". */
  text: string;
}

function trimNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, '');
}

export function progressSummary(stats: ProgressStats, basis: ProgressBasis = 'tasks', unit: EstimateUnit = 'points'): ProgressSummary {
  if (basis === 'estimate') {
    const done = stats.estimateClosed;
    const total = stats.estimateTotal;
    const pct = percent(done, total);
    const text = total > 0 ? `${trimNumber(done)}/${formatEstimate(total, unit)} done · ${pct}%` : 'No estimates';
    return { done, total, percent: pct, text };
  }
  const done = stats.tasksClosed;
  const total = stats.tasksTotal;
  const pct = percent(done, total);
  return { done, total, percent: pct, text: total > 0 ? `${done}/${total} done · ${pct}%` : 'No tasks' };
}
