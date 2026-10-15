import { describe, expect, it } from 'vitest';
import { defaultBoardConfig, type BoardConfigInput } from '@shared/board';
import { DEFAULT_STATUS_COLOR, DEFAULT_STATUSES } from '@shared/constants';
import type { StatusDTO } from '@shared/types';
import type { Db } from '../src/db';
import { getBoard } from '../src/services/entities';
import { createTestContext } from './helpers';
import { insertProject, insertTask, statusIdByName, T0, taskRow } from './services.fixtures';

const T1 = '2026-04-01T10:00:00.000Z';

async function setup() {
  const ctx = createTestContext();
  const { client, user } = await ctx.signedIn();
  const projectId = insertProject(ctx.db, 'WEB');
  const ids = {
    backlog: statusIdByName(ctx.db, 'Backlog'),
    todo: statusIdByName(ctx.db, 'Todo'),
    progress: statusIdByName(ctx.db, 'In Progress'),
    review: statusIdByName(ctx.db, 'In Review'),
    done: statusIdByName(ctx.db, 'Done'),
    cancelled: statusIdByName(ctx.db, 'Cancelled'),
  };
  return { ...ctx, client, user, projectId, ids };
}

function insertBoard(db: Db, config: BoardConfigInput): number {
  return db.run(
    `INSERT INTO boards (project_id, name, config, position, created_at, updated_at)
     VALUES (NULL, 'Status board', :config, 9, :t, :t)`,
    { config: JSON.stringify(defaultBoardConfig(config)), t: T0 },
  ).lastInsertRowid;
}

const activityCount = (db: Db) => db.get<{ n: number }>('SELECT COUNT(*) AS n FROM activity')!.n;

