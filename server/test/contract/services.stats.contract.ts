// The statistics services (services/stats.ts and the DTO lists carrying them) on any Db (design §14.4): run on
// NodeDb by server/test/services.stats.test.ts and on DoDb in workerd by server/test-workers/services.test.ts.

import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/db';
import { getEpic, getMilestone, getProject, listEpics, listMilestones, listProjects, listStatuses, listTags } from '../../src/services/entities';
import { epicStats, milestoneStats, projectStats, statusTaskCounts, tagTaskCounts } from '../../src/services/stats';
import {
  insertEpic,
  insertMilestone,
  insertProject,
  insertTag,
  insertTask,
  statusIdByName,
  type WithSpaceDb,
} from './fixtures';

const ARCHIVED = '2026-02-01T00:00:00.000Z';

function world(db: Db) {
  const todo = statusIdByName(db, 'Todo');
  const doing = statusIdByName(db, 'In Progress');
  const done = statusIdByName(db, 'Done');
  const cancelled = statusIdByName(db, 'Cancelled');
  const p1 = insertProject(db, 'ONE');
  const p2 = insertProject(db, 'TWO');
  const empty = insertProject(db, 'NIL');
  const m1 = insertMilestone(db, p1, { status: 'completed' });
  const m2 = insertMilestone(db, p1);
  insertMilestone(db, p2, { status: 'cancelled' });
  const e1 = insertEpic(db, p1, { milestoneId: m1, status: 'done' });
  const e2 = insertEpic(db, p1, { milestoneId: m1 });
  const e3 = insertEpic(db, p1, { milestoneId: null, status: 'cancelled' });
  const bug = insertTag(db, 'bug');
  const idea = insertTag(db, 'idea');
  // p1
  insertTask(db, { projectId: p1, epicId: e1, statusId: done, estimate: 3, dueDate: '2026-03-01', tagIds: [bug] });
  insertTask(db, { projectId: p1, epicId: e1, statusId: todo, estimate: 2, dueDate: '2026-03-01', tagIds: [bug, idea] });
  insertTask(db, { projectId: p1, epicId: e2, statusId: cancelled, estimate: null, dueDate: '2026-02-01' });
  insertTask(db, { projectId: p1, epicId: e2, statusId: doing, estimate: 1.5, dueDate: '2026-03-10' });
  insertTask(db, { projectId: p1, epicId: e3, statusId: todo, dueDate: null });
  insertTask(db, { projectId: p1, epicId: e1, statusId: todo, estimate: 100, dueDate: '2026-01-01', archivedAt: ARCHIVED, tagIds: [bug] });
  // p2
  insertTask(db, { projectId: p2, statusId: doing, dueDate: '2026-02-28' });
  insertTask(db, { projectId: p2, statusId: done, archivedAt: ARCHIVED, tagIds: [idea] });
  return { db, p1, p2, empty, m1, m2, e1, e2, e3, bug, idea, todo, done, cancelled };
}

