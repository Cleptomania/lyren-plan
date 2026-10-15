import { describe, expect, it } from 'vitest';
import { defaultBoardConfig } from '@shared/board';
import type { MilestoneDTO } from '@shared/types';
import type { Db } from '../src/db';
import { getBoard } from '../src/services/entities';
import { createTestContext } from './helpers';
import { insertEpic, insertMilestone, insertProject, insertTask, statusIdByName } from './services.fixtures';

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

const milestoneRow = (db: Db, id: number) =>
  db.get<{ completed_at: string | null; updated_at: string; position: number }>('SELECT * FROM milestones WHERE id = :id', { id });

describe('POST /api/milestones', () => {
  it('creates with defaults, appends the position and logs milestone.created', async () => {
    const { db, client, user, projectId } = await setup();
    const a = await client.post<MilestoneDTO>('/api/milestones', { projectId, name: ' MVP ' });
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({
      projectId,
      name: 'MVP',
      description: '',
      status: 'planned',
      startDate: null,
      dueDate: null,
      position: 0,
      completedAt: null,
      stats: { tasksTotal: 0, tasksClosed: 0, estimateTotal: 0, estimateClosed: 0, epicsTotal: 0, epicsDone: 0 },
    });
    const b = await client.post<MilestoneDTO>('/api/milestones', {
      projectId,
      name: 'Beta',
      description: 'Notes',
      status: 'active',
      startDate: '2026-01-01',
      dueDate: '2026-01-01',
    });
    expect(b.body).toMatchObject({ position: 1, status: 'active', startDate: '2026-01-01', dueDate: '2026-01-01', description: 'Notes' });
    expect(activityRows(db).map((r) => r.action)).toEqual(['milestone.created', 'milestone.created']);
    expect(db.get<{ user_id: number }>('SELECT user_id FROM activity LIMIT 1')!.user_id).toBe(user.id);
    expect(activityRows(db)[0]).toMatchObject({
      project_id: projectId,
      task_id: null,
      entity_type: 'milestone',
      entity_id: a.body.id,
      data: { name: 'MVP' },
    });
  });

  it('sets completedAt when created completed or cancelled', async () => {
    const { client, projectId } = await setup();
    for (const status of ['completed', 'cancelled'] as const) {
      const res = await client.post<MilestoneDTO>('/api/milestones', { projectId, name: status, status });
      expect(res.body.completedAt).toEqual(expect.any(String));
    }
  });

  it('positions are per project', async () => {
    const { db, client, projectId } = await setup();
    const other = insertProject(db, 'OTH');
    await client.post('/api/milestones', { projectId, name: 'A' });
    const res = await client.post<MilestoneDTO>('/api/milestones', { projectId: other, name: 'B' });
    expect(res.body.position).toBe(0);
  });

  it('400: dates out of order (path dueDate), unknown project (path projectId), invalid fields', async () => {
    const { client, projectId } = await setup();
    const dates = await client.post('/api/milestones', { projectId, name: 'X', startDate: '2026-02-02', dueDate: '2026-02-01' });
    expect(dates.status).toBe(400);
    expect(dates.body.error.details[0].path).toBe('dueDate');
    const unknown = await client.post('/api/milestones', { projectId: 999, name: 'X' });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.details[0].path).toBe('projectId');
    for (const body of [
      { name: 'X' },
      { projectId, name: '' },
      { projectId, name: 'X', status: 'done' },
      { projectId, name: 'X', dueDate: '2026-02-30' },
      { projectId, name: 'X', startDate: 'tomorrow' },
      { projectId: 'a', name: 'X' },
    ]) {
      expect((await client.post('/api/milestones', body)).status, JSON.stringify(body)).toBe(400);
    }
  });
});

describe('GET /api/milestones/:id', () => {
  it('returns the DTO with progress stats (archived tasks excluded); 404/400 otherwise', async () => {
    const { db, client, projectId } = await setup();
    const m = insertMilestone(db, projectId, { name: 'MVP' });
    const e1 = insertEpic(db, projectId, { milestoneId: m, status: 'done' });
    insertEpic(db, projectId, { milestoneId: m });
    insertTask(db, { projectId, epicId: e1, estimate: 2, statusId: statusIdByName(db, 'Done') });
    insertTask(db, { projectId, epicId: e1, estimate: 3 });
    insertTask(db, { projectId, epicId: e1, estimate: 8, archivedAt: '2026-01-01T00:00:00.000Z' });
    const res = await client.get<MilestoneDTO>(`/api/milestones/${m}`);
    expect(res.status).toBe(200);
    expect(res.body.stats).toEqual({ tasksTotal: 2, tasksClosed: 1, estimateTotal: 5, estimateClosed: 2, epicsTotal: 2, epicsDone: 1 });
    expect((await client.get('/api/milestones/999')).status).toBe(404);
    expect((await client.get('/api/milestones/-1')).status).toBe(400);
  });
});

