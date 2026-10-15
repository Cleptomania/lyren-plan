import { describe, expect, it } from 'vitest';
import { addDays } from '@shared/dates';
import type { BootstrapDTO } from '@shared/types';
import { createSampleData } from '../src/db/seed';
import { listActivity } from '../src/services/activity';
import { findTaskByRef, queryTasks } from '../src/services/tasks';
import { createTestContext } from './helpers';

let today = '';

async function setup() {
  const ctx = createTestContext();
  today = new Date().toISOString().slice(0, 10);
  const { client, user } = await ctx.signedIn({ createSampleData: true });
  const boot = (await client.get<BootstrapDTO>(`/api/bootstrap?today=${today}`)).body;
  return { ctx, client, user, boot };
}

describe('sample data', () => {
  it('creates the WEB and ME projects with milestones, epics, tags and boards', async () => {
    const { boot } = await setup();
    const web = boot.projects.find((p) => p.key === 'WEB')!;
    const me = boot.projects.find((p) => p.key === 'ME')!;
    expect(web).toMatchObject({ name: 'Website Relaunch', status: 'active' });
    expect(me).toMatchObject({ name: 'Personal', status: 'active' });
    expect(web.stats.tasksTotal).toBeGreaterThanOrEqual(14);
    expect(web.stats.tasksOverdue).toBeGreaterThan(0);
    expect(me.stats.tasksTotal).toBe(4);

    const milestones = boot.milestones.filter((m) => m.projectId === web.id);
    expect(milestones.map((m) => [m.name, m.status, m.dueDate])).toEqual([
      ['MVP launch', 'active', addDays(today, 21)],
      ['Post-launch polish', 'planned', addDays(today, 60)],
    ]);
    const epics = boot.epics.filter((e) => e.projectId === web.id);
    const mvp = milestones[0]!.id;
    const polish = milestones[1]!.id;
    expect(epics.map((e) => [e.name, e.milestoneId])).toEqual([
      ['Design system', mvp],
      ['Content migration', mvp],
      ['Performance', polish],
      ['Analytics', null],
    ]);
    expect(milestones[0]!.stats.tasksTotal).toBeGreaterThan(0);
    expect(boot.tags.map((t) => t.name)).toEqual(['blocked', 'bug', 'idea', 'quick win']);
    expect(boot.epics.some((e) => e.projectId === me.id)).toBe(false);

    const webBoard = boot.boards.find((b) => b.name === 'WEB board')!;
    expect(webBoard.projectId).toBe(web.id);
    expect(webBoard.config.filter.projectIds).toEqual([web.id]);
    expect(webBoard.config.columns.groupBy).toBe('status');
    expect(webBoard.config.swimlanes.groupBy).toBe('epic');
    const triage = boot.boards.find((b) => b.name === 'Priority triage')!;
    expect(triage.projectId).toBeNull();
    expect(triage.config.columns.groupBy).toBe('priority');
    expect(triage.config.swimlanes.groupBy).toBe('project');
    expect(triage.config.filter.closedWithinDays).toBe(7);
  });

  it('covers every status, priority and due-date situation', async () => {
    const { ctx, boot } = await setup();
    const all = queryTasks(ctx.db, { filter: { archived: 'include' }, today }).tasks;
    expect(all.length).toBeGreaterThanOrEqual(20);
    expect(new Set(all.map((t) => t.statusId))).toEqual(new Set(boot.statuses.map((s) => s.id)));
    expect(new Set(all.map((t) => t.priority))).toEqual(new Set([0, 1, 2, 3, 4]));
    const due = (preset: 'overdue' | 'today' | 'this_week') =>
      queryTasks(ctx.db, { filter: { due: [preset] }, today }).total;
    expect(due('overdue')).toBeGreaterThanOrEqual(2);
    expect(due('today')).toBeGreaterThanOrEqual(1);
    expect(due('this_week')).toBeGreaterThanOrEqual(1);
    expect(all.some((t) => t.archivedAt !== null)).toBe(true);
    expect(all.some((t) => t.commentCount > 0)).toBe(true);
    expect(all.some((t) => t.worklogMinutes > 0)).toBe(true);
    expect(all.some((t) => t.tags.length > 1)).toBe(true);
    // Closed tasks carry completedAt; open ones don't.
    const closed = new Set(boot.statuses.filter((s) => ['completed', 'cancelled'].includes(s.category)).map((s) => s.id));
    for (const t of all) expect(t.completedAt !== null).toBe(closed.has(t.statusId));
    // Ranks are unique; refs are numbered per project.
    expect(new Set(all.map((t) => t.rank)).size).toBe(all.length);
    expect(findTaskByRef(ctx.db, 'web-1')?.title).toBe('Define color tokens and typography scale');
    expect(findTaskByRef(ctx.db, 'ME-4')?.title).toBe('File tax return');
    const search = queryTasks(ctx.db, { filter: { search: 'safari' }, today });
    expect(search.tasks.map((t) => t.title)).toEqual(['Focus ring missing in Safari']);
  });

  it('writes chronological activity for every creation, and timestamps are not in the future', async () => {
    const { ctx, user } = await setup();
    const page = listActivity(ctx.db, { limit: 200 });
    const items = page.items;
    expect(items.length).toBeGreaterThan(30);
    expect(page.nextBefore).toBeNull();
    const created = [...items].reverse().map((a) => a.createdAt);
    expect(created).toEqual([...created].sort());
    const now = new Date().toISOString();
    expect(created.every((t) => t <= now)).toBe(true);
    const counts = (action: string) => items.filter((a) => a.action === action).length;
    expect(counts('project.created')).toBe(2);
    expect(counts('milestone.created')).toBe(2);
    expect(counts('epic.created')).toBe(4);
    expect(counts('task.created')).toBe(Number(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks')!.n));
    expect(counts('comment.created')).toBe(Number(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM comments')!.n));
    expect(counts('worklog.created')).toBe(Number(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM work_logs')!.n));
    for (const a of items) {
      expect(a.actor).toEqual({ id: user.id, displayName: 'Owner' });
      expect(a.projectId).not.toBeNull();
      if (['task', 'comment', 'worklog'].includes(a.entityType)) expect(a.task).not.toBeNull();
      else expect(a.taskId).toBeNull();
    }
    expect(ctx.db.all('PRAGMA foreign_key_check')).toEqual([]);
  });

  it('can run again on a non-empty database (keys made unique, tags reused)', async () => {
    const { ctx, user } = await setup();
    ctx.db.tx(() => createSampleData(ctx.db, user.id));
    const keys = ctx.db.all<{ key: string }>('SELECT key FROM projects ORDER BY id').map((r) => r.key);
    expect(keys).toEqual(['WEB', 'ME', 'WEB2', 'ME2']);
    expect(Number(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tags')!.n)).toBe(4);
    const ranks = ctx.db.get<{ n: number; d: number }>('SELECT COUNT(*) AS n, COUNT(DISTINCT rank) AS d FROM tasks')!;
    expect(ranks.d).toBe(ranks.n);
  });
});
