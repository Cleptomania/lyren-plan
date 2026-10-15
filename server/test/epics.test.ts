import { describe, expect, it } from 'vitest';
import { defaultBoardConfig } from '@shared/board';
import { DEFAULT_EPIC_COLOR } from '@shared/constants';
import type { EpicDTO } from '@shared/types';
import type { Db } from '../src/db';
import { getBoard } from '../src/services/entities';
import { createTestContext } from './helpers';
import { insertEpic, insertMilestone, insertProject, insertTag, insertTask, statusIdByName } from './services.fixtures';

async function setup() {
  const ctx = createTestContext();
  const { client, user } = await ctx.signedIn();
  const db = ctx.db;
  const projectId = insertProject(db, 'WEB', { name: 'Website' });
  return { ctx, db, client, user, projectId };
}

function activityRows(db: Db) {
  return db
    .all<{ action: string; project_id: number | null; task_id: number | null; entity_type: string; entity_id: number | null; data: string }>(
      'SELECT * FROM activity ORDER BY id',
    )
    .map((r) => ({ ...r, data: JSON.parse(r.data) as Record<string, unknown> }));
}

const count = (db: Db, sql: string, params: Record<string, number> = {}) => db.get<{ n: number }>(sql, params)!.n;

describe('POST /api/epics', () => {
  it('creates with defaults, appends the position and logs epic.created', async () => {
    const { db, client, projectId } = await setup();
    const res = await client.post<EpicDTO>('/api/epics', { projectId, name: 'Design system' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      projectId,
      milestoneId: null,
      name: 'Design system',
      description: '',
      color: DEFAULT_EPIC_COLOR,
      status: 'open',
      startDate: null,
      dueDate: null,
      position: 0,
      completedAt: null,
      stats: { tasksTotal: 0, tasksClosed: 0, estimateTotal: 0, estimateClosed: 0 },
    });
    const second = await client.post<EpicDTO>('/api/epics', { projectId, name: 'Second' });
    expect(second.body.position).toBe(1);
    expect(activityRows(db)[0]).toMatchObject({
      action: 'epic.created',
      project_id: projectId,
      task_id: null,
      entity_type: 'epic',
      entity_id: res.body.id,
      data: { name: 'Design system' },
    });
  });

  it('accepts a milestone of the same project, a color, status and dates', async () => {
    const { db, client, projectId } = await setup();
    const m = insertMilestone(db, projectId);
    const res = await client.post<EpicDTO>('/api/epics', {
      projectId,
      milestoneId: m,
      name: 'Perf',
      color: '#0EA5E9',
      status: 'done',
      startDate: '2026-01-01',
      dueDate: '2026-02-01',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ milestoneId: m, color: '#0ea5e9', status: 'done', completedAt: expect.any(String) });
  });

  it('400: milestone of another project or unknown (path milestoneId), unknown project, dates out of order', async () => {
    const { db, client, projectId } = await setup();
    const other = insertProject(db, 'OTH');
    const foreign = insertMilestone(db, other);
    for (const milestoneId of [foreign, 999]) {
      const res = await client.post('/api/epics', { projectId, milestoneId, name: 'X' });
      expect(res.status).toBe(400);
      expect(res.body.error.details[0].path).toBe('milestoneId');
    }
    const unknown = await client.post('/api/epics', { projectId: 999, name: 'X' });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.details[0].path).toBe('projectId');
    const dates = await client.post('/api/epics', { projectId, name: 'X', startDate: '2026-03-02', dueDate: '2026-03-01' });
    expect(dates.status).toBe(400);
    expect(dates.body.error.details[0].path).toBe('dueDate');
    for (const body of [{ projectId }, { projectId, name: 'X', status: 'planned' }, { projectId, name: 'X', color: '#12' }]) {
      expect((await client.post('/api/epics', body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(count(db, 'SELECT COUNT(*) AS n FROM epics')).toBe(0);
  });
});

describe('GET /api/epics/:id', () => {
  it('returns progress over non-archived tasks; 404 for unknown', async () => {
    const { db, client, projectId } = await setup();
    const e = insertEpic(db, projectId);
    insertTask(db, { projectId, epicId: e, estimate: 5, statusId: statusIdByName(db, 'Cancelled') });
    insertTask(db, { projectId, epicId: e, estimate: null });
    insertTask(db, { projectId, epicId: e, archivedAt: '2026-01-01T00:00:00.000Z' });
    const res = await client.get<EpicDTO>(`/api/epics/${e}`);
    expect(res.status).toBe(200);
    expect(res.body.stats).toEqual({ tasksTotal: 2, tasksClosed: 1, estimateTotal: 5, estimateClosed: 5 });
    expect((await client.get('/api/epics/999')).status).toBe(404);
  });
});

describe('PATCH /api/epics/:id', () => {
  it('updates fields and logs changes including milestone names', async () => {
    const { db, client, projectId } = await setup();
    const m1 = insertMilestone(db, projectId, { name: 'MVP' });
    const m2 = insertMilestone(db, projectId, { name: 'Polish' });
    const e = (await client.post<EpicDTO>('/api/epics', { projectId, milestoneId: m1, name: 'Design' })).body;
    const res = await client.patch<EpicDTO>(`/api/epics/${e.id}`, {
      milestoneId: m2,
      name: 'Design 2',
      status: 'in_progress',
      color: '#ef4444',
      dueDate: '2026-04-01',
      description: 'd',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ milestoneId: m2, name: 'Design 2', status: 'in_progress', color: '#ef4444', dueDate: '2026-04-01' });
    const last = activityRows(db).at(-1)!;
    expect(last).toMatchObject({ action: 'epic.updated', project_id: projectId, task_id: null, entity_type: 'epic', entity_id: e.id });
    expect(last.data).toEqual({
      name: 'Design 2',
      changes: [
        { field: 'name', from: 'Design', to: 'Design 2' },
        { field: 'status', from: 'open', to: 'in_progress', fromLabel: 'Open', toLabel: 'In progress' },
        { field: 'milestone', from: m1, to: m2, fromLabel: 'MVP', toLabel: 'Polish' },
        { field: 'dueDate', from: null, to: '2026-04-01' },
        { field: 'color' },
        { field: 'description' },
      ],
    });
    const cleared = await client.patch<EpicDTO>(`/api/epics/${e.id}`, { milestoneId: null });
    expect(cleared.body.milestoneId).toBeNull();
    expect((activityRows(db).at(-1)!.data.changes as unknown[])[0]).toEqual({
      field: 'milestone',
      from: m2,
      to: null,
      fromLabel: 'Polish',
      toLabel: null,
    });
  });

  it('moving the epic between milestones changes the derived milestone of its tasks', async () => {
    const { db, client, projectId } = await setup();
    const m = insertMilestone(db, projectId);
    const e = insertEpic(db, projectId);
    insertTask(db, { projectId, epicId: e, estimate: 4 });
    await client.patch(`/api/epics/${e}`, { milestoneId: m });
    const ms = await client.get(`/api/milestones/${m}`);
    expect(ms.body.stats).toMatchObject({ tasksTotal: 1, estimateTotal: 4, epicsTotal: 1 });
  });

  it('completedAt transitions on done/cancelled', async () => {
    const { client, projectId } = await setup();
    const e = (await client.post<EpicDTO>('/api/epics', { projectId, name: 'E' })).body;
    const done = (await client.patch<EpicDTO>(`/api/epics/${e.id}`, { status: 'done' })).body;
    expect(done.completedAt).toEqual(expect.any(String));
    const cancelled = (await client.patch<EpicDTO>(`/api/epics/${e.id}`, { status: 'cancelled' })).body;
    expect(cancelled.completedAt).toBe(done.completedAt);
    const open = (await client.patch<EpicDTO>(`/api/epics/${e.id}`, { status: 'in_progress' })).body;
    expect(open.completedAt).toBeNull();
  });

  it('400 for a milestone of another project, unknown milestone, merged date order; 404 unknown epic', async () => {
    const { db, client, projectId } = await setup();
    const other = insertProject(db, 'OTH');
    const foreign = insertMilestone(db, other);
    const e = (await client.post<EpicDTO>('/api/epics', { projectId, name: 'E', dueDate: '2026-01-10' })).body;
    for (const milestoneId of [foreign, 999]) {
      const res = await client.patch(`/api/epics/${e.id}`, { milestoneId });
      expect(res.status).toBe(400);
      expect(res.body.error.details[0].path).toBe('milestoneId');
    }
    const dates = await client.patch(`/api/epics/${e.id}`, { startDate: '2026-01-11' });
    expect(dates.status).toBe(400);
    expect(dates.body.error.details[0].path).toBe('dueDate');
    expect((await client.patch('/api/epics/999', { name: 'X' })).status).toBe(404);
  });

  it('no-op PATCH: unchanged updatedAt, no activity; projectId is immutable', async () => {
    const { db, client, projectId } = await setup();
    const other = insertProject(db, 'OTH');
    const e = (await client.post<EpicDTO>('/api/epics', { projectId, name: 'E', color: '#ef4444' })).body;
    const before = activityRows(db).length;
    const res = await client.patch<EpicDTO>(`/api/epics/${e.id}`, { name: 'E', color: '#EF4444', milestoneId: null, projectId: other });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ updatedAt: e.updatedAt, projectId });
    expect(activityRows(db)).toHaveLength(before);
  });
});

describe('DELETE /api/epics/:id', () => {
  function world(db: Db, projectId: number, userId: number) {
    const e = insertEpic(db, projectId, { name: 'Design' });
    const keep = insertEpic(db, projectId, { name: 'Keep' });
    const tag = insertTag(db, 'bug');
    const t1 = insertTask(db, { projectId, epicId: e, title: 'One', tagIds: [tag], updatedAt: '2026-01-01T00:00:00.000Z' });
    const t2 = insertTask(db, { projectId, epicId: e, title: 'Two', updatedAt: '2026-01-01T00:00:00.000Z' });
    const t3 = insertTask(db, { projectId, epicId: keep, title: 'Three' });
    db.run("INSERT INTO comments (task_id, user_id, body, created_at, updated_at) VALUES (:t, :u, 'c', 't', 't')", { t: t1, u: userId });
    db.run(
      "INSERT INTO activity (user_id, project_id, task_id, entity_type, entity_id, action, data, created_at) VALUES (:u, :p, :t, 'task', :t, 'task.created', '{}', 't')",
      { u: userId, p: projectId, t: t1 },
    );
    const board = db.run(
      `INSERT INTO boards (project_id, name, config, position, created_at, updated_at) VALUES (:p, 'B', :config, 0, 't', 't')`,
      {
        p: projectId,
        config: JSON.stringify(
          defaultBoardConfig({
            filter: { projectIds: [projectId], epicIds: [e, keep] },
            columns: {
              groupBy: 'custom',
              custom: [{ id: 'c', name: 'Design', match: { epicIds: [e] }, onDrop: { epicId: e, statusId: 1 } }],
            },
            swimlanes: { groupBy: 'epic', prefs: { epic: { order: [String(keep), String(e)], collapsed: [String(e)] } } },
          }),
        ),
      },
    ).lastInsertRowid;
    return { e, keep, tag, t1, t2, t3, board };
  }

  it('default ?tasks=detach keeps the tasks without an epic (not logged, updated_at untouched)', async () => {
    const { db, client, user, projectId } = await setup();
    const w = world(db, projectId, user.id);
    const res = await client.delete(`/api/epics/${w.e}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(db.all<{ id: number; epic_id: number | null; updated_at: string }>('SELECT id, epic_id, updated_at FROM tasks ORDER BY id')).toEqual([
      { id: w.t1, epic_id: null, updated_at: '2026-01-01T00:00:00.000Z' },
      { id: w.t2, epic_id: null, updated_at: '2026-01-01T00:00:00.000Z' },
      { id: w.t3, epic_id: w.keep, updated_at: expect.any(String) },
    ]);
    const rows = activityRows(db).filter((r) => r.action !== 'task.created');
    expect(rows).toEqual([
      expect.objectContaining({ action: 'epic.deleted', project_id: projectId, task_id: null, entity_type: 'epic', entity_id: w.e, data: { name: 'Design' } }),
    ]);
    const cfg = getBoard(db, w.board).config;
    expect(cfg.filter.epicIds).toEqual([w.e, w.keep]);
    expect(cfg.columns.custom[0]!.onDrop).toEqual({ statusId: 1 });
    expect(cfg.swimlanes.prefs.epic).toMatchObject({ order: [String(w.keep)], collapsed: [] });
  });

  it('?tasks=delete deletes the tasks (task.deleted each with ref) and their comments/tags/activity', async () => {
    const { db, client, user, projectId } = await setup();
    const w = world(db, projectId, user.id);
    const res = await client.delete(`/api/epics/${w.e}?tasks=delete`);
    expect(res.status).toBe(200);
    expect(db.all<{ id: number }>('SELECT id FROM tasks').map((t) => t.id)).toEqual([w.t3]);
    expect(count(db, 'SELECT COUNT(*) AS n FROM comments')).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM task_tags')).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM tags')).toBe(1);
    const rows = activityRows(db);
    expect(rows.map((r) => [r.action, r.entity_id])).toEqual([
      ['task.deleted', w.t1],
      ['task.deleted', w.t2],
      ['epic.deleted', w.e],
    ]);
    expect(rows[0]).toMatchObject({ project_id: projectId, task_id: null, entity_type: 'task', data: { title: 'One', ref: 'WEB-1' } });
    expect(rows[1]!.data).toEqual({ title: 'Two', ref: 'WEB-2' });
  });

  it('400 for an invalid ?tasks=, 404 for an unknown epic', async () => {
    const { db, client, user, projectId } = await setup();
    const w = world(db, projectId, user.id);
    const bad = await client.delete(`/api/epics/${w.e}?tasks=nuke`);
    expect(bad.status).toBe(400);
    expect(bad.body.error.details[0].path).toBe('query.tasks');
    expect(count(db, 'SELECT COUNT(*) AS n FROM epics')).toBe(2);
    expect((await client.delete('/api/epics/999')).status).toBe(404);
  });
});

describe('POST /api/epics/reorder', () => {
  it('reorders all epics of one project and rejects other sets', async () => {
    const { db, client, projectId } = await setup();
    const other = insertProject(db, 'OTH');
    const a = insertEpic(db, projectId);
    const b = insertEpic(db, projectId);
    const x = insertEpic(db, other);
    expect((await client.post('/api/epics/reorder', { ids: [b, a] })).status).toBe(200);
    const positions = () => db.all<{ id: number; position: number }>('SELECT id, position FROM epics WHERE project_id = :p ORDER BY position', { p: projectId });
    expect(positions().map((r) => r.id)).toEqual([b, a]);
    for (const ids of [[a], [a, b, x], [a, b, a], [a, 999, b], [x, 999]]) {
      const res = await client.post('/api/epics/reorder', { ids });
      expect(res.status, JSON.stringify(ids)).toBe(400);
    }
    expect(positions().map((r) => r.id)).toEqual([b, a]);
    expect((await client.post('/api/epics/reorder', { ids: [x] })).status).toBe(200);
  });
});
