// A swatch button that opens a color picker (popover on desktop, bottom sheet on touch).
// Changes are previewed immediately and saved debounced (the native color input fires
// continuously while dragging); a pending change is flushed when the picker closes.

import { clsx } from 'clsx';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ColorPicker, Popover } from '../../components/ui';

const SAVE_DELAY_MS = 350;

export interface ColorButtonProps {
  value: string;
  onChange: (hex: string) => void;
  /** Accessible name, e.g. `Color of “bug”`. */
  label: string;
  disabled?: boolean;
  /** Custom swatch (e.g. a status icon in the color); default a filled dot. */
  preview?: (color: string) => ReactNode;
  className?: string;
}

export function ColorButton({ value, onChange, label, disabled, preview, className }: ColorButtonProps) {
  const [draft, setDraft] = useState(value);
  const [open, setOpen] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const pending = useRef<string | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (pending.current === null) setDraft(value);
  }, [value]);

  const valueRef = useRef(value);
  valueRef.current = value;

  const flush = () => {
    window.clearTimeout(timer.current);
    const next = pending.current;
    pending.current = null;
    if (next !== null && next !== valueRef.current) onChangeRef.current(next);
  };
  const flushRef = useRef(flush);
  flushRef.current = flush;

  // Save a pending change if the row unmounts while the picker is open.
  useEffect(() => () => flushRef.current(), []);

  const change = (hex: string) => {
    setDraft(hex);
    pending.current = hex;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, SAVE_DELAY_MS);
  };

  return (
    <Popover
      title={label}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) flush();
      }}
      trigger={
        <button
          type="button"
          disabled={disabled}
          aria-label={`${label}: ${draft}. Change`}
          className={clsx(
            'relative flex size-10 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-surface-2 disabled:opacity-50 md:size-8',
            className,
          )}
        >
          {preview ? (
            <span aria-hidden className="flex">
              {preview(draft)}
            </span>
          ) : (
            <span aria-hidden className="size-5 rounded-full border border-black/10 shadow-card md:size-4" style={{ backgroundColor: draft }} />
          )}
        </button>
      }
    >
      <ColorPicker value={draft} onChange={change} aria-label={label} />
    </Popover>
  );
}
