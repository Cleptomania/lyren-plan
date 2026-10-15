// Simple divided lists of rows (settings lists, boards list, search results…).

import { clsx } from 'clsx';
import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';

export interface ListGroupProps {
  children: ReactNode;
  /** Wrap in a bordered card (default true). */
  card?: boolean;
  className?: string;
  'aria-label'?: string;
}

/** Container for ListRows: bordered card with dividers between rows. */
export function ListGroup({ children, card = true, className, 'aria-label': ariaLabel }: ListGroupProps) {
  return (
    <ul
      aria-label={ariaLabel}
      className={clsx(
        'flex min-w-0 flex-col divide-y divide-border',
        card && 'overflow-hidden rounded-lg border border-border bg-surface shadow-card',
        className,
      )}
    >
      {children}
    </ul>
  );
}

export interface ListRowProps {
  title: ReactNode;
  description?: ReactNode;
  /** Leading visual (icon, ColorDot, Avatar…). */
  icon?: ReactNode;
  /** Muted trailing text/elements (counts, dates, badges). */
  meta?: ReactNode;
  /** Trailing controls (IconButton, Menu…). Kept outside the link/button. */
  actions?: ReactNode;
  /** Makes the row a link. */
  to?: string;
  /** Makes the row a button (ignored when `to` is set). */
  onClick?: () => void;
  /** Show a chevron for navigational rows (default: when `to` is set). */
  chevron?: boolean;
  className?: string;
}

/** One row of a ListGroup (an <li>). Whole row is the hit target when `to`/`onClick` is set. */
export function ListRow({ title, description, icon, meta, actions, to, onClick, chevron, className }: ListRowProps) {
  const showChevron = chevron ?? !!to;
  const inner = (
    <>
      {icon && <span className="flex shrink-0 items-center text-fg-muted [&_svg]:size-4">{icon}</span>}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium text-fg">{title}</span>
        {description && <span className="truncate text-[13px] text-fg-muted">{description}</span>}
      </span>
      {meta && <span className="flex shrink-0 items-center gap-2 text-xs text-fg-muted">{meta}</span>}
      {showChevron && <ChevronRight aria-hidden className="size-4 shrink-0 text-fg-subtle" />}
    </>
  );
  const rowClasses = 'flex min-h-12 min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left md:min-h-11';
  const interactiveClasses = 'transition-colors hover:bg-surface-2 focus-visible:outline-offset-[-2px]';
  return (
    <li className={clsx('flex min-w-0 items-center', className)}>
      {to ? (
        <Link to={to} className={clsx(rowClasses, interactiveClasses)}>
          {inner}
        </Link>
      ) : onClick ? (
        <button type="button" onClick={onClick} className={clsx(rowClasses, interactiveClasses)}>
          {inner}
        </button>
      ) : (
        <div className={rowClasses}>{inner}</div>
      )}
      {actions && <div className="flex shrink-0 items-center gap-1 pr-2">{actions}</div>}
    </li>
  );
}
