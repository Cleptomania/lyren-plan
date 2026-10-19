import { describe, expect, it } from 'vitest';
import type { TaskTimelineDTO } from '@shared/types';
import { insertActivity, insertComment, insertWorklog, secondUser, setupTimeline } from './timeline.fixtures';

describe('GET /api/tasks/:id/timeline', () => {
  it('returns empty lists for a task without history', async () => {
    const ctx = await setupTimeline();
    const res = await ctx.client.get<TaskTimelineDTO>(`/api/tasks/${ctx.taskId}/timeline`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ comments: [], worklogs: [], activity: [] });
  });

  it('lists comments oldest first with their authors', async () => {
    const ctx = await setupTimeline();
    const guest = await secondUser(ctx, 'Robin');
    const later = insertComment(ctx.db, { taskId: ctx.taskId, userId: ctx.user.id, body: 'later', createdAt: '2026-10-02T10:00:00.000Z' });
    const earlier = insertComment(ctx.db, { taskId: ctx.taskId, userId: guest.userId, body: 'earlier', createdAt: '2026-10-01T10:00:00.000Z' });
    const other = ctx.addTask();
    insertComment(ctx.db, { taskId: other, userId: ctx.user.id, body: 'elsewhere' });
    const res = await ctx.client.get<TaskTimelineDTO>(`/api/tasks/${ctx.taskId}/timeline`);
    expect(res.body.comments.map((c) => c.id)).toEqual([earlier, later]);
    expect(res.body.comments[0]).toEqual({
      id: earlier,
      taskId: ctx.taskId,
      body: 'earlier',
      author: { id: guest.userId, displayName: 'Robin' },
      createdAt: '2026-10-01T10:00:00.000Z',
      updatedAt: '2026-10-01T10:00:00.000Z',
      editedAt: null,
      // §7.4: comments carry their import provenance (§8.6), none for a comment written here.
      importedBy: null,
      importedAt: null,
    });
  });

  it('lists work logs oldest first (by date, then by when they were logged)', async () => {
    const ctx = await setupTimeline();
    const b = insertWorklog(ctx.db, { taskId: ctx.taskId, userId: ctx.user.id, date: '2026-10-05', minutes: 30, createdAt: '2026-10-05T12:00:00.000Z' });
    const c = insertWorklog(ctx.db, { taskId: ctx.taskId, userId: ctx.user.id, date: '2026-10-07', minutes: 30, createdAt: '2026-10-07T12:00:00.000Z' });
    const a = insertWorklog(ctx.db, { taskId: ctx.taskId, userId: ctx.user.id, date: '2026-10-03', note: 'late entry', createdAt: '2026-10-08T12:00:00.000Z' });
    const b2 = insertWorklog(ctx.db, { taskId: ctx.taskId, userId: ctx.user.id, date: '2026-10-05', minutes: 15, createdAt: '2026-10-05T18:00:00.000Z' });
    const res = await ctx.client.get<TaskTimelineDTO>(`/api/tasks/${ctx.taskId}/timeline`);
    expect(res.body.worklogs.map((w) => w.id)).toEqual([a, b, b2, c]);
    expect(res.body.worklogs[0]).toMatchObject({ minutes: null, note: 'late entry', author: { id: ctx.user.id, displayName: 'Owner' } });
  });

  it("contains only the task's own (entity_type 'task') activity, oldest first", async () => {
    const ctx = await setupTimeline();
    const created = insertActivity(ctx.db, {
      userId: ctx.user.id,
      projectId: ctx.projectId,
      taskId: ctx.taskId,
      action: 'task.created',
      data: { title: 'Write the brief', ref: 'WEB-1' },
    });
    await ctx.client.post(`/api/tasks/${ctx.taskId}/comments`, { body: 'hello' });
    await ctx.client.post(`/api/tasks/${ctx.taskId}/worklogs`, { date: '2026-10-01', minutes: 5 });
    const updated = insertActivity(ctx.db, {
      userId: ctx.user.id,
      projectId: ctx.projectId,
      taskId: ctx.taskId,
      action: 'task.updated',
      data: { title: 'Write the brief', ref: 'WEB-1', changes: [{ field: 'priority', from: 0, to: 3, fromLabel: 'No priority', toLabel: 'High' }] },
    });
    // Another task's history and structural events stay out.
    const other = ctx.addTask();
    insertActivity(ctx.db, { userId: ctx.user.id, projectId: ctx.projectId, taskId: other, action: 'task.created' });
    insertActivity(ctx.db, { userId: ctx.user.id, projectId: ctx.projectId, taskId: null, action: 'epic.created', entityId: 1 });

    const res = await ctx.client.get<TaskTimelineDTO>(`/api/tasks/${ctx.taskId}/timeline`);
    expect(res.body.activity.map((a) => a.id)).toEqual([created, updated]);
    expect(res.body.activity[1]).toMatchObject({
      action: 'task.updated',
      entityType: 'task',
      taskId: ctx.taskId,
      projectId: ctx.projectId,
      actor: { id: ctx.user.id, displayName: 'Owner' },
      task: { id: ctx.taskId, ref: 'WEB-1', title: 'Write the brief' },
      data: { changes: [{ field: 'priority', from: 0, to: 3, fromLabel: 'No priority', toLabel: 'High' }] },
    });
    expect(res.body.comments).toHaveLength(1);
    expect(res.body.worklogs).toHaveLength(1);
  });

  it('returns 404 for unknown tasks, 400 for invalid ids and 401 without a session', async () => {
    const ctx = await setupTimeline();
    const res = await ctx.client.get('/api/tasks/9999/timeline');
    expect(res.status).toBe(404);
    expect(res.body.error).toEqual({ code: 'not_found', message: 'Task not found' });
    expect((await ctx.client.get('/api/tasks/1.5/timeline')).status).toBe(400);
    expect((await ctx.client.get('/api/tasks/abc/timeline')).status).toBe(400);
    expect((await ctx.newClient().get(`/api/tasks/${ctx.taskId}/timeline`)).status).toBe(401);
  });

  it('returns 404 once the task is deleted', async () => {
    const ctx = await setupTimeline();
    await ctx.client.post(`/api/tasks/${ctx.taskId}/comments`, { body: 'x' });
    ctx.db.run('DELETE FROM tasks WHERE id = :id', { id: ctx.taskId });
    expect((await ctx.client.get(`/api/tasks/${ctx.taskId}/timeline`)).status).toBe(404);
  });
});
