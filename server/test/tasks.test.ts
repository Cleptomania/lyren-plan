// API tests for /api/tasks (SPEC §5.5, §7): create, read, query, update (moves, tags,
// statuses, archive, dates, rank), delete, duplicate and bulk operations.

import { describe, expect, it } from 'vitest';
import { LIMITS } from '@shared/constants';
import type { ActivityData, FieldChange, TaskDTO, TaskQueryResult } from '@shared/types';
import type { Db } from '../src/db';
import type { ActivityRow, TaskRow } from '../src/services/rows';
import { createTestContext, type TestClient } from './helpers';
import { insertEpic, insertMilestone, insertProject, insertTag, statusIdByName } from './services.fixtures';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function setup() {
  const ctx = createTestContext();
  const { client, user } = await ctx.signedIn();
  const db = ctx.db;
  const alpha = insertProject(db, 'ALP', { name: 'Alpha' });
  const beta = insertProject(db, 'BET', { name: 'Beta' });
  const milestone = insertMilestone(db, alpha, { name: 'M1' });
  const epicA = insertEpic(db, alpha, { name: 'Design', milestoneId: milestone });
  const epicA2 = insertEpic(db, alpha, { name: 'Build' });
  const epicB = insertEpic(db, beta, { name: 'Ops' });
  const tags = {
    bug: insertTag(db, 'bug'),
    idea: insertTag(db, 'Idea'),
    zeta: insertTag(db, 'zeta'),
  };
  const status = {
    backlog: statusIdByName(db, 'Backlog'),
    todo: statusIdByName(db, 'Todo'),
    progress: statusIdByName(db, 'In Progress'),
    done: statusIdByName(db, 'Done'),
    cancelled: statusIdByName(db, 'Cancelled'),
  };
  const api = new Api(client);
  return { ctx, db, client, api, user, alpha, beta, milestone, epicA, epicA2, epicB, tags, status };
}

class Api {
  constructor(readonly client: TestClient) {}