describe('statuses API', () => {
  it('lists the default statuses by position with task counts including archived tasks', async () => {
    const { client, db, projectId, ids } = await setup();
    insertTask(db, { projectId, statusId: ids.todo });
    insertTask(db, { projectId, statusId: ids.todo, archivedAt: T0 });
    insertTask(db, { projectId, statusId: ids.done, completedAt: T0 });
    const res = await client.get<StatusDTO[]>('/api/statuses');
    expect(res.status).toBe(200);
    expect(res.body.map((s) => s.name)).toEqual(DEFAULT_STATUSES.map((s) => s.name));
    expect(res.body.map((s) => s.position)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(res.body.find((s) => s.id === ids.todo)!.taskCount).toBe(2);
    expect(res.body.find((s) => s.id === ids.done)!.taskCount).toBe(1);
    expect(res.body.find((s) => s.id === ids.backlog)!.taskCount).toBe(0);
  });

  it('creates statuses at the end of their category group with a default color; rejects invalid and duplicates', async () => {
    const { client, db } = await setup();
    db.run('UPDATE statuses SET position = position + 10');
    const res = await client.post<StatusDTO>('/api/statuses', { name: ' Blocked ', category: 'started' });
    expect(res.status).toBe(201);
    // After In Review (the last 'started' status), before Done; positions are renumbered densely.
    expect(res.body).toMatchObject({
      name: 'Blocked',
      category: 'started',
      color: DEFAULT_STATUS_COLOR,
      position: 4,
      taskCount: 0,
    });
    const colored = await client.post<StatusDTO>('/api/statuses', { name: 'QA', category: 'started', color: '#A855F7' });
    expect(colored.body).toMatchObject({ color: '#a855f7', position: 5 });

    expect((await client.post('/api/statuses', { name: 'blocked', category: 'backlog' })).status).toBe(409);
    expect((await client.post('/api/statuses', { name: 'DONE', category: 'completed' })).status).toBe(409);
    expect((await client.post('/api/statuses', { name: 'X' })).status).toBe(400);
    expect((await client.post('/api/statuses', { name: 'X', category: 'closed' })).status).toBe(400);
    expect((await client.post('/api/statuses', { name: '', category: 'started' })).status).toBe(400);
    expect((await client.post('/api/statuses', { name: 'x'.repeat(41), category: 'started' })).status).toBe(400);
  });

  it('keeps the stored order grouped by category when statuses are added (board columns = Settings order)', async () => {
    const { client, db } = await setup();
    const updatedBefore = db.all<{ id: number; updated_at: string }>('SELECT id, updated_at FROM statuses ORDER BY id');
    const add = async (name: string, category: string) => {
      const res = await client.post<StatusDTO>('/api/statuses', { name, category });
      expect(res.status).toBe(201);
    };
    await add('Blocked', 'started');
    const order = async () => (await client.get<StatusDTO[]>('/api/statuses')).body.map((s) => `${s.name}:${s.category}`);
    expect(await order()).toEqual([
      'Backlog:backlog', 'Todo:unstarted', 'In Progress:started', 'In Review:started', 'Blocked:started',
      'Done:completed', 'Cancelled:cancelled',
    ]);
    await add('Icebox', 'backlog');
    await add("Won't do", 'cancelled');
    await add('Shipped', 'completed');
    await add('Ready', 'unstarted');
    expect(await order()).toEqual([
      'Backlog:backlog', 'Icebox:backlog', 'Todo:unstarted', 'Ready:unstarted', 'In Progress:started', 'In Review:started',
      'Blocked:started', 'Done:completed', 'Shipped:completed', 'Cancelled:cancelled', "Won't do:cancelled",
    ]);
    const statuses = (await client.get<StatusDTO[]>('/api/statuses')).body;
    expect(statuses.map((s) => s.position)).toEqual(statuses.map((_, i) => i));
    // Shifting positions is not an edit of the existing statuses.
    const updatedAfter = db.all<{ id: number; updated_at: string }>('SELECT id, updated_at FROM statuses WHERE id <= 6 ORDER BY id');
    expect(updatedAfter).toEqual(updatedBefore);
    // The bootstrap (what boards and pickers use) has the same order.
    const boot = await client.get<{ statuses: StatusDTO[] }>('/api/bootstrap');
    expect(boot.body.statuses.map((s) => s.id)).toEqual(statuses.map((s) => s.id));
  });

  it('inserts a new status first when no status of its category or an earlier one exists', async () => {
    const { client, db, ids } = await setup();
    // Custom stored order: Done first, then the rest.
    const rest = Object.values(ids).filter((id) => id !== ids.done && id !== ids.backlog);
    db.run('DELETE FROM statuses WHERE id = :id', { id: ids.backlog });
    expect((await client.post('/api/statuses/reorder', { ids: [ids.done, ...rest] })).status).toBe(200);
    // 'backlog' sorts before every existing category: goes first.
    await client.post('/api/statuses', { name: 'Ideas', category: 'backlog' });
    const names = (await client.get<StatusDTO[]>('/api/statuses')).body.map((s) => s.name);
    expect(names[0]).toBe('Ideas');
  });

  it('renames and recolors; duplicate names → 409; unknown → 404; no-op leaves it untouched', async () => {
    const { client, db, ids } = await setup();
    const res = await client.patch<StatusDTO>(`/api/statuses/${ids.review}`, { name: 'Review', color: '#00FF00' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: ids.review, name: 'Review', color: '#00ff00', category: 'started' });
    expect((await client.patch(`/api/statuses/${ids.review}`, { name: 'todo' })).status).toBe(409);
    expect((await client.patch(`/api/statuses/${ids.review}`, { name: 'REVIEW' })).status).toBe(200);
    expect((await client.patch('/api/statuses/999', { name: 'Nope' })).status).toBe(404);
    expect((await client.patch(`/api/statuses/${ids.review}`, { category: 'nope' })).status).toBe(400);

    db.run('UPDATE statuses SET updated_at = :t WHERE id = :id', { id: ids.todo, t: T0 });
    await client.patch(`/api/statuses/${ids.todo}`, { name: 'Todo', category: 'unstarted' });
    expect(db.get<{ updated_at: string }>('SELECT updated_at FROM statuses WHERE id = :id', { id: ids.todo })!.updated_at).toBe(T0);
  });

  it('category changes move completedAt for its tasks without bumping updated_at or logging activity', async () => {
    const { client, db, projectId, ids } = await setup();
    const open = insertTask(db, { projectId, statusId: ids.review });
    const archived = insertTask(db, { projectId, statusId: ids.review, archivedAt: T0 });
    const elsewhere = insertTask(db, { projectId, statusId: ids.progress });
    const activityBefore = activityCount(db);

    // open → closed: completedAt set where NULL
    await client.patch(`/api/statuses/${ids.review}`, { category: 'completed' });
    const closedAt = taskRow(db, open).completed_at;
    expect(closedAt).not.toBeNull();
    expect(taskRow(db, archived).completed_at).not.toBeNull();
    expect(taskRow(db, elsewhere).completed_at).toBeNull();

    // closed → closed: unchanged
    db.run('UPDATE tasks SET completed_at = :t WHERE id = :id', { id: open, t: T1 });
    await client.patch(`/api/statuses/${ids.review}`, { category: 'cancelled' });
    expect(taskRow(db, open).completed_at).toBe(T1);

    // closed → open: cleared
    const res = await client.patch<StatusDTO>(`/api/statuses/${ids.review}`, { category: 'started' });
    expect(res.body.category).toBe('started');
    expect(taskRow(db, open).completed_at).toBeNull();
    expect(taskRow(db, archived).completed_at).toBeNull();

    for (const id of [open, archived, elsewhere]) expect(taskRow(db, id).updated_at).toBe(T0);
    expect(activityCount(db)).toBe(activityBefore);
  });

  it('deletes an unused status and rewrites nothing else', async () => {
    const { client, ids } = await setup();
    const res = await client.delete(`/api/statuses/${ids.backlog}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect((await client.get<StatusDTO[]>('/api/statuses')).body.map((s) => s.id)).not.toContain(ids.backlog);
    expect((await client.delete(`/api/statuses/${ids.backlog}`)).status).toBe(404);
  });

  it('refuses to delete a status in use without reassignTo (409 with the count) and validates reassignTo', async () => {
    const { client, db, projectId, ids } = await setup();
    insertTask(db, { projectId, statusId: ids.todo });
    insertTask(db, { projectId, statusId: ids.todo, archivedAt: T0 });

    const inUse = await client.delete(`/api/statuses/${ids.todo}`);
    expect(inUse.status).toBe(409);
    expect(inUse.body.error.message).toMatch(/2 tasks/);

    const self = await client.delete(`/api/statuses/${ids.todo}?reassignTo=${ids.todo}`);
    expect(self.status).toBe(400);
    expect(self.body.error.details[0].path).toBe('query.reassignTo');
    const unknown = await client.delete(`/api/statuses/${ids.todo}?reassignTo=999`);
    expect(unknown.status).toBe(400);
    expect((await client.delete(`/api/statuses/${ids.todo}?reassignTo=abc`)).status).toBe(400);
    // An unused status with an invalid target is still rejected.
    expect((await client.delete(`/api/statuses/${ids.backlog}?reassignTo=999`)).status).toBe(400);

    expect((await client.get<StatusDTO[]>('/api/statuses')).body).toHaveLength(6);
  });

  it('reassigns tasks (incl. archived) with completedAt transitions, remaps boards, no activity / updated_at', async () => {
    const { client, db, projectId, ids } = await setup();
    const a = insertTask(db, { projectId, statusId: ids.review });
    const b = insertTask(db, { projectId, statusId: ids.review, archivedAt: T0 });
    const c = insertTask(db, { projectId, statusId: ids.cancelled, completedAt: T1 });
    const boardId = insertBoard(db, {
      filter: { statusIds: [ids.review, ids.progress] },
      columns: { groupBy: 'status', prefs: { status: { order: [String(ids.review)], wipLimits: { [ids.review]: 4 } } } },
      swimlanes: { groupBy: 'custom', custom: [{ id: 'r', name: 'Review', match: { statusIds: [ids.review] }, onDrop: { statusId: ids.review } }] },
    });
    const activityBefore = activityCount(db);

    // open → closed: completedAt set
    expect((await client.delete(`/api/statuses/${ids.review}?reassignTo=${ids.done}`)).status).toBe(200);
    expect(taskRow(db, a)).toMatchObject({ status_id: ids.done, updated_at: T0 });
    expect(taskRow(db, a).completed_at).not.toBeNull();
    expect(taskRow(db, b)).toMatchObject({ status_id: ids.done, archived_at: T0 });

    const cfg = getBoard(db, boardId).config;
    expect(cfg.filter.statusIds).toEqual([ids.done, ids.progress]);
    // The deleted status's display prefs are dropped; Done keeps its own (none): no carried-over WIP.
    expect(cfg.columns.prefs.status).toEqual({ order: [], hidden: [], collapsed: [], wipLimits: {} });
    expect(cfg.swimlanes.custom[0]!.match.statusIds).toEqual([ids.done]);
    expect(cfg.swimlanes.custom[0]!.onDrop).toEqual({ statusId: ids.done });

    // closed → closed keeps completedAt
    db.run('UPDATE tasks SET completed_at = :t WHERE id = :id', { id: a, t: T1 });
    expect((await client.delete(`/api/statuses/${ids.done}?reassignTo=${ids.cancelled}`)).status).toBe(200);
    expect(taskRow(db, a)).toMatchObject({ status_id: ids.cancelled, completed_at: T1 });

    // closed → open clears it
    expect((await client.delete(`/api/statuses/${ids.cancelled}?reassignTo=${ids.todo}`)).status).toBe(200);
    for (const id of [a, b, c]) {
      expect(taskRow(db, id)).toMatchObject({ status_id: ids.todo, completed_at: null, updated_at: T0 });
    }
    expect(activityCount(db)).toBe(activityBefore);
    expect((await client.get<StatusDTO[]>('/api/statuses')).body.find((s) => s.id === ids.todo)!.taskCount).toBe(3);
  });

  it('never deletes the last status (409)', async () => {
    const { client, db, ids } = await setup();
    for (const id of [ids.backlog, ids.progress, ids.review, ids.done, ids.cancelled]) {
      expect((await client.delete(`/api/statuses/${id}`)).status).toBe(200);
    }
    const last = await client.delete(`/api/statuses/${ids.todo}`);
    expect(last.status).toBe(409);
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM statuses')!.n).toBe(1);
  });

  it('reorders with the exact id set only', async () => {
    const { client, ids } = await setup();
    const order = [ids.done, ids.todo, ids.backlog, ids.cancelled, ids.review, ids.progress];
    const res = await client.post('/api/statuses/reorder', { ids: order });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const listed = (await client.get<StatusDTO[]>('/api/statuses')).body;
    expect(listed.map((s) => s.id)).toEqual(order);
    expect(listed.map((s) => s.position)).toEqual([0, 1, 2, 3, 4, 5]);

    const missing = await client.post('/api/statuses/reorder', { ids: order.slice(1) });
    expect(missing.status).toBe(400);
    expect(missing.body.error.details[0].path).toBe('ids');
    expect((await client.post('/api/statuses/reorder', { ids: [...order, order[0]] })).status).toBe(400);
    expect((await client.post('/api/statuses/reorder', { ids: [...order.slice(1), 999] })).status).toBe(400);
    expect((await client.post('/api/statuses/reorder', { ids: [] })).status).toBe(400);
    expect((await client.get<StatusDTO[]>('/api/statuses')).body.map((s) => s.id)).toEqual(order);
  });
});
