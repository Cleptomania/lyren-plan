import { describe, expect, it } from 'vitest';
import { LIMITS } from '@shared/constants';
import type { CommentDTO } from '@shared/types';
import { getTaskDTO } from '../src/services/tasks';
import {
  activityRows,
  countRows,
  insertComment,
  lastActivity,
  secondUser,
  setupTimeline,
} from './timeline.fixtures';

describe('POST /api/tasks/:id/comments', () => {
  it('creates a comment (trimmed body, author, timestamps) and logs comment.created', async () => {
    const ctx = await setupTimeline();
    const res = await ctx.client.post<CommentDTO>(`/api/tasks/${ctx.taskId}/comments`, { body: '  Looks **good**  \n' });
    expect(res.status).toBe(201);
    const c = res.body;
    expect(c).toMatchObject({
      taskId: ctx.taskId,
      body: 'Looks **good**',
      author: { id: ctx.user.id, displayName: 'Owner' },
      editedAt: null,
    });
    expect(c.id).toBeGreaterThan(0);
    expect(c.createdAt).toBe(c.updatedAt);
    expect(new Date(c.createdAt).toISOString()).toBe(c.createdAt);

    const a = lastActivity(ctx.db);
    expect(a).toMatchObject({
      action: 'comment.created',
      entity_type: 'comment',
      entity_id: c.id,
      task_id: ctx.taskId,
      project_id: ctx.projectId,
      user_id: ctx.user.id,
      created_at: c.createdAt,
    });
    expect(a.parsed).toEqual({ excerpt: 'Looks **good**', title: 'Write the brief', ref: 'WEB-1' });
  });

  it('keeps only the first 200 characters of the body as the activity excerpt', async () => {
    const ctx = await setupTimeline();
    const body = 'x'.repeat(150) + 'y'.repeat(150);
    const res = await ctx.client.post<CommentDTO>(`/api/tasks/${ctx.taskId}/comments`, { body });
    expect(res.status).toBe(201);
    expect(res.body.body).toBe(body);
    expect(lastActivity(ctx.db).parsed.excerpt).toBe(body.slice(0, 200));
  });

  it('updates TaskDTO.commentCount', async () => {
    const ctx = await setupTimeline();
    await ctx.client.post(`/api/tasks/${ctx.taskId}/comments`, { body: 'one' });
    await ctx.client.post(`/api/tasks/${ctx.taskId}/comments`, { body: 'two' });
    expect(getTaskDTO(ctx.db, ctx.taskId).commentCount).toBe(2);
  });

  it('accepts a body of exactly the maximum length', async () => {
    const ctx = await setupTimeline();
    const res = await ctx.client.post(`/api/tasks/${ctx.taskId}/comments`, { body: 'a'.repeat(LIMITS.commentMax) });
    expect(res.status).toBe(201);
  });

  it.each([
    ['an empty body', { body: '' }],
    ['a whitespace-only body', { body: ' \n\t ' }],
    ['a missing body', {}],
    ['a non-string body', { body: 42 }],
    ['a body over the limit', { body: 'a'.repeat(LIMITS.commentMax + 1) }],
  ])('rejects %s with 400 (path body) and writes nothing', async (_label, payload) => {
    const ctx = await setupTimeline();
    const res = await ctx.client.post(`/api/tasks/${ctx.taskId}/comments`, payload);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
    expect(res.body.error.details[0].path).toBe('body');
    expect(countRows(ctx.db, 'comments')).toBe(0);
    expect(countRows(ctx.db, 'activity')).toBe(0);
  });

  it('rejects malformed JSON with 400', async () => {
    const ctx = await setupTimeline();
    const res = await ctx.client.request('POST', `/api/tasks/${ctx.taskId}/comments`, '{"body":');
    expect(res.status).toBe(400);
  });

  it('returns 404 for an unknown task and 400 for an invalid id', async () => {
    const ctx = await setupTimeline();
    const missing = await ctx.client.post('/api/tasks/9999/comments', { body: 'hi' });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('not_found');
    expect((await ctx.client.post('/api/tasks/abc/comments', { body: 'hi' })).status).toBe(400);
    expect((await ctx.client.post('/api/tasks/0/comments', { body: 'hi' })).status).toBe(400);
    expect(countRows(ctx.db, 'activity')).toBe(0);
  });

  it('requires a session and the CSRF header', async () => {
    const ctx = await setupTimeline();
    expect((await ctx.newClient().post(`/api/tasks/${ctx.taskId}/comments`, { body: 'hi' })).status).toBe(401);
    const noCsrf = await ctx.client.request('POST', `/api/tasks/${ctx.taskId}/comments`, { body: 'hi' }, { 'X-Lyren-Request': '' });
    expect(noCsrf.status).toBe(403);
    expect(countRows(ctx.db, 'comments')).toBe(0);
  });

  it("records activity under the task's current project", async () => {
    const ctx = await setupTimeline();
    ctx.db.run('UPDATE tasks SET project_id = :p, number = 7 WHERE id = :id', { p: ctx.otherProjectId, id: ctx.taskId });
    await ctx.client.post(`/api/tasks/${ctx.taskId}/comments`, { body: 'moved' });
    const a = lastActivity(ctx.db);
    expect(a.project_id).toBe(ctx.otherProjectId);
    expect(a.parsed.ref).toBe('ME-7');
  });

  it('does not touch the task row', async () => {
    const ctx = await setupTimeline();
    const before = getTaskDTO(ctx.db, ctx.taskId).updatedAt;
    await ctx.client.post(`/api/tasks/${ctx.taskId}/comments`, { body: 'hi' });
    expect(getTaskDTO(ctx.db, ctx.taskId).updatedAt).toBe(before);
  });
});

