// Editing an existing comment or work-log entry and then leaving it (the drawer closed with
// Back / ← / ×, another task opened, the timeline tab switched) saves the edit, like the task
// title and description editors do. That save must not run once the item itself is gone (it
// was deleted elsewhere, or the user signed out and the cache was dropped): such a request
// could only fail. A request that still loses that race (404 / 401) fails silently.

import type { QueryClient } from '@tanstack/react-query';
import type { TaskTimelineDTO, WorklogDTO } from '@shared/types';
import { ApiError } from '../../api/client';
import { qk } from '../../api/keys';
import { validateWorklogForm, type WorklogFormValues } from './worklogForm';

export type TimelineItemKind = 'comments' | 'worklogs';

type WorklogFormInput = Extract<ReturnType<typeof validateWorklogForm>, { ok: true }>['input'];

/**
 * The comment body to save when an in-place edit is left without Save / Cancel, or null:
 * nothing to save when not editing, a save is already in flight, the draft is blank (Save is
 * disabled for that too) or unchanged.
 */
export function commentLeaveBody(state: { editing: boolean; saving: boolean; draft: string; body: string }): string | null {
  if (!state.editing || state.saving) return null;
  const next = state.draft.trim();
  return next !== '' && next !== state.body.trim() ? next : null;
}

/**
 * The PATCH input to save when a work-log entry edit is left without Save / Cancel, or null
 * when the form is invalid (nothing to save: the entry keeps its values) or unchanged.
 */
export function worklogLeaveInput(
  values: WorklogFormValues,
  entry: Pick<WorklogDTO, 'date' | 'minutes' | 'note'>,
): WorklogFormInput | null {
  const result = validateWorklogForm(values);
  if (!result.ok) return null;
  const { date, minutes, note } = result.input;
  if (date === entry.date && minutes === entry.minutes && note === entry.note) return null;
  return result.input;
}

/** True while the cached timeline of the task still lists the item. */
export function listedInTimeline(timeline: TaskTimelineDTO | undefined, kind: TimelineItemKind, id: number): boolean {
  const list = timeline?.[kind] as ReadonlyArray<{ id: number }> | undefined;
  return Array.isArray(list) && list.some((item) => item.id === id);
}

/** listedInTimeline against the query cache, read at call time. */
export function stillInTimeline(qc: QueryClient, taskId: number, kind: TimelineItemKind, id: number): boolean {
  return listedInTimeline(qc.getQueryData<TaskTimelineDTO>(qk.timeline(taskId)), kind, id);
}

/** A failed leave-save that only means "nothing left to save to": not worth an error toast. */
export function isGoneError(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 404 || err.status === 401);
}
