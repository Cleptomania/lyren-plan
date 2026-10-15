// Estimate editing in the configured unit (settings.estimateUnit): EstimateField (form field)
// and EstimatePicker (property button with presets + input).

import { clsx } from 'clsx';
import { Gauge, Hourglass } from 'lucide-react';
import { useEffect, useId, useState, type KeyboardEvent, type ReactElement, type ReactNode } from 'react';
import type { Placement } from '@floating-ui/react';
import type { EstimateUnit } from '@shared/constants';
import { useLookups } from '../../api/bootstrap';
import { formatEstimate } from '../../lib/format';
import { Button, Field, Input, Popover, useSheetMode } from '../ui';
import { ESTIMATE_PRESETS, estimateInputText, parseEstimateInput } from './estimateInput';
import { PropertyButton, type PropertyButtonProps } from './PropertyButton';

const UNIT_SUFFIX: Record<EstimateUnit, string> = { points: 'pts', hours: 'h' };

function useEstimateUnit(unit: EstimateUnit | undefined): EstimateUnit {
  const { settings } = useLookups();
  return unit ?? settings.estimateUnit;
}

/** Local text draft for an estimate input, re-synced when the value changes outside editing. */
function useEstimateDraft(value: number | null, unit: EstimateUnit) {
  const [draft, setDraft] = useState(() => estimateInputText(value));
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!editing) setDraft(estimateInputText(value));
  }, [value, editing]);
  const parse = (text: string) => parseEstimateInput(text, unit);
  return { draft, setDraft, editing, setEditing, error, setError, parse };
}

// ---- EstimateField --------------------------------------------------------------------------

export interface EstimateFieldProps {
  value: number | null;
  onChange: (value: number | null) => void;
  label?: ReactNode;
  hint?: ReactNode;
  hideLabel?: boolean;
  /** 'blur' (default): onChange on blur / Enter. 'change': on every valid edit (forms). */
  commitOn?: 'blur' | 'change';
  /** Default: settings.estimateUnit. */
  unit?: EstimateUnit;
  disabled?: boolean;
  className?: string;
}

/** Numeric estimate input with the unit as suffix; invalid input shows an inline error. */
export function EstimateField({
  value,
  onChange,
  label = 'Estimate',
  hint,
  hideLabel,
  commitOn = 'blur',
  unit: unitProp,
  disabled,
  className,
}: EstimateFieldProps) {
  const unit = useEstimateUnit(unitProp);
  const d = useEstimateDraft(value, unit);

  /** Returns false (and shows the error) when the text is not a valid estimate. */
  const commit = (text: string): boolean => {
    const r = d.parse(text);
    if (!r.ok) {
      d.setError(r.error);
      return false;
    }
    d.setError(null);
    if (r.value !== value) onChange(r.value);
    return true;
  };

  return (
    <Field label={label} hint={hint} error={d.error} hideLabel={hideLabel} className={className}>
      <Input
        value={d.draft}
        inputMode="decimal"
        autoComplete="off"
        placeholder={unit === 'hours' ? 'e.g. 2 or 1h 30m' : 'e.g. 3'}
        disabled={disabled}
        trailing={<span className="pr-2 text-xs text-fg-subtle">{UNIT_SUFFIX[unit]}</span>}
        onFocus={() => d.setEditing(true)}
        onChange={(e) => {
          d.setDraft(e.target.value);
          if (commitOn === 'change') {
            const r = d.parse(e.target.value);
            if (r.ok) {
              d.setError(null);
              if (r.value !== value) onChange(r.value);
            }
          } else if (d.error) {
            d.setError(null);
          }
        }}
        onBlur={(e) => {
          // Invalid text stays (with its error) instead of snapping back to the old value.
          if (commit(e.target.value)) d.setEditing(false);
        }}
        onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
          if (e.key === 'Enter' && commitOn === 'blur') commit(e.currentTarget.value);
        }}
      />
    </Field>
  );
}

// ---- EstimatePicker -------------------------------------------------------------------------

export interface EstimatePickerProps {
  value: number | null;
  onChange: (value: number | null) => void;
  /** Accessible name / popover title (default "Estimate"). */
  label?: string;
  unit?: EstimateUnit;
  trigger?: ReactElement;
  triggerProps?: Partial<PropertyButtonProps>;
  placement?: Placement;
}

/** Compact estimate editor: quick presets (1 2 3 5 8 13 pts / ½ 1 2 4 8 16 h), a custom value and Clear. */
export function EstimatePicker({ value, onChange, label = 'Estimate', unit: unitProp, trigger, triggerProps, placement }: EstimatePickerProps) {
  const unit = useEstimateUnit(unitProp);
  const sheetMode = useSheetMode();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  const onOpenChange = (next: boolean) => {
    if (next) {
      setDraft(estimateInputText(value));
      setError(null);
    }
    setOpen(next);
  };

  const Icon = unit === 'hours' ? Hourglass : Gauge;
  const triggerEl = trigger ?? (
    <PropertyButton aria-label={`${label}: ${value === null ? 'none' : formatEstimate(value, unit)}`} icon={<Icon />} placeholder={value === null} {...triggerProps}>
      {value === null ? 'No estimate' : formatEstimate(value, unit)}
    </PropertyButton>
  );

  const apply = (next: number | null) => {
    if (next !== value) onChange(next);
    setOpen(false);
  };

  return (
    <Popover trigger={triggerEl} open={open} onOpenChange={onOpenChange} title={label} placement={placement} className="w-64 p-3">
      <div className="flex flex-col gap-3">
        <div role="group" aria-label="Quick estimates" className="grid grid-cols-6 gap-1">
          {ESTIMATE_PRESETS[unit].map((preset) => (
            <button
              key={preset}
              type="button"
              aria-pressed={value === preset}
              aria-label={formatEstimate(preset, unit)}
              onClick={() => apply(preset)}
              className={clsx(
                'flex items-center justify-center rounded-md border text-sm tabular-nums transition-colors',
                sheetMode ? 'h-11' : 'h-8 text-[13px]',
                value === preset ? 'border-accent bg-accent-soft font-semibold text-accent' : 'border-border text-fg hover:bg-surface-2',
              )}
            >
              {preset === 0.5 ? '½' : preset}
            </button>
          ))}
        </div>
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const r = parseEstimateInput(draft, unit);
            if (r.ok) apply(r.value);
            else setError(r.error);
          }}
        >
          <Field label="Custom" htmlFor={inputId} error={error} hideLabel>
            <Input
              size="sm"
              value={draft}
              inputMode="decimal"
              autoComplete="off"
              enterKeyHint="done"
              aria-label={`Custom ${label.toLocaleLowerCase()}`}
              placeholder={unit === 'hours' ? 'Hours, e.g. 1h 30m' : 'Points'}
              trailing={<span className="pr-2 text-xs text-fg-subtle">{UNIT_SUFFIX[unit]}</span>}
              onChange={(e) => {
                setDraft(e.target.value);
                setError(null);
              }}
            />
          </Field>
          <div className="flex gap-2">
            {value !== null && (
              <Button size="sm" variant="ghost" onClick={() => apply(null)}>
                Clear
              </Button>
            )}
            <Button size="sm" variant="primary" type="submit" className="ml-auto">
              Set
            </Button>
          </div>
        </form>
      </div>
    </Popover>
  );
}
