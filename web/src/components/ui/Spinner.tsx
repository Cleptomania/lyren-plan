import { clsx } from 'clsx';

export interface SpinnerProps {
  size?: 'xs' | 'sm' | 'md' | 'lg';
  /** Accessible label; pass `null` when the spinner is decorative (e.g. inside a busy button). */
  label?: string | null;
  className?: string;
}

const SIZES = {
  xs: 'size-3 border-[1.5px]',
  sm: 'size-4 border-2',
  md: 'size-5 border-2',
  lg: 'size-7 border-[2.5px]',
} as const;

/** Indeterminate loading indicator. Inherits the current text color for its arc. */
export function Spinner({ size = 'sm', label = 'Loading', className }: SpinnerProps) {
  const ring = (
    <span
      aria-hidden
      className={clsx(
        'inline-block shrink-0 animate-spin rounded-full border-current border-r-transparent opacity-80',
        SIZES[size],
        label !== null && className,
      )}
    />
  );
  if (label === null) return <span className={clsx('inline-flex', className)}>{ring}</span>;
  return (
    <span role="status" className="inline-flex">
      {ring}
      <span className="sr-only">{label}</span>
    </span>
  );
}
