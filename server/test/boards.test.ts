import { describe, expect, it } from 'vitest';
import { defaultBoardConfig, type BoardConfig } from '@shared/board';
import { LIMITS } from '@shared/constants';
import type { BoardDTO, BootstrapDTO } from '@shared/types';
import { createTestContext, type TestClient } from './helpers';
import { insertProject } from './services.fixtures';

async function setup() {
  const ctx = createTestContext();
  const { client } = await ctx.signedIn();
  const web = insertProject(ctx.db, 'WEB', { name: 'Website' });
  const me = insertProject(ctx.db, 'ME', { name: 'Personal' });
  const seeded = (await client.get<BoardDTO[]>('/api/boards')).body;
  return { ctx, client, web, me, allTasks: seeded[0]! };
}

async function createBoard(client: TestClient, body: Record<string, unknown>): Promise<BoardDTO> {
  const res = await client.post<BoardDTO>('/api/boards', body);
  if (res.status !== 201) throw new Error(`create failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

const activityCount = (ctx: ReturnType<typeof createTestContext>) =>
  Number(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM activity')!.n);

describe('boards API', () => {
  it('requires a session and the CSRF header', async () => {
    const ctx = createTestContext();
    const { client } = await ctx.signedIn();
    expect((await ctx.client().get('/api/boards')).status).toBe(401);
    const noCsrf = await client.request('POST', '/api/boards', { name: 'x' }, { 'X-Lyren-Request': '' });
    expect(noCsrf.status).toBe(403);
  });

  describe('GET /api/boards', () => {
    it('lists global boards first, then project boards by project, each scope by position', async () => {
      const { client, web, me, allTasks } = await setup();
      expect(allTasks).toMatchObject({ name: 'All tasks', projectId: null, position: 0 });
      const meBoard = await createBoard(client, { name: 'Me board', projectId: me });
      const g2 = await createBoard(client, { name: 'Global 2' });
      const web1 = await createBoard(client, { name: 'Web 1', projectId: web });
      const web2 = await createBoard(client, { name: 'Web 2', projectId: web });
      const res = await client.get<BoardDTO[]>('/api/boards');
      expect(res.status).toBe(200);
      expect(res.body.map((b) => b.id)).toEqual([allTasks.id, g2.id, web1.id, web2.id, meBoard.id]);
      expect(res.body.map((b) => b.position)).toEqual([0, 1, 0, 1, 0]);
    });

    it('is mirrored in bootstrap', async () => {
      const { client, web } = await setup();
      const b = await createBoard(client, { name: 'Web', projectId: web });
      const boot = (await client.get<BootstrapDTO>('/api/bootstrap')).body;
      expect(boot.boards.find((x) => x.id === b.id)).toEqual(b);
    });
  });

  describe('POST /api/boards', () => {
    it('creates a global board with a complete default config, appended to the global scope', async () => {
      const { ctx, client } = await setup();
      const before = activityCount(ctx);
      const res = await client.post<BoardDTO>('/api/boards', { name: '  Triage  ' });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ name: 'Triage', description: '', projectId: null, position: 1 });
      expect(res.body.config).toEqual(defaultBoardConfig());
      expect(res.body.createdAt).toBe(res.body.updatedAt);
      expect(activityCount(ctx)).toBe(before); // boards are not activity subjects
    });

    it('fills defaults into a partial config and normalizes clashing swimlanes', async () => {
      const { client } = await setup();
      const b = await createBoard(client, {
        name: 'Prio',
        description: 'By priority',
        config: { layout: 'list', columns: { groupBy: 'priority' }, swimlanes: { groupBy: 'priority' } },
      });
      expect(b.description).toBe('By priority');
      expect(b.config.layout).toBe('list');
      expect(b.config.columns.groupBy).toBe('priority');
      expect(b.config.columns.showEmpty).toBe(true);
      expect(b.config.swimlanes.groupBy).toBe('none');
      expect(b.config.card.fields.ref).toBe(true);
      expect(b.config.filter).toEqual({ closedWithinDays: 14 });
    });

    it('creates project boards scoped to their project, with positions per project', async () => {
      const { client, web, me } = await setup();
      const a = await createBoard(client, { name: 'A', projectId: web });
      const b = await createBoard(client, {
        name: 'B',
        projectId: web,
        config: { filter: { projectIds: [me], priorities: [4] } },
      });
      const c = await createBoard(client, { name: 'C', projectId: me });
      expect(a).toMatchObject({ projectId: web, position: 0 });
      expect(a.config.filter.projectIds).toEqual([web]);
      expect(b).toMatchObject({ projectId: web, position: 1 });
      expect(b.config.filter).toEqual({ projectIds: [web], priorities: [4] });
      expect(c).toMatchObject({ projectId: me, position: 0 });
      const global = await createBoard(client, { name: 'G', projectId: null, config: { filter: { projectIds: [me] } } });
      expect(global.projectId).toBeNull();
      expect(global.config.filter.projectIds).toEqual([me]);
    });

    it('rejects an unknown project (400 projectId) and invalid input (400)', async () => {
      const { client } = await setup();
      const unknown = await client.post('/api/boards', { name: 'X', projectId: 9999 });
      expect(unknown.status).toBe(400);
      expect(unknown.body.error.details).toEqual([{ path: 'projectId', message: 'Unknown project id: 9999' }]);

      for (const body of [
        {},
        { name: '   ' },
        { name: 'x'.repeat(LIMITS.boardNameMax + 1) },
        { name: 'X', description: 'd'.repeat(2001) },
        { name: 'X', projectId: 0 },
        { name: 'X', config: { layout: 'grid' } },
        { name: 'X', config: { columns: { groupBy: 'assignee' } } },
        { name: 'X', config: { columns: { custom: [{ id: '__other', name: 'Reserved' }] } } },
        { name: 'X', config: { columns: { custom: [{ id: 'a', name: 'A', onDrop: { due: 'today', dueDate: '2026-01-01' } }] } } },
        { name: 'X', config: { filter: { closedWithinDays: -1 } } },
      ]) {
        const res = await client.post('/api/boards', body);
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(res.body.error.code).toBe('validation_error');
      }
      const malformed = await client.request('POST', '/api/boards', '{"name":', { 'Content-Type': 'application/json' });
      expect(malformed.status).toBe(400);
    });

    it('keeps custom columns with their match filters and drop patches', async () => {
      const { client } = await setup();
      const b = await createBoard(client, {
        name: 'Custom',
        config: {
          columns: {
            groupBy: 'custom',
            custom: [
              { id: 'now', name: 'Now', color: '#ef4444', match: { priorities: [4, 3] }, onDrop: { priority: 4 } },
              { id: 'later', name: 'Later', match: { priorities: [1] }, onDrop: {} },
              { id: 'now', name: 'Duplicate id is dropped' },
            ],
          },
        },
      });
      expect(b.config.columns.custom).toEqual([
        { id: 'now', name: 'Now', color: '#ef4444', match: { priorities: [4, 3] }, onDrop: { priority: 4 } },
        { id: 'later', name: 'Later', color: null, match: { priorities: [1] }, onDrop: {} },
      ]);
    });
  });

  describe('GET /api/boards/:id', () => {
    it('returns one board, 404 when missing, 400 for a malformed id', async () => {
      const { client, allTasks } = await setup();
      expect((await client.get(`/api/boards/${allTasks.id}`)).body).toEqual(allTasks);
      const missing = await client.get('/api/boards/9999');
      expect(missing.status).toBe(404);
      expect(missing.body.error).toEqual({ code: 'not_found', message: 'Board not found' });
      expect((await client.get('/api/boards/abc')).status).toBe(400);
    });

    it('reads a corrupted stored config leniently', async () => {
      const { ctx, client, allTasks } = await setup();
      ctx.db.run('UPDATE boards SET config = :c WHERE id = :id', {
        id: allTasks.id,
        c: JSON.stringify({ layout: 'list', columns: { groupBy: 'nope' }, sort: 42 }),
      });
      const b = (await client.get<BoardDTO>(`/api/boards/${allTasks.id}`)).body;
      expect(b.config.layout).toBe('list');
      expect(b.config.columns.groupBy).toBe('status');
      expect(b.config.sort).toEqual({ field: 'manual', dir: 'asc' });
    });
  });

  describe('PATCH /api/boards/:id', () => {
    it('updates name, description and the complete config', async () => {
      const { client } = await setup();
      const b = await createBoard(client, { name: 'Old' });
      const config: BoardConfig = defaultBoardConfig({
        columns: { groupBy: 'tag', prefs: { tag: { order: ['3'], hidden: ['none'], collapsed: [], wipLimits: { '3': 2 } } } },
        swimlanes: { groupBy: 'priority' },
        sort: { field: 'dueDate', dir: 'desc' },
      });
      await new Promise((r) => setTimeout(r, 5));
      const res = await client.patch<BoardDTO>(`/api/boards/${b.id}`, { name: ' New ', description: 'Desc', config });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: b.id, name: 'New', description: 'Desc', position: b.position, projectId: null });
      expect(res.body.config).toEqual(config);
      expect(res.body.updatedAt > b.updatedAt).toBe(true);
      expect(res.body.createdAt).toBe(b.createdAt);
      expect((await client.get<BoardDTO>(`/api/boards/${b.id}`)).body).toEqual(res.body);
    });

    it('applies partial updates and leaves other fields alone', async () => {
      const { client } = await setup();
      const b = await createBoard(client, { name: 'Keep', description: 'Text', config: { layout: 'list' } });
      const res = await client.patch<BoardDTO>(`/api/boards/${b.id}`, { description: '' });
      expect(res.body).toMatchObject({ name: 'Keep', description: '' });
      expect(res.body.config.layout).toBe('list');
    });

    it('fills defaults into a partial config (the config is replaced, not merged)', async () => {
      const { client } = await setup();
      const b = await createBoard(client, { name: 'B', config: { layout: 'list', columns: { groupBy: 'epic' } } });
      const res = await client.patch<BoardDTO>(`/api/boards/${b.id}`, { config: { columns: { groupBy: 'due' } } });
      expect(res.body.config.layout).toBe('kanban');
      expect(res.body.config.columns.groupBy).toBe('due');
    });

    it('keeps project boards scoped and projectId immutable', async () => {
      const { client, web, me } = await setup();
      const b = await createBoard(client, { name: 'Web', projectId: web });
      const res = await client.patch<BoardDTO>(`/api/boards/${b.id}`, {
        projectId: me,
        config: defaultBoardConfig({ filter: { projectIds: [me, web], search: 'login' } }),
      });
      expect(res.status).toBe(200);
      expect(res.body.projectId).toBe(web);
      expect(res.body.config.filter).toEqual({ projectIds: [web], search: 'login' });
      const cleared = await client.patch<BoardDTO>(`/api/boards/${b.id}`, { config: defaultBoardConfig({ filter: {} }) });
      expect(cleared.body.config.filter).toEqual({ projectIds: [web] });
    });

    it('does not bump updatedAt for a no-op update', async () => {
      const { client } = await setup();
      const b = await createBoard(client, { name: 'Same', description: 'D' });
      await new Promise((r) => setTimeout(r, 5));
      const res = await client.patch<BoardDTO>(`/api/boards/${b.id}`, { name: 'Same', description: 'D', config: b.config });
      expect(res.status).toBe(200);
      expect(res.body).toEqual(b);
      expect((await client.patch<BoardDTO>(`/api/boards/${b.id}`, {})).body).toEqual(b);
    });

    it('returns 404 for a missing board and 400 for invalid input', async () => {
      const { client, allTasks } = await setup();
      expect((await client.patch('/api/boards/9999', { name: 'X' })).status).toBe(404);
      for (const body of [
        { name: '' },
        { name: 'x'.repeat(LIMITS.boardNameMax + 1) },
        { config: { sort: { field: 'bogus', dir: 'asc' } } },
        { config: { card: { density: 'huge' } } },
      ]) {
        const res = await client.patch(`/api/boards/${allTasks.id}`, body);
        expect(res.status, JSON.stringify(body)).toBe(400);
      }
      expect((await client.get<BoardDTO>(`/api/boards/${allTasks.id}`)).body).toEqual(allTasks);
    });
  });

  describe('DELETE /api/boards/:id', () => {
    it('deletes a board and resets defaultBoardId when it pointed at it', async () => {
      const { ctx, client, allTasks } = await setup();
      const other = await createBoard(client, { name: 'Other' });
      expect((await client.get<BootstrapDTO>('/api/bootstrap')).body.settings.defaultBoardId).toBe(allTasks.id);
      const before = activityCount(ctx);

      expect((await client.delete(`/api/boards/${other.id}`)).body).toEqual({ ok: true });
      let boot = (await client.get<BootstrapDTO>('/api/bootstrap')).body;
      expect(boot.boards.map((b) => b.id)).toEqual([allTasks.id]);
      expect(boot.settings.defaultBoardId).toBe(allTasks.id);

      const res = await client.delete(`/api/boards/${allTasks.id}`);
      expect(res.status).toBe(200);
      boot = (await client.get<BootstrapDTO>('/api/bootstrap')).body;
      expect(boot.boards).toEqual([]);
      expect(boot.settings.defaultBoardId).toBeNull();
      expect(activityCount(ctx)).toBe(before);
    });

    it('returns 404 for a missing board', async () => {
      const { client, allTasks } = await setup();
      expect((await client.delete('/api/boards/9999')).status).toBe(404);
      await client.delete(`/api/boards/${allTasks.id}`);
      expect((await client.delete(`/api/boards/${allTasks.id}`)).status).toBe(404);
    });

    it('cascades with the project (and clears the default board)', async () => {
      const { ctx, client, web, allTasks } = await setup();
      const pb = await createBoard(client, { name: 'Web', projectId: web });
      ctx.db.run("UPDATE settings SET value = :v WHERE key = 'defaultBoardId'", { v: JSON.stringify(pb.id) });
      expect((await client.delete(`/api/projects/${web}`)).status).toBe(200);
      const boot = (await client.get<BootstrapDTO>('/api/bootstrap')).body;
      expect(boot.boards.map((b) => b.id)).toEqual([allTasks.id]);
      expect(boot.settings.defaultBoardId).toBeNull();
    });
  });

  describe('POST /api/boards/:id/duplicate', () => {
    it('copies a global board as "<name> copy" at the end of its scope', async () => {
      const { client, allTasks, web } = await setup();
      await createBoard(client, { name: 'Web', projectId: web });
      const source = await createBoard(client, {
        name: 'Triage',
        description: 'Desc',
        config: { columns: { groupBy: 'priority' }, swimlanes: { groupBy: 'project' } },
      });
      await createBoard(client, { name: 'Last' });
      const res = await client.post<BoardDTO>(`/api/boards/${source.id}/duplicate`);
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ name: 'Triage copy', description: 'Desc', projectId: null, position: 3 });
      expect(res.body.id).not.toBe(source.id);
      expect(res.body.config).toEqual(source.config);
      const list = (await client.get<BoardDTO[]>('/api/boards')).body;
      expect(list.filter((b) => b.projectId === null).map((b) => b.name)).toEqual([allTasks.name, 'Triage', 'Last', 'Triage copy']);
    });

    it('keeps the project of a project board (and its scope)', async () => {
      const { ctx, client, web } = await setup();
      const source = await createBoard(client, { name: 'Web', projectId: web });
      // A stale/unscoped stored config is re-scoped on duplicate.
      ctx.db.run('UPDATE boards SET config = :c WHERE id = :id', {
        id: source.id,
        c: JSON.stringify(defaultBoardConfig({ filter: { projectIds: [] } })),
      });
      const copy = (await client.post<BoardDTO>(`/api/boards/${source.id}/duplicate`)).body;
      expect(copy).toMatchObject({ name: 'Web copy', projectId: web, position: 1 });
      expect(copy.config.filter.projectIds).toEqual([web]);
    });

    it('truncates long names to the limit', async () => {
      const { client } = await setup();
      const long = await createBoard(client, { name: 'n'.repeat(LIMITS.boardNameMax) });
      const copy = (await client.post<BoardDTO>(`/api/boards/${long.id}/duplicate`)).body;
      expect(copy.name).toHaveLength(LIMITS.boardNameMax);
      expect(copy.name.endsWith(' copy')).toBe(true);
    });

    it('returns 404 for a missing board', async () => {
      const { client } = await setup();
      expect((await client.post('/api/boards/9999/duplicate')).status).toBe(404);
    });
  });

  describe('POST /api/boards/reorder', () => {
    it('reorders the global scope', async () => {
      const { client, allTasks, web } = await setup();
      const pb = await createBoard(client, { name: 'Web', projectId: web });
      const a = await createBoard(client, { name: 'A' });
      const b = await createBoard(client, { name: 'B' });
      const res = await client.post('/api/boards/reorder', { ids: [b.id, allTasks.id, a.id] });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      const list = (await client.get<BoardDTO[]>('/api/boards')).body;
      expect(list.map((x) => [x.id, x.position])).toEqual([
        [b.id, 0],
        [allTasks.id, 1],
        [a.id, 2],
        [pb.id, 0],
      ]);
    });

    it('reorders one project scope without touching others', async () => {
      const { client, web, me, allTasks } = await setup();
      const w1 = await createBoard(client, { name: 'W1', projectId: web });
      const w2 = await createBoard(client, { name: 'W2', projectId: web });
      const m1 = await createBoard(client, { name: 'M1', projectId: me });
      expect((await client.post('/api/boards/reorder', { ids: [w2.id, w1.id] })).status).toBe(200);
      const list = (await client.get<BoardDTO[]>('/api/boards')).body;
      expect(list.map((x) => x.id)).toEqual([allTasks.id, w2.id, w1.id, m1.id]);
      const updated = list.find((x) => x.id === w1.id)!;
      expect(updated.updatedAt).toBe(w1.updatedAt); // positions are not content edits
    });

    it('requires exactly the full id set of one scope', async () => {
      const { client, web, allTasks } = await setup();
      const w1 = await createBoard(client, { name: 'W1', projectId: web });
      const w2 = await createBoard(client, { name: 'W2', projectId: web });
      const g = await createBoard(client, { name: 'G' });
      const cases: Array<[unknown, RegExp | null]> = [
        [{ ids: [w1.id] }, /missing ids: /],
        [{ ids: [w1.id, w2.id, g.id] }, /unknown ids: /],
        [{ ids: [allTasks.id, g.id, w1.id] }, /unknown ids: /],
        [{ ids: [w1.id, w2.id, w2.id] }, /duplicate ids: /],
        [{ ids: [9999] }, /unknown ids: 9999/],
        [{ ids: [] }, null],
        [{}, null],
        [{ ids: ['x'] }, null],
      ];
      for (const [body, message] of cases) {
        const res = await client.post('/api/boards/reorder', body);
        expect(res.status, JSON.stringify(body)).toBe(400);
        if (message) expect(res.body.error.message).toMatch(message);
      }
      const list = (await client.get<BoardDTO[]>('/api/boards')).body;
      expect(list.map((x) => x.id)).toEqual([allTasks.id, g.id, w1.id, w2.id]);
    });
  });
});
