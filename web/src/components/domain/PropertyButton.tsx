// Default trigger of the domain pickers: a quiet, left-aligned button showing the current
// value (icon + text), like a property row in a side panel. 40px tall on phones.

import { clsx } from 'clsx';
import { ChevronDown } from 'lucide-react';
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

export interface PropertyButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: ReactNode;
  /** Render the value muted (empty state such as "No epic"). */
  placeholder?: boolean;
  /** Stretch to the container width. */
  fullWidth?: boolean;
  /** Show a chevron at the end (default false). */
  chevron?: boolean;
  /** 'sm' is 32px on desktop (default), 'md' 36px; always 40px on phones. */
  size?: 'sm' | 'md';
  /** Bordered look (for forms) instead of the quiet ghost look. */
  bordered?: boolean;
  /** Text color for a value that needs attention (e.g. an overdue date). */
  tone?: 'danger' | 'warning';
}

export const PropertyButton = forwardRef<HTMLButtonElement, PropertyButtonProps>(function PropertyButton(
  { icon, placeholder, fullWidth, chevron, size = 'sm', bordered, tone, className, children, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      className={clsx(
        'inline-flex min-w-0 max-w-full items-center gap-2 rounded-md px-2 text-left text-sm transition-colors',
        'h-10 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:pointer-events-none disabled:opacity-50',
        'aria-expanded:bg-surface-2 [&_svg]:shrink-0',
        size === 'sm' ? 'md:h-8 md:text-[13px]' : 'md:h-9',
        bordered ? 'border border-border bg-surface shadow-card hover:border-border-strong' : 'hover:bg-surface-2 active:bg-surface-3',
        tone === 'danger' ? 'text-danger' : tone === 'warning' ? 'text-warning' : placeholder ? 'text-fg-subtle' : 'text-fg',
        fullWidth && 'w-full',
        className,
      )}
      {...rest}
    >
      {icon !== undefined && (
        <span aria-hidden className="flex size-4 shrink-0 items-center justify-center [&_svg]:size-4">
          {icon}
        </span>
      )}
      <span className="flex min-w-0 flex-1 items-center gap-1 truncate">
        {/* A bare text node is an anonymous flex item, which clips without an ellipsis. */}
        {typeof children === 'string' ? <span className="truncate">{children}</span> : children}
      </span>
      {chevron && <ChevronDown aria-hidden className="size-4 text-fg-subtle" />}
    </button>
  );
});
