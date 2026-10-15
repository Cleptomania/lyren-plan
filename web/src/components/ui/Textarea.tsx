import { useMergeRefs } from '@floating-ui/react';
import { clsx } from 'clsx';
import { forwardRef, useLayoutEffect, useRef, type TextareaHTMLAttributes } from 'react';
import { autosizeTextarea } from './autosize';
import { CONTROL_SURFACE } from './controlStyles';
import { useFieldControl } from './Field';

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** Grow with the content between minRows and maxRows. */
  autoGrow?: boolean;
  /** Minimum visible rows (default 3). */
  minRows?: number;
  /** Maximum rows before scrolling when autoGrow (default 16; 0 = unlimited). */
  maxRows?: number;
  invalid?: boolean;
}

/** Multi-line text input (native props). */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { autoGrow, minRows = 3, maxRows = 16, invalid, className, rows, onInput, ...rest },
  ref,
) {
  const field = useFieldControl({ ...rest, invalid });
  const inner = useRef<HTMLTextAreaElement | null>(null);
  const merged = useMergeRefs([inner, ref]);
  useAutosize(inner, !!autoGrow, minRows, maxRows, rest.value);

  return (
    <textarea
      ref={merged}
      rows={rows ?? minRows}
      {...rest}
      {...field}
      onInput={(e) => {
        onInput?.(e);
        if (autoGrow) autosizeTextarea(e.currentTarget, minRows, maxRows);
      }}
      className={clsx(
        'block w-full min-w-0 px-3 py-2 text-sm leading-relaxed',
        CONTROL_SURFACE,
        autoGrow ? 'resize-none' : 'resize-y',
        className,
      )}
    />
  );
});

/** Keep an auto-growing textarea sized on value changes and width changes. */
export function useAutosize(
  ref: { current: HTMLTextAreaElement | null },
  enabled: boolean,
  minRows: number,
  maxRows: number,
  value: unknown,
): void {
  useLayoutEffect(() => {
    if (enabled && ref.current) autosizeTextarea(ref.current, minRows, maxRows);
  }, [ref, enabled, minRows, maxRows, value]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!enabled || !el || typeof ResizeObserver === 'undefined') return;
    let width = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth !== width) {
        width = el.clientWidth;
        autosizeTextarea(el, minRows, maxRows);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, enabled, minRows, maxRows]);
}
