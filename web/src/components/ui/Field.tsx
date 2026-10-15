// Form field wrapper: label + control + hint/error. Controls from this kit (Input, Textarea,
// Select, DateInput, PasswordInput, MarkdownEditor, ColorPicker…) pick up the field's id,
// aria-describedby and aria-invalid automatically through context.

import { clsx } from 'clsx';
import { CircleAlert } from 'lucide-react';
import { createContext, useContext, useId, type AriaAttributes, type ReactNode } from 'react';

interface FieldContextValue {
  id: string;
  describedBy: string | undefined;
  invalid: boolean;
  required: boolean;
}

const FieldContext = createContext<FieldContextValue | null>(null);

/** Props a control should apply so it is labelled/described by the enclosing Field. */
export function useFieldControl(props: {
  id?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: AriaAttributes['aria-invalid'];
  invalid?: boolean;
  required?: boolean;
}): { id: string | undefined; 'aria-describedby': string | undefined; 'aria-invalid': true | undefined; required: boolean | undefined } {
  const ctx = useContext(FieldContext);
  const describedBy = [ctx?.describedBy, props['aria-describedby']].filter(Boolean).join(' ') || undefined;
  const ownInvalid = props['aria-invalid'];
  const invalid = props.invalid ?? ((ownInvalid !== undefined && ownInvalid !== false && ownInvalid !== 'false') || ctx?.invalid === true);
  return {
    id: props.id ?? ctx?.id,
    'aria-describedby': describedBy,
    'aria-invalid': invalid || undefined,
    required: props.required ?? (ctx?.required || undefined),
  };
}

export interface FieldProps {
  label: ReactNode;
  children: ReactNode;
  /** Help text under the control (hidden while an error is shown). */
  hint?: ReactNode;
  /** Error message; marks the control aria-invalid. Falsy = no error. */
  error?: ReactNode;
  /** Adds a required marker and sets `required` on the control. */
  required?: boolean;
  /** Shows a muted "Optional" next to the label. */
  optional?: boolean;
  /** Id for the control (generated when omitted). */
  htmlFor?: string;
  /** Visually hide the label (still read by screen readers). */
  hideLabel?: boolean;
  /** Element at the end of the label row (e.g. a "Forgot?" link). */
  labelAction?: ReactNode;
  className?: string;
}

export function Field({ label, children, hint, error, required, optional, htmlFor, hideLabel, labelAction, className }: FieldProps) {
  const autoId = useId();
  const id = htmlFor ?? `f${autoId}`;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const hasError = !!error;
  const describedBy = hasError ? errorId : hint ? hintId : undefined;

  return (
    <FieldContext.Provider value={{ id, describedBy, invalid: hasError, required: !!required }}>
      <div className={clsx('flex min-w-0 flex-col gap-1.5', className)}>
        <div className={clsx('flex items-baseline justify-between gap-2', hideLabel && 'sr-only')}>
          <label htmlFor={id} className="text-[13px] font-medium text-fg">
            {label}
            {required && (
              <span aria-hidden className="ml-0.5 text-danger">
                *
              </span>
            )}
            {optional && <span className="ml-1.5 text-xs font-normal text-fg-subtle">Optional</span>}
          </label>
          {labelAction}
        </div>
        {children}
        {hasError ? (
          <p id={errorId} className="flex items-start gap-1 text-xs text-danger">
            <CircleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
            <span>{error}</span>
          </p>
        ) : hint ? (
          <p id={hintId} className="text-xs text-fg-muted">
            {hint}
          </p>
        ) : null}
      </div>
    </FieldContext.Provider>
  );
}
