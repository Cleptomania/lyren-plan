import { clsx } from 'clsx';
import { X } from 'lucide-react';
import { forwardRef, useRef, type InputHTMLAttributes } from 'react';
import { useMergeRefs } from '@floating-ui/react';
import { CONTROL_HEIGHTS, CONTROL_SURFACE, type ControlSize } from './controlStyles';
import { useFieldControl } from './Field';

export interface DateInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type' | 'size' | 'min' | 'max'> {
  /** 'YYYY-MM-DD' or null. */
  value: string | null;
  onChange: (value: string | null) => void;
  min?: string;
  max?: string;
  /** Show a clear (×) button when a date is set. Default true. */
  clearable?: boolean;
  size?: ControlSize;
  invalid?: boolean;
}

/** Native date input (OS date picker on phones) with a clear button. */
export const DateInput = forwardRef<HTMLInputElement, DateInputProps>(function DateInput(
  { value, onChange, clearable = true, size = 'md', invalid, className, disabled, ...rest },
  ref,
) {
  const field = useFieldControl({ ...rest, invalid });
  const inner = useRef<HTMLInputElement | null>(null);
  const merged = useMergeRefs([inner, ref]);
  const showClear = clearable && !!value && !disabled;
  return (
    <div className={clsx('relative w-full min-w-0', className)}>
      <input
        ref={merged}
        type="date"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
        disabled={disabled}
        {...rest}
        {...field}
        className={clsx(
          'block w-full min-w-0 appearance-none pl-3 text-sm',
          showClear ? 'pr-9' : 'pr-3',
          !value && 'text-fg-subtle',
          CONTROL_HEIGHTS[size],
          CONTROL_SURFACE,
        )}
      />
      {showClear && (
        <button
          type="button"
          aria-label="Clear date"
          onClick={() => {
            onChange(null);
            inner.current?.focus();
          }}
          className="absolute right-1 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-md text-fg-subtle hover:bg-surface-2 hover:text-fg md:size-7"
        >
          <X aria-hidden className="size-4" />
        </button>
      )}
    </div>
  );
});
