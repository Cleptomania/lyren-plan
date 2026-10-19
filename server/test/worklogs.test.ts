import { describe, expect, it } from 'vitest';
import { LIMITS } from '@shared/constants';
import type { WorklogDTO } from '@shared/types';
import { getTaskDTO } from '../src/services/tasks';
import { activityRows, countRows, insertWorklog, lastActivity, secondUser, setupTimeline } from './timeline.fixtures';

describe('POST /api/tasks/:id/worklogs', () => {
  it('logs time with a note and records worklog.created', async () => {
    const ctx = await setupTimeline();
    const res = await ctx.client.post<WorklogDTO>(`/api/tasks/${ctx.taskId}/worklogs`, {
      date: '2026-10-12',
      minutes: 90,
      note: '  Pairing on the layout  ',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      taskId: ctx.taskId,
      date: '2026-10-12',
      minutes: 90,
      note: 'Pairing on the layout',
      author: { id: ctx.user.id, displayName: 'Owner' },
    });
    expect(res.body.createdAt).toBe(res.body.updatedAt);

    const a = lastActivity(ctx.db);
    expect(a).toMatchObject({
      action: 'worklog.created',
      entity_type: 'worklog',
      entity_id: res.body.id,
      task_id: ctx.taskId,
      project_id: ctx.projectId,
      user_id: ctx.user.id,
      created_at: res.body.createdAt,
    });
    expect(a.parsed).toEqual({
      minutes: 90,
      date: '2026-10-12',
      note: 'Pairing on the layout',
      title: 'Write the brief',
      ref: 'WEB-1',
    });
  });

  it('accepts minutes without a note and a note without minutes', async () => {
    const ctx = await setupTimeline();
    const onlyMinutes = await ctx.client.post<WorklogDTO>(`/api/tasks/${ctx.taskId}/worklogs`, { date: '2026-10-01', minutes: 15 });
    expect(onlyMinutes.status).toBe(201);
    expect(onlyMinutes.body).toMatchObject({ minutes: 15, note: '' });
    const onlyNote = await ctx.client.post<WorklogDTO>(`/api/tasks/${ctx.taskId}/worklogs`, {
      date: '2026-10-01',
      minutes: null,
      note: 'Called the vendor',
    });
    expect(onlyNote.status).toBe(201);
    expect(onlyNote.body).toMatchObject({ minutes: null, note: 'Called the vendor' });
    const zeroWithNote = await ctx.client.post<WorklogDTO>(`/api/tasks/${ctx.taskId}/worklogs`, {
      date: '2026-10-01',
      minutes: 0,
      note: 'Quick check',
    });
    expect(zeroWithNote.status).toBe(201);
    expect(lastActivity(ctx.db).parsed).toMatchObject({ minutes: 0, note: 'Quick check' });
    expect(getTaskDTO(ctx.db, ctx.taskId).worklogMinutes).toBe(15);
  });

  it('keeps a 200-character note snapshot in the activity entry', async () => {
    const ctx = await setupTimeline();
    const note = 'n'.repeat(500);
    const res = await ctx.client.post<WorklogDTO>(`/api/tasks/${ctx.taskId}/worklogs`, { date: '2026-10-01', note });
    expect(res.body.note).toBe(note);
    expect(lastActivity(ctx.db).parsed.note).toBe(note.slice(0, 200));
  });

  it.each([
    ['neither minutes nor a note', { date: '2026-10-01' }, 'note'],
    ['zero minutes and no note', { date: '2026-10-01', minutes: 0 }, 'note'],
    ['null minutes and a blank note', { date: '2026-10-01', minutes: null, note: '   ' }, 'note'],
    ['a missing date', { minutes: 30 }, 'date'],
    ['an impossible date', { date: '2026-02-30', minutes: 30 }, 'date'],
    ['a badly formatted date', { date: '10/01/2026', minutes: 30 }, 'date'],
    ['negative minutes', { date: '2026-10-01', minutes: -5 }, 'minutes'],
    ['fractional minutes', { date: '2026-10-01', minutes: 1.5 }, 'minutes'],
    ['minutes as a string', { date: '2026-10-01', minutes: '30' }, 'minutes'],
    ['too many minutes', { date: '2026-10-01', minutes: LIMITS.worklogMinutesMax + 1 }, 'minutes'],
    ['a note over the limit', { date: '2026-10-01', note: 'x'.repeat(LIMITS.worklogNoteMax + 1) }, 'note'],
  ])('rejects %s with 400 (path %s)', async (_label, payload, path) => {
    const ctx = await setupTimeline();
    const res = await ctx.client.post(`/api/tasks/${ctx.taskId}/worklogs`, payload);
    expect(res.status).toBe(400);
    expect(res.body.error.details.map((d: { path: string }) => d.path)).toContain(path);
    expect(countRows(ctx.db, 'work_logs')).toBe(0);
    expect(countRows(ctx.db, 'activity')).toBe(0);
  });

  it('accepts the maximum duration', async () => {
    const ctx = await setupTimeline();
    const res = await ctx.client.post(`/api/tasks/${ctx.taskId}/worklogs`, { date: '2026-10-01', minutes: LIMITS.worklogMinutesMax });
    expect(res.status).toBe(201);
  });

  it('returns 404 for an unknown task and 401 without a session', async () => {
    const ctx = await setupTimeline();
    expect((await ctx.client.post('/api/tasks/777/worklogs', { date: '2026-10-01', minutes: 5 })).status).toBe(404);
    expect((await ctx.newClient().post(`/api/tasks/${ctx.taskId}/worklogs`, { date: '2026-10-01', minutes: 5 })).status).toBe(401);
    expect(countRows(ctx.db, 'work_logs')).toBe(0);
  });
});

