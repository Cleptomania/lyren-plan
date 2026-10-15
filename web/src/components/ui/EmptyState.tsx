import { clsx } from 'clsx';
import type { ReactNode } from 'react';

export interface EmptyStateProps {
  /** A lucide icon element (sized automatically). */
  icon?: ReactNode;
  title: ReactNode;
  body?: ReactNode;
  /** Call to action (e.g. a Button). */
  action?: ReactNode;
  /** 'sm' for inside cards / panels, 'md' (default) for whole pages. */
  size?: 'sm' | 'md';
  className?: string;
}

/** Friendly placeholder for empty lists, no search results, etc. */
export function EmptyState({ icon, title, body, action, size = 'md', className }: EmptyStateProps) {
  return (
    <div
      className={clsx(
        'flex flex-col items-center justify-center text-center',
        size === 'md' ? 'gap-3 px-6 py-14' : 'gap-2 px-4 py-8',
        className,
      )}
    >
      {icon && (
        <div
          aria-hidden
          className={clsx(
            'flex items-center justify-center rounded-xl border border-border bg-surface text-fg-subtle shadow-card',
            size === 'md' ? 'mb-1 size-11 [&_svg]:size-5' : 'size-9 [&_svg]:size-4',
          )}
        >
          {icon}
        </div>
      )}
      <div className="flex max-w-sm flex-col gap-1">
        <p className={clsx('font-semibold text-fg', size === 'md' ? 'text-[15px]' : 'text-sm')}>{title}</p>
        {body && <div className="text-sm text-fg-muted">{body}</div>}
      </div>
      {action && <div className="mt-1 flex flex-wrap items-center justify-center gap-2">{action}</div>}
    </div>
  );
}