describe('PATCH /api/milestones/:id', () => {
  it('updates fields and logs the changed fields with status labels', async () => {
    const { db, client, projectId } = await setup();
    const m = (await client.post<MilestoneDTO>('/api/milestones', { projectId, name: 'MVP', dueDate: '2026-03-01' })).body;
    const res = await client.patch<MilestoneDTO>(`/api/milestones/${m.id}`, {
      name: 'Launch',
      status: 'active',
      startDate: '2026-02-01',
      dueDate: null,
      description: 'x',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'Launch', status: 'active', startDate: '2026-02-01', dueDate: null, description: 'x' });
    const last = activityRows(db).at(-1)!;
    expect(last).toMatchObject({ action: 'milestone.updated', project_id: projectId, task_id: null, entity_id: m.id });
    expect(last.data).toEqual({
      name: 'Launch',
      changes: [
        { field: 'name', from: 'MVP', to: 'Launch' },
        { field: 'status', from: 'planned', to: 'active', fromLabel: 'Planned', toLabel: 'Active' },
        { field: 'startDate', from: null, to: '2026-02-01' },
        { field: 'dueDate', from: '2026-03-01', to: null },
        { field: 'description' },
      ],
    });
  });

  it('completedAt transitions: set on completed/cancelled (kept between them), cleared otherwise', async () => {
    const { db, client, projectId } = await setup();
    const m = (await client.post<MilestoneDTO>('/api/milestones', { projectId, name: 'MVP' })).body;
    const done = (await client.patch<MilestoneDTO>(`/api/milestones/${m.id}`, { status: 'completed' })).body;
    expect(done.completedAt).toEqual(expect.any(String));
    db.run("UPDATE milestones SET completed_at = '2020-01-01T00:00:00.000Z' WHERE id = :id", { id: m.id });
    const cancelled = (await client.patch<MilestoneDTO>(`/api/milestones/${m.id}`, { status: 'cancelled' })).body;
    expect(cancelled.completedAt).toBe('2020-01-01T00:00:00.000Z');
    const renamed = (await client.patch<MilestoneDTO>(`/api/milestones/${m.id}`, { name: 'Renamed' })).body;
    expect(renamed.completedAt).toBe('2020-01-01T00:00:00.000Z');
    const reopened = (await client.patch<MilestoneDTO>(`/api/milestones/${m.id}`, { status: 'active' })).body;
    expect(reopened.completedAt).toBeNull();
  });

  it('validates the date order on the merged result', async () => {
    const { client, projectId } = await setup();
    const m = (await client.post<MilestoneDTO>('/api/milestones', { projectId, name: 'MVP', startDate: '2026-05-10' })).body;
    const bad = await client.patch(`/api/milestones/${m.id}`, { dueDate: '2026-05-01' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details).toEqual([{ path: 'dueDate', message: expect.any(String) }]);
    expect((await client.patch(`/api/milestones/${m.id}`, { startDate: null, dueDate: '2026-05-01' })).status).toBe(200);
    expect((await client.patch(`/api/milestones/${m.id}`, { startDate: '2026-05-02' })).status).toBe(400);
  });

  it('no-op PATCH: no write, no activity', async () => {
    const { db, client, projectId } = await setup();
    const m = (await client.post<MilestoneDTO>('/api/milestones', { projectId, name: 'MVP', dueDate: '2026-05-01' })).body;
    const count = activityRows(db).length;
    const res = await client.patch<MilestoneDTO>(`/api/milestones/${m.id}`, { name: 'MVP', dueDate: '2026-05-01', status: 'planned' });
    expect(res.status).toBe(200);
    expect(res.body.updatedAt).toBe(m.updatedAt);
    expect(activityRows(db)).toHaveLength(count);
  });

  it('ignores projectId (immutable); 400 for invalid fields; 404 for unknown', async () => {
    const { db, client, projectId } = await setup();
    const other = insertProject(db, 'OTH');
    const m = (await client.post<MilestoneDTO>('/api/milestones', { projectId, name: 'MVP' })).body;
    const res = await client.patch<MilestoneDTO>(`/api/milestones/${m.id}`, { projectId: other, name: 'Moved?' });
    expect(res.status).toBe(200);
    expect(res.body.projectId).toBe(projectId);
    expect((await client.patch(`/api/milestones/${m.id}`, { status: 'open' })).status).toBe(400);
    expect((await client.patch(`/api/milestones/${m.id}`, { name: '  ' })).status).toBe(400);
    expect((await client.patch('/api/milestones/999', { name: 'X' })).status).toBe(404);
  });
});

describe('DELETE /api/milestones/:id', () => {
  function world(db: Db, projectId: number) {
    const m = insertMilestone(db, projectId, { name: 'MVP' });
    const keep = insertMilestone(db, projectId, { name: 'Keep' });
    const e1 = insertEpic(db, projectId, { milestoneId: m, name: 'Design' });
    const e2 = insertEpic(db, projectId, { milestoneId: m, name: 'Content' });
    const e3 = insertEpic(db, projectId, { milestoneId: keep, name: 'Other' });
    const t1 = insertTask(db, { projectId, epicId: e1, updatedAt: '2026-01-01T00:00:00.000Z' });
    const board = db.run(
      `INSERT INTO boards (project_id, name, config, position, created_at, updated_at)
       VALUES (NULL, 'B', :config, 0, 't', 't')`,
      {
        config: JSON.stringify(
          defaultBoardConfig({
            filter: { milestoneIds: [m, null] },
            columns: { groupBy: 'milestone', prefs: { milestone: { order: [String(m), String(keep)], hidden: [String(m)] } } },
            swimlanes: {
              groupBy: 'custom',
              custom: [{ id: 'l1', name: 'Design', match: { epicIds: [e1] }, onDrop: { epicId: e1, priority: 2 } }],
            },
          }),
        ),
      },
    ).lastInsertRowid;
    return { m, keep, e1, e2, e3, t1, board };
  }

  it('default ?epics=detach keeps the epics without a milestone (not logged) and cleans board prefs', async () => {
    const { db, client, projectId } = await setup();
    const w = world(db, projectId);
    const res = await client.delete(`/api/milestones/${w.m}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(db.get('SELECT 1 FROM milestones WHERE id = :id', { id: w.m })).toBeUndefined();
    const epics = db.all<{ id: number; milestone_id: number | null }>('SELECT id, milestone_id FROM epics ORDER BY id');
    expect(epics).toEqual([
      { id: w.e1, milestone_id: null },
      { id: w.e2, milestone_id: null },
      { id: w.e3, milestone_id: w.keep },
    ]);
    const rows = activityRows(db);
    expect(rows.map((r) => r.action)).toEqual(['milestone.deleted']);
    expect(rows[0]).toMatchObject({ project_id: projectId, task_id: null, entity_type: 'milestone', entity_id: w.m, data: { name: 'MVP' } });
    const cfg = getBoard(db, w.board).config;
    expect(cfg.filter.milestoneIds).toEqual([w.m, null]);
    expect(cfg.columns.prefs.milestone).toMatchObject({ order: [String(w.keep)], hidden: [] });
    expect(cfg.swimlanes.custom[0]!.onDrop).toEqual({ epicId: w.e1, priority: 2 });
  });

  it('?epics=delete deletes the epics (epic.deleted each), tasks lose the epic via FK (not logged)', async () => {
    const { db, client, projectId } = await setup();
    const w = world(db, projectId);
    const res = await client.delete(`/api/milestones/${w.m}?epics=delete`);
    expect(res.status).toBe(200);
    expect(db.all<{ id: number }>('SELECT id FROM epics').map((e) => e.id)).toEqual([w.e3]);
    const task = db.get<{ epic_id: number | null; updated_at: string }>('SELECT * FROM tasks WHERE id = :id', { id: w.t1 })!;
    expect(task).toMatchObject({ epic_id: null, updated_at: '2026-01-01T00:00:00.000Z' });
    const rows = activityRows(db);
    expect(rows.map((r) => [r.action, r.entity_id])).toEqual([
      ['epic.deleted', w.e1],
      ['epic.deleted', w.e2],
      ['milestone.deleted', w.m],
    ]);
    expect(rows[0]).toMatchObject({ project_id: projectId, task_id: null, entity_type: 'epic', data: { name: 'Design' } });
    expect(getBoard(db, w.board).config.swimlanes.custom[0]!.onDrop).toEqual({ priority: 2 });
  });

  it('400 for an invalid ?epics=, 404 for an unknown milestone (nothing changed)', async () => {
    const { db, client, projectId } = await setup();
    const w = world(db, projectId);
    const bad = await client.delete(`/api/milestones/${w.m}?epics=archive`);
    expect(bad.status).toBe(400);
    expect(bad.body.error.details[0].path).toBe('query.epics');
    expect(db.get('SELECT 1 FROM milestones WHERE id = :id', { id: w.m })).toBeDefined();
    expect((await client.delete('/api/milestones/999')).status).toBe(404);
  });
});

describe('POST /api/milestones/reorder', () => {
  it('reorders all milestones of one project', async () => {
    const { db, client, projectId } = await setup();
    const a = insertMilestone(db, projectId);
    const b = insertMilestone(db, projectId);
    const c = insertMilestone(db, projectId);
    const res = await client.post('/api/milestones/reorder', { ids: [b, c, a] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect([a, b, c].map((id) => milestoneRow(db, id)!.position)).toEqual([2, 0, 1]);
    expect(activityRows(db)).toHaveLength(0);
  });

  it('400 for an incomplete set, foreign or unknown ids, duplicates, or ids of two projects', async () => {
    const { db, client, projectId } = await setup();
    const other = insertProject(db, 'OTH');
    const a = insertMilestone(db, projectId);
    const b = insertMilestone(db, projectId);
    const x = insertMilestone(db, other);
    for (const ids of [[a], [a, b, 999], [a, b, b], [a, b, x], [999], []]) {
      const res = await client.post('/api/milestones/reorder', { ids });
      expect(res.status, JSON.stringify(ids)).toBe(400);
    }
    expect([a, b].map((id) => milestoneRow(db, id)!.position)).toEqual([0, 1]);
  });
});