describe('PATCH /api/worklogs/:id', () => {
  async function withWorklog(body: { minutes?: number | null; note?: string } = { minutes: 60, note: 'Initial' }) {
    const ctx = await setupTimeline();
    const res = await ctx.client.post<WorklogDTO>(`/api/tasks/${ctx.taskId}/worklogs`, { date: '2026-10-05', ...body });
    if (res.status !== 201) throw new Error(JSON.stringify(res.body));
    return { ctx, worklog: res.body };
  }

  it('updates only the given fields and logs worklog.updated with the new values', async () => {
    const { ctx, worklog } = await withWorklog();
    await new Promise((r) => setTimeout(r, 5));
    const res = await ctx.client.patch<WorklogDTO>(`/api/worklogs/${worklog.id}`, { minutes: 45 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: worklog.id, date: '2026-10-05', minutes: 45, note: 'Initial', createdAt: worklog.createdAt });
    expect(res.body.updatedAt > worklog.updatedAt).toBe(true);
    const a = lastActivity(ctx.db);
    expect(a).toMatchObject({
      action: 'worklog.updated',
      entity_type: 'worklog',
      entity_id: worklog.id,
      task_id: ctx.taskId,
      project_id: ctx.projectId,
      user_id: ctx.user.id,
    });
    expect(a.parsed).toEqual({ minutes: 45, date: '2026-10-05', note: 'Initial', title: 'Write the brief', ref: 'WEB-1' });

    const moved = await ctx.client.patch<WorklogDTO>(`/api/worklogs/${worklog.id}`, { date: '2026-10-06', note: ' Revised ' });
    expect(moved.body).toMatchObject({ date: '2026-10-06', minutes: 45, note: 'Revised' });
    expect(getTaskDTO(ctx.db, ctx.taskId).worklogMinutes).toBe(45);
  });

  it('validates "minutes or note" on the merged entry', async () => {
    const minutesOnly = await withWorklog({ minutes: 30 });
    const cleared = await minutesOnly.ctx.client.patch(`/api/worklogs/${minutesOnly.worklog.id}`, { minutes: null });
    expect(cleared.status).toBe(400);
    expect(cleared.body.error.details).toEqual([{ path: 'note', message: 'Enter time spent or a note' }]);
    const zeroed = await minutesOnly.ctx.client.patch(`/api/worklogs/${minutesOnly.worklog.id}`, { minutes: 0 });
    expect(zeroed.status).toBe(400);
    // Clearing the minutes is fine when a note is added in the same request.
    const swapped = await minutesOnly.ctx.client.patch<WorklogDTO>(`/api/worklogs/${minutesOnly.worklog.id}`, {
      minutes: null,
      note: 'Now a note',
    });
    expect(swapped.status).toBe(200);
    expect(swapped.body).toMatchObject({ minutes: null, note: 'Now a note' });

    const noteOnly = await withWorklog({ note: 'Just a note' });
    const blanked = await noteOnly.ctx.client.patch(`/api/worklogs/${noteOnly.worklog.id}`, { note: '  ' });
    expect(blanked.status).toBe(400);
    expect(blanked.body.error.details[0].path).toBe('note');
    expect(activityRows(noteOnly.ctx.db, 'worklog.updated')).toHaveLength(0);

    const both = await withWorklog({ minutes: 20, note: 'Both' });
    const dropNote = await both.ctx.client.patch<WorklogDTO>(`/api/worklogs/${both.worklog.id}`, { note: '' });
    expect(dropNote.status).toBe(200);
    expect(dropNote.body).toMatchObject({ minutes: 20, note: '' });
  });

  it('is a no-op (no activity, same updatedAt) when nothing changes', async () => {
    const { ctx, worklog } = await withWorklog();
    const before = countRows(ctx.db, 'activity');
    const res = await ctx.client.patch<WorklogDTO>(`/api/worklogs/${worklog.id}`, { date: '2026-10-05', minutes: 60, note: 'Initial ' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(worklog);
    expect((await ctx.client.patch<WorklogDTO>(`/api/worklogs/${worklog.id}`, {})).body).toEqual(worklog);
    expect(countRows(ctx.db, 'activity')).toBe(before);
  });

  it.each([
    ['an invalid date', { date: '2026-13-01' }, 'date'],
    ['negative minutes', { minutes: -1 }, 'minutes'],
    ['a non-integer', { minutes: 2.5 }, 'minutes'],
  ])('rejects %s with 400', async (_label, payload, path) => {
    const { ctx, worklog } = await withWorklog();
    const res = await ctx.client.patch(`/api/worklogs/${worklog.id}`, payload);
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].path).toBe(path);
  });

  it('forbids editing somebody else’s entry (403) and returns 404 for unknown ids', async () => {
    const { ctx, worklog } = await withWorklog();
    const guest = await secondUser(ctx);
    const res = await guest.client.patch(`/api/worklogs/${worklog.id}`, { minutes: 5 });
    expect(res.status).toBe(403);
    expect(ctx.db.get<{ minutes: number }>('SELECT minutes FROM work_logs WHERE id = :id', { id: worklog.id })!.minutes).toBe(60);
    expect((await ctx.client.patch('/api/worklogs/4242', { minutes: 5 })).status).toBe(404);
    expect((await ctx.client.patch('/api/worklogs/x', { minutes: 5 })).status).toBe(400);
  });
});

