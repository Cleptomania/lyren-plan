import { clsx } from 'clsx';
import type { HTMLAttributes, ReactNode } from 'react';
import { softChipStyle } from '../../lib/colors';

export type BadgeVariant = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'outline';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  /** Entity color (#rrggbb): soft tinted chip that works in both themes. Overrides variant colors. */
  color?: string;
  size?: 'sm' | 'md';
  icon?: ReactNode;
}

const VARIANTS: Record<BadgeVariant, string> = {
  neutral: 'border-transparent bg-surface-2 text-fg-muted',
  accent: 'border-transparent bg-accent-soft text-accent',
  success: 'border-transparent bg-success-soft text-success',
  warning: 'border-transparent bg-warning-soft text-warning',
  danger: 'border-transparent bg-danger-soft text-danger',
  outline: 'border-border bg-transparent text-fg-muted',
};

/** Small status/count label. */
export function Badge({ variant = 'neutral', color, size = 'sm', icon, className, style, children, ...rest }: BadgeProps) {
  return (
    <span
      className={clsx(
        'inline-flex max-w-full shrink-0 items-center gap-1 whitespace-nowrap rounded-md border font-medium leading-none [&_svg]:shrink-0',
        size === 'sm' ? 'h-5 px-1.5 text-[11px] [&_svg]:size-3' : 'h-6 px-2 text-xs [&_svg]:size-3.5',
        !color && VARIANTS[variant],
        className,
      )}
      style={color ? { ...softChipStyle(color), ...style } : style}
      {...rest}
    >
      {icon}
      {children !== undefined && <span className="truncate">{children}</span>}
    </span>
  );
}
