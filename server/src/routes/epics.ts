// /api/epics — create/get/update/delete/reorder epics (SPEC §5.3, §7).

import { Hono } from 'hono';
import { z } from 'zod';
import { DEFAULT_EPIC_COLOR } from '@shared/constants';
import { epicCreateInput, epicUpdateInput, reorderInput } from '@shared/schemas';
import { currentUser } from '../auth/context';
import type { Db } from '../db';
import type { AppEnv, Deps } from '../env';
import { badRequest } from '../http/errors';
import { readId, readJson, readQuery } from '../http/validate';
import { epicChanges, recordActivity } from '../services/activity';
import { rewriteBoardRefs } from '../services/boardRefs';
import { getEpic, nextPosition, requireEpic } from '../services/entities';
import type { EpicRow, TaskRow } from '../services/rows';
import { nowIso } from '../services/sql';
import { assertDateOrder, nextCompletedAt, reorderWithinProject, requireParentProject } from './milestones';

const isClosedEpic = (status: EpicRow['status']) => status === 'done' || status === 'cancelled';

/** An epic's milestone must exist and belong to the epic's project (400, path `milestoneId`). */
function assertMilestoneInProject(db: Db, milestoneId: number | null, projectId: number): void {
  if (milestoneId === null) return;
  const row = db.get<{ project_id: number }>('SELECT project_id FROM milestones WHERE id = :milestoneId', { milestoneId });
  if (row?.project_id === projectId) return;
  const message = row ? 'The milestone belongs to another project' : `Unknown milestone id: ${milestoneId}`;
  throw badRequest(message, [{ path: 'milestoneId', message }]);
}

const deleteQuery = z.object({ tasks: z.enum(['detach', 'delete']).optional() });

export function epicRoutes({ db }: Deps) {
  const r = new Hono<AppEnv>();

  r.post('/', async (c) => {
    const input = await readJson(c, epicCreateInput);
    const user = currentUser(c);
    const id = db.tx(() => {
      requireParentProject(db, input.projectId);
      const milestoneId = input.milestoneId ?? null;
      assertMilestoneInProject(db, milestoneId, input.projectId);
      const startDate = input.startDate ?? null;
      const dueDate = input.dueDate ?? null;
      assertDateOrder(startDate, dueDate);
      const status = input.status ?? 'open';
      const now = nowIso();
      const epicId = db.run(
        `INSERT INTO epics (project_id, milestone_id, name, description, color, status, start_date, due_date, position,
                            completed_at, created_at, updated_at)
         VALUES (:projectId, :milestoneId, :name, :description, :color, :status, :startDate, :dueDate, :position,
                 :completedAt, :now, :now)`,
        {
          projectId: input.projectId,
          milestoneId,
          name: input.name,
          description: input.description ?? '',
          color: input.color ?? DEFAULT_EPIC_COLOR,
          status,
          startDate,
          dueDate,
          position: nextPosition(db, 'epics', input.projectId),
          completedAt: nextCompletedAt(isClosedEpic(status), null, now),
          now,
        },
      ).lastInsertRowid;
      recordActivity(db, {
        userId: user.id,
        projectId: input.projectId,
        taskId: null,
        entityType: 'epic',
        entityId: epicId,
        action: 'epic.created',
        data: { name: input.name },
        createdAt: now,
      });
      return epicId;
    });
    return c.json(getEpic(db, id), 201);
  });

  /** Body: every epic id of one project, in the desired order. */
  r.post('/reorder', async (c) => {
    const { ids } = await readJson(c, reorderInput);
    reorderWithinProject(db, 'epics', ids);
    return c.json({ ok: true as const });
  });

  r.get('/:id', (c) => c.json(getEpic(db, readId(c))));

  r.patch('/:id', async (c) => {
    const id = readId(c);
    const input = await readJson(c, epicUpdateInput);
    const user = currentUser(c);
    db.tx(() => {
      const before = requireEpic(db, id);
      const after: EpicRow = {
        ...before,
        milestone_id: input.milestoneId !== undefined ? input.milestoneId : before.milestone_id,
        name: input.name ?? before.name,
        description: input.description ?? before.description,
        color: input.color ?? before.color,
        status: input.status ?? before.status,
        start_date: input.startDate !== undefined ? input.startDate : before.start_date,
        due_date: input.dueDate !== undefined ? input.dueDate : before.due_date,
      };
      if (after.milestone_id !== before.milestone_id) assertMilestoneInProject(db, after.milestone_id, before.project_id);
      assertDateOrder(after.start_date, after.due_date);
      const changes = epicChanges(db, before, after);
      if (changes.length === 0) return;
      const now = nowIso();
      after.completed_at = nextCompletedAt(isClosedEpic(after.status), before.completed_at, now);
      db.run(
        `UPDATE epics
            SET milestone_id = :milestoneId, name = :name, description = :description, color = :color, status = :status,
                start_date = :startDate, due_date = :dueDate, completed_at = :completedAt, updated_at = :now
          WHERE id = :id`,
        {
          id,
          milestoneId: after.milestone_id,
          name: after.name,
          description: after.description,
          color: after.color,
          status: after.status,
          startDate: after.start_date,
          dueDate: after.due_date,
          completedAt: after.completed_at,
          now,
        },
      );
      recordActivity(db, {
        userId: user.id,
        projectId: before.project_id,
        taskId: null,
        entityType: 'epic',
        entityId: id,
        action: 'epic.updated',
        data: { changes, name: after.name },
        createdAt: now,
      });
    });
    return c.json(getEpic(db, id));
  });

  /**
   * ?tasks=detach (default): the FK clears the tasks' epic (not logged, SPEC §5.8).
   * ?tasks=delete: deletes the epic's tasks (each logs task.deleted) and everything under them.
   */
  r.delete('/:id', (c) => {
    const id = readId(c);
    const { tasks: mode = 'detach' } = readQuery(c, deleteQuery);
    const user = currentUser(c);
    db.tx(() => {
      const epic = requireEpic(db, id);
      const now = nowIso();
      if (mode === 'delete') {
        const tasks = db.all<Pick<TaskRow, 'id' | 'project_id' | 'title'> & { ref: string }>(
          `SELECT t.id, t.project_id, t.title, p.key || '-' || t.number AS ref
             FROM tasks t JOIN projects p ON p.id = t.project_id
            WHERE t.epic_id = :id
            ORDER BY t.rank, t.id`,
          { id },
        );
        for (const task of tasks) {
          recordActivity(db, {
            userId: user.id,
            projectId: task.project_id,
            taskId: null,
            entityType: 'task',
            entityId: task.id,
            action: 'task.deleted',
            data: { title: task.title, ref: task.ref },
            createdAt: now,
          });
        }
        db.run('DELETE FROM tasks WHERE epic_id = :id', { id });
      }
      db.run('DELETE FROM epics WHERE id = :id', { id });
      rewriteBoardRefs(db, 'epic', id, null);
      recordActivity(db, {
        userId: user.id,
        projectId: epic.project_id,
        taskId: null,
        entityType: 'epic',
        entityId: id,
        action: 'epic.deleted',
        data: { name: epic.name },
        createdAt: now,
      });
    });
    return c.json({ ok: true as const });
  });

  return r;
}
