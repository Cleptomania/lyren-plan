// Date editing: DateField (form field: label + date input + quick-date menu) and DatePicker
// (compact property button opening quick dates + a date input).

import { clsx } from 'clsx';
import { CalendarArrowUp, CalendarDays, CalendarFold, X } from 'lucide-react';
import { useState, type ReactElement, type ReactNode } from 'react';
import type { Placement } from '@floating-ui/react';
import { isValidISODate, type ISODate } from '@shared/dates';
import { useLookups } from '../../api/bootstrap';
import { formatDate, formatDateLong, formatDueDate } from '../../lib/format';
import { Button, DateInput, Field, IconButton, Menu, Popover, useSheetMode, type MenuItem } from '../ui';
import { dueState, quickDates } from './dueDates';
import { PropertyButton, type PropertyButtonProps } from './PropertyButton';
import { useSharedToday } from './useSharedToday';

function useQuickDates() {
  const today = useSharedToday();
  const { settings } = useLookups();
  return { today, quick: quickDates(today, settings.weekStartsOn) };
}

// ---- DateField -----------------------------------------------------------------------------

export interface DateFieldProps {
  label: ReactNode;
  value: ISODate | null;
  onChange: (value: ISODate | null) => void;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  optional?: boolean;
  hideLabel?: boolean;
  min?: ISODate;
  max?: ISODate;
  /** Menu with Today / Tomorrow / Next week / Clear next to the input (default true). */
  quickOptions?: boolean;
  disabled?: boolean;
  className?: string;
}

/** Labelled native date input plus a quick-date menu. onChange fires with 'YYYY-MM-DD' or null. */
export function DateField({
  label,
  value,
  onChange,
  hint,
  error,
  required,
  optional,
  hideLabel,
  min,
  max,
  quickOptions = true,
  disabled,
  className,
}: DateFieldProps) {
  const { today, quick } = useQuickDates();
  const items: MenuItem[] = [
    ...quick.map((q) => ({
      label: q.label,
      hint: formatDate(q.date, today),
      checked: value === q.date,
      disabled: (min !== undefined && q.date < min) || (max !== undefined && q.date > max),
      onSelect: () => onChange(q.date),
    })),
    { separator: true },
    { label: 'Clear', icon: <X />, disabled: value === null, onSelect: () => onChange(null) },
  ];
  return (
    <Field label={label} hint={hint} error={error} required={required} optional={optional} hideLabel={hideLabel} className={className}>
      <div className="flex min-w-0 items-center gap-2">
        <DateInput value={value} onChange={onChange} min={min} max={max} disabled={disabled} className="flex-1" />
        {quickOptions && (
          <Menu
            label="Quick dates"
            items={items}
            trigger={<IconButton variant="secondary" aria-label="Quick dates" icon={<CalendarFold />} disabled={disabled} />}
          />
        )}
      </div>
    </Field>
  );
}

// ---- DatePicker ----------------------------------------------------------------------------

export interface DatePickerProps {
  value: ISODate | null;
  onChange: (value: ISODate | null) => void;
  /** Accessible name and popover title (default "Due date"). */
  label?: string;
  /** 'due' (default) colors overdue / today values; 'start' uses a start icon. */
  kind?: 'due' | 'start';
  /** The task is closed: a past due date is not shown as overdue. */
  closed?: boolean;
  min?: ISODate;
  max?: ISODate;
  /** Default-trigger text without a date (default "No due date" / "No start date"). */
  placeholder?: string;
  trigger?: ReactElement;
  triggerProps?: Partial<PropertyButtonProps>;
  placement?: Placement;
}

/**
 * Compact date editor for property panels: a button showing the date ("Tomorrow",
 * "Oct 3" in red when overdue) that opens quick dates, a date input and Clear.
 */
export function DatePicker({
  value,
  onChange,
  label = 'Due date',
  kind = 'due',
  closed = false,
  min,
  max,
  placeholder,
  trigger,
  triggerProps,
  placement,
}: DatePickerProps) {
  const { today, quick } = useQuickDates();
  const sheetMode = useSheetMode();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ISODate | null>(value);
  const onOpenChange = (next: boolean) => {
    if (next) setDraft(value);
    setOpen(next);
  };

  const state = kind === 'due' && value ? dueState(value, today, closed) : null;
  const emptyText = placeholder ?? (kind === 'due' ? 'No due date' : 'No start date');
  const triggerEl = trigger ?? (
    <PropertyButton
      aria-label={`${label}: ${value ? formatDateLong(value) : 'none'}${state === 'overdue' ? ' (overdue)' : ''}`}
      icon={kind === 'start' ? <CalendarArrowUp /> : <CalendarDays />}
      placeholder={!value}
      tone={state === 'overdue' ? 'danger' : state === 'today' ? 'warning' : undefined}
      {...triggerProps}
    >
      {value ? formatDueDate(value, today) : emptyText}
    </PropertyButton>
  );

  const apply = (next: ISODate | null) => {
    if (next !== value) onChange(next);
    setOpen(false);
  };
  const draftValid = draft === null || (isValidISODate(draft) && (!min || draft >= min) && (!max || draft <= max));

  return (
    <Popover trigger={triggerEl} open={open} onOpenChange={onOpenChange} title={label} placement={placement} className="w-64 p-1.5">
      <div className="flex flex-col">
        {quick.map((q) => {
          const outOfRange = (min !== undefined && q.date < min) || (max !== undefined && q.date > max);
          return (
            <button
              key={q.key}
              type="button"
              disabled={outOfRange}
              onClick={() => apply(q.date)}
              className={clsx(
                'flex items-center justify-between gap-3 rounded-md text-left hover:bg-surface-2 disabled:opacity-45',
                sheetMode ? 'h-12 px-3 text-[15px]' : 'h-8 px-2 text-[13px]',
                value === q.date ? 'font-medium text-accent' : 'text-fg',
              )}
            >
              <span>{q.label}</span>
              <span className="text-xs text-fg-subtle">{formatDate(q.date, today)}</span>
            </button>
          );
        })}
        <div className="-mx-1.5 my-1.5 h-px bg-border" />
        <form
          className="flex flex-col gap-2 px-1.5 pb-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (draftValid) apply(draft);
          }}
        >
          <DateInput value={draft} onChange={setDraft} min={min} max={max} aria-label={label} size="sm" />
          <div className="flex gap-2">
            {value !== null && (
              <Button size="sm" variant="ghost" onClick={() => apply(null)} className="mr-auto">
                Clear
              </Button>
            )}
            <Button size="sm" variant="primary" type="submit" disabled={!draftValid || draft === value} className="ml-auto">
              Set date
            </Button>
          </div>
        </form>
      </div>
    </Popover>
  );
}
