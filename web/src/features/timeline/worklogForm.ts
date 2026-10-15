// Work-log form logic (pure, unit-tested): the free-text duration field and turning the
// form's values into a validated WorklogCreateInput.

import { LIMITS } from '@shared/constants';
import { isValidISODate } from '@shared/dates';
import { formatMinutes, parseDuration } from '@shared/duration';
import { worklogCreateInput, type WorklogCreateInput } from '@shared/schemas';

export type DurationParse =
  | { state: 'empty' }
  | { state: 'valid'; minutes: number }
  | { state: 'invalid'; message: string };

export const DURATION_HINT = 'e.g. 1h 30m, 90, 1.5h or 1:30';

/** Parse the duration text ("1h 30m", "90", "1.5h", "1:30"); empty means "no time". */
export function parseDurationInput(text: string): DurationParse {
  if (text.trim() === '') return { state: 'empty' };
  const minutes = parseDuration(text);
  if (minutes === null) return { state: 'invalid', message: `Couldn’t read that — try ${DURATION_HINT}` };
  if (minutes > LIMITS.worklogMinutesMax) {
    return { state: 'invalid', message: `That’s more than ${formatMinutes(LIMITS.worklogMinutesMax)} — split it into several entries` };
  }
  return { state: 'valid', minutes };
}

export interface WorklogFormValues {
  date: string | null;
  /** Free text, parsed with parseDurationInput. */
  duration: string;
  note: string;
}

export type WorklogFormField = 'date' | 'duration' | 'note';
export type WorklogFormErrors = Partial<Record<WorklogFormField, string>>;

export const TIME_OR_NOTE = 'Enter time spent or a note';

/** Validate the form; on success the input is ready for POST/PATCH. */
export function validateWorklogForm(
  values: WorklogFormValues,
): { ok: true; input: WorklogCreateInput & { minutes: number | null; note: string } } | { ok: false; errors: WorklogFormErrors } {
  const errors: WorklogFormErrors = {};
  if (!values.date) errors.date = 'Pick a date';
  else if (!isValidISODate(values.date)) errors.date = 'Enter a valid date';
  const duration = parseDurationInput(values.duration);
  if (duration.state === 'invalid') errors.duration = duration.message;
  const minutes = duration.state === 'valid' ? duration.minutes : null;
  const note = values.note.trim();
  if (note.length > LIMITS.worklogNoteMax) errors.note = `Keep it under ${LIMITS.worklogNoteMax.toLocaleString('en')} characters`;
  if (duration.state !== 'invalid' && (minutes ?? 0) <= 0 && note === '') errors.duration = TIME_OR_NOTE;
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const parsed = worklogCreateInput.safeParse({ date: values.date, minutes, note });
  if (!parsed.success) {
    const out: WorklogFormErrors = {};
    for (const issue of parsed.error.issues) {
      const path = String(issue.path[0] ?? '');
      const field: WorklogFormField = path === 'minutes' ? 'duration' : path === 'date' ? 'date' : 'note';
      out[field] ??= issue.message;
    }
    return { ok: false, errors: out };
  }
  return { ok: true, input: { date: parsed.data.date, minutes, note } };
}

/** Map API field errors (paths date / minutes / note) onto the form's fields. */
export function worklogApiErrors(details: ReadonlyArray<{ path: string; message: string }>): WorklogFormErrors {
  const out: WorklogFormErrors = {};
  for (const d of details) {
    const field: WorklogFormField | null =
      d.path === 'minutes' ? 'duration' : d.path === 'date' ? 'date' : d.path === 'note' ? (d.message === TIME_OR_NOTE ? 'duration' : 'note') : null;
    if (field) out[field] ??= d.message;
  }
  return out;
}

/** Initial duration text for editing an entry ("1h 30m"; empty for none). */
export function durationText(minutes: number | null): string {
  return minutes === null || minutes <= 0 ? '' : formatMinutes(minutes);
}
