// The activity services (services/activity.ts) on any Db (design §14.4): run on NodeDb by
// server/test/services.activity.test.ts and on DoDb in workerd by server/test-workers/services.test.ts.

import { describe, expect, it } from 'vitest';
import {
  commentExcerpt,
  epicChanges,
  listActivity,
  milestoneChanges,
  projectChanges,
  recordActivity,
  setChange,
  taskActivity,
  taskChanges,
  valueChange,
} from '../../src/services/activity';
import type { EpicRow, MilestoneRow, ProjectRow } from '../../src/services/rows';
import {
  insertEpic,
  insertMilestone,
  insertProject,
  insertTask,
  statusIdByName,
  taskRow,
  type SpaceDb,
  type WithSpaceDb,
} from './fixtures';

function world({ db, userId }: SpaceDb) {
  const p1 = insertProject(db, 'ONE');
  const p2 = insertProject(db, 'TWO');
  const task = insertTask(db, { projectId: p1, title: 'First' });
  return { db, userId, p1, p2, task };
}

export function defineActivityContract(kind: string, withSpaceDb: WithSpaceDb): void {
  describe(`activity feed (${kind})`, () => {
    it('pages newest first with a nextBefore cursor', () =>
      withSpaceDb((space) => {
        const { db, userId, p1, task } = world(space);
        const ids = Array.from({ length: 7 }, (_, i) =>
          recordActivity(db, {
            userId,
            projectId: p1,
            taskId: task,
            entityType: 'task',
            entityId: task,
            action: 'task.updated',
            data: { title: `v${i}` },
          }),
        );
        const page1 = listActivity(db, { limit: 3 });
        expect(page1.items.map((a) => a.id)).toEqual([ids[6], ids[5], ids[4]]);
        expect(page1.nextBefore).toBe(ids[4]);
        const page2 = listActivity(db, { limit: 3, before: page1.nextBefore! });
        expect(page2.items.map((a) => a.id)).toEqual([ids[3], ids[2], ids[1]]);
        const page3 = listActivity(db, { limit: 3, before: page2.nextBefore! });
        expect(page3.items.map((a) => a.id)).toEqual([ids[0]]);
        expect(page3.nextBefore).toBeNull();
        // An exact multiple of the page size ends with nextBefore null.
        const exact = listActivity(db, { limit: 3, before: ids[3] });
        expect(exact.items).toHaveLength(3);
        expect(exact.nextBefore).toBeNull();
        expect(listActivity(db).items).toHaveLength(7);
        expect(listActivity(db, { limit: 0 }).items).toHaveLength(1);
      }));

    it('filters by project and task and hydrates actor + current task ref', () =>
      withSpaceDb((space) => {
        const { db, userId, p1, p2, task } = world(space);
        recordActivity(db, { userId, projectId: p1, taskId: task, entityType: 'task', entityId: task, action: 'task.created', data: { title: 'First', ref: 'ONE-1' } });
        recordActivity(db, { userId, projectId: p1, taskId: task, entityType: 'comment', entityId: 1, action: 'comment.created', data: { excerpt: 'hi' } });
        recordActivity(db, { userId: null, projectId: p2, taskId: null, entityType: 'project', entityId: p2, action: 'project.created', data: { name: 'Two' } });
        recordActivity(db, { userId, projectId: null, taskId: null, entityType: 'project', entityId: 99, action: 'project.deleted', data: { name: 'Gone', key: 'GO' } });

        expect(listActivity(db, { projectId: p2 }).items.map((a) => a.action)).toEqual(['project.created']);
        expect(listActivity(db, { taskId: task }).items.map((a) => a.action)).toEqual(['comment.created', 'task.created']);

        db.run("UPDATE projects SET key = 'NEW' WHERE id = :p1", { p1 });
        db.run("UPDATE tasks SET title = 'Renamed', title_fold = 'renamed' WHERE id = :task", { task });
        const [deleted, created2, comment, created1] = listActivity(db).items;
        expect(created1).toMatchObject({
          action: 'task.created',
          entityType: 'task',
          entityId: task,
          projectId: p1,
          taskId: task,
          data: { title: 'First', ref: 'ONE-1' },
          actor: { id: userId, displayName: 'Owner' },
          task: { id: task, ref: 'NEW-1', title: 'Renamed' },
        });
        expect(comment!.task).toEqual({ id: task, ref: 'NEW-1', title: 'Renamed' });
        expect(created2).toMatchObject({ actor: null, task: null, taskId: null });
        expect(deleted).toMatchObject({ projectId: null, data: { name: 'Gone', key: 'GO' } });
        expect(typeof deleted!.createdAt).toBe('string');
      }));

    it('tolerates corrupt data JSON', () =>
      withSpaceDb((space) => {
        const { db, userId, p1 } = world(space);
        const id = recordActivity(db, { userId, projectId: p1, taskId: null, entityType: 'project', entityId: p1, action: 'project.updated' });
        db.run("UPDATE activity SET data = '[1,2' WHERE id = :id", { id });
        expect(listActivity(db).items[0]!.data).toEqual({});
      }));

    it('taskActivity returns only task entries, oldest first', () =>
      withSpaceDb((space) => {
        const { db, userId, p1, task } = world(space);
        const base = { userId, projectId: p1, taskId: task } as const;
        const a = recordActivity(db, { ...base, entityType: 'task', entityId: task, action: 'task.created' });
        recordActivity(db, { ...base, entityType: 'comment', entityId: 3, action: 'comment.created' });
        const b = recordActivity(db, { ...base, entityType: 'task', entityId: task, action: 'task.updated' });
        recordActivity(db, { ...base, entityType: 'worklog', entityId: 4, action: 'worklog.created' });
        expect(taskActivity(db, task).map((x) => x.id)).toEqual([a, b]);
      }));
  });

  describe(`field change helpers (${kind})`, () => {
    it('builds generic changes', () => {
      expect(valueChange('title', 'a', 'a')).toBeNull();
      expect(valueChange('dueDate', null, '2026-01-02')).toEqual({ field: 'dueDate', from: null, to: '2026-01-02' });
      expect(valueChange('status', 1, 2, { from: 'Todo', to: 'Done' })).toEqual({
        field: 'status', from: 1, to: 2, fromLabel: 'Todo', toLabel: 'Done',
      });
      expect(setChange('tags', [{ id: 1, name: 'b' }], [{ id: 1, name: 'b' }])).toBeNull();
      expect(
        setChange('tags', [{ id: 1, name: 'b' }, { id: 2, name: 'Z' }], [{ id: 3, name: 'c' }, { id: 4, name: 'A' }, { id: 1, name: 'b' }]),
      ).toEqual({ field: 'tags', added: ['A', 'c'], removed: ['Z'] });
      expect(commentExcerpt('x'.repeat(250))).toHaveLength(200);
    });

    it('diffs tasks with labels, in spec order, and nothing for a no-op', () =>
      withSpaceDb((space) => {
        const { db, p1, task } = world(space);
        const epicA = insertEpic(db, p1, { name: 'Epic A' });
        const before = taskRow(db, task);
        expect(taskChanges(db, before, { ...before })).toEqual([]);
        const after = {
          ...before,
          title: 'Second',
          description: 'new text',
          status_id: statusIdByName(db, 'Done'),
          priority: 4 as const,
          epic_id: epicA,
          due_date: '2026-05-01',
          estimate: 3,
          archived_at: '2026-04-01T00:00:00.000Z',
        };
        const changes = taskChanges(db, before, after, {
          before: [{ id: 1, name: 'bug' }],
          after: [{ id: 2, name: 'idea' }],
        });
        expect(changes).toEqual([
          { field: 'title', from: 'First', to: 'Second' },
          { field: 'description' },
          { field: 'status', from: before.status_id, to: after.status_id, fromLabel: 'Todo', toLabel: 'Done' },
          { field: 'priority', from: 0, to: 4, fromLabel: 'No priority', toLabel: 'Urgent' },
          { field: 'epic', from: null, to: epicA, fromLabel: null, toLabel: 'Epic A' },
          { field: 'dueDate', from: null, to: '2026-05-01' },
          { field: 'estimate', from: null, to: 3 },
          { field: 'tags', added: ['idea'], removed: ['bug'] },
          { field: 'archived', from: false, to: true },
        ]);
      }));

    it('diffs projects, milestones and epics', () =>
      withSpaceDb((space) => {
        const { db, p1 } = world(space);
        const project = db.get<ProjectRow>('SELECT * FROM projects WHERE id = :p1', { p1 })!;
        expect(projectChanges(project, { ...project, key: 'UNO', status: 'on_hold', color: '#000000' })).toEqual([
          { field: 'key', from: 'ONE', to: 'UNO' },
          { field: 'status', from: 'active', to: 'on_hold', fromLabel: 'Active', toLabel: 'On hold' },
          { field: 'color' },
        ]);
        const m1 = insertMilestone(db, p1, { name: 'M1' });
        const milestone = db.get<MilestoneRow>('SELECT * FROM milestones WHERE id = :m1', { m1 })!;
        expect(milestoneChanges(milestone, { ...milestone, status: 'completed', start_date: '2026-01-01' })).toEqual([
          { field: 'status', from: 'planned', to: 'completed', fromLabel: 'Planned', toLabel: 'Completed' },
          { field: 'startDate', from: null, to: '2026-01-01' },
        ]);
        const e = insertEpic(db, p1, { name: 'E', milestoneId: m1 });
        const epic = db.get<EpicRow>('SELECT * FROM epics WHERE id = :e', { e })!;
        expect(epicChanges(db, epic, { ...epic, name: 'E2', milestone_id: null, description: 'x' })).toEqual([
          { field: 'name', from: 'E', to: 'E2' },
          { field: 'milestone', from: m1, to: null, fromLabel: 'M1', toLabel: null },
          { field: 'description' },
        ]);
      }));
  });
}
