import { clsx } from 'clsx';
import { ChevronRight } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';

export interface DisclosureProps {
  title: ReactNode;
  children: ReactNode;
  /** Uncontrolled initial state (default true). */
  defaultOpen?: boolean;
  /** Controlled state. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Number shown after the title. */
  count?: number;
  /** Controls at the end of the header row (outside the toggle button). */
  actions?: ReactNode;
  className?: string;
  headerClassName?: string;
  /** Classes for the content wrapper. */
  contentClassName?: string;
}

/** Collapsible section with a chevron header. */
export function Disclosure({
  title,
  children,
  defaultOpen = true,
  open: openProp,
  onOpenChange,
  count,
  actions,
  className,
  headerClassName,
  contentClassName,
}: DisclosureProps) {
  const [uncontrolled, setUncontrolled] = useState(defaultOpen);
  const open = openProp ?? uncontrolled;
  const contentId = useId();
  const toggle = () => {
    if (openProp === undefined) setUncontrolled(!open);
    onOpenChange?.(!open);
  };
  return (
    <div className={clsx('min-w-0', className)}>
      <div className={clsx('flex min-h-9 items-center gap-2', headerClassName)}>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={contentId}
          onClick={toggle}
          className="-ml-1 flex min-h-9 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 text-left text-sm font-semibold text-fg hover:text-fg"
        >
          <ChevronRight
            aria-hidden
            className={clsx('size-4 shrink-0 text-fg-subtle transition-transform duration-150 motion-reduce:transition-none', open && 'rotate-90')}
          />
          <span className="min-w-0 truncate">{title}</span>
          {count !== undefined && <span className="shrink-0 text-xs font-medium tabular-nums text-fg-subtle">{count}</span>}
        </button>
        {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
      </div>
      <div id={contentId} hidden={!open} className={contentClassName}>
        {children}
      </div>
    </div>
  );
}
