import { clsx } from 'clsx';
import { ChevronDown } from 'lucide-react';
import { forwardRef, type SelectHTMLAttributes } from 'react';
import { CONTROL_HEIGHTS, CONTROL_SURFACE, type ControlSize } from './controlStyles';
import { useFieldControl } from './Field';

export interface SelectOption {
  value: string | number;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  size?: ControlSize;
  /** Options (alternatively pass <option> children). */
  options?: readonly SelectOption[];
  /** Adds a first, disabled option shown while value is ''. */
  placeholder?: string;
  invalid?: boolean;
}

/**
 * Native <select>, styled (best on phones: uses the OS picker). Native props; `onChange`
 * receives the native event (values are strings — convert numbers yourself).
 * Full width by default; `className` goes on the wrapper.
 */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { size = 'md', options, placeholder, invalid, className, children, ...rest },
  ref,
) {
  const field = useFieldControl({ ...rest, invalid });
  return (
    <div className={clsx('relative w-full min-w-0', className)}>
      <select
        ref={ref}
        {...rest}
        {...field}
        className={clsx('block w-full min-w-0 appearance-none truncate pl-3 pr-9 text-sm', CONTROL_HEIGHTS[size], CONTROL_SURFACE)}
      >
        {placeholder !== undefined && (
          <option value="" disabled>
            {placeholder}
          </option>
        )}
        {options?.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
        {children}
      </select>
      <ChevronDown aria-hidden className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" />
    </div>
  );
});
