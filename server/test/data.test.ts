import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { CSRF_HEADER } from '@shared/constants';
import { exportSchema, IMPORT_INT_MAX, type ExportInput } from '@shared/export';
import type { BoardDTO, ExportDTO, StatusDTO, TagDTO } from '@shared/types';
import { buildExport } from '../src/routes/data';
import { getBoard } from '../src/services/entities';
import { createTestContext } from './helpers';

const TS = '2026-01-01T00:00:00.000Z';

async function sampleSetup(overrides: Parameters<typeof createTestContext>[0] = {}) {
  const ctx = createTestContext(overrides);
  const { client, user } = await ctx.signedIn({ createSampleData: true });
  return { ...ctx, client, user };
}

/** Comparable export: exportedAt is the only field that legitimately differs between two exports. */
const comparable = (e: ExportDTO) => ({ ...e, exportedAt: '' });

function backupsIn(dataDir: string): string[] {
  const dir = path.join(dataDir, 'backups');
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

/** A small hand-written export exercising the import fix-ups. */
function handExport(): ExportInput {
  const stamps = { createdAt: TS, updatedAt: TS };
  const task = (id: number, number: number, statusId: number, rank: string, extra: Partial<ExportInput['tasks'][number]> = {}) => ({
    id,
    projectId: 3,
    number,
    epicId: null,
    statusId,
    priority: 2 as const,
    title: `Task ${id}`,
    description: '',
    startDate: null,
    dueDate: null,
    estimate: null,
    rank,
    completedAt: null,
    archivedAt: null,
    createdBy: 42,
    tagIds: [],
    ...stamps,
    ...extra,
  });
  return {
    format: 'lyren-plan-export',
    formatVersion: 1,
    exportedAt: TS,
    appVersion: 'test',
    settings: { weekStartsOn: 0, estimateUnit: 'hours', defaultBoardId: 77, homePage: 'default_board' },
    statuses: [
      { id: 10, name: 'Open', category: 'unstarted', color: '#111111', position: 0 },
      { id: 11, name: 'Shipped', category: 'completed', color: '#222222', position: 1 },
    ],
    tags: [{ id: 5, name: 'urgent', color: '#FF0000', createdAt: TS }],
    projects: [
      { id: 3, key: 'AB', name: 'Alpha', description: '', color: '#333333', status: 'active', position: 0, taskCounter: 1, ...stamps },
    ],
    milestones: [
      {
        id: 4, projectId: 3, name: 'M', description: '', status: 'completed', startDate: null, dueDate: null,
        position: 0, completedAt: null, ...stamps,
      },
    ],
    epics: [
      {
        id: 6, projectId: 3, milestoneId: 4, name: 'E', description: '', color: '#444444', status: 'open',
        startDate: null, dueDate: null, position: 0, completedAt: TS, ...stamps,
      },
    ],
    tasks: [
      task(100, 7, 11, 'zz', { tagIds: [5, 5], epicId: 6 }),
      task(101, 2, 10, 'b', { completedAt: '2026-01-02T00:00:00Z' }),
      task(102, 3, 10, 'b', { createdBy: null }),
    ],
    comments: [{ id: 1, taskId: 100, body: 'hi', authorId: 42, editedAt: null, ...stamps }],
    worklogs: [{ id: 1, taskId: 101, date: '2026-01-01', minutes: 30, note: '', authorId: null, ...stamps }],
    activity: [
      { id: 1, action: 'task.created', entityType: 'task', entityId: 100, projectId: 3, taskId: 100, data: { title: 'Task 100', ref: 'AB-7' }, actorId: 42, createdAt: TS },
      { id: 2, action: 'task.created', entityType: 'task', entityId: 999, projectId: 3, taskId: 999, data: {}, actorId: 42, createdAt: TS },
      { id: 3, action: 'project.created', entityType: 'project', entityId: 998, projectId: 998, taskId: null, data: {}, actorId: 42, createdAt: TS },
      { id: 4, action: 'project.deleted', entityType: 'project', entityId: 998, projectId: null, taskId: null, data: { name: 'Gone' }, actorId: null, createdAt: TS },
    ],
    boards: [
      {
        id: 8, projectId: 3, name: 'Alpha board', description: '', position: 0, ...stamps,
        config: { filter: { projectIds: [1, 2], priorities: [4] }, columns: { groupBy: 'bogus' } },
      },
      { id: 9, projectId: null, name: 'Global', description: '', position: 0, config: 'garbage', ...stamps },
    ],
  };
}

describe('GET /api/data/export', () => {
  it('exports every table as a valid ExportDTO attachment without internal settings', async () => {
    const { client, db, user } = await sampleSetup();
    const res = await client.get<ExportDTO>('/api/data/export');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="lyren-export-\d{4}-\d\d-\d\d\.json"$/);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const e = res.body;
    expect(exportSchema.safeParse(e).success).toBe(true);
    expect(e).toMatchObject({ format: 'lyren-plan-export', formatVersion: 1 });
    expect(Object.keys(e.settings).sort()).toEqual(['defaultBoardId', 'estimateUnit', 'homePage', 'weekStartsOn']);

    const count = (table: string) => db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)!.n;
    expect(e.statuses).toHaveLength(count('statuses'));
    expect(e.tags).toHaveLength(count('tags'));
    expect(e.projects).toHaveLength(2);
    expect(e.tasks).toHaveLength(count('tasks'));
    expect(e.comments).toHaveLength(count('comments'));
    expect(e.worklogs).toHaveLength(count('work_logs'));
    expect(e.activity).toHaveLength(count('activity'));
    expect(e.boards).toHaveLength(count('boards'));
    expect(e.statuses[0]).not.toHaveProperty('taskCount');

    const web = e.projects.find((p) => p.key === 'WEB')!;
    expect(web.taskCounter).toBe(Math.max(...e.tasks.filter((t) => t.projectId === web.id).map((t) => t.number)));
    expect(e.boards.find((b) => b.name === 'WEB board')!.projectId).toBe(web.id);
    expect(e.boards.find((b) => b.name === 'Priority triage')!.projectId).toBeNull();
    const taggedTasks = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM task_tags')!.n;
    expect(e.tasks.reduce((n, t) => n + t.tagIds.length, 0)).toBe(taggedTasks);
    expect(e.comments.every((cm) => cm.authorId === user.id)).toBe(true);
    expect(e.activity.every((a) => typeof a.data === 'object' && a.actorId === user.id)).toBe(true);
  });

  it('requires a session', async () => {
    const { app } = await sampleSetup();
    expect((await app.request('/api/data/export')).status).toBe(401);
  });
});

