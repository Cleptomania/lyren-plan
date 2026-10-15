import { describe, expect, it } from 'vitest';
import type { TaskTimelineDTO } from '@shared/types';
import { ApiError } from '../../api/client';
import { commentLeaveBody, isGoneError, listedInTimeline, worklogLeaveInput } from './leaveSave';

describe('commentLeaveBody', () => {
  const base = { editing: true, saving: false, draft: 'New text ', body: 'Old text' };

  it('saves a changed, non-blank draft (trimmed)', () => {
    expect(commentLeaveBody(base)).toBe('New text');
  });

  it('saves nothing when not editing, already saving, blank or unchanged', () => {
    expect(commentLeaveBody({ ...base, editing: false })).toBeNull();
    expect(commentLeaveBody({ ...base, saving: true })).toBeNull();
    expect(commentLeaveBody({ ...base, draft: '   ' })).toBeNull();
    expect(commentLeaveBody({ ...base, draft: ' Old text\n' })).toBeNull();
  });
});

describe('worklogLeaveInput', () => {
  const entry = { date: '2026-10-01', minutes: 30, note: 'Original' };

  it('returns the input for valid changes', () => {
    expect(worklogLeaveInput({ date: '2026-10-01', duration: '30m', note: 'Edited' }, entry)).toEqual({
      date: '2026-10-01',
      minutes: 30,
      note: 'Edited',
    });
    expect(worklogLeaveInput({ date: '2026-10-02', duration: '1h', note: 'Original' }, entry)).toEqual({
      date: '2026-10-02',
      minutes: 60,
      note: 'Original',
    });
  });

  it('returns null when unchanged or invalid', () => {
    expect(worklogLeaveInput({ date: '2026-10-01', duration: '30m', note: ' Original ' }, entry)).toBeNull();
    expect(worklogLeaveInput({ date: '2026-10-01', duration: 'soon', note: 'Edited' }, entry)).toBeNull();
    expect(worklogLeaveInput({ date: null, duration: '30m', note: 'Edited' }, entry)).toBeNull();
    expect(worklogLeaveInput({ date: '2026-10-01', duration: '', note: '' }, entry)).toBeNull();
  });
});

describe('listedInTimeline / isGoneError', () => {
  const timeline = { comments: [{ id: 3 }], worklogs: [{ id: 7 }], activity: [] } as unknown as TaskTimelineDTO;

  it('finds items of the right kind only', () => {
    expect(listedInTimeline(timeline, 'comments', 3)).toBe(true);
    expect(listedInTimeline(timeline, 'comments', 7)).toBe(false);
    expect(listedInTimeline(timeline, 'worklogs', 7)).toBe(true);
    expect(listedInTimeline(undefined, 'comments', 3)).toBe(false);
  });

  it('treats 404 / 401 as "gone", other failures not', () => {
    expect(isGoneError(new ApiError(404, 'not_found', 'Comment not found'))).toBe(true);
    expect(isGoneError(new ApiError(401, 'unauthorized', 'Sign in'))).toBe(true);
    expect(isGoneError(new ApiError(400, 'validation_error', 'Too long'))).toBe(false);
    expect(isGoneError(new Error('boom'))).toBe(false);
  });
});
