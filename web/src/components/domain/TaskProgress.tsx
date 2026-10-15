// Progress of a milestone / epic from its ProgressStats: bar + "12/20 done · 60%".

import type { ProgressStats } from '@shared/types';
import { useLookups } from '../../api/bootstrap';
import { ProgressBar } from '../ui';
import { progressSummary, type ProgressBasis } from './progress';

export interface TaskProgressProps {
  stats: ProgressStats;
  /** Count closed tasks (default) or sum closed estimates. */
  basis?: ProgressBasis;
  /** Text on the left above the bar (e.g. the epic name). */
  label?: string;
  /** Show "12/20 done · 60%" (default true). */
  showText?: boolean;
  /** Bar color (entity hex); default accent. */
  color?: string;
  size?: 'sm' | 'md';
  className?: string;
}

export function TaskProgress({ stats, basis = 'tasks', label, showText = true, color, size = 'sm', className }: TaskProgressProps) {
  const { settings } = useLookups();
  const summary = progressSummary(stats, basis, settings.estimateUnit);
  return (
    <div className={className}>
      <ProgressBar
        value={summary.done}
        total={summary.total}
        label={label}
        color={color}
        size={size}
        aria-label={label ? `${label} progress` : 'Progress'}
      />
      {showText && <p className="mt-1 text-xs tabular-nums text-fg-muted">{summary.text}</p>}
    </div>
  );
}