describe('PATCH /api/comments/:id', () => {
  async function withComment() {
    const ctx = await setupTimeline();
    const res = await ctx.client.post<CommentDTO>(`/api/tasks/${ctx.taskId}/comments`, { body: 'First draft' });
    return { ctx, comment: res.body };
  }

  it('edits the body, sets editedAt/updatedAt and logs comment.updated', async () => {
    const { ctx, comment } = await withComment();
    await new Promise((r) => setTimeout(r, 5));
    const res = await ctx.client.patch<CommentDTO>(`/api/comments/${comment.id}`, { body: '  Second draft ' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: comment.id, body: 'Second draft', createdAt: comment.createdAt });
    expect(res.body.editedAt).not.toBeNull();
    expect(res.body.updatedAt).toBe(res.body.editedAt);
    expect(res.body.updatedAt > comment.createdAt).toBe(true);

    const a = lastActivity(ctx.db);
    expect(a).toMatchObject({
      action: 'comment.updated',
      entity_type: 'comment',
      entity_id: comment.id,
      task_id: ctx.taskId,
      project_id: ctx.projectId,
      user_id: ctx.user.id,
    });
    expect(a.parsed).toEqual({ excerpt: 'Second draft', title: 'Write the brief', ref: 'WEB-1' });
  });

  it('is a no-op when the body is unchanged (not marked edited, nothing logged)', async () => {
    const { ctx, comment } = await withComment();
    const before = countRows(ctx.db, 'activity');
    const res = await ctx.client.patch<CommentDTO>(`/api/comments/${comment.id}`, { body: ' First draft ' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(comment);
    expect(countRows(ctx.db, 'activity')).toBe(before);
  });

  it('forbids editing somebody else’s comment (403) and changes nothing', async () => {
    const { ctx, comment } = await withComment();
    const guest = await secondUser(ctx);
    const res = await guest.client.patch(`/api/comments/${comment.id}`, { body: 'hijacked' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('forbidden');
    const stored = ctx.db.get<{ body: string; edited_at: string | null }>('SELECT body, edited_at FROM comments WHERE id = :id', {
      id: comment.id,
    });
    expect(stored).toEqual({ body: 'First draft', edited_at: null });
    expect(activityRows(ctx.db, 'comment.updated')).toHaveLength(0);
  });

  it('locks comments whose author account no longer exists', async () => {
    const ctx = await setupTimeline();
    const guest = await secondUser(ctx);
    const created = await guest.client.post<CommentDTO>(`/api/tasks/${ctx.taskId}/comments`, { body: 'from guest' });
    expect(created.body.author).toEqual({ id: guest.userId, displayName: 'Guest' });
    ctx.db.run('DELETE FROM users WHERE id = :id', { id: guest.userId });
    const timeline = await ctx.client.get(`/api/tasks/${ctx.taskId}/timeline`);
    expect(timeline.body.comments[0].author).toBeNull();
    expect((await ctx.client.patch(`/api/comments/${created.body.id}`, { body: 'mine now' })).status).toBe(403);
    // §6.5: owners and admins may delete others' comments (moderation deletes), a removed author's too.
    expect((await ctx.client.delete(`/api/comments/${created.body.id}`)).status).toBe(200);
  });

  it('validates the body (400) and the id (404 / 400)', async () => {
    const { ctx, comment } = await withComment();
    const empty = await ctx.client.patch(`/api/comments/${comment.id}`, { body: '   ' });
    expect(empty.status).toBe(400);
    expect(empty.body.error.details[0].path).toBe('body');
    expect((await ctx.client.patch(`/api/comments/${comment.id}`, {})).status).toBe(400);
    expect((await ctx.client.patch('/api/comments/9999', { body: 'x' })).status).toBe(404);
    expect((await ctx.client.patch('/api/comments/nope', { body: 'x' })).status).toBe(400);
  });
});

describe('DELETE /api/comments/:id', () => {
  it('deletes the comment and logs comment.deleted with the old excerpt', async () => {
    const ctx = await setupTimeline();
    const { body: comment } = await ctx.client.post<CommentDTO>(`/api/tasks/${ctx.taskId}/comments`, { body: 'Bye' });
    const res = await ctx.client.delete(`/api/comments/${comment.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(countRows(ctx.db, 'comments')).toBe(0);
    const a = lastActivity(ctx.db);
    expect(a).toMatchObject({
      action: 'comment.deleted',
      entity_type: 'comment',
      entity_id: comment.id,
      task_id: ctx.taskId,
      project_id: ctx.projectId,
      user_id: ctx.user.id,
    });
    expect(a.parsed).toEqual({ excerpt: 'Bye', title: 'Write the brief', ref: 'WEB-1' });
    expect(getTaskDTO(ctx.db, ctx.taskId).commentCount).toBe(0);
    // A second delete finds nothing.
    expect((await ctx.client.delete(`/api/comments/${comment.id}`)).status).toBe(404);
  });

  it('forbids deleting somebody else’s comment (403)', async () => {
    const ctx = await setupTimeline();
    const id = insertComment(ctx.db, { taskId: ctx.taskId, userId: ctx.user.id, body: 'owner’s' });
    const guest = await secondUser(ctx);
    const res = await guest.client.delete(`/api/comments/${id}`);
    expect(res.status).toBe(403);
    expect(countRows(ctx.db, 'comments')).toBe(1);
    expect(countRows(ctx.db, 'activity')).toBe(0);
  });

  it('lets owners and admins delete somebody else’s comment (§6.5)', async () => {
    const ctx = await setupTimeline();
    const guest = await secondUser(ctx);
    const admin = await secondUser(ctx, 'Admin', { email: 'admin@example.com', role: 'admin' });
    const first = insertComment(ctx.db, { taskId: ctx.taskId, userId: guest.userId, body: 'one' });
    const second = insertComment(ctx.db, { taskId: ctx.taskId, userId: ctx.user.id, body: 'two' });
    expect((await admin.client.delete(`/api/comments/${first}`)).status).toBe(200);
    expect(lastActivity(ctx.db)).toMatchObject({ action: 'comment.deleted', entity_id: first, user_id: admin.userId });
    expect((await admin.client.delete(`/api/comments/${second}`)).status).toBe(200);
    expect(countRows(ctx.db, 'comments')).toBe(0);
  });

  it('returns 404 / 400 for unknown or invalid ids and requires the CSRF header', async () => {
    const ctx = await setupTimeline();
    expect((await ctx.client.delete('/api/comments/12345')).status).toBe(404);
    expect((await ctx.client.delete('/api/comments/-1')).status).toBe(400);
    const id = insertComment(ctx.db, { taskId: ctx.taskId, userId: ctx.user.id, body: 'x' });
    expect((await ctx.client.request('DELETE', `/api/comments/${id}`, undefined, { 'X-Lyren-Request': '0' })).status).toBe(403);
    expect(countRows(ctx.db, 'comments')).toBe(1);
  });
});

describe('comment cascades', () => {
  it('deleting the task removes its comments and their activity', async () => {
    const ctx = await setupTimeline();
    await ctx.client.post(`/api/tasks/${ctx.taskId}/comments`, { body: 'one' });
    await ctx.client.post(`/api/tasks/${ctx.taskId}/comments`, { body: 'two' });
    expect(activityRows(ctx.db, 'comment.created')).toHaveLength(2);
    ctx.db.run('DELETE FROM tasks WHERE id = :id', { id: ctx.taskId });
    expect(countRows(ctx.db, 'comments')).toBe(0);
    expect(activityRows(ctx.db, 'comment.created')).toHaveLength(0);
  });
});
