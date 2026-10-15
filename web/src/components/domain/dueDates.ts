// Due-date states and quick date presets shared by labels, pickers and the task menu.

import { addDays, endOfWeek, type ISODate, type WeekStart } from '@shared/dates';

/**
 * Visual state of a due date:
 *  - overdue:  before today and the task is open (danger)
 *  - today:    due today and open (warning)
 *  - soon:     due tomorrow and open
 *  - upcoming: later, open
 *  - closed:   the task is closed (always muted, never "overdue")
 */
export type DueState = 'overdue' | 'today' | 'soon' | 'upcoming' | 'closed';

export function dueState(dueDate: ISODate, today: ISODate, closed = false): DueState {
  if (closed) return 'closed';
  if (dueDate < today) return 'overdue';
  if (dueDate === today) return 'today';
  if (dueDate === addDays(today, 1)) return 'soon';
  return 'upcoming';
}

export type QuickDateKey = 'today' | 'tomorrow' | 'next_week';

export interface QuickDate {
  key: QuickDateKey;
  label: string;
  date: ISODate;
}

/**
 * Today / Tomorrow / Next week (the first day of next week, same as a board drop patch's
 * `due: 'next_week'`).
 */
export function quickDates(today: ISODate, weekStartsOn: WeekStart): QuickDate[] {
  return [
    { key: 'today', label: 'Today', date: today },
    { key: 'tomorrow', label: 'Tomorrow', date: addDays(today, 1) },
    { key: 'next_week', label: 'Next week', date: addDays(endOfWeek(today, weekStartsOn), 1) },
  ];
}
