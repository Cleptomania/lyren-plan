// The small bordered chip used for task metadata on cards and rows (due date, epic,
// milestone, tags…). Neutral surface so entity colors (dots/icons) read in both themes.

import { clsx } from 'clsx';
import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';

export type PillSize = 'sm' | 'md';
/** `subtle`: de-emphasised (closed items); still meets WCAG AA text contrast, unlike dimming with opacity. */
export type PillTone = 'subtle' | 'muted' | 'default' | 'danger' | 'warning';

export interface PillProps extends HTMLAttributes<HTMLSpanElement> {
  icon?: ReactNode;
  /** After the (truncating) text, e.g. a remove button. */
  trailing?: ReactNode;
  /** Classes for the text span (e.g. a max width so long names truncate). */
  textClassName?: string;
  size?: PillSize;
  /** Text color; danger/warning also tint the background unless `plain`. Default 'muted'. */
  tone?: PillTone;
  /** Borderless variant (inline text with an icon). */
  plain?: boolean;
}

const SIZES: Record<PillSize, string> = {
  sm: 'h-5 gap-1 text-[11px] [&_svg]:size-3',
  md: 'h-6 gap-1.5 text-xs [&_svg]:size-3.5',
};
const PADDING: Record<PillSize, string> = { sm: 'px-1.5', md: 'px-2' };
const TEXT: Record<PillTone, string> = {
  subtle: 'text-fg-subtle',
  muted: 'text-fg-muted',
  default: 'text-fg',
  danger: 'text-danger',
  warning: 'text-warning',
};
const FRAME: Record<PillTone, string> = {
  subtle: 'border border-border',
  muted: 'border border-border',
  default: 'border border-border',
  danger: 'border border-transparent bg-danger-soft',
  warning: 'border border-transparent bg-warning-soft',
};

export const Pill = forwardRef<HTMLSpanElement, PillProps>(function Pill(
  { icon, trailing, textClassName, size = 'sm', tone = 'muted', plain, className, children, ...rest },
  ref,
) {
  return (
    <span
      ref={ref}
      className={clsx(
        'inline-flex min-w-0 max-w-full shrink-0 items-center whitespace-nowrap rounded-md font-medium leading-none [&_svg]:shrink-0',
        SIZES[size],
        TEXT[tone],
        !plain && [FRAME[tone], PADDING[size]],
        className,
      )}
      {...rest}
    >
      {icon}
      {children !== undefined && children !== null && <span className={clsx('min-w-0 truncate', textClassName)}>{children}</span>}
      {trailing}
    </span>
  );
});
