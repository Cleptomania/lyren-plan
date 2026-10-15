import { clsx } from 'clsx';
import type { ReactNode } from 'react';
import { formatShortcutKeys } from './shortcuts';

export interface KbdProps {
  children: ReactNode;
  className?: string;
}

/** One keyboard key. */
export function Kbd({ children, className }: KbdProps) {
  return (
    <kbd
      className={clsx(
        'inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-surface px-1 font-sans text-[11px] font-medium leading-none text-fg-muted shadow-[inset_0_-1px_0_var(--border)]',
        className,
      )}
    >
      {children}
    </kbd>
  );
}

export interface ShortcutProps {
  /** Combo like 'mod+k', 'c', 'shift+?'. Rendered with platform-specific labels. */
  combo: string;
  className?: string;
}

/** A shortcut as a row of keys (hidden on touch-only devices, where it means nothing). */
export function Shortcut({ combo, className }: ShortcutProps) {
  return (
    <span className={clsx('inline-flex items-center gap-0.5 pointer-coarse:hidden', className)}>
      {formatShortcutKeys(combo).map((k, i) => (
        <Kbd key={i}>{k}</Kbd>
      ))}
    </span>
  );
}
