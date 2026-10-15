import { clsx } from 'clsx';
import type { ReactNode } from 'react';
import { percent } from '../../lib/format';

export interface ProgressBarProps {
  /** Completed amount. */
  value: number;
  /** Total amount (default 100, i.e. value is a percentage). */
  total?: number;
  /** Text on the left above the bar. */
  label?: ReactNode;
  /** Value text on the right: 'percent' ("40%"), 'fraction' ("4 / 10") or none (default). */
  showValue?: 'percent' | 'fraction' | false;
  /** Bar color (entity hex color); default accent. */
  color?: string;
  size?: 'sm' | 'md';
  className?: string;
  /** Accessible name when there is no visible label. */
  'aria-label'?: string;
}

export function ProgressBar({
  value,
  total = 100,
  label,
  showValue = false,
  color,
  size = 'sm',
  className,
  'aria-label': ariaLabel,
}: ProgressBarProps) {
  const pct = percent(Math.max(0, Math.min(value, total)), total);
  const valueText = showValue === 'fraction' ? `${value} / ${total}` : `${pct}%`;
  return (
    <div className={clsx('flex min-w-0 flex-col gap-1.5', className)}>
      {(label || showValue) && (
        <div className="flex items-baseline justify-between gap-2 text-xs">
          <span className="min-w-0 truncate text-fg-muted">{label}</span>
          {showValue && <span className="shrink-0 font-medium tabular-nums text-fg-muted">{valueText}</span>}
        </div>
      )}
      <div
        role="progressbar"
        aria-label={ariaLabel ?? (typeof label === 'string' ? label : 'Progress')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-valuetext={showValue === 'fraction' ? valueText : `${pct}%`}
        className={clsx('w-full overflow-hidden rounded-full bg-surface-3', size === 'sm' ? 'h-1.5' : 'h-2')}
      >
        <div
          className={clsx('h-full rounded-full transition-[width] duration-300 motion-reduce:transition-none', !color && 'bg-accent')}
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
      </div>
    </div>
  );
}
