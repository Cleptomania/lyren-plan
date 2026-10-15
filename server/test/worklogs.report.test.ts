import { describe, expect, it } from 'vitest';
import { addDays } from '@shared/dates';
import type { WorklogReportDTO } from '@shared/types';
import { serverToday } from '../src/services/sql';
import { insertProject } from './services.fixtures';
import { insertWorklog, secondUser, setupTimeline } from './timeline.fixtures';

const TODAY = '2026-10-13';

async function reportContext() {
  const ctx = await setupTimeline();
  const log = (date: string, minutes: number | null, opts: { taskId?: number; note?: string; createdAt?: string } = {}) =>
    insertWorklog(ctx.db, {
      taskId: opts.taskId ?? ctx.taskId,
      userId: ctx.user.id,
      date,
      minutes,
      note: opts.note ?? (minutes === null ? 'note only' : ''),
      createdAt: opts.createdAt,
    });
  return { ...ctx, log };
}

const ids = (body: WorklogReportDTO) => body.items.map((i) => i.id);

describe('GET /api/worklogs', () => {
  it('defaults to the 30 days ending at ?today= (inclusive)', async () => {
    const ctx = await reportContext();
    const tooOld = ctx.log(addDays(TODAY, -30), 10);
    const first = ctx.log(addDays(TODAY, -29), 20);
    const last = ctx.log(TODAY, 30);
    const future = ctx.log(addDays(TODAY, 1), 40);
    const res = await ctx.client.get<WorklogReportDTO>(`/api/worklogs?today=${TODAY}`);
    expect(res.status).toBe(200);
    expect(ids(res.body)).toEqual([last, first]);
    expect(ids(res.body)).not.toContain(tooOld);
    expect(ids(res.body)).not.toContain(future);
    expect(res.body.totalMinutes).toBe(50);
  });

  it("falls back to the server's UTC date without ?today=", async () => {
    const ctx = await reportContext();
    const today = serverToday();
    const inRange = ctx.log(today, 5);
    ctx.log(addDays(today, -30), 5);
    const res = await ctx.client.get<WorklogReportDTO>('/api/worklogs');
    expect(ids(res.body)).toEqual([inRange]);
  });

  it('treats from/to as an inclusive range', async () => {
    const ctx = await reportContext();
    ctx.log('2026-09-30', 1);
    const a = ctx.log('2026-10-01', 2);
    const b = ctx.log('2026-10-07', 3);
    ctx.log('2026-10-08', 4);
    const res = await ctx.client.get<WorklogReportDTO>(`/api/worklogs?from=2026-10-01&to=2026-10-07&today=${TODAY}`);
    expect(ids(res.body)).toEqual([b, a]);
    expect(res.body.totalMinutes).toBe(5);
    const single = await ctx.client.get<WorklogReportDTO>('/api/worklogs?from=2026-10-07&to=2026-10-07');
    expect(ids(single.body)).toEqual([b]);
  });

  it('defaults a missing bound: from = to − 29 days, to = today', async () => {
    const ctx = await reportContext();
    const old = ctx.log('2026-01-15', 1);
    const recent = ctx.log(TODAY, 2);
    const onlyTo = await ctx.client.get<WorklogReportDTO>(`/api/worklogs?to=2026-01-20&today=${TODAY}`);
    expect(ids(onlyTo.body)).toEqual([old]);
    const onlyFrom = await ctx.client.get<WorklogReportDTO>(`/api/worklogs?from=2026-01-01&today=${TODAY}`);
    expect(ids(onlyFrom.body)).toEqual([recent, old]);
  });

  it('orders by date (newest first), then by creation (newest first)', async () => {
    const ctx = await reportContext();
    const older = ctx.log('2026-10-10', 10, { createdAt: '2026-10-10T09:00:00.000Z' });
    const newer = ctx.log('2026-10-10', 10, { createdAt: '2026-10-10T18:00:00.000Z' });
    const loggedLate = ctx.log('2026-10-09', 10, { createdAt: '2026-10-12T08:00:00.000Z' });
    const latest = ctx.log('2026-10-11', 10, { createdAt: '2026-10-11T08:00:00.000Z' });
    const res = await ctx.client.get<WorklogReportDTO>(`/api/worklogs?today=${TODAY}`);
    expect(ids(res.body)).toEqual([latest, newer, older, loggedLate]);
  });

  it('embeds the task (current ref/title/project) and the author', async () => {
    const ctx = await reportContext();
    const guest = secondUser(ctx, 'Robin');
    insertWorklog(ctx.db, { taskId: ctx.taskId, userId: guest.userId, date: TODAY, minutes: 15, note: 'Pairing' });
    ctx.db.run("UPDATE tasks SET title = 'Renamed' WHERE id = :id", { id: ctx.taskId });
    const res = await ctx.client.get<WorklogReportDTO>(`/api/worklogs?today=${TODAY}`);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({
      taskId: ctx.taskId,
      date: TODAY,
      minutes: 15,
      note: 'Pairing',
      author: { id: guest.userId, displayName: 'Robin' },
      task: { id: ctx.taskId, ref: 'WEB-1', title: 'Renamed', projectId: ctx.projectId },
    });
  });

  it('filters by project (unknown project = no entries) and counts null minutes as 0', async () => {
    const ctx = await reportContext();
    const meTask = ctx.addTask({ projectId: ctx.otherProjectId, title: 'Groceries' });
    const web = ctx.log(TODAY, 30);
    const webNote = ctx.log(TODAY, null);
    const me = ctx.log(TODAY, 45, { taskId: meTask });
    const all = await ctx.client.get<WorklogReportDTO>(`/api/worklogs?today=${TODAY}`);
    expect(new Set(ids(all.body))).toEqual(new Set([web, webNote, me]));
    expect(all.body.totalMinutes).toBe(75);
    const onlyMe = await ctx.client.get<WorklogReportDTO>(`/api/worklogs?today=${TODAY}&projectId=${ctx.otherProjectId}`);
    expect(ids(onlyMe.body)).toEqual([me]);
    expect(onlyMe.body.items[0]!.task).toEqual({ id: meTask, ref: 'ME-1', title: 'Groceries', projectId: ctx.otherProjectId });
    expect(onlyMe.body.totalMinutes).toBe(45);
    const onlyWeb = await ctx.client.get<WorklogReportDTO>(`/api/worklogs?today=${TODAY}&projectId=${ctx.projectId}`);
    expect(onlyWeb.body.totalMinutes).toBe(30);
    const unknown = await ctx.client.get<WorklogReportDTO>(`/api/worklogs?today=${TODAY}&projectId=9999`);
    expect(unknown.status).toBe(200);
    expect(unknown.body).toEqual({ items: [], totalMinutes: 0 });
  });

  it('includes archived tasks and archived projects', async () => {
    const ctx = await reportContext();
    const archivedProject = insertProject(ctx.db, 'OLD', { status: 'archived' });
    const t1 = ctx.addTask({ projectId: archivedProject });
    const t2 = ctx.addTask({ archivedAt: '2026-10-01T00:00:00.000Z' });
    ctx.log(TODAY, 10, { taskId: t1 });
    ctx.log(TODAY, 10, { taskId: t2 });
    const res = await ctx.client.get<WorklogReportDTO>(`/api/worklogs?today=${TODAY}`);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.totalMinutes).toBe(20);
  });

  it('returns an empty report when nothing was logged', async () => {
    const ctx = await reportContext();
    const res = await ctx.client.get<WorklogReportDTO>(`/api/worklogs?today=${TODAY}`);
    expect(res.body).toEqual({ items: [], totalMinutes: 0 });
  });

  it.each([
    ['today=2026-02-30', 'query.today'],
    ['from=yesterday', 'query.from'],
    ['to=2026-1-5', 'query.to'],
    ['projectId=abc', 'query.projectId'],
    ['projectId=0', 'query.projectId'],
  ])('rejects %s with 400 (%s)', async (query, path) => {
    const ctx = await reportContext();
    const res = await ctx.client.get(`/api/worklogs?${query}`);
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].path).toBe(path);
  });

  it('rejects an inverted range with 400', async () => {
    const ctx = await reportContext();
    const res = await ctx.client.get('/api/worklogs?from=2026-10-10&to=2026-10-01');
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].path).toBe('query.from');
  });

  it('requires a session', async () => {
    const ctx = await reportContext();
    expect((await ctx.newClient().get('/api/worklogs')).status).toBe(401);
  });
});
