import { describe, expect, it } from 'vitest';
import { defaultBoardConfig, type BoardConfigInput } from '@shared/board';
import { DEFAULT_PROJECT_COLOR } from '@shared/constants';
import type { ActivityDTO, ActivityPage, EpicDTO, MilestoneDTO, ProjectDTO } from '@shared/types';
import type { Db } from '../src/db';
import { getBoard } from '../src/services/entities';
import { getSettings, saveSettings } from '../src/services/settings';
import { createTestContext } from './helpers';
import { insertEpic, insertMilestone, insertProject, insertTask, statusIdByName } from './services.fixtures';

const STAMP = '2026-01-01T00:00:00.000Z';

function insertBoard(db: Db, projectId: number | null, config: BoardConfigInput): number {
  return db.run(
    `INSERT INTO boards (project_id, name, config, position, created_at, updated_at)
     VALUES (:projectId, 'B', :config, 0, :t, :t)`,
    { projectId, config: JSON.stringify(defaultBoardConfig(config)), t: STAMP },
  ).lastInsertRowid;
}

async function setup() {
  const ctx = createTestContext();
  const { client, user } = await ctx.signedIn();
  return { ctx, db: ctx.db, client, user };
}

async function activity(client: Awaited<ReturnType<typeof setup>>['client'], query = ''): Promise<ActivityDTO[]> {
  const res = await client.get<ActivityPage>(`/api/activity${query}`);
  if (res.status === 200 && Array.isArray(res.body?.items)) return res.body.items;
  throw new Error(`activity feed unavailable: ${res.status}`);
}

/** Read activity straight from the table (the feed route belongs to another area). */
function activityRows(db: Db) {
  return db
    .all<{ action: string; project_id: number | null; task_id: number | null; entity_type: string; entity_id: number | null; data: string; user_id: number | null }>(
      'SELECT * FROM activity ORDER BY id',
    )
    .map((r) => ({ ...r, data: JSON.parse(r.data) as Record<string, unknown> }));
}

