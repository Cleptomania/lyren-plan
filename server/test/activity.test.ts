import { describe, expect, it } from 'vitest';
import type { ActivityPage } from '@shared/types';
import { insertActivity, setupTimeline } from './timeline.fixtures';

async function feedContext() {
  const ctx = await setupTimeline();
  const otherTask = ctx.addTask({ title: 'Second' });
  const meTask = ctx.addTask({ projectId: ctx.otherProjectId, title: 'Groceries' });
  const ids = {
    projectCreated: insertActivity(ctx.db, {
      userId: ctx.user.id,
      projectId: ctx.projectId,
      taskId: null,
      action: 'project.created',
      entityId: ctx.projectId,
      data: { name: 'Website' },
    }),
    taskCreated: insertActivity(ctx.db, {
      userId: ctx.user.id,
      projectId: ctx.projectId,
      taskId: ctx.taskId,
      action: 'task.created',
      data: { title: 'Write the brief', ref: 'WEB-1' },
    }),
    otherTaskCreated: insertActivity(ctx.db, {
      userId: ctx.user.id,
      projectId: ctx.projectId,
      taskId: otherTask,
      action: 'task.created',
      data: { title: 'Second', ref: 'WEB-2' },
    }),
    meTaskCreated: insertActivity(ctx.db, {
      userId: ctx.user.id,
      projectId: ctx.otherProjectId,
      taskId: meTask,
      action: 'task.created',
      data: { title: 'Groceries', ref: 'ME-1' },
    }),
  };
  return { ...ctx, otherTask, meTask, ids };
}

describe('GET /api/activity', () => {
  it('lists everything newest first (by id) with actor and current task', async () => {
    const ctx = await feedContext();
    const comment = await ctx.client.post(`/api/tasks/${ctx.taskId}/comments`, { body: 'Comment' });
    await ctx.client.post(`/api/tasks/${ctx.taskId}/worklogs`, { date: '2026-10-01', minutes: 30 });
    const res = await ctx.client.get<ActivityPage>('/api/activity');
    expect(res.status).toBe(200);
    expect(res.body.items.map((i) => i.action)).toEqual([
      'worklog.created',
      'comment.created',
      'task.created',
      'task.created',
      'task.created',
      'project.created',
    ]);
    expect(res.body.nextBefore).toBeNull();
    expect(res.body.items[1]).toMatchObject({
      action: 'comment.created',
      entityType: 'comment',
      entityId: comment.body.id,
      projectId: ctx.projectId,
      taskId: ctx.taskId,
      actor: { id: ctx.user.id, displayName: 'Owner' },
      task: { id: ctx.taskId, ref: 'WEB-1', title: 'Write the brief' },
      data: { excerpt: 'Comment', ref: 'WEB-1', title: 'Write the brief' },
    });
    expect(res.body.items.at(-1)).toMatchObject({ action: 'project.created', task: null, taskId: null });
  });

  it('pages with limit + before (nextBefore cursor)', async () => {
    const ctx = await feedContext();
    const first = await ctx.client.get<ActivityPage>('/api/activity?limit=3');
    expect(first.body.items.map((i) => i.id)).toEqual([ctx.ids.meTaskCreated, ctx.ids.otherTaskCreated, ctx.ids.taskCreated]);
    expect(first.body.nextBefore).toBe(ctx.ids.taskCreated);
    const second = await ctx.client.get<ActivityPage>(`/api/activity?limit=3&before=${first.body.nextBefore}`);
    expect(second.body.items.map((i) => i.id)).toEqual([ctx.ids.projectCreated]);
    expect(second.body.nextBefore).toBeNull();
    // An exactly full last page reports no further page.
    const exact = await ctx.client.get<ActivityPage>('/api/activity?limit=4');
    expect(exact.body.items).toHaveLength(4);
    expect(exact.body.nextBefore).toBeNull();
  });

  it('filters by project and by task (task feeds include comments and work logs)', async () => {
    const ctx = await feedContext();
    await ctx.client.post(`/api/tasks/${ctx.taskId}/comments`, { body: 'c' });
    await ctx.client.post(`/api/tasks/${ctx.meTask}/worklogs`, { date: '2026-10-01', note: 'shopping' });

    const me = await ctx.client.get<ActivityPage>(`/api/activity?projectId=${ctx.otherProjectId}`);
    expect(me.body.items.map((i) => i.action)).toEqual(['worklog.created', 'task.created']);
    expect(me.body.items.every((i) => i.projectId === ctx.otherProjectId)).toBe(true);

    const task = await ctx.client.get<ActivityPage>(`/api/activity?taskId=${ctx.taskId}`);
    expect(task.body.items.map((i) => i.action)).toEqual(['comment.created', 'task.created']);

    const both = await ctx.client.get<ActivityPage>(`/api/activity?taskId=${ctx.taskId}&projectId=${ctx.otherProjectId}`);
    expect(both.body.items).toEqual([]);
  });

  it('keeps task.deleted entries (task null, snapshot in data)', async () => {
    const ctx = await feedContext();
    ctx.db.run('DELETE FROM tasks WHERE id = :id', { id: ctx.otherTask });
    insertActivity(ctx.db, {
      userId: ctx.user.id,
      projectId: ctx.projectId,
      taskId: null,
      entityId: ctx.otherTask,
      action: 'task.deleted',
      data: { title: 'Second', ref: 'WEB-2' },
    });
    const res = await ctx.client.get<ActivityPage>(`/api/activity?projectId=${ctx.projectId}`);
    expect(res.body.items[0]).toMatchObject({
      action: 'task.deleted',
      entityId: ctx.otherTask,
      taskId: null,
      task: null,
      data: { title: 'Second', ref: 'WEB-2' },
    });
    // The deleted task's own history went with it (FK cascade).
    expect(res.body.items.some((i) => i.id === ctx.ids.otherTaskCreated)).toBe(false);
  });

  it('returns an empty page for unknown filters', async () => {
    const ctx = await feedContext();
    expect((await ctx.client.get<ActivityPage>('/api/activity?projectId=999')).body).toEqual({ items: [], nextBefore: null });
    expect((await ctx.client.get<ActivityPage>('/api/activity?taskId=999')).body).toEqual({ items: [], nextBefore: null });
    expect((await ctx.client.get<ActivityPage>('/api/activity?before=1')).body).toEqual({ items: [], nextBefore: null });
  });

  it('defaults to pages of 50', async () => {
    const ctx = await setupTimeline();
    for (let i = 0; i < 55; i++) {
      insertActivity(ctx.db, { userId: ctx.user.id, projectId: ctx.projectId, taskId: ctx.taskId, action: 'task.updated', data: { changes: [] } });
    }
    const res = await ctx.client.get<ActivityPage>('/api/activity');
    expect(res.body.items).toHaveLength(50);
    expect(res.body.nextBefore).toBe(res.body.items[49]!.id);
    const max = await ctx.client.get<ActivityPage>('/api/activity?limit=200');
    expect(max.body.items).toHaveLength(55);
  });

  it.each([
    ['limit=0', 'query.limit'],
    ['limit=201', 'query.limit'],
    ['limit=ten', 'query.limit'],
    ['before=-3', 'query.before'],
    ['projectId=x', 'query.projectId'],
    ['taskId=1.5', 'query.taskId'],
  ])('rejects %s with 400 (%s)', async (query, path) => {
    const ctx = await setupTimeline();
    const res = await ctx.client.get(`/api/activity?${query}`);
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].path).toBe(path);
  });

  it('requires a session', async () => {
    const ctx = await setupTimeline();
    expect((await ctx.newClient().get('/api/activity')).status).toBe(401);
  });
});