describe('GET /api/data/backup', () => {
  async function download(ctx: Awaited<ReturnType<typeof sampleSetup>>) {
    return ctx.app.request('/api/data/backup', { headers: { Cookie: ctx.client.cookie!, [CSRF_HEADER]: '1' } });
  }

  it('streams a consistent SQLite snapshot without sessions and removes the temp file', async () => {
    const ctx = await sampleSetup();
    const res = await download(ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/vnd.sqlite3');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="lyren-backup-\d{4}-\d\d-\d\d\.db"$/);
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(Number(res.headers.get('content-length'))).toBe(bytes.length);
    expect(bytes.subarray(0, 15).toString('latin1')).toBe('SQLite format 3');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyren-backup-test-'));
    const file = path.join(dir, 'copy.db');
    fs.writeFileSync(file, bytes);
    const copy = new DatabaseSync(file);
    try {
      const n = (sql: string) => Number((copy.prepare(sql).get() as { n: number }).n);
      expect(n('SELECT COUNT(*) AS n FROM sessions')).toBe(0);
      expect(n('SELECT COUNT(*) AS n FROM users')).toBe(1);
      expect(n('SELECT COUNT(*) AS n FROM tasks')).toBe(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks')!.n);
      expect((copy.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('delete');
    } finally {
      copy.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
    // The live database still has its session.
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sessions')!.n).toBe(1);
    expect(fs.readdirSync(ctx.config.dataDir).filter((f) => f.startsWith('.backup-'))).toEqual([]);
  });

  it('leaves no temp file behind when the download is aborted', async () => {
    const ctx = await sampleSetup();
    const res = await download(ctx);
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fs.readdirSync(ctx.config.dataDir).filter((f) => f.startsWith('.backup-'))).toEqual([]);
  });

  it('requires a session', async () => {
    const { app } = await sampleSetup();
    expect((await app.request('/api/data/backup')).status).toBe(401);
  });

  it('answers HEAD with headers only, without taking (and leaking) a snapshot', async () => {
    const ctx = await sampleSetup();
    const openBackups = () => {
      if (!fs.existsSync('/proc/self/fd')) return 0;
      return fs.readdirSync('/proc/self/fd').filter((fd) => {
        try {
          return fs.readlinkSync(`/proc/self/fd/${fd}`).includes('.backup-');
        } catch {
          return false;
        }
      }).length;
    };
    const fdsBefore = openBackups();
    const backupTo = vi.spyOn(ctx.db, 'backupTo');
    for (let i = 0; i < 3; i++) {
      const res = await ctx.app.request('/api/data/backup', {
        method: 'HEAD',
        headers: { Cookie: ctx.client.cookie!, [CSRF_HEADER]: '1' },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/vnd.sqlite3');
      expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="lyren-backup-/);
      expect(await res.text()).toBe('');
    }
    expect(backupTo).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(openBackups()).toBe(fdsBefore);
    expect(fs.readdirSync(ctx.config.dataDir).filter((f) => f.startsWith('.backup-'))).toEqual([]);
    // GET still streams a snapshot.
    backupTo.mockRestore();
    const get = await download(ctx);
    expect(Buffer.from(await get.arrayBuffer()).subarray(0, 15).toString('latin1')).toBe('SQLite format 3');
  });
});

describe('POST /api/data/import', () => {
  it('round-trips: export → mutate → import the export → export again is identical', async () => {
    const { client, db, config, user } = await sampleSetup();
    const e1 = (await client.get<ExportDTO>('/api/data/export')).body;

    // Mutate through the API and directly.
    const tags = (await client.get<TagDTO[]>('/api/tags')).body;
    const statuses = (await client.get<StatusDTO[]>('/api/statuses')).body;
    await client.post('/api/tags', { name: 'brand new' });
    await client.delete(`/api/tags/${tags[0]!.id}`);
    await client.patch(`/api/statuses/${statuses[1]!.id}`, { name: 'Renamed', category: 'completed' });
    await client.post('/api/statuses/reorder', { ids: statuses.map((s) => s.id).reverse() });
    await client.patch('/api/settings', { weekStartsOn: 0, estimateUnit: 'hours' });
    db.run('DELETE FROM tasks WHERE id = (SELECT MIN(id) FROM tasks)');
    db.run("UPDATE projects SET name = 'Changed', task_counter = 999");
    db.run('DELETE FROM boards WHERE project_id IS NOT NULL');
    db.run("UPDATE tasks SET rank = 'a0' WHERE id = (SELECT MAX(id) FROM tasks)");
    expect(comparable((await client.get<ExportDTO>('/api/data/export')).body)).not.toEqual(comparable(e1));

    const res = await client.post('/api/data/import', e1);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.counts).toEqual({
      statuses: e1.statuses.length,
      tags: e1.tags.length,
      projects: e1.projects.length,
      milestones: e1.milestones.length,
      epics: e1.epics.length,
      tasks: e1.tasks.length,
      comments: e1.comments.length,
      worklogs: e1.worklogs.length,
      activity: e1.activity.length,
      boards: e1.boards.length,
    });

    const e2 = (await client.get<ExportDTO>('/api/data/export')).body;
    expect(comparable(e2)).toEqual(comparable(e1));

    // The safety snapshot holds the state from just before the import.
    expect(res.body.backupFile).toMatch(/^backups\/pre-import-.*\.db$/);
    const snapshot = new DatabaseSync(path.join(config.dataDir, res.body.backupFile), { readOnly: true });
    try {
      expect(snapshot.prepare("SELECT COUNT(*) AS n FROM tags WHERE name = 'brand new'").get()).toEqual({ n: 1 });
    } finally {
      snapshot.close();
    }

    // The account and its session survived.
    expect((await client.get('/api/auth/me')).body.id).toBe(user.id);
    // Importing the same data again is stable.
    expect((await client.post('/api/data/import', e2)).status).toBe(200);
    expect(comparable((await client.get<ExportDTO>('/api/data/export')).body)).toEqual(comparable(e1));
    expect(backupsIn(config.dataDir)).toHaveLength(2);
  });

  it('keeps users, sessions and internal settings, and maps user references to the importer', async () => {
    const ctx = createTestContext();
    const { client, user } = await ctx.signedIn({ password: 'importer-pass' });
    const second = ctx.client();
    expect((await second.post('/api/auth/login', { username: 'owner', password: 'importer-pass' })).status).toBe(200);
    const sessionsBefore = ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sessions')!.n;

    const res = await client.post('/api/data/import', handExport());
    expect(res.status).toBe(200);
    expect(res.body.counts).toMatchObject({ tasks: 3, activity: 2, boards: 2, comments: 1 });

    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sessions')!.n).toBe(sessionsBefore);
    expect((await second.get('/api/auth/me')).status).toBe(200);
    expect(ctx.db.get("SELECT value FROM settings WHERE key = '_seeded'")).toBeDefined();
    expect(ctx.db.all<{ created_by: number | null }>('SELECT created_by FROM tasks ORDER BY id').map((r) => r.created_by)).toEqual([
      user.id,
      user.id,
      null,
    ]);
    expect(ctx.db.get<{ user_id: number }>('SELECT user_id FROM comments')!.user_id).toBe(user.id);
    // Comments and work logs without an author still get the importer: only the author may edit them.
    expect(ctx.db.get<{ user_id: number | null }>('SELECT user_id FROM work_logs')!.user_id).toBe(user.id);
    expect(ctx.db.all<{ user_id: number | null }>('SELECT user_id FROM activity ORDER BY id').map((r) => r.user_id)).toEqual([user.id, null]);
  });

  it('applies the import fix-ups: completedAt, counters, ranks, tags, boards, settings, dangling activity', async () => {
    const ctx = createTestContext();
    const { client } = await ctx.signedIn();
    const res = await client.post('/api/data/import', handExport());
    expect(res.status).toBe(200);
    const { db } = ctx;

    const task = (id: number) => db.get<{ completed_at: string | null; rank: string }>('SELECT * FROM tasks WHERE id = :id', { id })!;
    expect(task(100).completed_at).not.toBeNull(); // closed without completedAt → now
    expect(task(101).completed_at).toBeNull(); // open with completedAt → NULL
    expect(db.get<{ completed_at: string | null }>('SELECT completed_at FROM milestones WHERE id = 4')!.completed_at).not.toBeNull();
    expect(db.get<{ completed_at: string | null }>('SELECT completed_at FROM epics WHERE id = 6')!.completed_at).toBeNull();
    expect(db.get<{ task_counter: number }>('SELECT task_counter FROM projects WHERE id = 3')!.task_counter).toBe(7);
    expect(db.all<{ tag_id: number }>('SELECT tag_id FROM task_tags WHERE task_id = 100')).toEqual([{ tag_id: 5 }]);
    expect(db.get<{ color: string }>('SELECT color FROM tags WHERE id = 5')!.color).toBe('#ff0000');

    // Ranks regenerated, unique, in the exported (rank, id) order.
    const ranked = db.all<{ id: number; rank: string }>('SELECT id, rank FROM tasks ORDER BY rank, id');
    expect(ranked.map((r) => r.id)).toEqual([101, 102, 100]);
    expect(new Set(ranked.map((r) => r.rank)).size).toBe(3);

    // Board configs parsed leniently; project boards forced to their project.
    const projectBoard: BoardDTO = getBoard(db, 8);
    expect(projectBoard.config.filter.projectIds).toEqual([3]);
    expect(projectBoard.config.filter.priorities).toEqual([4]);
    expect(projectBoard.config.columns.groupBy).toBe('status');
    expect(getBoard(db, 9).config.columns.groupBy).toBe('status');

    const settings = (await client.get('/api/settings')).body;
    expect(settings).toEqual({ weekStartsOn: 0, estimateUnit: 'hours', defaultBoardId: null, homePage: 'default_board' });
    expect(db.all<{ id: number }>('SELECT id FROM activity ORDER BY id').map((a) => a.id)).toEqual([1, 4]);
    expect(db.all('PRAGMA foreign_key_check')).toEqual([]);

    // The app works on the imported data: refs and new ids continue after the imported ones.
    const boot = (await client.get('/api/bootstrap')).body;
    expect(boot.statuses.map((s: StatusDTO) => s.name)).toEqual(['Open', 'Shipped']);
    const tag = (await client.post<TagDTO>('/api/tags', { name: 'fresh' })).body;
    expect(tag.id).toBeGreaterThan(5);
    expect(buildExport(db).tasks.find((t) => t.id === 100)!.tagIds).toEqual([5]);
  });

  describe('rejections (400, nothing changed, no snapshot)', () => {
    async function expectRejected(payload: unknown, expectedPath?: string | RegExp) {
      const ctx = await sampleSetup();
      const before = comparable(buildExport(ctx.db));
      const res = await ctx.client.request('POST', '/api/data/import', typeof payload === 'string' ? payload : JSON.stringify(payload));
      expect(res.status).toBe(400);
      expect(typeof res.body.error.message).toBe('string');
      if (expectedPath !== undefined) {
        const paths: string[] = res.body.error.details.map((d: { path: string }) => d.path);
        expect(paths.some((p) => (typeof expectedPath === 'string' ? p === expectedPath : expectedPath.test(p)))).toBe(true);
      }
      expect(comparable(buildExport(ctx.db))).toEqual(before);
      expect(backupsIn(ctx.config.dataDir)).toEqual([]);
      return res.body.error;
    }

    const variant = (fn: (e: ExportInput) => void): ExportInput => {
      const e = handExport();
      fn(e);
      return e;
    };

    it('rejects malformed files', async () => {
      expect((await expectRejected('{oops')).message).toMatch(/not valid JSON/);
      expect((await expectRejected({ hello: 'world' }, 'format')).message).toMatch(/not a Lyren Plan export/);
      expect((await expectRejected({ ...handExport(), formatVersion: 2 }, 'formatVersion')).message).toMatch(/version 2/);
      await expectRejected(variant((e) => void ((e.tasks[0] as { title?: string }).title = '')), 'tasks.0.title');
      await expectRejected(variant((e) => (e.statuses = [])), 'statuses');
      await expectRejected(variant((e) => (e.projects[0]!.key = 'lower')), 'projects.0.key');
    });

    it('rejects referential problems with a list of them', async () => {
      await expectRejected(variant((e) => e.tags.push({ id: 5, name: 'dupe id', color: '#000000', createdAt: TS })), 'tags.1.id');
      await expectRejected(variant((e) => e.tags.push({ id: 6, name: 'URGENT', color: '#000000', createdAt: TS })), 'tags.1.name');
      await expectRejected(variant((e) => e.statuses.push({ id: 12, name: 'open', category: 'started', color: '#000000', position: 2 })), 'statuses.2.name');
      await expectRejected(variant((e) => (e.tasks[1]!.statusId = 99)), 'tasks.1.statusId');
      await expectRejected(variant((e) => (e.tasks[1]!.projectId = 99)), 'tasks.1.projectId');
      await expectRejected(variant((e) => (e.tasks[1]!.tagIds = [5, 77])), 'tasks.1.tagIds');
      await expectRejected(variant((e) => (e.tasks[1]!.number = 7)), 'tasks.1.number');
      await expectRejected(variant((e) => (e.milestones[0]!.projectId = 99)), 'milestones.0.projectId');
      await expectRejected(variant((e) => (e.comments[0]!.taskId = 99)), 'comments.0.taskId');
      await expectRejected(variant((e) => (e.worklogs[0]!.taskId = 99)), 'worklogs.0.taskId');
      await expectRejected(variant((e) => (e.boards[1]!.projectId = 99)), 'boards.1.projectId');
      await expectRejected(variant((e) => (e.epics[0]!.milestoneId = 99)), 'epics.0.milestoneId');

      // Epic / milestone in another project.
      const crossProject = variant((e) => {
        e.projects.push({ ...e.projects[0]!, id: 13, key: 'CD', position: 1 });
        e.epics.push({ ...e.epics[0]!, id: 7, projectId: 13, milestoneId: 4 });
        e.tasks[1]!.epicId = 7;
      });
      const err = await expectRejected(crossProject, 'epics.1.milestoneId');
      expect(err.details.map((d: { path: string }) => d.path)).toEqual(['epics.1.milestoneId', 'tasks.1.epicId']);
    });

    it('caps the problem list', async () => {
      const many = variant((e) => {
        for (let i = 0; i < 80; i++) e.comments.push({ ...e.comments[0]!, id: 1000 + i, taskId: 5000 + i });
      });
      const err = await expectRejected(many, /^comments\./);
      expect(err.details).toHaveLength(51);
      expect(err.details[50].message).toMatch(/30 more/);
      expect(err.message).toMatch(/80 problems/);
    });
  });

  it('accepts files above the normal body limit up to the import limit', async () => {
    const big = await sampleSetup({ bodyLimit: 1024 });
    const e = (await big.client.get<ExportDTO>('/api/data/export')).body;
    expect(JSON.stringify(e).length).toBeGreaterThan(1024);
    expect((await big.client.post('/api/data/import', e)).status).toBe(200);

    const small = await sampleSetup({ importBodyLimit: 1024 });
    const res = await small.client.post('/api/data/import', e);
    expect(res.status).toBe(413);
    expect(backupsIn(small.config.dataDir)).toEqual([]);
  });

  it('requires a session and the CSRF header', async () => {
    const ctx = await sampleSetup();
    const anon = await ctx.app.request('/api/data/import', {
      method: 'POST',
      headers: { [CSRF_HEADER]: '1', 'Content-Type': 'application/json' },
      body: JSON.stringify(handExport()),
    });
    expect(anon.status).toBe(401);
    const noCsrf = await ctx.client.request('POST', '/api/data/import', handExport(), { [CSRF_HEADER]: '' });
    expect(noCsrf.status).toBe(403);
  });
});

describe('POST /api/data/import: values the API relies on later', () => {
  async function setupWithTask() {
    const ctx = createTestContext();
    const { client, user } = await ctx.signedIn();
    expect((await client.post('/api/data/import', handExport())).status).toBe(200);
    return { ...ctx, client, user };
  }

  it('rejects start dates after due dates (tasks, milestones, epics) and empty work logs', async () => {
    const ctx = createTestContext();
    const { client } = await ctx.signedIn();
    const e = handExport();
    e.tasks[0]!.startDate = '2026-05-10';
    e.tasks[0]!.dueDate = '2026-05-01';
    e.milestones[0]!.startDate = '2026-06-02';
    e.milestones[0]!.dueDate = '2026-06-01';
    e.epics[0]!.startDate = '2026-07-02';
    e.epics[0]!.dueDate = '2026-07-01';
    e.worklogs.push({ id: 77, taskId: 100, date: '2026-05-01', minutes: 0, note: '  ', authorId: null, createdAt: TS, updatedAt: TS });
    e.worklogs.push({ id: 78, taskId: 100, date: '2026-05-01', minutes: null, note: '', authorId: 1, createdAt: TS, updatedAt: TS });
    const res = await client.post('/api/data/import', e);
    expect(res.status).toBe(400);
    expect(res.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual(
      ['epics.0.dueDate', 'milestones.0.dueDate', 'tasks.0.dueDate', 'worklogs.1.note', 'worklogs.2.note'].sort(),
    );
    expect(backupsIn(ctx.config.dataDir)).toEqual([]);
    // Equal dates and time-only / note-only logs are fine.
    const ok = handExport();
    ok.tasks[0]!.startDate = '2026-05-01';
    ok.tasks[0]!.dueDate = '2026-05-01';
    ok.worklogs.push({ id: 79, taskId: 100, date: '2026-05-01', minutes: null, note: 'notes only', authorId: null, createdAt: TS, updatedAt: TS });
    expect((await client.post('/api/data/import', ok)).status).toBe(200);
  });

  it('imported comments and work logs without an author stay editable', async () => {
    const ctx = createTestContext();
    const { client, user } = await ctx.signedIn();
    const e = handExport();
    e.comments[0]!.authorId = null;
    expect((await client.post('/api/data/import', e)).status).toBe(200);
    expect((await client.patch('/api/comments/1', { body: 'edited' })).status).toBe(200);
    expect((await client.patch('/api/worklogs/1', { date: '2026-01-02' })).status).toBe(200);
    expect((await client.delete('/api/worklogs/1')).status).toBe(200);
    expect(ctx.db.get<{ user_id: number }>('SELECT user_id FROM comments WHERE id = 1')!.user_id).toBe(user.id);
  });

  it('rejects ids, numbers, counters and positions near 2^53', async () => {
    const ctx = createTestContext();
    const { client } = await ctx.signedIn();
    const huge = 2 ** 53 - 1;
    for (const [mutate, where] of [
      [(e: ExportInput) => (e.comments[0]!.id = huge), 'comments.0.id'],
      [(e: ExportInput) => (e.activity[0]!.id = huge), 'activity.0.id'],
      [(e: ExportInput) => (e.projects[0]!.taskCounter = huge), 'projects.0.taskCounter'],
      [(e: ExportInput) => (e.tasks[0]!.number = huge), 'tasks.0.number'],
      [(e: ExportInput) => (e.projects[0]!.position = huge), 'projects.0.position'],
      [(e: ExportInput) => (e.statuses[0]!.position = -huge), 'statuses.0.position'],
    ] as const) {
      const e = handExport();
      mutate(e);
      const res = await client.post('/api/data/import', e);
      expect(res.status, where).toBe(400);
      expect(res.body.error.details.map((d: { path: string }) => d.path), where).toContain(where);
    }
    const max = handExport();
    max.comments[0]!.id = IMPORT_INT_MAX;
    expect((await client.post('/api/data/import', max)).status).toBe(200);
    const added = await client.post<{ id: number }>('/api/tasks/100/comments', { body: 'after a big id' });
    expect(added.status).toBe(201);
    expect(added.body.id).toBe(IMPORT_INT_MAX + 1);
    expect((await client.get('/api/tasks/100/timeline')).status).toBe(200);
  });

  it('heals an AUTOINCREMENT counter that an older import pushed towards 2^53', async () => {
    const ctx = await setupWithTask();
    const { client, db } = ctx;
    const good = (await client.get<ExportDTO>('/api/data/export')).body;
    // What an import of comments[0].id = 2^53 - 1 left behind before ids were capped.
    db.run(
      "INSERT INTO comments (id, task_id, user_id, body, created_at, updated_at) VALUES (:id, 100, :u, 'x', :t, :t)",
      { id: Number.MAX_SAFE_INTEGER, u: ctx.user.id, t: TS },
    );
    db.run('UPDATE sqlite_sequence SET seq = 9007199254740993 WHERE name = :n', { n: 'activity' });
    expect((await client.post('/api/data/import', good)).status).toBe(200);
    expect(
      db.all<{ name: string; ok: number }>('SELECT name, seq < 1000000 AS ok FROM sqlite_sequence').every((r) => r.ok === 1),
    ).toBe(true);
    const added = await client.post<{ id: number }>('/api/tasks/100/comments', { body: 'works again' });
    expect(added.status).toBe(201);
    expect(added.body.id).toBe(Math.max(...good.comments.map((cm) => cm.id)) + 1);
    expect((await client.get('/api/tasks/100/timeline')).status).toBe(200);
    expect((await client.get('/api/activity')).status).toBe(200);
    expect((await client.get('/api/data/export')).status).toBe(200);
  });

  it('leaves normal counters alone: ids of deleted rows are still never reused', async () => {
    const ctx = await setupWithTask();
    const { client } = ctx;
    const good = (await client.get<ExportDTO>('/api/data/export')).body;
    const first = await client.post<{ id: number }>('/api/tasks/100/comments', { body: 'later deleted' });
    expect((await client.post('/api/data/import', good)).status).toBe(200);
    const next = await client.post<{ id: number }>('/api/tasks/100/comments', { body: 'new' });
    expect(next.body.id).toBeGreaterThan(first.body.id);
  });

  it('the app\'s own export always imports: long ranks and tasks with more than 100 tags', async () => {
    const ctx = await setupWithTask();
    const { client, db } = ctx;
    const tagIds: number[] = [];
    for (let i = 0; i < 120; i++) tagIds.push((await client.post<TagDTO>('/api/tags', { name: `t${i}` })).body.id);
    expect((await client.patch('/api/tasks/100', { tagIds: tagIds.slice(0, 100) })).status).toBe(200);
    expect((await client.patch('/api/tasks/100', { addTagIds: tagIds.slice(100) })).status).toBe(200);
    // A rank left over from before ranks were kept short.
    db.run('UPDATE tasks SET rank = :rank WHERE id = 101', { rank: 'a' + '1'.repeat(400) });
    const e = (await client.get<ExportDTO>('/api/data/export')).body;
    expect(e.tasks.find((t) => t.id === 100)!.tagIds).toHaveLength(120);
    expect(exportSchema.safeParse(e).success).toBe(true);
    expect((await client.post('/api/data/import', e)).status).toBe(200);
    expect(buildExport(db).tasks.find((t) => t.id === 100)!.tagIds).toHaveLength(120);
  });

  it('rejects activity data that does not match ActivityData', async () => {
    const ctx = createTestContext();
    const { client } = await ctx.signedIn();
    const bad = (data: Record<string, unknown>) => {
      const e = handExport();
      e.activity.push({ id: 90, action: 'task.updated', entityType: 'task', entityId: 100, projectId: 3, taskId: 100, data, actorId: 1, createdAt: TS });
      return e;
    };
    for (const [data, where] of [
      [{ changes: [{ field: 'tags', added: 'notarray', removed: 5 }] }, /^activity\.4\.data\.changes\.0\.(added|removed)$/],
      [{ changes: [{ field: 'status', fromLabel: { x: 1 } }] }, /^activity\.4\.data\.changes\.0\.fromLabel$/],
      [{ changes: 'nope' }, /^activity\.4\.data\.changes$/],
      [{ title: { evil: true } }, /^activity\.4\.data\.title$/],
      [{ excerpt: ['a'] }, /^activity\.4\.data\.excerpt$/],
    ] as const) {
      const res = await client.post('/api/data/import', bad(data));
      expect(res.status, JSON.stringify(data)).toBe(400);
      expect(res.body.error.details.some((d: { path: string }) => where.test(d.path)), JSON.stringify(res.body.error.details)).toBe(true);
    }
    // Well-formed data with extra keys is fine.
    const ok = bad({ changes: [{ field: 'tags', added: ['a'], removed: [] }, { field: 'status', from: 1, to: 2, fromLabel: 'A', toLabel: null }], title: 'T', extra: { any: 1 } });
    expect((await client.post('/api/data/import', ok)).status).toBe(200);
  });

  it('repairs malformed stored activity data when reading and exporting it', async () => {
    const ctx = await setupWithTask();
    const { client, db } = ctx;
    db.run(
      `INSERT INTO activity (user_id, project_id, task_id, entity_type, entity_id, action, data, created_at)
       VALUES (NULL, 3, 100, 'task', 100, 'task.updated', :data, :t)`,
      {
        data: JSON.stringify({
          changes: [{ field: 'tags', added: 'notarray', removed: 5 }, { field: 'priority', from: 1, to: 2 }, 7],
          title: { evil: true },
          ref: 'AB-7',
        }),
        t: TS,
      },
    );
    const feed = await client.get<{ items: Array<{ data: Record<string, unknown> }> }>('/api/activity?taskId=100&limit=1');
    expect(feed.status).toBe(200);
    expect(feed.body.items[0]!.data).toEqual({ changes: [{ field: 'priority', from: 1, to: 2 }], ref: 'AB-7' });
    const e = (await client.get<ExportDTO>('/api/data/export')).body;
    expect(exportSchema.safeParse(e).success).toBe(true);
    expect((await client.post('/api/data/import', e)).status).toBe(200);
  });
});