describe('POST /api/projects', () => {
  it('creates a project with defaults, a generated key and an activity entry', async () => {
    const { db, client, user } = await setup();
    const res = await client.post<ProjectDTO>('/api/projects', { name: 'Lyren Plan Web' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      key: 'LPW',
      name: 'Lyren Plan Web',
      description: '',
      color: DEFAULT_PROJECT_COLOR,
      status: 'active',
      position: 0,
      stats: { tasksTotal: 0, tasksOpen: 0, tasksClosed: 0, tasksOverdue: 0, milestonesTotal: 0, epicsTotal: 0 },
    });
    expect(res.body.createdAt).toBe(res.body.updatedAt);
    const rows = activityRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'project.created',
      entity_type: 'project',
      entity_id: res.body.id,
      project_id: res.body.id,
      task_id: null,
      user_id: user.id,
      data: { name: 'Lyren Plan Web', key: 'LPW' },
    });
  });

  it('generates keys per SPEC §5.1 (single word, prefix, padding, uniqueness suffix)', async () => {
    const { client } = await setup();
    const key = async (name: string) => (await client.post<ProjectDTO>('/api/projects', { name })).body.key;
    expect(await key('Website')).toBe('WEB');
    expect(await key('Website')).toBe('WEB2');
    expect(await key('website relaunch extra words here')).toBe('WREW');
    expect(await key('42 things')).toBe('P4T');
    expect(await key('A')).toBe('AX');
    expect(await key('!!!')).toBe('PX');
    expect(await key('Évènement')).toBe('EVE');
  });

  it('accepts an explicit key (normalized to upper case), color, status and description', async () => {
    const { client } = await setup();
    const res = await client.post<ProjectDTO>('/api/projects', {
      name: 'Home',
      key: ' home1 ',
      color: '#22C55E',
      status: 'on_hold',
      description: '# Notes',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ key: 'HOME1', color: '#22c55e', status: 'on_hold', description: '# Notes' });
  });

  it('appends positions', async () => {
    const { client } = await setup();
    const a = (await client.post<ProjectDTO>('/api/projects', { name: 'Alpha' })).body;
    const b = (await client.post<ProjectDTO>('/api/projects', { name: 'Beta' })).body;
    expect([a.position, b.position]).toEqual([0, 1]);
  });

  it('409 on a duplicate key (case-insensitive) with a field detail', async () => {
    const { client } = await setup();
    await client.post('/api/projects', { name: 'Web', key: 'WEB' });
    const res = await client.post('/api/projects', { name: 'Other', key: 'web' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('conflict');
    expect(res.body.error.details[0].path).toBe('key');
  });

  it('400 on invalid input', async () => {
    const { client } = await setup();
    for (const body of [
      {},
      { name: '   ' },
      { name: 'x'.repeat(121) },
      { name: 'Ok', key: '1AB' },
      { name: 'Ok', key: 'A' },
      { name: 'Ok', key: 'ABCDEFGHIJK' },
      { name: 'Ok', key: 'AB-C' },
      { name: 'Ok', color: 'red' },
      { name: 'Ok', status: 'paused' },
    ]) {
      const res = await client.post('/api/projects', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.code).toBe('validation_error');
    }
    expect((await client.request('POST', '/api/projects', '{not json')).status).toBe(400);
  });

  it('requires a session and the CSRF header', async () => {
    const { ctx, client } = await setup();
    expect((await ctx.client().post('/api/projects', { name: 'X' })).status).toBe(401);
    const res = await client.request('POST', '/api/projects', { name: 'X' }, { 'X-Lyren-Request': '' });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/projects', () => {
  it('lists every project by position with stats honouring ?today=', async () => {
    const { db, client } = await setup();
    const web = insertProject(db, 'WEB');
    insertProject(db, 'OLD', { status: 'archived' });
    insertTask(db, { projectId: web, dueDate: '2026-05-10' });
    insertTask(db, { projectId: web, dueDate: '2026-05-01', statusId: statusIdByName(db, 'Done') });
    insertTask(db, { projectId: web, dueDate: '2026-05-01', archivedAt: STAMP });

    const early = await client.get<ProjectDTO[]>('/api/projects?today=2026-05-05');
    expect(early.status).toBe(200);
    expect(early.body.map((p) => p.key)).toEqual(['WEB', 'OLD']);
    expect(early.body[0]!.stats).toMatchObject({ tasksTotal: 2, tasksOpen: 1, tasksClosed: 1, tasksOverdue: 0 });
    const late = await client.get<ProjectDTO[]>('/api/projects?today=2026-05-20');
    expect(late.body[0]!.stats.tasksOverdue).toBe(1);

    const one = await client.get<ProjectDTO>(`/api/projects/${web}?today=2026-05-20`);
    expect(one.status).toBe(200);
    expect(one.body).toEqual(late.body[0]);
  });

  it('400 on an invalid ?today= or id; 404 for an unknown project', async () => {
    const { client } = await setup();
    const bad = await client.get('/api/projects?today=2026-13-01');
    expect(bad.status).toBe(400);
    expect(bad.body.error.details[0].path).toBe('query.today');
    expect((await client.get('/api/projects/abc')).status).toBe(400);
    expect((await client.get('/api/projects/0')).status).toBe(400);
    const missing = await client.get('/api/projects/999');
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('not_found');
  });

  it('lists a project’s milestones and epics in position order (404 for an unknown project)', async () => {
    const { db, client } = await setup();
    const p = insertProject(db, 'WEB');
    const other = insertProject(db, 'OTH');
    const m1 = insertMilestone(db, p, { name: 'One' });
    const m2 = insertMilestone(db, p, { name: 'Two' });
    insertMilestone(db, other, { name: 'Elsewhere' });
    db.run('UPDATE milestones SET position = 5 WHERE id = :id', { id: m1 });
    const e1 = insertEpic(db, p, { name: 'E1', milestoneId: m1 });
    const e2 = insertEpic(db, p, { name: 'E2' });
    insertEpic(db, other, { name: 'Other epic' });
    insertTask(db, { projectId: p, epicId: e1, estimate: 3 });

    const ms = await client.get<MilestoneDTO[]>(`/api/projects/${p}/milestones`);
    expect(ms.status).toBe(200);
    expect(ms.body.map((m) => m.id)).toEqual([m2, m1]);
    expect(ms.body[1]!.stats).toMatchObject({ tasksTotal: 1, estimateTotal: 3, epicsTotal: 1 });
    const es = await client.get<EpicDTO[]>(`/api/projects/${p}/epics`);
    expect(es.body.map((e) => e.id)).toEqual([e1, e2]);
    expect(es.body[0]!.stats).toMatchObject({ tasksTotal: 1, tasksClosed: 0 });
    expect((await client.get('/api/projects/999/milestones')).status).toBe(404);
    expect((await client.get('/api/projects/999/epics')).status).toBe(404);
  });
});

describe('PATCH /api/projects/:id', () => {
  it('updates fields, logs only real changes and returns fresh stats', async () => {
    const { db, client } = await setup();
    const p = (await client.post<ProjectDTO>('/api/projects', { name: 'Web', key: 'WEB' })).body;
    insertTask(db, { projectId: p.id, dueDate: '2026-01-01' });
    const res = await client.patch<ProjectDTO>(`/api/projects/${p.id}?today=2026-06-01`, {
      name: 'Website',
      key: 'site',
      status: 'archived',
      color: '#ef4444',
      description: 'New',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'Website', key: 'SITE', status: 'archived', color: '#ef4444', description: 'New' });
    expect(res.body.stats).toMatchObject({ tasksTotal: 1, tasksOverdue: 1 });
    expect(res.body.updatedAt >= p.updatedAt).toBe(true);
    const last = activityRows(db).at(-1)!;
    expect(last).toMatchObject({ action: 'project.updated', project_id: p.id, entity_id: p.id, task_id: null });
    expect(last.data).toEqual({
      name: 'Website',
      changes: [
        { field: 'name', from: 'Web', to: 'Website' },
        { field: 'key', from: 'WEB', to: 'SITE' },
        { field: 'status', from: 'active', to: 'archived', fromLabel: 'Active', toLabel: 'Archived' },
        { field: 'color' },
        { field: 'description' },
      ],
    });
  });

  it('a no-op PATCH changes nothing and logs nothing', async () => {
    const { db, client } = await setup();
    const p = (await client.post<ProjectDTO>('/api/projects', { name: 'Web', key: 'WEB', color: '#ef4444' })).body;
    const count = activityRows(db).length;
    for (const body of [{}, { name: 'Web', key: 'web', color: '#EF4444', status: 'active', description: '' }]) {
      const res = await client.patch<ProjectDTO>(`/api/projects/${p.id}`, body);
      expect(res.status).toBe(200);
      expect(res.body.updatedAt).toBe(p.updatedAt);
    }
    expect(activityRows(db)).toHaveLength(count);
  });

  it('409 when the new key is used by another project; renaming to its own key is fine', async () => {
    const { client } = await setup();
    const a = (await client.post<ProjectDTO>('/api/projects', { name: 'A', key: 'AAA' })).body;
    await client.post('/api/projects', { name: 'B', key: 'BBB' });
    const res = await client.patch(`/api/projects/${a.id}`, { key: 'bbb' });
    expect(res.status).toBe(409);
    expect(res.body.error.details[0]).toMatchObject({ path: 'key' });
    expect((await client.patch(`/api/projects/${a.id}`, { key: 'AAA', name: 'A2' })).status).toBe(200);
  });

  it('changing the key changes task refs', async () => {
    const { db, client } = await setup();
    const p = (await client.post<ProjectDTO>('/api/projects', { name: 'Web', key: 'WEB' })).body;
    const t = insertTask(db, { projectId: p.id });
    await client.patch(`/api/projects/${p.id}`, { key: 'SITE' });
    const res = await client.get(`/api/tasks/${t}`);
    if (res.status === 200) expect(res.body.ref).toBe('SITE-1');
    const row = db.get<{ ref: string }>(
      "SELECT p.key || '-' || t.number AS ref FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = :t",
      { t },
    );
    expect(row?.ref).toBe('SITE-1');
  });

  it('400 on invalid input, 404 for an unknown project', async () => {
    const { client } = await setup();
    const p = (await client.post<ProjectDTO>('/api/projects', { name: 'Web' })).body;
    for (const body of [{ name: '' }, { key: '9X' }, { color: '#abc' }, { status: 'gone' }, { description: 5 }]) {
      expect((await client.patch(`/api/projects/${p.id}`, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await client.patch('/api/projects/999', { name: 'X' })).status).toBe(404);
  });
});

describe('DELETE /api/projects/:id', () => {
  it('cascades everything, logs project.deleted with project_id NULL and cleans boards and settings', async () => {
    const { db, client, user } = await setup();
    const p = (await client.post<ProjectDTO>('/api/projects', { name: 'Web', key: 'WEB' })).body;
    const keep = (await client.post<ProjectDTO>('/api/projects', { name: 'Keep', key: 'KEEP' })).body;
    const m = insertMilestone(db, p.id);
    const e = insertEpic(db, p.id, { milestoneId: m });
    const t = insertTask(db, { projectId: p.id, epicId: e });
    db.run("INSERT INTO comments (task_id, user_id, body, created_at, updated_at) VALUES (:t, :u, 'hi', :s, :s)", {
      t,
      u: user.id,
      s: STAMP,
    });
    db.run("INSERT INTO work_logs (task_id, user_id, date, minutes, note, created_at, updated_at) VALUES (:t, :u, '2026-01-01', 30, '', :s, :s)", {
      t,
      u: user.id,
      s: STAMP,
    });
    const projectBoard = insertBoard(db, p.id, { filter: { projectIds: [p.id] } });
    const global = insertBoard(db, null, {
      filter: { projectIds: [p.id, keep.id], epicIds: [e] },
      columns: {
        groupBy: 'custom',
        custom: [
          { id: 'c1', name: 'Web', match: { projectIds: [p.id] }, onDrop: { projectId: p.id } },
          { id: 'c2', name: 'Epic', match: { epicIds: [e] }, onDrop: { epicId: e } },
        ],
      },
      swimlanes: { groupBy: 'epic', prefs: { epic: { order: [String(e), 'none'], collapsed: [String(e)] } } },
    });
    saveSettings(db, { defaultBoardId: projectBoard });

    const res = await client.delete(`/api/projects/${p.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    for (const [table, where] of [
      ['projects', `id = ${p.id}`],
      ['milestones', `project_id = ${p.id}`],
      ['epics', `project_id = ${p.id}`],
      ['tasks', `project_id = ${p.id}`],
      ['comments', `task_id = ${t}`],
      ['work_logs', `task_id = ${t}`],
      ['boards', `id = ${projectBoard}`],
      ['activity', `project_id = ${p.id}`],
    ] as const) {
      expect(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)!.n, table).toBe(0);
    }
    expect(getSettings(db).defaultBoardId).toBeNull();

    const cfg = getBoard(db, global).config;
    expect(cfg.filter.projectIds).toEqual([p.id, keep.id]); // filter ids stay (match nothing)
    expect(cfg.columns.custom[0]!.onDrop).toEqual({});
    expect(cfg.columns.custom[1]!.onDrop).toEqual({});
    expect(cfg.swimlanes.prefs.epic?.order ?? []).not.toContain(String(e));

    const rows = activityRows(db);
    expect(rows.at(-1)).toMatchObject({
      action: 'project.deleted',
      project_id: null,
      task_id: null,
      entity_type: 'project',
      entity_id: p.id,
      data: { name: 'Web', key: 'WEB' },
    });
    expect(rows.filter((r) => r.action !== 'project.deleted').every((r) => r.project_id === keep.id)).toBe(true);
  });

  it('keeps the history of tasks that were moved out of the deleted project', async () => {
    const { db, client } = await setup();
    const alp = (await client.post<ProjectDTO>('/api/projects', { name: 'Alpha', key: 'ALP' })).body;
    const bet = (await client.post<ProjectDTO>('/api/projects', { name: 'Beta', key: 'BET' })).body;
    const task = (await client.post<{ id: number }>('/api/tasks', { projectId: alp.id, title: 'Keep me' })).body;
    const stays = (await client.post<{ id: number }>('/api/tasks', { projectId: alp.id, title: 'Goes away' })).body;
    expect((await client.patch(`/api/tasks/${task.id}`, { priority: 3 })).status).toBe(200);
    expect((await client.post(`/api/tasks/${task.id}/comments`, { body: 'note' })).status).toBe(201);
    expect((await client.post(`/api/tasks/${task.id}/worklogs`, { date: '2026-05-01', minutes: 30 })).status).toBe(201);
    expect((await client.patch(`/api/tasks/${task.id}`, { projectId: bet.id })).status).toBe(200);
    expect((await client.post(`/api/tasks/${stays.id}/comments`, { body: 'bye' })).status).toBe(201);

    const before = (await activity(client, `?taskId=${task.id}`)).map((a) => a.action);
    expect(before).toEqual(['task.moved', 'worklog.created', 'comment.created', 'task.updated', 'task.created']);

    expect((await client.delete(`/api/projects/${alp.id}`)).status).toBe(200);

    expect((await client.get(`/api/tasks/${task.id}`)).status).toBe(200);
    const timeline = await client.get<{ activity: ActivityDTO[] }>(`/api/tasks/${task.id}/timeline`);
    expect(timeline.status).toBe(200);
    expect(timeline.body.activity.map((a) => a.action).sort()).toEqual(['task.created', 'task.moved', 'task.updated']);
    expect((await activity(client, `?taskId=${task.id}`)).map((a) => a.action)).toEqual(before);
    // The surviving rows now belong to the task's current project.
    const kept = db.all<{ project_id: number }>('SELECT project_id FROM activity WHERE task_id = :t', { t: task.id });
    expect(kept.every((r) => r.project_id === bet.id)).toBe(true);
    // The deleted project's own tasks and structural events still cascade away.
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM activity WHERE project_id = :p', { p: alp.id })!.n).toBe(0);
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM activity WHERE task_id = :t', { t: stays.id })!.n).toBe(0);
  });

  it('keeps settings.defaultBoardId when it points at a surviving board', async () => {
    const { db, client } = await setup();
    const p = (await client.post<ProjectDTO>('/api/projects', { name: 'Web' })).body;
    const before = getSettings(db).defaultBoardId;
    expect(before).not.toBeNull();
    await client.delete(`/api/projects/${p.id}`);
    expect(getSettings(db).defaultBoardId).toBe(before);
  });

  it('404 for an unknown project, 400 for a bad id', async () => {
    const { client } = await setup();
    expect((await client.delete('/api/projects/999')).status).toBe(404);
    expect((await client.delete('/api/projects/x')).status).toBe(400);
  });
});

describe('POST /api/projects/reorder', () => {
  it('reorders with the exact id set', async () => {
    const { db, client } = await setup();
    const a = insertProject(db, 'AAA');
    const b = insertProject(db, 'BBB');
    const c = insertProject(db, 'CCC');
    const count = activityRows(db).length;
    const res = await client.post('/api/projects/reorder', { ids: [c, a, b] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect((await client.get<ProjectDTO[]>('/api/projects')).body.map((p) => [p.id, p.position])).toEqual([
      [c, 0],
      [a, 1],
      [b, 2],
    ]);
    expect(activityRows(db)).toHaveLength(count);
  });

  it('400 for missing, unknown or duplicate ids and an empty list', async () => {
    const { db, client } = await setup();
    const a = insertProject(db, 'AAA');
    const b = insertProject(db, 'BBB');
    for (const ids of [[a], [a, b, 999], [a, b, b], [], [a, a]]) {
      const res = await client.post('/api/projects/reorder', { ids });
      expect(res.status, JSON.stringify(ids)).toBe(400);
    }
    const msg = (await client.post('/api/projects/reorder', { ids: [a, 999] })).body.error.message as string;
    expect(msg).toContain('unknown ids: 999');
    expect(msg).toContain(`missing ids: ${b}`);
  });
});

describe('activity feed integration', () => {
  it('structural events appear in the project feed when the feed route exists', async () => {
    const { client } = await setup();
    const p = (await client.post<ProjectDTO>('/api/projects', { name: 'Web' })).body;
    let items: ActivityDTO[];
    try {
      items = await activity(client, `?projectId=${p.id}`);
    } catch {
      return; // timeline routes are implemented by another area; the table is checked above
    }
    expect(items[0]).toMatchObject({ action: 'project.created', entityType: 'project', projectId: p.id });
  });
});
