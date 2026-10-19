// /api/milestones — create/get/update/delete/reorder milestones (SPEC §5.2, §7).
// Also exports the small helpers epics.ts shares (date order, project reference, reorder scope).

import { Hono } from 'hono';
import { z } from 'zod';
import { milestoneCreateInput, milestoneUpdateInput, reorderInput } from '@shared/schemas';
import { fold } from '../core/fold';
import type { Db } from '../db';
import type { AppEnv, Deps } from '../env';
import { badRequest } from '../http/errors';
import { readId, readJson, readQuery } from '../http/validate';
import { milestoneChanges, recordActivity } from '../services/activity';
import { rewriteBoardRefs } from '../services/boardRefs';
import { applyPositions, assertExactIdSet, getMilestone, nextPosition, requireMilestone } from '../services/entities';
import type { EpicRow, MilestoneRow, ProjectRow } from '../services/rows';
import { inJson, jsonList, nowIso } from '../services/sql';
import { currentUser } from '../space/context';

// ---------------------------------------------------------------------------
// Shared helpers (milestones + epics)
// ---------------------------------------------------------------------------

const DATE_ORDER_MESSAGE = 'Due date must be on or after start date';

/** SPEC §5.2/5.3: when both dates are set, startDate <= dueDate (400, path `dueDate`). */
export function assertDateOrder(startDate: string | null, dueDate: string | null): void {
  if (startDate !== null && dueDate !== null && startDate > dueDate) {
    throw badRequest(DATE_ORDER_MESSAGE, [{ path: 'dueDate', message: DATE_ORDER_MESSAGE }]);
  }
}

/** The project a new milestone/epic is created in; an unknown id is a 400 on `projectId`. */
export function requireParentProject(db: Db, projectId: number): ProjectRow {
  const row = db.get<ProjectRow>('SELECT * FROM projects WHERE id = :projectId', { projectId });
  if (!row) {
    const message = `Unknown project id: ${projectId}`;
    throw badRequest(message, [{ path: 'projectId', message }]);
  }
  return row;
}

/**
 * Reorder all milestones or all epics of ONE project. The project is taken from the listed
 * ids; the list must then be exactly that project's ids (400 otherwise).
 */
export function reorderWithinProject(db: Db, table: 'milestones' | 'epics', ids: readonly number[]): void {
  db.tx(() => {
    const found = db.all<{ project_id: number }>(
      `SELECT DISTINCT project_id FROM ${table} WHERE ${inJson('id', 'ids')}`,
      { ids: jsonList(ids) },
    );
    if (found.length > 1) {
      const message = `All ${table} must belong to the same project`;
      throw badRequest(message, [{ path: 'ids', message }]);
    }
    const projectId = found[0]?.project_id;
    const expected =
      projectId === undefined
        ? []
        : db.all<{ id: number }>(`SELECT id FROM ${table} WHERE project_id = :projectId`, { projectId }).map((x) => x.id);
    assertExactIdSet(ids, expected);
    applyPositions(db, table, ids);
  });
}

/** completedAt rule: set (keeping an existing value) while closed, cleared otherwise. */
export function nextCompletedAt(closed: boolean, current: string | null, now: string): string | null {
  return closed ? (current ?? now) : null;
}

const isClosedMilestone = (status: MilestoneRow['status']) => status === 'completed' || status === 'cancelled';

