import { clsx } from 'clsx';
import { Eye, EyeOff } from 'lucide-react';
import { forwardRef, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { IconButton } from './Button';
import { CONTROL_HEIGHTS, CONTROL_SURFACE, type ControlSize } from './controlStyles';
import { useFieldControl } from './Field';

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'prefix'> {
  size?: ControlSize;
  /** Icon inside the field on the left (e.g. a search icon). */
  leadingIcon?: ReactNode;
  /** Element inside the field on the right (e.g. a unit label or a clear button). */
  trailing?: ReactNode;
  /** Marks the field invalid (Field's `error` does this automatically). */
  invalid?: boolean;
  /** Applied to the <input> when the field has adornments (className goes on the wrapper then). */
  inputClassName?: string;
}

/**
 * Text input (native props; `onChange` receives the native event). Full width by default.
 * `className` goes on the outermost element.
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { size = 'md', leadingIcon, trailing, invalid, className, inputClassName, type = 'text', ...rest },
  ref,
) {
  const field = useFieldControl({ ...rest, invalid });
  const adorned = leadingIcon !== undefined || trailing !== undefined;
  const input = (
    <input
      ref={ref}
      type={type}
      {...rest}
      {...field}
      className={clsx(
        'block w-full min-w-0 px-3 text-sm',
        CONTROL_HEIGHTS[size],
        CONTROL_SURFACE,
        leadingIcon !== undefined && 'pl-9',
        trailing !== undefined && 'pr-10',
        adorned ? inputClassName : className,
      )}
    />
  );
  if (!adorned) return input;
  return (
    <div className={clsx('relative w-full min-w-0', className)}>
      {leadingIcon !== undefined && (
        <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-fg-subtle [&_svg]:size-4">{leadingIcon}</span>
      )}
      {input}
      {trailing !== undefined && <span className="absolute inset-y-0 right-1 flex items-center text-fg-muted">{trailing}</span>}
    </div>
  );
});

export type PasswordInputProps = Omit<InputProps, 'type' | 'trailing'>;

/** Password field with a show/hide toggle. Set autoComplete ('current-password' / 'new-password'). */
export const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(function PasswordInput(props, ref) {
  const [visible, setVisible] = useState(false);
  return (
    <Input
      ref={ref}
      {...props}
      type={visible ? 'text' : 'password'}
      autoCapitalize="none"
      autoCorrect="off"
      spellCheck={false}
      trailing={
        <IconButton
          size="sm"
          aria-label={visible ? 'Hide password' : 'Show password'}
          tooltip={false}
          pressed={visible}
          icon={visible ? <EyeOff /> : <Eye />}
          onClick={() => setVisible((v) => !v)}
          // 36px fits inside the 40px phone input; the ::before makes the touch target 40px.
          className="max-md:size-9 max-md:before:absolute max-md:before:-inset-0.5 max-md:before:content-['']"
        />
      }
    />
  );
});
