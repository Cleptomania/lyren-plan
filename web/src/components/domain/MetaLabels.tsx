// Small metadata labels for tasks: due/start dates, estimate, logged time, comment count.
// Each has a distinct icon and screen-reader text, so color is never the only signal.

import { CalendarArrowUp, CalendarClock, CalendarDays, CircleAlert, Clock, Gauge, Hourglass, MessageSquare } from 'lucide-react';
import type { EstimateUnit } from '@shared/constants';
import type { ISODate } from '@shared/dates';
import { formatMinutes } from '@shared/duration';
import { useLookups } from '../../api/bootstrap';
import { formatDateLong, formatDueDate, formatEstimate } from '../../lib/format';
import { dueState, type DueState } from './dueDates';
import { Pill, type PillSize, type PillTone } from './Pill';
import { useSharedToday } from './useSharedToday';

interface LabelBaseProps {
  size?: PillSize;
  /** Borderless (icon + text). */
  plain?: boolean;
  className?: string;
}

// ---- Dates ---------------------------------------------------------------------------

export interface DueDateLabelProps extends LabelBaseProps {
  date: ISODate | null | undefined;
  /** Default: the local date. */
  today?: ISODate;
  /** The task is closed: never shown as overdue/today. */
  closed?: boolean;
  /** Spell the state out ("Overdue · Oct 3", "Due today") instead of the date alone. */
  verbose?: boolean;
}

const DUE_TONE: Record<DueState, PillTone> = {
  overdue: 'danger',
  today: 'warning',
  soon: 'default',
  upcoming: 'muted',
  closed: 'subtle',
};

/**
 * Due date relative to today ("Today", "Tomorrow", "Fri, Oct 16", "Oct 3"). Overdue open
 * tasks are red with an alert icon, due-today ones amber; closed tasks stay muted.
 */
export function DueDateLabel({ date, today: todayProp, closed = false, verbose, size = 'sm', plain, className }: DueDateLabelProps) {
  const sharedToday = useSharedToday();
  if (!date) return null;
  const today = todayProp ?? sharedToday;
  const state = dueState(date, today, closed);
  const relative = formatDueDate(date, today);
  const Icon = state === 'overdue' ? CircleAlert : state === 'today' ? CalendarClock : CalendarDays;
  const visible =
    verbose && state === 'overdue' ? `Overdue · ${relative}` : verbose && state === 'today' ? 'Due today' : relative;
  const spoken = state === 'overdue' ? (verbose ? '' : 'Overdue, due ') : verbose && state === 'today' ? '' : 'Due ';
  return (
    <Pill
      size={size}
      plain={plain}
      tone={DUE_TONE[state]}
      className={className}
      title={`${state === 'overdue' ? 'Overdue — due' : 'Due'} ${formatDateLong(date)}`}
      icon={<Icon aria-hidden />}
    >
      {spoken && <span className="sr-only">{spoken}</span>}
      {visible}
    </Pill>
  );
}

export interface StartDateLabelProps extends LabelBaseProps {
  date: ISODate | null | undefined;
  today?: ISODate;
}

/** Start date ("Starts Oct 20" for screen readers; the date with a start icon visually). */
export function StartDateLabel({ date, today: todayProp, size = 'sm', plain, className }: StartDateLabelProps) {
  const sharedToday = useSharedToday();
  if (!date) return null;
  const today = todayProp ?? sharedToday;
  return (
    <Pill size={size} plain={plain} className={className} title={`Start ${formatDateLong(date)}`} icon={<CalendarArrowUp aria-hidden />}>
      <span className="sr-only">{date > today ? 'Starts ' : 'Started '}</span>
      {formatDueDate(date, today)}
    </Pill>
  );
}

// ---- Estimate / time / comments ------------------------------------------------------

export interface EstimateLabelProps extends LabelBaseProps {
  value: number | null | undefined;
  /** Default: settings.estimateUnit. */
  unit?: EstimateUnit;
}

/** "3 pts" / "4h" with a gauge (points) or hourglass (hours) icon. */
export function EstimateLabel({ unit, ...rest }: EstimateLabelProps) {
  if (rest.value === null || rest.value === undefined) return null;
  return unit ? <EstimateLabelView unit={unit} {...rest} /> : <ConnectedEstimateLabel {...rest} />;
}

function ConnectedEstimateLabel(props: Omit<EstimateLabelProps, 'unit'>) {
  const { settings } = useLookups();
  return <EstimateLabelView unit={settings.estimateUnit} {...props} />;
}

function EstimateLabelView({ value, unit, size = 'sm', plain, className }: EstimateLabelProps & { unit: EstimateUnit }) {
  const Icon = unit === 'hours' ? Hourglass : Gauge;
  return (
    <Pill size={size} plain={plain} className={className} icon={<Icon aria-hidden />}>
      <span className="sr-only">Estimate </span>
      {formatEstimate(value, unit)}
    </Pill>
  );
}

export interface DurationLabelProps extends LabelBaseProps {
  minutes: number | null | undefined;
  /** Screen-reader prefix (default "Time logged"). */
  srLabel?: string;
}

/** Logged time ("1h 30m") with a clock icon. */
export function DurationLabel({ minutes, srLabel = 'Time logged', size = 'sm', plain, className }: DurationLabelProps) {
  if (minutes === null || minutes === undefined) return null;
  return (
    <Pill size={size} plain={plain} className={className} icon={<Clock aria-hidden />}>
      <span className="sr-only">{srLabel} </span>
      {formatMinutes(minutes)}
    </Pill>
  );
}

export interface CommentCountLabelProps extends LabelBaseProps {
  count: number;
}

/** Speech-bubble icon + count ("3 comments" for screen readers). */
export function CommentCountLabel({ count, size = 'sm', plain = true, className }: CommentCountLabelProps) {
  return (
    <Pill size={size} plain={plain} className={className} icon={<MessageSquare aria-hidden />}>
      <span aria-hidden>{count}</span>
      <span className="sr-only">
        {count} {count === 1 ? 'comment' : 'comments'}
      </span>
    </Pill>
  );
}
