import { clsx } from 'clsx';
import { forwardRef, useId, type ButtonHTMLAttributes, type ReactNode } from 'react';

export interface SwitchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'role'> {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** Visible label; the row becomes "label … switch". Omit for a bare switch (pass aria-label). */
  label?: ReactNode;
  description?: ReactNode;
  size?: 'sm' | 'md';
}

/** On/off toggle (role="switch"). With a label it renders a full-width settings row. */
export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  { checked, onCheckedChange, label, description, size = 'md', className, disabled, id, ...rest },
  ref,
) {
  const autoId = useId();
  const labelId = `${id ?? autoId}-label`;
  const descId = `${id ?? autoId}-desc`;
  const toggle = (
    <button
      ref={ref}
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={label ? labelId : undefined}
      aria-describedby={description ? descId : undefined}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={clsx(
        'relative inline-flex shrink-0 items-center rounded-full border transition-colors duration-150',
        'focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
        // A larger invisible hit area for touch.
        "before:absolute before:-inset-2 before:content-['']",
        size === 'sm' ? 'h-4 w-7' : 'h-5 w-9',
        checked ? 'border-transparent bg-accent' : 'border-border-control bg-surface-3 hover:bg-border-strong',
        !label && className,
      )}
      {...rest}
    >
      <span
        aria-hidden
        className={clsx(
          'pointer-events-none inline-block rounded-full shadow-card transition-transform duration-150 motion-reduce:transition-none',
          checked ? 'bg-accent-fg' : 'bg-surface dark:bg-fg-muted',
          size === 'sm' ? 'size-3' : 'size-4',
          checked ? (size === 'sm' ? 'translate-x-3.5' : 'translate-x-[1.125rem]') : 'translate-x-0.5',
        )}
      />
    </button>
  );
  if (!label) return toggle;
  return (
    <div className={clsx('flex items-start justify-between gap-4', className)}>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span
          id={labelId}
          className={clsx('text-sm text-fg', !disabled && 'cursor-pointer')}
          onClick={() => !disabled && onCheckedChange(!checked)}
        >
          {label}
        </span>
        {description && (
          <span id={descId} className="text-xs text-fg-muted">
            {description}
          </span>
        )}
      </div>
      <span className="pt-0.5">{toggle}</span>
    </div>
  );
});
