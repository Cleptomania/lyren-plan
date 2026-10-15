import { clsx } from 'clsx';

export interface SkeletonProps {
  /** Size/shape via classes, e.g. "h-4 w-32" or "size-8 rounded-full". */
  className?: string;
}

/** Placeholder block shown while content loads (decorative). */
export function Skeleton({ className }: SkeletonProps) {
  return <span aria-hidden className={clsx('block rounded-md bg-surface-3/70 motion-safe:animate-pulse', className ?? 'h-4 w-full')} />;
}

export interface SkeletonTextProps {
  lines?: number;
  className?: string;
}

/** A paragraph-like stack of skeleton lines (announces "Loading"). */
export function SkeletonText({ lines = 3, className }: SkeletonTextProps) {
  return (
    <div role="status" className={clsx('flex flex-col gap-2', className)}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={clsx('h-3.5', i === lines - 1 && lines > 1 ? 'w-2/3' : 'w-full')} />
      ))}
      <span className="sr-only">Loading</span>
    </div>
  );
}

export interface SkeletonListProps {
  rows?: number;
  /** Show a leading circle/icon placeholder in each row. */
  withIcon?: boolean;
  className?: string;
}

/** List-row placeholders (announces "Loading"). */
export function SkeletonList({ rows = 5, withIcon = true, className }: SkeletonListProps) {
  return (
    <div role="status" className={clsx('flex flex-col', className)}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex h-11 items-center gap-3 px-1">
          {withIcon && <Skeleton className="size-4 rounded-full" />}
          <Skeleton className={clsx('h-3.5', ['w-1/2', 'w-2/3', 'w-2/5', 'w-3/5'][i % 4])} />
          <Skeleton className="ml-auto h-3.5 w-12" />
        </div>
      ))}
      <span className="sr-only">Loading</span>
    </div>
  );
}
