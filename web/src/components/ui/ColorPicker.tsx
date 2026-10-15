import { clsx } from 'clsx';
import { Check, Pipette } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { COLOR_PALETTE } from '@shared/constants';
import { readableTextColor } from '../../lib/colors';
import { useFieldControl } from './Field';
import { normalizeHex } from './hex';

export interface ColorPickerProps {
  /** '#rrggbb'. */
  value: string;
  onChange: (hex: string) => void;
  /** Swatches (default COLOR_PALETTE). */
  palette?: readonly string[];
  /** Show the custom color row (native color input + hex field). Default true. */
  allowCustom?: boolean;
  'aria-label'?: string;
  id?: string;
  className?: string;
}

/** Swatch grid (radio group) plus an optional custom hex color. */
export function ColorPicker({
  value,
  onChange,
  palette = COLOR_PALETTE,
  allowCustom = true,
  'aria-label': ariaLabel = 'Color',
  id,
  className,
}: ColorPickerProps) {
  const field = useFieldControl({ id });
  const current = normalizeHex(value) ?? value;
  const inPalette = palette.some((c) => normalizeHex(c) === current);
  const groupRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState(current);
  const hexId = useId();
  useEffect(() => setDraft(current), [current]);

  const commitDraft = () => {
    const hex = normalizeHex(draft);
    if (hex) {
      if (hex !== current) onChange(hex);
      setDraft(hex);
    } else {
      setDraft(current);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const keys: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    const delta = keys[e.key];
    if (!delta) return;
    e.preventDefault();
    const idx = palette.findIndex((c) => normalizeHex(c) === current);
    const next = palette[(Math.max(idx, 0) + delta + palette.length) % palette.length]!;
    onChange(normalizeHex(next) ?? next);
    requestAnimationFrame(() => groupRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus());
  };

  return (
    <div className={clsx('flex flex-col gap-3', className)}>
      <div
        ref={groupRef}
        role="radiogroup"
        aria-label={ariaLabel}
        id={field.id}
        aria-describedby={field['aria-describedby']}
        onKeyDown={onKeyDown}
        className="flex flex-wrap gap-2 md:gap-1.5"
      >
        {palette.map((c, i) => {
          const hex = normalizeHex(c) ?? c;
          const checked = hex === current;
          return (
            <button
              key={hex}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={hex}
              tabIndex={checked || (!inPalette && i === 0) ? 0 : -1}
              onClick={() => onChange(hex)}
              className={clsx(
                'flex size-9 shrink-0 items-center justify-center rounded-md transition-transform duration-100 hover:scale-110 motion-reduce:transition-none md:size-7',
                checked && 'ring-2 ring-fg ring-offset-2 ring-offset-popover',
              )}
              style={{ backgroundColor: hex }}
            >
              {checked && <Check aria-hidden className="size-4" style={{ color: readableTextColor(hex) }} />}
            </button>
          );
        })}
      </div>
      {allowCustom && (
        <div className="flex items-center gap-2">
          <label
            className={clsx(
              'relative flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-md border border-border shadow-card md:size-8',
              !inPalette && 'ring-2 ring-fg ring-offset-2 ring-offset-popover',
            )}
            style={{ backgroundColor: current }}
            title="Pick a custom color"
          >
            <Pipette aria-hidden className="size-4" style={{ color: readableTextColor(current) }} />
            <input
              type="color"
              aria-label="Custom color"
              value={normalizeHex(current) ?? '#000000'}
              onChange={(e) => onChange(e.target.value.toLowerCase())}
              className="absolute inset-0 size-full cursor-pointer opacity-0"
            />
          </label>
          <label htmlFor={hexId} className="sr-only">
            Hex color
          </label>
          <input
            id={hexId}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitDraft}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitDraft();
              }
            }}
            maxLength={7}
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            aria-invalid={normalizeHex(draft) === null || undefined}
            className="h-9 w-28 rounded-md border md:h-8 border-border bg-surface px-2.5 font-mono text-sm text-fg uppercase shadow-card focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-focus/20 aria-[invalid=true]:border-danger"
          />
        </div>
      )}
    </div>
  );
}
