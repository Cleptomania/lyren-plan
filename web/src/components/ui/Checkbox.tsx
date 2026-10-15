import { useMergeRefs } from '@floating-ui/react';
import { clsx } from 'clsx';
import { Check, Minus } from 'lucide-react';
import { forwardRef, useLayoutEffect, useRef, type InputHTMLAttributes, type ReactNode } from 'react';

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'> {
  /** Visible label (clicking it toggles). Omit for a bare checkbox — then pass aria-label. */
  label?: ReactNode;
  /** Secondary text under the label. */
  description?: ReactNode;
  /** Mixed state ("some selected"). */
  indeterminate?: boolean;
  /** Called with the new checked state (in addition to the native onChange). */
  onCheckedChange?: (checked: boolean) => void;
}

/** Native checkbox with custom visuals. `className` goes on the root <label>. */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, description, indeterminate = false, onCheckedChange, onChange, className, disabled, ...rest },
  ref,
) {
  const inner = useRef<HTMLInputElement | null>(null);
  const merged = useMergeRefs([inner, ref]);
  useLayoutEffect(() => {
    if (inner.current) inner.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return (
    <label
      className={clsx(
        'group/checkbox relative inline-flex min-w-0 items-start gap-2.5 select-none',
        disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
        className,
      )}
    >
      {/* The ::before extends the touch target without affecting layout. */}
      <span className="relative mt-0.5 inline-flex size-4 shrink-0 before:absolute before:-inset-3 before:content-['']">
        <input
          ref={merged}
          type="checkbox"
          disabled={disabled}
          onChange={(e) => {
            onChange?.(e);
            onCheckedChange?.(e.currentTarget.checked);
          }}
          className={clsx(
            'peer size-4 shrink-0 cursor-[inherit] appearance-none rounded-[4px] border border-border-control bg-surface shadow-card',
            'transition-colors duration-100 checked:border-accent checked:bg-accent indeterminate:border-accent indeterminate:bg-accent',
            'group-hover/checkbox:border-fg-subtle checked:group-hover/checkbox:border-accent',
            'focus-visible:outline-2 focus-visible:outline-offset-2',
          )}
          {...rest}
        />
        <Check
          aria-hidden
          strokeWidth={3}
          className="pointer-events-none absolute inset-0 m-auto size-3 text-accent-fg opacity-0 peer-checked:opacity-100 peer-indeterminate:opacity-0"
        />
        <Minus
          aria-hidden
          strokeWidth={3}
          className="pointer-events-none absolute inset-0 m-auto size-3 text-accent-fg opacity-0 peer-indeterminate:opacity-100"
        />
      </span>
      {(label || description) && (
        <span className="flex min-w-0 flex-col gap-0.5">
          {label && <span className="text-sm leading-5 text-fg">{label}</span>}
          {description && <span className="text-xs text-fg-muted">{description}</span>}
        </span>
      )}
    </label>
  );
});