const deleteQuery = z.object({ epics: z.enum(['detach', 'delete']).optional() });

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function milestoneRoutes({ db }: Deps) {
  const r = new Hono<AppEnv>();

  r.post('/', async (c) => {
    const input = await readJson(c, milestoneCreateInput);
    const user = currentUser(c);
    const id = db.tx(() => {
      requireParentProject(db, input.projectId);
      const startDate = input.startDate ?? null;
      const dueDate = input.dueDate ?? null;
      assertDateOrder(startDate, dueDate);
      const status = input.status ?? 'planned';
      const now = nowIso();
      const milestoneId = db.run(
        `INSERT INTO milestones (project_id, name, name_fold, description, description_fold, status, start_date, due_date,
                                position, completed_at, created_at, updated_at)
         VALUES (:projectId, :name, :nameFold, :description, :descriptionFold, :status, :startDate, :dueDate,
                 :position, :completedAt, :now, :now)`,
        {
          projectId: input.projectId,
          name: input.name,
          nameFold: fold(input.name),
          description: input.description ?? '',
          descriptionFold: fold(input.description ?? ''),
          status,
          startDate,
          dueDate,
          position: nextPosition(db, 'milestones', input.projectId),
          completedAt: nextCompletedAt(isClosedMilestone(status), null, now),
          now,
        },
      ).lastInsertRowid;
      recordActivity(db, {
        userId: user.id,
        projectId: input.projectId,
        taskId: null,
        entityType: 'milestone',
        entityId: milestoneId,
        action: 'milestone.created',
        data: { name: input.name },
        createdAt: now,
      });
      return milestoneId;
    });
    return c.json(getMilestone(db, id), 201);
  });

  /** Body: every milestone id of one project, in the desired order. */
  r.post('/reorder', async (c) => {
    const { ids } = await readJson(c, reorderInput);
    reorderWithinProject(db, 'milestones', ids);
    return c.json({ ok: true as const });
  });

  r.get('/:id', (c) => c.json(getMilestone(db, readId(c))));

  r.patch('/:id', async (c) => {
    const id = readId(c);
    const input = await readJson(c, milestoneUpdateInput);
    const user = currentUser(c);
    db.tx(() => {
      const before = requireMilestone(db, id);
      const after: MilestoneRow = {
        ...before,
        name: input.name ?? before.name,
        description: input.description ?? before.description,
        status: input.status ?? before.status,
        start_date: input.startDate !== undefined ? input.startDate : before.start_date,
        due_date: input.dueDate !== undefined ? input.dueDate : before.due_date,
      };
      assertDateOrder(after.start_date, after.due_date);
      const changes = milestoneChanges(before, after);
      if (changes.length === 0) return;
      const now = nowIso();
      after.completed_at = nextCompletedAt(isClosedMilestone(after.status), before.completed_at, now);
      db.run(
        `UPDATE milestones
            SET name = :name, name_fold = :nameFold, description = :description, description_fold = :descriptionFold,
                status = :status, start_date = :startDate, due_date = :dueDate, completed_at = :completedAt,
                updated_at = :now
          WHERE id = :id`,
        {
          id,
          name: after.name,
          nameFold: fold(after.name),
          description: after.description,
          descriptionFold: fold(after.description),
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
        entityType: 'milestone',
        entityId: id,
        action: 'milestone.updated',
        data: { changes, name: after.name },
        createdAt: now,
      });
    });
    return c.json(getMilestone(db, id));
  });

  /**
   * ?epics=detach (default): the FK clears the epics' milestone (not logged, SPEC §5.8).
   * ?epics=delete: deletes the milestone's epics (each logs epic.deleted; their tasks lose the epic via FK).
   */
  r.delete('/:id', (c) => {
    const id = readId(c);
    const { epics: mode = 'detach' } = readQuery(c, deleteQuery);
    const user = currentUser(c);
    db.tx(() => {
      const milestone = requireMilestone(db, id);
      const now = nowIso();
      if (mode === 'delete') {
        const epics = db.all<EpicRow>('SELECT * FROM epics WHERE milestone_id = :id ORDER BY position, id', { id });
        for (const epic of epics) {
          db.run('DELETE FROM epics WHERE id = :epicId', { epicId: epic.id });
          rewriteBoardRefs(db, 'epic', epic.id, null);
          recordActivity(db, {
            userId: user.id,
            projectId: epic.project_id,
            taskId: null,
            entityType: 'epic',
            entityId: epic.id,
            action: 'epic.deleted',
            data: { name: epic.name },
            createdAt: now,
          });
        }
      }
      db.run('DELETE FROM milestones WHERE id = :id', { id });
      rewriteBoardRefs(db, 'milestone', id, null);
      recordActivity(db, {
        userId: user.id,
        projectId: milestone.project_id,
        taskId: null,
        entityType: 'milestone',
        entityId: id,
        action: 'milestone.deleted',
        data: { name: milestone.name },
        createdAt: now,
      });
    });
    return c.json({ ok: true as const });
  });

  return r;
}
