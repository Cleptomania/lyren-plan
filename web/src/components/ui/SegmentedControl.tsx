import { clsx } from 'clsx';
import { useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
  /** Accessible name when `label` is visually hidden or icon-only. */
  'aria-label'?: string;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: ReadonlyArray<SegmentedOption<T>>;
  /** Accessible name of the group. */
  'aria-label': string;
  size?: 'sm' | 'md';
  /** Stretch segments to fill the width. */
  fullWidth?: boolean;
  /** Show only icons below md (labels stay accessible). */
  iconOnlyOnMobile?: boolean;
  /** The whole group is read-only (the value still shows). */
  disabled?: boolean;
  className?: string;
}

/** Pill-style single choice (role=radiogroup) for 2–5 short options. */
export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  'aria-label': ariaLabel,
  size = 'md',
  fullWidth,
  iconOnlyOnMobile,
  disabled,
  className,
}: SegmentedControlProps<T>) {
  const ref = useRef<HTMLDivElement>(null);
  const enabled = disabled ? [] : options.filter((o) => !o.disabled);
  const onKeyDown = (e: KeyboardEvent) => {
    const idx = enabled.findIndex((o) => o.value === value);
    const delta = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!delta || enabled.length === 0) return;
    e.preventDefault();
    const next = enabled[(idx + delta + enabled.length) % enabled.length]!;
    onChange(next.value);
    requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus());
  };
  return (
    <div
      ref={ref}
      role="radiogroup"
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      onKeyDown={onKeyDown}
      className={clsx(
        'items-center gap-0.5 rounded-lg bg-surface-2 p-0.5',
        fullWidth ? 'flex w-full' : 'inline-flex w-fit max-w-full',
        className,
      )}
    >
      {options.map((o) => {
        const checked = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={o['aria-label']}
            tabIndex={checked ? 0 : -1}
            // The chosen value of a read-only group stays fully visible.
            disabled={disabled || o.disabled}
            onClick={() => onChange(o.value)}
            className={clsx(
              'inline-flex min-w-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-2.5 font-medium transition-colors duration-150',
              'focus-visible:outline-offset-0 disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
              size === 'sm' ? 'h-9 text-[13px] md:h-7' : 'h-9 text-sm md:h-8',
              fullWidth && 'flex-1',
              checked ? 'bg-surface text-fg shadow-card' : 'text-fg-muted hover:text-fg',
              disabled && checked && 'disabled:opacity-100',
            )}
          >
            {o.icon}
            <span className={clsx('truncate', iconOnlyOnMobile && o.icon !== undefined && 'max-md:sr-only')}>{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}
