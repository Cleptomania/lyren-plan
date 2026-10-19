// The people of a space's content (design §8.6, §6.5; space/people.ts): reassigning a former member's or a
// placeholder's rows to a member (admins and owners), and disowning the imported rows attributed to oneself
// (anyone, viewers included).

import { describe, expect, it } from 'vitest';
import type { PeopleDisownedDTO, PeopleReassignedDTO, TaskDTO } from '@shared/types';
import { DISOWNED_NAME } from '../src/space/people';
import { createTestContext } from './helpers';
import { downloadArchive, importArchive } from './support/archive';
import { addMembership } from './support/directoryHarness';

/** The owner's space, where Carol (removed since) and Bob wrote rows of their own, without any import. */
async function space() {
  const ctx = createTestContext();
  const owner = await ctx.signedIn({ createSampleData: true });
  const bob = await ctx.addUser({ email: 'bob@example.com', displayName: 'Bob' });
  const carol = await ctx.addUser({ email: 'carol@example.com', displayName: 'Carol' });
  const viewer = await ctx.addUser({ email: 'viewer@example.com', displayName: 'Viewer', role: 'viewer' });
  const task = (await owner.client.post<{ tasks: TaskDTO[] }>('/api/tasks/query', { limit: 1 })).body.tasks[0]!;
  expect((await carol.client.post(`/api/tasks/${task.id}/comments`, { body: 'by Carol' })).status).toBe(201);
  expect((await carol.client.post(`/api/tasks/${task.id}/worklogs`, { date: '2026-10-01', minutes: 30 })).status).toBe(201);
  expect((await carol.client.post('/api/tasks', { projectId: task.projectId, title: "Carol's" })).status).toBe(201);
  expect((await owner.client.delete(`/api/spaces/${owner.spaceId}/members/${carol.user.id}`)).status).toBe(200);
  expect((await owner.client.get('/api/bootstrap')).status).toBe(200);
  return { ctx, owner, bob, carol, viewer, task };
}