describe('DELETE /api/worklogs/:id', () => {
  it('deletes the entry and logs worklog.deleted with the old values', async () => {
    const ctx = await setupTimeline();
    const { body: w } = await ctx.client.post<WorklogDTO>(`/api/tasks/${ctx.taskId}/worklogs`, {
      date: '2026-10-02',
      minutes: 25,
      note: 'Review',
    });
    const res = await ctx.client.delete(`/api/worklogs/${w.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(countRows(ctx.db, 'work_logs')).toBe(0);
    const a = lastActivity(ctx.db);
    expect(a).toMatchObject({ action: 'worklog.deleted', entity_type: 'worklog', entity_id: w.id, task_id: ctx.taskId });
    expect(a.parsed).toEqual({ minutes: 25, date: '2026-10-02', note: 'Review', title: 'Write the brief', ref: 'WEB-1' });
    expect(getTaskDTO(ctx.db, ctx.taskId).worklogMinutes).toBe(0);
    expect((await ctx.client.delete(`/api/worklogs/${w.id}`)).status).toBe(404);
  });

  it('forbids deleting somebody else’s entry', async () => {
    const ctx = await setupTimeline();
    const guest = await secondUser(ctx);
    const id = insertWorklog(ctx.db, { taskId: ctx.taskId, userId: guest.userId, date: '2026-10-02', minutes: 10 });
    // §6.5: owners and admins may delete others' entries (moderation deletes), so the one refused is a member.
    const member = await secondUser(ctx, 'Member', { email: 'third@example.com' });
    expect((await member.client.delete(`/api/worklogs/${id}`)).status).toBe(403);
    expect(countRows(ctx.db, 'work_logs')).toBe(1);
    expect((await guest.client.delete(`/api/worklogs/${id}`)).status).toBe(200);
    expect(lastActivity(ctx.db)).toMatchObject({ action: 'worklog.deleted', user_id: guest.userId });
  });

  it('lets owners and admins delete somebody else’s entry, but not edit it (§6.5)', async () => {
    const ctx = await setupTimeline();
    const guest = await secondUser(ctx);
    const admin = await secondUser(ctx, 'Admin', { email: 'admin@example.com', role: 'admin' });
    const first = insertWorklog(ctx.db, { taskId: ctx.taskId, userId: guest.userId, date: '2026-10-02', minutes: 10 });
    const second = insertWorklog(ctx.db, { taskId: ctx.taskId, userId: guest.userId, date: '2026-10-03', minutes: 20 });
    expect((await admin.client.patch(`/api/worklogs/${second}`, { minutes: 5 })).status).toBe(403);
    expect((await ctx.client.delete(`/api/worklogs/${first}`)).status).toBe(200);
    expect(lastActivity(ctx.db)).toMatchObject({ action: 'worklog.deleted', user_id: ctx.user.id });
    expect((await admin.client.delete(`/api/worklogs/${second}`)).status).toBe(200);
    expect(lastActivity(ctx.db)).toMatchObject({ action: 'worklog.deleted', user_id: admin.userId });
    expect(countRows(ctx.db, 'work_logs')).toBe(0);
  });

  it('cascades with the task', async () => {
    const ctx = await setupTimeline();
    await ctx.client.post(`/api/tasks/${ctx.taskId}/worklogs`, { date: '2026-10-02', minutes: 10 });
    ctx.db.run('DELETE FROM tasks WHERE id = :id', { id: ctx.taskId });
    expect(countRows(ctx.db, 'work_logs')).toBe(0);
    expect(activityRows(ctx.db, 'worklog.created')).toHaveLength(0);
  });
});
