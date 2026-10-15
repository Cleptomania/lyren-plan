import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@shared/schemas';
import type { BootstrapDTO } from '@shared/types';
import { insertEpic, insertMilestone, insertProject, insertTag, insertTask, statusIdByName } from './services.fixtures';
import { createTestContext } from './helpers';

describe('GET /api/bootstrap', () => {
  it('requires a session', async () => {
    const ctx = createTestContext();
    await ctx.signedIn();
    expect((await ctx.client().get('/api/bootstrap')).status).toBe(401);
  });

  it('returns the lookup lists of a fresh install', async () => {
    const ctx = createTestContext();
    const { client, user } = await ctx.signedIn();
    const res = await client.get<BootstrapDTO>('/api/bootstrap');
    expect(res.status).toBe(200);
    const b = res.body;
    expect(b.user).toEqual(user);
    expect(typeof b.version).toBe('string');
    expect(b.settings).toEqual({ ...DEFAULT_SETTINGS, defaultBoardId: b.boards[0]!.id });
    expect(b.statuses.map((s) => s.name)).toEqual(['Backlog', 'Todo', 'In Progress', 'In Review', 'Done', 'Cancelled']);
    expect(b.statuses[0]).toEqual({ id: b.statuses[0]!.id, name: 'Backlog', category: 'backlog', color: '#94a3b8', position: 0, taskCount: 0 });
    expect(b.tags).toEqual([]);
    expect(b.projects).toEqual([]);
    expect(b.milestones).toEqual([]);
    expect(b.epics).toEqual([]);
    expect(b.boards).toHaveLength(1);
    expect(b.boards[0]).toMatchObject({ name: 'All tasks', projectId: null, position: 0 });
    expect(b.boards[0]!.config.columns.groupBy).toBe('status');
  });

  it('includes entities with stats and honours ?today= for overdue counts', async () => {
    const ctx = createTestContext();
    const { client } = await ctx.signedIn();
    const db = ctx.db;
    const p = insertProject(db, 'WEB', { name: 'Website' });
    insertProject(db, 'OLD', { status: 'archived' });
    const m = insertMilestone(db, p, { name: 'MVP' });
    const e = insertEpic(db, p, { milestoneId: m, name: 'Design' });
    const tag = insertTag(db, 'bug');
    insertTask(db, { projectId: p, epicId: e, dueDate: '2026-05-10', tagIds: [tag], estimate: 2 });
    insertTask(db, { projectId: p, statusId: statusIdByName(db, 'Done'), dueDate: '2026-05-01' });

    const early = (await client.get<BootstrapDTO>('/api/bootstrap?today=2026-05-05')).body;
    const late = (await client.get<BootstrapDTO>('/api/bootstrap?today=2026-05-20')).body;
    expect(early.projects.map((x) => x.key)).toEqual(['WEB', 'OLD']);
    expect(early.projects[0]!.stats).toMatchObject({ tasksTotal: 2, tasksOpen: 1, tasksClosed: 1, tasksOverdue: 0, milestonesTotal: 1, epicsTotal: 1 });
    expect(late.projects[0]!.stats.tasksOverdue).toBe(1);
    expect(early.milestones[0]).toMatchObject({ name: 'MVP', projectId: p, stats: { tasksTotal: 1, estimateTotal: 2, epicsTotal: 1 } });
    expect(early.epics[0]).toMatchObject({ name: 'Design', milestoneId: m, stats: { tasksTotal: 1, tasksClosed: 0 } });
    expect(early.tags).toEqual([{ id: tag, name: 'bug', color: '#64748b', taskCount: 1, createdAt: expect.any(String) }]);
    expect(early.statuses.find((s) => s.name === 'Done')!.taskCount).toBe(1);
  });

  it('rejects an invalid ?today=', async () => {
    const ctx = createTestContext();
    const { client } = await ctx.signedIn();
    const res = await client.get('/api/bootstrap?today=2026-02-30');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
    expect(res.body.error.details[0].path).toBe('query.today');
  });
});