export function defineStatsContract(kind: string, withSpaceDb: WithSpaceDb): void {
  describe(`stats (${kind})`, () => {
    it('computes project stats (archived closed tasks count, archived open ones do not; overdue vs today)', () =>
      withSpaceDb(({ db }) => {
        const w = world(db);
        const stats = projectStats(w.db, '2026-03-05');
        expect(stats.get(w.p1)).toEqual({
          tasksTotal: 5,
          tasksOpen: 3,
          tasksClosed: 2,
          tasksOverdue: 1, // todo due 03-01 (done & cancelled ones don't count, archived excluded)
          milestonesTotal: 2,
          milestonesCompleted: 1,
          epicsTotal: 3,
          epicsDone: 1,
        });
        // p2's archived DONE task still counts as closed work.
        expect(stats.get(w.p2)).toMatchObject({
          tasksTotal: 2,
          tasksOpen: 1,
          tasksClosed: 1,
          tasksOverdue: 1,
          milestonesTotal: 1,
          milestonesCompleted: 0,
        });
        expect(stats.has(w.empty)).toBe(false);
        expect(projectStats(w.db, '2026-03-11').get(w.p1)!.tasksOverdue).toBe(2);
        expect([...projectStats(w.db, '2026-03-05', [w.p2]).keys()]).toEqual([w.p2]);
      }));

    it('computes milestone and epic progress through epics', () =>
      withSpaceDb(({ db }) => {
        const w = world(db);
        expect(milestoneStats(w.db).get(w.m1)).toEqual({
          tasksTotal: 4,
          tasksClosed: 2,
          estimateTotal: 6.5,
          estimateClosed: 3,
          epicsTotal: 2,
          epicsDone: 1,
        });
        expect(milestoneStats(w.db).has(w.m2)).toBe(false);
        expect(epicStats(w.db).get(w.e1)).toEqual({ tasksTotal: 2, tasksClosed: 1, estimateTotal: 5, estimateClosed: 3 });
        expect(epicStats(w.db).get(w.e2)).toEqual({ tasksTotal: 2, tasksClosed: 1, estimateTotal: 1.5, estimateClosed: 0 });
        expect(epicStats(w.db, [w.e3]).get(w.e3)).toEqual({ tasksTotal: 1, tasksClosed: 0, estimateTotal: 0, estimateClosed: 0 });
      }));

    it('archiving finished tasks never moves progress backwards; archiving open tasks drops them', () =>
      withSpaceDb(({ db }) => {
        const w = world(db);
        const before = { p: projectStats(w.db, '2026-03-05').get(w.p1)!, m: milestoneStats(w.db).get(w.m1)! };
        // Archive every task of e1 (the done one, the open one; the third is already archived and open).
        w.db.run('UPDATE tasks SET archived_at = :at WHERE epic_id = :e AND archived_at IS NULL', { at: ARCHIVED, e: w.e1 });
        const p = projectStats(w.db, '2026-03-05').get(w.p1)!;
        const m = milestoneStats(w.db).get(w.m1)!;
        const e = epicStats(w.db).get(w.e1)!;
        // The done task (estimate 3) still counts; the open one (estimate 2, due 03-01) is gone.
        expect(e).toEqual({ tasksTotal: 1, tasksClosed: 1, estimateTotal: 3, estimateClosed: 3 });
        expect(m).toMatchObject({
          tasksTotal: before.m.tasksTotal - 1,
          tasksClosed: before.m.tasksClosed,
          estimateClosed: before.m.estimateClosed,
        });
        expect(p).toMatchObject({
          tasksTotal: before.p.tasksTotal - 1,
          tasksClosed: before.p.tasksClosed,
          tasksOpen: before.p.tasksOpen - 1,
          tasksOverdue: before.p.tasksOverdue - 1,
        });
        // An archived task that is reopened (status no longer closed) stops counting.
        const todo = statusIdByName(w.db, 'Todo');
        w.db.run('UPDATE tasks SET status_id = :todo WHERE epic_id = :e', { todo, e: w.e1 });
        expect(epicStats(w.db).has(w.e1)).toBe(false);
      }));

    it('counts tasks per status (archived included) and per tag (archived excluded)', () =>
      withSpaceDb(({ db }) => {
        const w = world(db);
        const s = statusTaskCounts(w.db);
        expect(s.get(w.todo)).toBe(3);
        expect(s.get(w.done)).toBe(2);
        const t = tagTaskCounts(w.db);
        expect(t.get(w.bug)).toBe(2);
        expect(t.get(w.idea)).toBe(1);
      }));

    it('DTO lists and getters carry the stats (zeros when nothing matches)', () =>
      withSpaceDb(({ db }) => {
        const w = world(db);
        const projects = listProjects(w.db, '2026-03-05');
        expect(projects.map((p) => p.key)).toEqual(['ONE', 'TWO', 'NIL']);
        expect(projects[2]!.stats).toEqual({
          tasksTotal: 0, tasksOpen: 0, tasksClosed: 0, tasksOverdue: 0,
          milestonesTotal: 0, milestonesCompleted: 0, epicsTotal: 0, epicsDone: 0,
        });
        expect(getProject(w.db, w.p1, '2026-03-05').stats).toEqual(projects[0]!.stats);
        expect(getMilestone(w.db, w.m2).stats).toEqual({ tasksTotal: 0, tasksClosed: 0, estimateTotal: 0, estimateClosed: 0, epicsTotal: 0, epicsDone: 0 });
        expect(getMilestone(w.db, w.m1).stats.tasksTotal).toBe(4);
        expect(getEpic(w.db, w.e1).stats.tasksTotal).toBe(2);
        expect(listMilestones(w.db, w.p1).map((m) => m.id)).toEqual([w.m1, w.m2]);
        expect(listEpics(w.db, w.p1).map((e) => e.stats.tasksTotal)).toEqual([2, 2, 1]);
        expect(listStatuses(w.db).find((s) => s.id === w.todo)!.taskCount).toBe(3);
        expect(listTags(w.db).map((t) => [t.name, t.taskCount])).toEqual([['bug', 2], ['idea', 1]]);
      }));

    it('runs a constant number of queries regardless of the number of entities (no N+1)', async () => {
      const countQueries = (db: Db, fn: () => void): number => {
        let n = 0;
        const all = db.all.bind(db);
        const get = db.get.bind(db);
        db.all = ((sql, params) => (n++, all(sql, params))) as Db['all'];
        db.get = ((sql, params) => (n++, get(sql, params))) as Db['get'];
        try {
          fn();
        } finally {
          db.all = all;
          db.get = get;
        }
        return n;
      };
      const lists = [
        (db: Db) => listProjects(db, '2026-03-05'),
        (db: Db) => listMilestones(db),
        (db: Db) => listEpics(db),
        (db: Db) => listStatuses(db),
        (db: Db) => listTags(db),
      ];
      // Two spaces (a database each): the counts of the small one, then of the big one.
      const small = await withSpaceDb(({ db }) => {
        world(db);
        return lists.map((fn) => countQueries(db, () => fn(db)));
      });
      const big = await withSpaceDb(({ db }) => {
        world(db);
        for (let i = 0; i < 20; i++) {
          const p = insertProject(db, `X${i}`);
          const m = insertMilestone(db, p);
          const e = insertEpic(db, p, { milestoneId: m });
          insertTask(db, { projectId: p, epicId: e });
        }
        return lists.map((fn) => countQueries(db, () => fn(db)));
      });
      lists.forEach((_, i) => expect(big[i]).toBe(small[i]));
    });
  });
}