describe('POST /api/people/:personId/reassign', () => {
  it("moves a former member's rows to a member, labelled as the admin's attribution", async () => {
    const { ctx, owner, bob, carol } = await space();
    const rows = (table: string, column = 'user_id') => ctx.db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = :id`, { id: carol.user.id })[0]!.n;
    const before = { tasks: rows('tasks', 'created_by'), comments: rows('comments'), worklogs: rows('work_logs'), activity: rows('activity') };
    expect(before).toMatchObject({ tasks: 1, comments: 1, worklogs: 1 });
    const res = await owner.client.post<PeopleReassignedDTO>(`/api/people/${carol.user.id}/reassign`, { toUserId: bob.user.id });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, counts: before });
    expect(rows('comments') + rows('tasks', 'created_by') + rows('work_logs') + rows('activity')).toBe(0);
    const comment = ctx.db.get<{ id: number; user_id: number; imported_by: number; imported_at: string }>("SELECT * FROM comments WHERE body = 'by Carol'")!;
    expect(comment).toMatchObject({ user_id: bob.user.id, imported_by: owner.user.id, imported_at: expect.any(String) });
    // An account's row stays (a former member); no activity is recorded for it.
    expect(ctx.db.get('SELECT id FROM users WHERE id = :id', { id: carol.user.id })).toBeDefined();
    expect(ctx.db.all("SELECT id FROM activity WHERE action LIKE 'people%'")).toEqual([]);
    // Bob may edit the comment now (an imported row attributed to him, §6.5).
    expect((await bob.client.patch(`/api/comments/${comment.id}`, { body: 'mine now' })).status).toBe(200);
  });

  it("a placeholder's rows: the placeholder goes; rows an import labelled are labelled as the reassigning admin's, now", async () => {
    const { ctx, owner, bob, carol } = await space();
    const archive = (await downloadArchive(owner.client)).archive!;
    const target = (await owner.client.post<{ id: string }>('/api/spaces', { name: 'Moved', forImport: true })).body.id;
    const mapping = {
      mapping: [
        { archiveId: owner.user.id, target: { kind: 'user', userId: owner.user.id } },
        { archiveId: carol.user.id, target: { kind: 'placeholder' } },
      ],
    };
    expect((await importArchive(owner.client, { path: `/api/s/${target}/data`, mode: 'new', file: archive, mapping })).commit.status).toBe(200);
    // Bob joins as a member, and an admin, Dave, reassigns the placeholder's rows to him.
    addMembership(ctx.directoryDb, { spaceId: target, userId: bob.user.id, role: 'member', nowMs: Date.now() });
    const dave = await ctx.addUser({ email: 'dave@example.com', displayName: 'Dave', spaceId: target, role: 'admin' });
    expect((await bob.client.get(`/api/s/${target}/tags`)).status).toBe(200);
    const db = ctx.stack.spaces.database(target)!;
    const imported = db.get<{ imported_by: number; imported_at: string }>("SELECT imported_by, imported_at FROM comments WHERE body = 'by Carol'")!;
    expect(imported.imported_by).toBe(owner.user.id);

    const res = await dave.client.post<PeopleReassignedDTO>(`/api/s/${target}/people/-1/reassign`, { toUserId: bob.user.id });
    expect(res.status).toBe(200);
    expect(res.body.counts).toMatchObject({ tasks: 1, comments: 1, worklogs: 1 });
    expect(db.get('SELECT id FROM users WHERE id = -1')).toBeUndefined();
    // Who chose the new author is who the label names (§13.16), not the import before.
    const moved = db.get<{ user_id: number; imported_by: number; imported_at: string }>("SELECT user_id, imported_by, imported_at FROM comments WHERE body = 'by Carol'")!;
    expect(moved).toMatchObject({ user_id: bob.user.id, imported_by: dave.user.id });
    expect(moved.imported_at > imported.imported_at).toBe(true);
    expect(db.all('SELECT imported_by FROM work_logs WHERE user_id = :bob', { bob: bob.user.id })).toEqual([{ imported_by: dave.user.id }]);
    expect((await owner.client.get(`/api/s/${target}/people/-1/reassign`)).status).toBe(404);
  });

  it('refuses a member, a target who is no member, an unknown person, and anyone below admin', async () => {
    const { owner, bob, carol, viewer } = await space();
    const reassign = (client: typeof owner.client, person: string | number, to: number) =>
      client.post(`/api/people/${person}/reassign`, { toUserId: to });
    const member = await reassign(owner.client, bob.user.id, owner.user.id);
    expect(member.status).toBe(409);
    expect(member.body.error.message).toBe("Bob is a member of this space: only a former member's rows can be reassigned");
    const notMember = await reassign(owner.client, carol.user.id, 424242);
    expect(notMember.status).toBe(400);
    expect(notMember.body.error.details).toEqual([{ path: 'toUserId', message: 'Not a member of this space' }]);
    expect((await reassign(owner.client, 424242, bob.user.id)).status).toBe(404);
    expect((await reassign(owner.client, 'abc', bob.user.id)).status).toBe(404);
    expect((await reassign(owner.client, '-0', bob.user.id)).status).toBe(404);
    const byMember = await reassign(bob.client, carol.user.id, bob.user.id);
    expect(byMember.status).toBe(403);
    expect(byMember.body.error.message).toBe('Only admins and owners can do this.');
    expect((await reassign(viewer.client, carol.user.id, bob.user.id)).status).toBe(403);
  });
});

describe('POST /api/people/me/disown', () => {
  it('moves the imported rows attributed to the actor to an "Unknown (imported)" placeholder; their own stay', async () => {
    const { ctx, owner, bob, carol, task } = await space();
    const archive = (await downloadArchive(owner.client)).archive!;
    const target = (await owner.client.post<{ id: string }>('/api/spaces', { name: 'Moved', forImport: true })).body.id;
    // Carol's rows are attributed to Bob, who then joins as a viewer.
    const mapping = {
      mapping: [
        { archiveId: owner.user.id, target: { kind: 'user', userId: owner.user.id } },
        { archiveId: carol.user.id, target: { kind: 'user', userId: bob.user.id } },
      ],
    };
    expect((await importArchive(owner.client, { path: `/api/s/${target}/data`, mode: 'new', file: archive, mapping })).commit.status).toBe(200);
    addMembership(ctx.directoryDb, { spaceId: target, userId: bob.user.id, role: 'viewer', nowMs: Date.now() });
    const db = ctx.stack.spaces.database(target)!;
    // A row Bob wrote himself (as a viewer he can only disown; a member's own comment, inserted here).
    db.run("INSERT INTO comments (task_id, user_id, body, created_at, updated_at) VALUES (:task, :bob, 'by Bob', :now, :now)", {
      task: task.id,
      bob: bob.user.id,
      now: new Date().toISOString(),
    });

    const res = await bob.client.post<PeopleDisownedDTO>(`/api/s/${target}/people/me/disown`);
    expect(res.status).toBe(200);
    expect(res.body.counts).toMatchObject({ comments: 1, worklogs: 1 });
    expect(res.body.counts.activity).toBeGreaterThan(0);
    const placeholder = db.get<{ id: number; display_name: string; kind: string }>("SELECT * FROM users WHERE kind = 'placeholder'")!;
    expect(placeholder.display_name).toBe(DISOWNED_NAME);
    expect(db.get("SELECT user_id, imported_by FROM comments WHERE body = 'by Carol'")).toEqual({ user_id: placeholder.id, imported_by: owner.user.id });
    expect(db.get("SELECT user_id FROM comments WHERE body = 'by Bob'")).toEqual({ user_id: bob.user.id });
    // Tasks are no imported rows of their own (no provenance): they stay.
    expect(db.get("SELECT created_by FROM tasks WHERE title = 'Carol''s'")).toEqual({ created_by: bob.user.id });
    // Nothing left to disown: no new placeholder.
    expect((await bob.client.post<PeopleDisownedDTO>(`/api/s/${target}/people/me/disown`)).body.counts).toEqual({ comments: 0, worklogs: 0, activity: 0 });
    expect(db.all("SELECT id FROM users WHERE kind = 'placeholder'")).toHaveLength(1);
    // A second person's disowned rows join the same placeholder: two of one name could not be told apart.
    db.run("UPDATE comments SET user_id = :owner WHERE body = 'by Carol'", { owner: owner.user.id });
    expect((await owner.client.post<PeopleDisownedDTO>(`/api/s/${target}/people/me/disown`)).body.counts.comments).toBe(1);
    expect(db.all("SELECT id FROM users WHERE kind = 'placeholder'")).toEqual([{ id: placeholder.id }]);
    expect(db.get("SELECT user_id FROM comments WHERE body = 'by Carol'")).toEqual({ user_id: placeholder.id });
  });
});