  async create(body: Record<string, unknown>): Promise<TaskDTO> {
    const res = await this.client.post<TaskDTO>('/api/tasks', body);
    if (res.status !== 201) throw new Error(`create failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  }

  async patch(id: number, body: Record<string, unknown>): Promise<TaskDTO> {
    const res = await this.client.patch<TaskDTO>(`/api/tasks/${id}`, body);
    if (res.status !== 200) throw new Error(`patch failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  }

  async query(body: Record<string, unknown>): Promise<TaskQueryResult> {
    const res = await this.client.post<TaskQueryResult>('/api/tasks/query', body);
    if (res.status !== 200) throw new Error(`query failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  }
}

function activity(db: Db, where = '1', params: Record<string, number | string | null> = {}): Array<ActivityRow & { parsed: ActivityData }> {
  return db
    .all<ActivityRow>(`SELECT * FROM activity WHERE ${where} ORDER BY id`, params)
    .map((r) => ({ ...r, parsed: JSON.parse(r.data) as ActivityData }));
}

function taskActivity(db: Db, taskId: number) {
  return activity(db, 'task_id = :taskId', { taskId });
}

function row(db: Db, id: number): TaskRow {
  return db.get<TaskRow>('SELECT * FROM tasks WHERE id = :id', { id })!;
}

/** Push a task's updated_at into the past so a bump is detectable. */
function backdate(db: Db, id: number, iso = '2020-01-01T00:00:00.000Z'): void {
  db.run('UPDATE tasks SET updated_at = :iso WHERE id = :id', { id, iso });
}

function globalOrder(db: Db): number[] {
  return db.all<{ id: number }>('SELECT id FROM tasks ORDER BY rank, id').map((r) => r.id);
}

function change(changes: FieldChange[] | undefined, field: string): FieldChange | undefined {
  return changes?.find((c) => c.field === field);
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

describe('POST /api/tasks', () => {
  it('creates a task with defaults, a per-project number and a task.created entry', async () => {
    const { api, db, client, alpha, status, user } = await setup();
    const res = await client.post<TaskDTO>('/api/tasks', { projectId: alpha, title: '  Write spec  ' });
    expect(res.status).toBe(201);
    const t = res.body;
    expect(t).toMatchObject({
      projectId: alpha,
      number: 1,
      ref: 'ALP-1',
      title: 'Write spec',
      description: '',
      statusId: status.todo, // first 'unstarted' status
      priority: 0,
      epicId: null,
      milestoneId: null,
      startDate: null,
      dueDate: null,
      estimate: null,
      completedAt: null,
      archivedAt: null,
      createdBy: user.id,
      tags: [],
      commentCount: 0,
      worklogMinutes: 0,
    });
    expect(t.createdAt).toBe(t.updatedAt);
    expect(typeof t.rank).toBe('string');
    const second = await api.create({ projectId: alpha, title: 'Second' });
    expect(second.number).toBe(2);
    expect(second.ref).toBe('ALP-2');
    expect(second.rank > t.rank).toBe(true); // default position: bottom

    const entries = taskActivity(db, t.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: 'task.created',
      entity_type: 'task',
      entity_id: t.id,
      project_id: alpha,
      task_id: t.id,
      user_id: user.id,
    });
    expect(entries[0]!.parsed).toEqual({ title: 'Write spec', ref: 'ALP-1' });
  });

  it('numbers tasks per project and never reuses numbers', async () => {
    const { api, client, alpha, beta } = await setup();
    const a1 = await api.create({ projectId: alpha, title: 'a1' });
    const b1 = await api.create({ projectId: beta, title: 'b1' });
    const a2 = await api.create({ projectId: alpha, title: 'a2' });
    expect([a1.ref, b1.ref, a2.ref]).toEqual(['ALP-1', 'BET-1', 'ALP-2']);
    expect((await client.delete(`/api/tasks/${a2.id}`)).status).toBe(200);
    const a3 = await api.create({ projectId: alpha, title: 'a3' });
    expect(a3.number).toBe(3);
  });

  it('stores every field, sorts tags by name and derives the milestone from the epic', async () => {
    const { api, alpha, epicA, milestone, tags, status } = await setup();
    const t = await api.create({
      projectId: alpha,
      epicId: epicA,
      statusId: status.progress,
      title: 'Full',
      description: '# Hello',
      priority: 3,
      startDate: '2026-10-01',
      dueDate: '2026-10-10',
      estimate: 2.5,
      tagIds: [tags.zeta, tags.bug, tags.idea, tags.bug],
    });
    expect(t).toMatchObject({
      epicId: epicA,
      milestoneId: milestone,
      statusId: status.progress,
      description: '# Hello',
      priority: 3,
      startDate: '2026-10-01',
      dueDate: '2026-10-10',
      estimate: 2.5,
      completedAt: null,
    });
    expect(t.tags.map((g) => g.name)).toEqual(['bug', 'Idea', 'zeta']);
  });

  it('sets completedAt when created in a closed status', async () => {
    const { api, alpha, status } = await setup();
    const done = await api.create({ projectId: alpha, title: 'Done already', statusId: status.done });
    expect(done.completedAt).not.toBeNull();
    const cancelled = await api.create({ projectId: alpha, title: 'Nope', statusId: status.cancelled });
    expect(cancelled.completedAt).not.toBeNull();
  });

  it('honours the position (top / after a task)', async () => {
    const { api, db, alpha } = await setup();
    const a = await api.create({ projectId: alpha, title: 'a' });
    const b = await api.create({ projectId: alpha, title: 'b' });
    const top = await api.create({ projectId: alpha, title: 'top', position: 'top' });
    const mid = await api.create({ projectId: alpha, title: 'mid', position: { afterId: a.id } });
    expect(globalOrder(db)).toEqual([top.id, a.id, mid.id, b.id]);
  });

  it.each([
    ['unknown project', { projectId: 999, title: 'x' }, 'projectId'],
    ['missing project', { projectId: undefined, title: 'x' }, 'projectId'],
    ['blank title', { title: '   ' }, 'title'],
    ['title too long', { title: 'x'.repeat(LIMITS.titleMax + 1) }, 'title'],
    ['unknown status', { title: 'x', statusId: 999 }, 'statusId'],
    ['unknown epic', { title: 'x', epicId: 999 }, 'epicId'],
    ['bad priority', { title: 'x', priority: 7 }, 'priority'],
    ['bad date', { title: 'x', dueDate: '2026-02-30' }, 'dueDate'],
    ['start after due', { title: 'x', startDate: '2026-05-02', dueDate: '2026-05-01' }, 'dueDate'],
    ['unknown tag', { title: 'x', tagIds: [999] }, 'tagIds'],
    ['unknown neighbour', { title: 'x', position: { afterId: 999 } }, 'position.afterId'],
    ['negative estimate', { title: 'x', estimate: -1 }, 'estimate'],
  ])('rejects %s with 400', async (_name, body, path) => {
    const { client, alpha, db } = await setup();
    const res = await client.post('/api/tasks', { projectId: alpha, ...body });
    expect(res.status).toBe(400);
    expect(res.body.error.details?.[0]?.path).toBe(path);
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks')!.n).toBe(0);
    // A rejected create must not consume a task number.
    expect(db.get<{ task_counter: number }>('SELECT task_counter FROM projects WHERE id = :alpha', { alpha })!.task_counter).toBe(0);
  });

  it('rejects an epic of another project', async () => {
    const { client, alpha, epicB } = await setup();
    const res = await client.post('/api/tasks', { projectId: alpha, title: 'x', epicId: epicB });
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].path).toBe('epicId');
  });

  it('lists every unknown tag id', async () => {
    const { client, alpha, tags } = await setup();
    const res = await client.post('/api/tasks', { projectId: alpha, title: 'x', tagIds: [tags.bug, 998, 999] });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('998');
    expect(res.body.error.message).toContain('999');
  });

  it('requires a session and the CSRF header', async () => {
    const { ctx, client, alpha } = await setup();
    expect((await ctx.client().post('/api/tasks', { projectId: alpha, title: 'x' })).status).toBe(401);
    const noCsrf = await client.request('POST', '/api/tasks', { projectId: alpha, title: 'x' }, { 'X-Lyren-Request': '0' });
    expect(noCsrf.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

describe('GET /api/tasks/:id and /ref/:ref', () => {
  it('returns the task by id and by ref (case-insensitive)', async () => {
    const { api, client, alpha } = await setup();
    const t = await api.create({ projectId: alpha, title: 'Find me' });
    const byId = await client.get<TaskDTO>(`/api/tasks/${t.id}`);
    expect(byId.status).toBe(200);
    expect(byId.body).toEqual(t);
    const byRef = await client.get<TaskDTO>('/api/tasks/ref/alp-1');
    expect(byRef.status).toBe(200);
    expect(byRef.body.id).toBe(t.id);
  });

  it('404s for unknown tasks and refs, 400 for malformed ids', async () => {
    const { client } = await setup();
    expect((await client.get('/api/tasks/12345')).status).toBe(404);
    expect((await client.get('/api/tasks/ref/ALP-99')).status).toBe(404);
    expect((await client.get('/api/tasks/ref/not-a-ref!')).status).toBe(404);
    expect((await client.get('/api/tasks/abc')).status).toBe(400);
    expect((await client.get('/api/tasks/-1')).status).toBe(400);
  });

  it('includes comment counts and work-log sums', async () => {
    const { api, db, client, alpha, user } = await setup();
    const t = await api.create({ projectId: alpha, title: 'Busy' });
    const now = new Date().toISOString();
    for (const body of ['a', 'b']) {
      db.run('INSERT INTO comments (task_id, user_id, body, created_at, updated_at) VALUES (:t, :u, :body, :now, :now)', {
        t: t.id,
        u: user.id,
        body,
        now,
      });
    }
    for (const minutes of [30, 45, null]) {
      db.run(
        "INSERT INTO work_logs (task_id, user_id, date, minutes, note, created_at, updated_at) VALUES (:t, :u, '2026-10-01', :minutes, 'n', :now, :now)",
        { t: t.id, u: user.id, minutes, now },
      );
    }
    const res = await client.get<TaskDTO>(`/api/tasks/${t.id}`);
    expect(res.body.commentCount).toBe(2);
    expect(res.body.worklogMinutes).toBe(75);
  });
});

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

describe('POST /api/tasks/query', () => {
  async function seeded() {
    const s = await setup();
    const { api, alpha, beta, status, tags, epicA } = s;
    const a = await api.create({ projectId: alpha, title: 'Alpha one', priority: 4, dueDate: '2026-10-10', tagIds: [tags.bug] });
    const b = await api.create({ projectId: alpha, title: 'Alpha two', priority: 1, epicId: epicA, statusId: status.progress });
    const c = await api.create({ projectId: alpha, title: 'Alpha done', statusId: status.done, dueDate: '2026-10-01' });
    const d = await api.create({ projectId: beta, title: 'Beta needle', priority: 2, dueDate: '2026-10-20' });
    const e = await api.create({ projectId: beta, title: 'Archived beta' });
    await api.patch(e.id, { archived: true });
    return { ...s, a, b, c, d, e };
  }

  it('defaults to manual order and hides archived tasks', async () => {
    const { api, a, b, c, d } = await seeded();
    const res = await api.query({});
    expect(res.tasks.map((t) => t.id)).toEqual([a.id, b.id, c.id, d.id]);
    expect(res.total).toBe(4);
  });

  it('filters by project, status category, priority, epic, tags, search and archived', async () => {
    const { api, alpha, a, b, c, d, e, epicA, tags } = await seeded();
    const ids = async (filter: Record<string, unknown>) => (await api.query({ filter })).tasks.map((t) => t.id);
    expect(await ids({ projectIds: [alpha] })).toEqual([a.id, b.id, c.id]);
    expect(await ids({ statusCategories: ['completed'] })).toEqual([c.id]);
    expect(await ids({ priorities: [4, 2] })).toEqual([a.id, d.id]);
    expect(await ids({ epicIds: [epicA] })).toEqual([b.id]);
    expect(await ids({ epicIds: [null], projectIds: [alpha] })).toEqual([a.id, c.id]);
    expect(await ids({ tagIds: [tags.bug] })).toEqual([a.id]);
    expect(await ids({ search: 'NEEDLE' })).toEqual([d.id]);
    expect(await ids({ search: 'alp-2' })).toEqual([b.id]);
    expect(await ids({ archived: 'only' })).toEqual([e.id]);
    expect(await ids({ closedWithinDays: 0 })).toEqual([a.id, b.id, d.id]);
  });

  it('resolves due presets against the client today', async () => {
    const { api, a, d } = await seeded();
    const res = await api.query({ filter: { due: ['overdue'] }, today: '2026-10-15', weekStartsOn: 1 });
    // c is due 2026-10-01 but closed, so not overdue.
    expect(res.tasks.map((t) => t.id)).toEqual([a.id]);
    const week = await api.query({ filter: { due: ['next_7_days'] }, today: '2026-10-15' });
    expect(week.tasks.map((t) => t.id)).toEqual([d.id]);
  });

  it('sorts and pages with a total', async () => {
    const { api, a, b, c, d } = await seeded();
    const byPriority = await api.query({ sort: { field: 'priority', dir: 'desc' } });
    expect(byPriority.tasks.map((t) => t.id)).toEqual([a.id, d.id, b.id, c.id]);
    const page = await api.query({ sort: { field: 'dueDate', dir: 'asc' }, limit: 2, offset: 1 });
    expect(page.tasks.map((t) => t.id)).toEqual([a.id, d.id]);
    expect(page.total).toBe(4);
    const beyond = await api.query({ limit: 2, offset: 10 });
    expect(beyond).toEqual({ tasks: [], total: 4 });
  });

  it('validates the body', async () => {
    const { client } = await setup();
    expect((await client.post('/api/tasks/query', { limit: 0 })).status).toBe(400);
    expect((await client.post('/api/tasks/query', { limit: LIMITS.queryLimitMax + 1 })).status).toBe(400);
    expect((await client.post('/api/tasks/query', { sort: { field: 'nope', dir: 'asc' } })).status).toBe(400);
    expect((await client.post('/api/tasks/query', { today: '13/10/2026' })).status).toBe(400);
    expect((await client.post('/api/tasks/query', { filter: { due: ['someday'] } })).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

describe('PATCH /api/tasks/:id', () => {
  it('updates fields and logs one task.updated entry with labelled changes in SPEC order', async () => {
    const { api, db, alpha, epicA, epicA2, status } = await setup();
    const t = await api.create({ projectId: alpha, title: 'Old', epicId: epicA, priority: 1, statusId: status.todo });
    backdate(db, t.id);
    const updated = await api.patch(t.id, {
      title: 'New',
      description: 'Body',
      statusId: status.progress,
      priority: 4,
      epicId: epicA2,
      startDate: '2026-10-01',
      dueDate: '2026-10-05',
      estimate: 3,
    });
    expect(updated).toMatchObject({
      title: 'New',
      description: 'Body',
      statusId: status.progress,
      priority: 4,
      epicId: epicA2,
      milestoneId: null,
      startDate: '2026-10-01',
      dueDate: '2026-10-05',
      estimate: 3,
      number: 1,
    });
    expect(updated.updatedAt > '2020-01-01T00:00:00.000Z').toBe(true);
    const entries = taskActivity(db, t.id);
    expect(entries.map((e) => e.action)).toEqual(['task.created', 'task.updated']);
    const data = entries[1]!.parsed;
    expect(entries[1]!.project_id).toBe(alpha);
    expect(data.title).toBe('New');
    expect(data.ref).toBe('ALP-1');
    expect(data.changes).toEqual([
      { field: 'title', from: 'Old', to: 'New' },
      { field: 'description' },
      { field: 'status', from: status.todo, to: status.progress, fromLabel: 'Todo', toLabel: 'In Progress' },
      { field: 'priority', from: 1, to: 4, fromLabel: 'Low', toLabel: 'Urgent' },
      { field: 'epic', from: epicA, to: epicA2, fromLabel: 'Design', toLabel: 'Build' },
      { field: 'startDate', from: null, to: '2026-10-01' },
      { field: 'dueDate', from: null, to: '2026-10-05' },
      { field: 'estimate', from: null, to: 3 },
    ]);
  });

  it('treats a PATCH without real changes as a no-op (no activity, updated_at kept)', async () => {
    const { api, db, client, alpha, tags, status } = await setup();
    const t = await api.create({ projectId: alpha, title: 'Same', priority: 2, tagIds: [tags.bug], statusId: status.todo });
    backdate(db, t.id);
    const before = (await client.get<TaskDTO>(`/api/tasks/${t.id}`)).body;
    for (const body of [
      {},
      { title: 'Same', priority: 2, statusId: status.todo, epicId: null, dueDate: null },
      { projectId: alpha },
      { tagIds: [tags.bug] },
      { addTagIds: [tags.bug], removeTagIds: [tags.idea] },
      { archived: false },
      { position: {} },
      { position: { afterId: null, beforeId: null } },
    ]) {
      const res = await client.patch<TaskDTO>(`/api/tasks/${t.id}`, body);
      expect(res.status).toBe(200);
      expect(res.body).toEqual(before);
    }
    expect(taskActivity(db, t.id).map((e) => e.action)).toEqual(['task.created']);
  });

  it('applies rank-only changes without bumping updated_at or logging', async () => {
    const { api, db, alpha } = await setup();
    const a = await api.create({ projectId: alpha, title: 'a' });
    const b = await api.create({ projectId: alpha, title: 'b' });
    const c = await api.create({ projectId: alpha, title: 'c' });
    backdate(db, c.id);
    const moved = await api.patch(c.id, { position: { afterId: a.id, beforeId: b.id } });
    expect(globalOrder(db)).toEqual([a.id, c.id, b.id]);
    expect(moved.updatedAt).toBe('2020-01-01T00:00:00.000Z');
    expect(moved.rank).not.toBe(c.rank);
    await api.patch(c.id, { position: 'bottom' });
    expect(globalOrder(db)).toEqual([a.id, b.id, c.id]);
    await api.patch(c.id, { position: 'top' });
    expect(globalOrder(db)).toEqual([c.id, a.id, b.id]);
    await api.patch(c.id, { position: { beforeId: b.id } });
    expect(globalOrder(db)).toEqual([a.id, c.id, b.id]);
    expect(row(db, c.id).updated_at).toBe('2020-01-01T00:00:00.000Z');
    expect(taskActivity(db, c.id).map((e) => e.action)).toEqual(['task.created']);
  });

  it('places a task directly after afterId in the GLOBAL order (other projects in between)', async () => {
    const { api, db, alpha, beta } = await setup();
    const a1 = await api.create({ projectId: alpha, title: 'a1' });
    const b1 = await api.create({ projectId: beta, title: 'b1' });
    const a2 = await api.create({ projectId: alpha, title: 'a2' });
    const a3 = await api.create({ projectId: alpha, title: 'a3' });
    // In a project-filtered view the neighbours of a3 are a1 (above) and a2 (below).
    await api.patch(a3.id, { position: { afterId: a1.id, beforeId: a2.id } });
    expect(globalOrder(db)).toEqual([a1.id, a3.id, b1.id, a2.id]);
    // Ranks stay unique.
    const ranks = db.all<{ rank: string }>('SELECT rank FROM tasks').map((r) => r.rank);
    expect(new Set(ranks).size).toBe(ranks.length);
  });

  it('restores an earlier rank with position { rank } (the Undo of a move)', async () => {
    const { api, db, client, alpha, beta } = await setup();
    const a1 = await api.create({ projectId: alpha, title: 'a1' });
    const b1 = await api.create({ projectId: beta, title: 'b1' });
    const a2 = await api.create({ projectId: alpha, title: 'a2' });
    const b2 = await api.create({ projectId: beta, title: 'b2' });
    const a3 = await api.create({ projectId: alpha, title: 'a3' });
    const order = globalOrder(db);
    // A drop puts a2 after a3 (in a view that shows alpha only); Undo restores the old rank,
    // so a2 is back between b1 and b2 — not merely somewhere between a1 and a3.
    await api.patch(a2.id, { position: { afterId: a3.id } });
    expect(globalOrder(db)).toEqual([a1.id, b1.id, b2.id, a3.id, a2.id]);
    backdate(db, a2.id);
    const back = await api.patch(a2.id, { position: { rank: a2.rank } });
    expect(back.rank).toBe(a2.rank);
    expect(globalOrder(db)).toEqual(order);
    expect(back.updatedAt).toBe('2020-01-01T00:00:00.000Z');
    expect(taskActivity(db, a2.id).map((e) => e.action)).toEqual(['task.created']);
    // Taken meanwhile: directly after the task that holds it now.
    await api.patch(a2.id, { position: 'bottom' });
    db.run('UPDATE tasks SET rank = :rank WHERE id = :id', { id: b1.id, rank: a2.rank });
    await api.patch(a2.id, { position: { rank: a2.rank } });
    expect(globalOrder(db)).toEqual([a1.id, b1.id, a2.id, b2.id, a3.id]);
    // Malformed ranks are 400s.
    for (const rank of ['', 'a 1', 'a10', 'zz', 'x'.repeat(300)]) {
      const res = await client.patch(`/api/tasks/${a2.id}`, { position: { rank } });
      expect(res.status, rank).toBe(400);
    }
  });

  it('renormalizes duplicate ranks transparently', async () => {
    const { api, db, alpha } = await setup();
    const a = await api.create({ projectId: alpha, title: 'a' });
    const b = await api.create({ projectId: alpha, title: 'b' });
    const c = await api.create({ projectId: alpha, title: 'c' });
    db.run("UPDATE tasks SET rank = 'a0'");
    backdate(db, a.id);
    await api.patch(c.id, { position: { afterId: a.id } });
    expect(globalOrder(db)).toEqual([a.id, c.id, b.id]);
    expect(row(db, a.id).updated_at).toBe('2020-01-01T00:00:00.000Z');
    expect(new Set(db.all<{ rank: string }>('SELECT rank FROM tasks').map((r) => r.rank)).size).toBe(3);
  });

  it.each([
    ['self as afterId', (id: number) => ({ position: { afterId: id } }), 'position.afterId'],
    ['self as beforeId', (id: number) => ({ position: { beforeId: id } }), 'position.beforeId'],
    ['unknown afterId', () => ({ position: { afterId: 9999 } }), 'position.afterId'],
    ['unknown beforeId', () => ({ position: { beforeId: 9999 } }), 'position.beforeId'],
  ])('rejects a position with %s (400)', async (_name, body, path) => {
    const { api, client, alpha } = await setup();
    const t = await api.create({ projectId: alpha, title: 't' });
    const res = await client.patch(`/api/tasks/${t.id}`, body(t.id));
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].path).toBe(path);
  });

  it('rejects afterId === beforeId', async () => {
    const { api, client, alpha } = await setup();
    const a = await api.create({ projectId: alpha, title: 'a' });
    const t = await api.create({ projectId: alpha, title: 't' });
    const res = await client.patch(`/api/tasks/${t.id}`, { position: { afterId: a.id, beforeId: a.id } });
    expect(res.status).toBe(400);
  });

  it('sets / clears / keeps completedAt on status category transitions', async () => {
    const { api, db, alpha, status } = await setup();
    const t = await api.create({ projectId: alpha, title: 't' });
    const done = await api.patch(t.id, { statusId: status.done });
    expect(done.completedAt).not.toBeNull();
    const stamp = '2026-01-02T03:04:05.000Z';
    db.run('UPDATE tasks SET completed_at = :stamp WHERE id = :id', { stamp, id: t.id });
    const cancelled = await api.patch(t.id, { statusId: status.cancelled });
    expect(cancelled.completedAt).toBe(stamp); // closed -> closed: unchanged
    const reopened = await api.patch(t.id, { statusId: status.backlog });
    expect(reopened.completedAt).toBeNull();
    const started = await api.patch(t.id, { statusId: status.progress });
    expect(started.completedAt).toBeNull();
  });

  describe('tags', () => {
    it('replaces the set with tagIds and logs added / removed names', async () => {
      const { api, db, alpha, tags } = await setup();
      const t = await api.create({ projectId: alpha, title: 't', tagIds: [tags.bug, tags.idea] });
      const res = await api.patch(t.id, { tagIds: [tags.zeta, tags.idea] });
      expect(res.tags.map((g) => g.name)).toEqual(['Idea', 'zeta']);
      const last = taskActivity(db, t.id).at(-1)!;
      expect(last.parsed.changes).toEqual([{ field: 'tags', added: ['zeta'], removed: ['bug'] }]);
      const cleared = await api.patch(t.id, { tagIds: [] });
      expect(cleared.tags).toEqual([]);
    });

    it('adds and removes tags relative to the current set', async () => {
      const { api, db, alpha, tags } = await setup();
      const t = await api.create({ projectId: alpha, title: 't', tagIds: [tags.bug] });
      const res = await api.patch(t.id, { addTagIds: [tags.idea, tags.idea], removeTagIds: [tags.bug, tags.zeta] });
      expect(res.tags.map((g) => g.id)).toEqual([tags.idea]);
      expect(change(taskActivity(db, t.id).at(-1)!.parsed.changes, 'tags')).toEqual({
        field: 'tags',
        added: ['Idea'],
        removed: ['bug'],
      });
      // Adding a tag the task already has changes nothing.
      const again = await api.patch(t.id, { addTagIds: [tags.idea] });
      expect(again.tags.map((g) => g.id)).toEqual([tags.idea]);
      expect(taskActivity(db, t.id).filter((e) => e.action === 'task.updated')).toHaveLength(1);
    });

    it('rejects tagIds together with add/remove, unknown ids and add+remove of one tag', async () => {
      const { api, client, alpha, tags } = await setup();
      const t = await api.create({ projectId: alpha, title: 't' });
      const both = await client.patch(`/api/tasks/${t.id}`, { tagIds: [tags.bug], addTagIds: [tags.idea] });
      expect(both.status).toBe(400);
      expect(both.body.error.details[0].path).toBe('tagIds');
      const both2 = await client.patch(`/api/tasks/${t.id}`, { tagIds: [], removeTagIds: [tags.idea] });
      expect(both2.status).toBe(400);
      const unknown = await client.patch(`/api/tasks/${t.id}`, { tagIds: [tags.bug, 4242] });
      expect(unknown.status).toBe(400);
      expect(unknown.body.error.details[0].path).toBe('tagIds');
      expect(unknown.body.error.message).toContain('4242');
      const unknownAdd = await client.patch(`/api/tasks/${t.id}`, { addTagIds: [4242] });
      expect(unknownAdd.status).toBe(400);
      expect(unknownAdd.body.error.details[0].path).toBe('addTagIds');
      const clash = await client.patch(`/api/tasks/${t.id}`, { addTagIds: [tags.bug], removeTagIds: [tags.bug] });
      expect(clash.status).toBe(400);
      expect((await client.get<TaskDTO>(`/api/tasks/${t.id}`)).body.tags).toEqual([]);
    });
  });

  it('archives and unarchives (archivedAt), logging boolean changes', async () => {
    const { api, db, alpha } = await setup();
    const t = await api.create({ projectId: alpha, title: 't' });
    const archived = await api.patch(t.id, { archived: true });
    expect(archived.archivedAt).not.toBeNull();
    const again = await api.patch(t.id, { archived: true });
    expect(again.archivedAt).toBe(archived.archivedAt);
    const restored = await api.patch(t.id, { archived: false });
    expect(restored.archivedAt).toBeNull();
    const changes = taskActivity(db, t.id)
      .filter((e) => e.action === 'task.updated')
      .map((e) => e.parsed.changes);
    expect(changes).toEqual([
      [{ field: 'archived', from: false, to: true }],
      [{ field: 'archived', from: true, to: false }],
    ]);
  });

  it('checks start <= due on the merged result (path dueDate)', async () => {
    const { api, client, alpha } = await setup();
    const t = await api.create({ projectId: alpha, title: 't', dueDate: '2026-10-10' });
    const bad = await client.patch(`/api/tasks/${t.id}`, { startDate: '2026-10-11' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details[0].path).toBe('dueDate');
    expect((await api.patch(t.id, { startDate: '2026-10-10' })).startDate).toBe('2026-10-10');
    const cleared = await api.patch(t.id, { dueDate: null, startDate: '2026-12-01' });
    expect(cleared).toMatchObject({ dueDate: null, startDate: '2026-12-01' });
  });

  it('clears the epic with epicId null (milestone follows)', async () => {
    const { api, alpha, epicA } = await setup();
    const t = await api.create({ projectId: alpha, title: 't', epicId: epicA });
    const res = await api.patch(t.id, { epicId: null });
    expect(res).toMatchObject({ epicId: null, milestoneId: null, projectId: alpha });
  });

  describe('project moves', () => {
    it('moves implicitly to the epic’s project (new number, task.moved + task.updated)', async () => {
      const { api, db, alpha, beta, epicA, epicB } = await setup();
      await api.create({ projectId: beta, title: 'occupies BET-1' });
      const t = await api.create({ projectId: alpha, title: 'Mover', epicId: epicA });
      expect(t.ref).toBe('ALP-1');
      const moved = await api.patch(t.id, { epicId: epicB });
      expect(moved).toMatchObject({ projectId: beta, number: 2, ref: 'BET-2', epicId: epicB, milestoneId: null });
      const entries = taskActivity(db, t.id);
      expect(entries.map((e) => e.action)).toEqual(['task.created', 'task.moved', 'task.updated']);
      const mv = entries[1]!;
      expect(mv.project_id).toBe(beta);
      expect(mv.entity_id).toBe(t.id);
      expect(mv.parsed).toMatchObject({
        fromProjectId: alpha,
        fromProjectName: 'Alpha',
        toProjectId: beta,
        toProjectName: 'Beta',
        fromRef: 'ALP-1',
        toRef: 'BET-2',
        title: 'Mover',
        ref: 'BET-2',
      });
      const upd = entries[2]!;
      expect(upd.project_id).toBe(beta);
      expect(upd.parsed.ref).toBe('BET-2');
      expect(upd.parsed.changes).toEqual([{ field: 'epic', from: epicA, to: epicB, fromLabel: 'Design', toLabel: 'Ops' }]);
      // The old project's counter is not rewound; the new ref resolves.
      expect((await api.client.get<TaskDTO>('/api/tasks/ref/BET-2')).body.id).toBe(t.id);
      expect((await api.client.get('/api/tasks/ref/ALP-1')).status).toBe(404);
    });

    it('moves explicitly with projectId and clears the epic', async () => {
      const { api, db, alpha, beta, epicA } = await setup();
      const t = await api.create({ projectId: alpha, title: 'Mover', epicId: epicA, priority: 1 });
      backdate(db, t.id);
      const moved = await api.patch(t.id, { projectId: beta, priority: 2 });
      expect(moved).toMatchObject({ projectId: beta, ref: 'BET-1', epicId: null, milestoneId: null, priority: 2 });
      expect(moved.updatedAt > '2020-01-01T00:00:00.000Z').toBe(true);
      const entries = taskActivity(db, t.id);
      expect(entries.map((e) => e.action)).toEqual(['task.created', 'task.moved', 'task.updated']);
      expect(entries[2]!.parsed.changes).toEqual([
        { field: 'priority', from: 1, to: 2, fromLabel: 'Low', toLabel: 'Medium' },
        { field: 'epic', from: epicA, to: null, fromLabel: 'Design', toLabel: null },
      ]);
    });

    it('logs only task.moved when nothing else changes', async () => {
      const { api, db, alpha, beta } = await setup();
      const t = await api.create({ projectId: alpha, title: 'Plain' });
      await api.patch(t.id, { projectId: beta });
      expect(taskActivity(db, t.id).map((e) => e.action)).toEqual(['task.created', 'task.moved']);
    });

    it('keeps a valid target-project epic given in the same request', async () => {
      const { api, alpha, beta, epicA, epicB } = await setup();
      const t = await api.create({ projectId: alpha, title: 't', epicId: epicA });
      const moved = await api.patch(t.id, { projectId: beta, epicId: epicB });
      expect(moved).toMatchObject({ projectId: beta, epicId: epicB });
    });

    it('rejects a projectId / epicId mismatch and unknown targets without changing anything', async () => {
      const { api, client, alpha, beta, epicA, epicB } = await setup();
      const t = await api.create({ projectId: alpha, title: 't', epicId: epicA });
      const mismatch = await client.patch(`/api/tasks/${t.id}`, { projectId: beta, epicId: epicA });
      expect(mismatch.status).toBe(400);
      expect(mismatch.body.error.details[0].path).toBe('epicId');
      const mismatch2 = await client.patch(`/api/tasks/${t.id}`, { projectId: alpha, epicId: epicB });
      expect(mismatch2.status).toBe(400);
      const unknownProject = await client.patch(`/api/tasks/${t.id}`, { projectId: 999 });
      expect(unknownProject.status).toBe(400);
      expect(unknownProject.body.error.details[0].path).toBe('projectId');
      const unknownEpic = await client.patch(`/api/tasks/${t.id}`, { epicId: 999 });
      expect(unknownEpic.status).toBe(400);
      expect(unknownEpic.body.error.details[0].path).toBe('epicId');
      const after = (await client.get<TaskDTO>(`/api/tasks/${t.id}`)).body;
      expect(after).toMatchObject({ projectId: alpha, epicId: epicA, ref: 'ALP-1' });
    });

    it('moving a task back to a project it left gives it its old number (Undo keeps refs)', async () => {
      const { api, db, alpha, beta, epicA } = await setup();
      await api.create({ projectId: alpha, title: 'ALP-1' });
      const t = await api.create({ projectId: alpha, title: 'Mover', epicId: epicA });
      await api.create({ projectId: alpha, title: 'ALP-3' });
      expect(t.ref).toBe('ALP-2');
      const away = await api.patch(t.id, { projectId: beta });
      expect(away.ref).toBe('BET-1');
      // The Undo: project and epic back together.
      const back = await api.patch(t.id, { projectId: alpha, epicId: epicA });
      expect(back).toMatchObject({ projectId: alpha, epicId: epicA, number: 2, ref: 'ALP-2' });
      expect((await api.client.get<TaskDTO>('/api/tasks/ref/ALP-2')).body.id).toBe(t.id);
      const moves = taskActivity(db, t.id).filter((e) => e.action === 'task.moved');
      expect(moves.map((e) => [e.parsed.fromRef, e.parsed.toRef])).toEqual([
        ['ALP-2', 'BET-1'],
        ['BET-1', 'ALP-2'],
      ]);
      // The counter was not used for the return; the next new task still gets a fresh number.
      expect((await api.create({ projectId: alpha, title: 'next' })).ref).toBe('ALP-4');
      // Away and back again, also via the epic: BET-1 comes back too, then ALP-2.
      expect((await api.patch(t.id, { projectId: beta })).ref).toBe('BET-1');
      expect((await api.patch(t.id, { epicId: epicA })).ref).toBe('ALP-2');
    });

    it('a returning task gets a new number when it never was in the project or its old one is taken', async () => {
      const { api, db, alpha, beta } = await setup();
      const gamma = insertProject(db, 'GAM', { name: 'Gamma' });
      const t = await api.create({ projectId: alpha, title: 'Mover' });
      expect((await api.patch(t.id, { projectId: beta })).ref).toBe('BET-1');
      expect((await api.patch(t.id, { projectId: gamma })).ref).toBe('GAM-1');
      // Last left alpha as ALP-1: that number is free, so it comes back even after a detour.
      expect((await api.patch(t.id, { projectId: alpha })).ref).toBe('ALP-1');
      // A number that is somehow held by another task (e.g. hand-edited data) is not reused.
      expect((await api.patch(t.id, { projectId: beta })).ref).toBe('BET-1');
      const other = await api.create({ projectId: alpha, title: 'other' });
      db.run('UPDATE tasks SET number = 1 WHERE id = :id', { id: other.id });
      expect((await api.patch(t.id, { projectId: alpha })).ref).toBe('ALP-3');
    });

    it('rolls back the whole update when a later rule fails', async () => {
      const { api, db, client, alpha, beta } = await setup();
      const t = await api.create({ projectId: alpha, title: 't', dueDate: '2026-10-01' });
      const res = await client.patch(`/api/tasks/${t.id}`, { projectId: beta, startDate: '2026-11-01' });
      expect(res.status).toBe(400);
      expect(row(db, t.id).project_id).toBe(alpha);
      expect(db.get<{ task_counter: number }>('SELECT task_counter FROM projects WHERE id = :beta', { beta })!.task_counter).toBe(0);
    });
  });

  it('validates input and the route id', async () => {
    const { api, client, alpha } = await setup();
    const t = await api.create({ projectId: alpha, title: 't' });
    expect((await client.patch('/api/tasks/9999', { title: 'x' })).status).toBe(404);
    expect((await client.patch('/api/tasks/abc', { title: 'x' })).status).toBe(400);
    expect((await client.patch(`/api/tasks/${t.id}`, { title: '' })).status).toBe(400);
    expect((await client.patch(`/api/tasks/${t.id}`, { statusId: 999 })).status).toBe(400);
    expect((await client.patch(`/api/tasks/${t.id}`, { priority: 5 })).status).toBe(400);
    expect((await client.patch(`/api/tasks/${t.id}`, { estimate: 'big' })).status).toBe(400);
    expect((await client.request('PATCH', `/api/tasks/${t.id}`, '{not json')).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

describe('DELETE /api/tasks/:id', () => {
  it('deletes the task with cascades and records task.deleted (task_id NULL)', async () => {
    const { api, db, client, alpha, tags, user } = await setup();
    const t = await api.create({ projectId: alpha, title: 'Doomed', tagIds: [tags.bug] });
    await api.patch(t.id, { priority: 2 });
    const now = new Date().toISOString();
    db.run('INSERT INTO comments (task_id, user_id, body, created_at, updated_at) VALUES (:t, :u, :b, :now, :now)', {
      t: t.id,
      u: user.id,
      b: 'hi',
      now,
    });
    db.run(
      "INSERT INTO work_logs (task_id, user_id, date, minutes, note, created_at, updated_at) VALUES (:t, :u, '2026-10-01', 10, '', :now, :now)",
      { t: t.id, u: user.id, now },
    );
    const res = await client.delete(`/api/tasks/${t.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect((await client.get(`/api/tasks/${t.id}`)).status).toBe(404);
    for (const table of ['comments', 'work_logs', 'task_tags']) {
      expect(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)!.n).toBe(0);
    }
    const entries = activity(db);
    expect(entries).toHaveLength(1); // the task's own entries cascade away
    expect(entries[0]).toMatchObject({
      action: 'task.deleted',
      entity_type: 'task',
      entity_id: t.id,
      task_id: null,
      project_id: alpha,
      user_id: user.id,
    });
    expect(entries[0]!.parsed).toEqual({ title: 'Doomed', ref: 'ALP-1' });
  });

  it('404s for unknown tasks', async () => {
    const { client } = await setup();
    expect((await client.delete('/api/tasks/777')).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Duplicate
// ---------------------------------------------------------------------------

describe('POST /api/tasks/:id/duplicate', () => {
  it('copies fields, tags and epic; titles it "(copy)"; places it right after the original', async () => {
    const { api, db, client, alpha, epicA, tags, status, user } = await setup();
    const original = await api.create({
      projectId: alpha,
      epicId: epicA,
      statusId: status.progress,
      title: 'Original',
      description: 'desc',
      priority: 3,
      startDate: '2026-10-01',
      dueDate: '2026-10-09',
      estimate: 5,
      tagIds: [tags.bug, tags.idea],
    });
    const next = await api.create({ projectId: alpha, title: 'Next' });
    const res = await client.post<TaskDTO>(`/api/tasks/${original.id}/duplicate`);
    expect(res.status).toBe(201);
    const copy = res.body;
    expect(copy).toMatchObject({
      projectId: alpha,
      number: 3,
      ref: 'ALP-3',
      epicId: epicA,
      statusId: status.progress,
      title: 'Original (copy)',
      description: 'desc',
      priority: 3,
      startDate: '2026-10-01',
      dueDate: '2026-10-09',
      estimate: 5,
      completedAt: null,
      archivedAt: null,
      createdBy: user.id,
    });
    expect(copy.tags.map((g) => g.id)).toEqual(original.tags.map((g) => g.id));
    expect(globalOrder(db)).toEqual([original.id, copy.id, next.id]);
    const entries = taskActivity(db, copy.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.action).toBe('task.created');
    expect(entries[0]!.parsed).toEqual({ title: 'Original (copy)', ref: 'ALP-3', duplicatedFrom: 'ALP-1' });
  });

  it('resets a closed status to the default status and drops archive / completion', async () => {
    const { api, alpha, status } = await setup();
    const t = await api.create({ projectId: alpha, title: 'Closed', statusId: status.done });
    await api.patch(t.id, { archived: true });
    const copy = (await api.client.post<TaskDTO>(`/api/tasks/${t.id}/duplicate`)).body;
    expect(copy).toMatchObject({ statusId: status.todo, completedAt: null, archivedAt: null });
  });

  it('keeps the title within the limit', async () => {
    const { api, alpha } = await setup();
    const t = await api.create({ projectId: alpha, title: 'y'.repeat(LIMITS.titleMax) });
    const copy = (await api.client.post<TaskDTO>(`/api/tasks/${t.id}/duplicate`)).body;
    expect(copy.title.length).toBe(LIMITS.titleMax);
    expect(copy.title.endsWith(' (copy)')).toBe(true);
  });

  it('404s for unknown tasks', async () => {
    const { client } = await setup();
    expect((await client.post('/api/tasks/555/duplicate')).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Bulk
// ---------------------------------------------------------------------------

describe('POST /api/tasks/bulk', () => {
  it('applies the patch to every task and logs one entry per changed task', async () => {
    const { api, db, client, alpha, beta, status, tags } = await setup();
    const a = await api.create({ projectId: alpha, title: 'a', tagIds: [tags.bug] });
    const b = await api.create({ projectId: beta, title: 'b', priority: 3 });
    const c = await api.create({ projectId: alpha, title: 'c', priority: 3, statusId: status.done });
    const res = await client.post<{ tasks: TaskDTO[] }>('/api/tasks/bulk', {
      ids: [b.id, a.id, c.id, a.id],
      patch: { statusId: status.done, priority: 3, addTagIds: [tags.idea], removeTagIds: [tags.bug], dueDate: '2026-11-01' },
    });
    expect(res.status).toBe(200);
    expect(res.body.tasks.map((t) => t.id)).toEqual([b.id, a.id, c.id]);
    for (const t of res.body.tasks) {
      expect(t).toMatchObject({ statusId: status.done, priority: 3, dueDate: '2026-11-01' });
      expect(t.tags.map((g) => g.id)).toEqual([tags.idea]);
      expect(t.completedAt).not.toBeNull();
    }
    expect(res.body.tasks[2]!.completedAt).toBe(c.completedAt); // closed -> closed: unchanged
    for (const t of [a, b, c]) {
      const updates = taskActivity(db, t.id).filter((e) => e.action === 'task.updated');
      expect(updates).toHaveLength(1);
    }
    expect(change(taskActivity(db, a.id).at(-1)!.parsed.changes, 'tags')).toEqual({
      field: 'tags',
      added: ['Idea'],
      removed: ['bug'],
    });
  });

  it('skips activity for tasks the patch does not change', async () => {
    const { api, db, client, alpha } = await setup();
    const a = await api.create({ projectId: alpha, title: 'a', priority: 2 });
    const b = await api.create({ projectId: alpha, title: 'b', priority: 1 });
    backdate(db, a.id);
    await client.post('/api/tasks/bulk', { ids: [a.id, b.id], patch: { priority: 2 } });
    expect(taskActivity(db, a.id).map((e) => e.action)).toEqual(['task.created']);
    expect(row(db, a.id).updated_at).toBe('2020-01-01T00:00:00.000Z');
    expect(taskActivity(db, b.id).map((e) => e.action)).toEqual(['task.created', 'task.updated']);
  });

  it('archives / unarchives and sets an epic of the same project', async () => {
    const { api, client, alpha, epicA } = await setup();
    const a = await api.create({ projectId: alpha, title: 'a' });
    const b = await api.create({ projectId: alpha, title: 'b' });
    const res = await client.post<{ tasks: TaskDTO[] }>('/api/tasks/bulk', {
      ids: [a.id, b.id],
      patch: { epicId: epicA, archived: true },
    });
    expect(res.status).toBe(200);
    expect(res.body.tasks.every((t) => t.epicId === epicA && t.archivedAt !== null)).toBe(true);
    const cleared = await client.post<{ tasks: TaskDTO[] }>('/api/tasks/bulk', {
      ids: [a.id, b.id],
      patch: { epicId: null, archived: false },
    });
    expect(cleared.body.tasks.every((t) => t.epicId === null && t.archivedAt === null)).toBe(true);
  });

  it('rejects unknown ids (listing them) and changes nothing', async () => {
    const { api, db, client, alpha } = await setup();
    const a = await api.create({ projectId: alpha, title: 'a' });
    const res = await client.post('/api/tasks/bulk', { ids: [a.id, 901, 902], patch: { priority: 4 } });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('901');
    expect(res.body.error.message).toContain('902');
    expect(res.body.error.details[0].path).toBe('ids');
    expect(row(db, a.id).priority).toBe(0);
  });

  it('rejects an epic outside some task’s project (listing offenders); never moves projects', async () => {
    const { api, db, client, alpha, beta, epicA } = await setup();
    const a = await api.create({ projectId: alpha, title: 'a' });
    const b = await api.create({ projectId: beta, title: 'b' });
    const res = await client.post('/api/tasks/bulk', { ids: [a.id, b.id], patch: { epicId: epicA, priority: 4 } });
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].path).toBe('patch.epicId');
    expect(res.body.error.message).toContain('BET-1');
    expect(res.body.error.message).not.toContain('ALP-1');
    expect(row(db, a.id)).toMatchObject({ epic_id: null, priority: 0 });
    expect(row(db, b.id)).toMatchObject({ project_id: beta, epic_id: null, priority: 0 });
  });

  it('is all-or-nothing when one task fails a rule', async () => {
    const { api, db, client, alpha } = await setup();
    const a = await api.create({ projectId: alpha, title: 'a' });
    const b = await api.create({ projectId: alpha, title: 'b', startDate: '2026-12-01' });
    const res = await client.post('/api/tasks/bulk', { ids: [a.id, b.id], patch: { dueDate: '2026-11-01' } });
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].path).toBe('patch.dueDate');
    expect(row(db, a.id).due_date).toBeNull();
    expect(taskActivity(db, a.id).map((e) => e.action)).toEqual(['task.created']);
  });

  it('validates the body', async () => {
    const { api, client, alpha, tags } = await setup();
    const a = await api.create({ projectId: alpha, title: 'a' });
    expect((await client.post('/api/tasks/bulk', { ids: [], patch: {} })).status).toBe(400);
    expect((await client.post('/api/tasks/bulk', { ids: [a.id] })).status).toBe(400);
    const tooMany = Array.from({ length: LIMITS.bulkMax + 1 }, (_, i) => i + 1);
    expect((await client.post('/api/tasks/bulk', { ids: tooMany, patch: {} })).status).toBe(400);
    const unknownStatus = await client.post('/api/tasks/bulk', { ids: [a.id], patch: { statusId: 999 } });
    expect(unknownStatus.status).toBe(400);
    expect(unknownStatus.body.error.details[0].path).toBe('patch.statusId');
    const unknownTag = await client.post('/api/tasks/bulk', { ids: [a.id], patch: { addTagIds: [tags.bug, 999] } });
    expect(unknownTag.status).toBe(400);
    expect(unknownTag.body.error.details[0].path).toBe('patch.addTagIds');
    const unknownEpic = await client.post('/api/tasks/bulk', { ids: [a.id], patch: { epicId: 999 } });
    expect(unknownEpic.status).toBe(400);
    expect(unknownEpic.body.error.details[0].path).toBe('patch.epicId');
  });
});

describe('POST /api/tasks/bulk-delete', () => {
  it('deletes all listed tasks with one task.deleted entry each', async () => {
    const { api, db, client, alpha, beta } = await setup();
    const a = await api.create({ projectId: alpha, title: 'a' });
    const b = await api.create({ projectId: beta, title: 'b' });
    const keep = await api.create({ projectId: alpha, title: 'keep' });
    const res = await client.post('/api/tasks/bulk-delete', { ids: [a.id, b.id, a.id] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: 2 });
    expect(db.all<{ id: number }>('SELECT id FROM tasks').map((r) => r.id)).toEqual([keep.id]);
    const deleted = activity(db, "action = 'task.deleted'");
    expect(deleted.map((e) => [e.entity_id, e.project_id, e.task_id, e.parsed.ref])).toEqual([
      [a.id, alpha, null, 'ALP-1'],
      [b.id, beta, null, 'BET-1'],
    ]);
  });

  it('rejects unknown ids and deletes nothing', async () => {
    const { api, db, client, alpha } = await setup();
    const a = await api.create({ projectId: alpha, title: 'a' });
    const res = await client.post('/api/tasks/bulk-delete', { ids: [a.id, 31337] });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('31337');
    expect(row(db, a.id)).toBeDefined();
    expect(activity(db, "action = 'task.deleted'")).toHaveLength(0);
    expect((await client.post('/api/tasks/bulk-delete', { ids: [] })).status).toBe(400);
  });
});
