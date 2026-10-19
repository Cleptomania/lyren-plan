// /api/projects — list/get/create/update/delete/reorder projects, plus each project's
// milestones and epics (SPEC §5.1, §7).

import { Hono } from 'hono';
import { z } from 'zod';
import { DEFAULT_PROJECT_COLOR } from '@shared/constants';
import { isoDateSchema, projectCreateInput, projectUpdateInput, reorderInput } from '@shared/schemas';
import { fold } from '../core/fold';
import type { AppEnv, Deps } from '../env';
import { HttpError } from '../http/errors';
import { readId, readJson, readQuery } from '../http/validate';
import { projectChanges, recordActivity } from '../services/activity';
import { clearDefaultBoardIfMissing, rewriteBoardRefs } from '../services/boardRefs';
import {
  applyPositions,
  assertExactIdSet,
  generateProjectKey,
  getProject,
  isProjectKeyTaken,
  listEpics,
  listMilestones,
  listProjects,
  nextPosition,
  requireProject,
} from '../services/entities';
import type { ProjectRow } from '../services/rows';
import { nowIso, serverToday } from '../services/sql';
import { currentUser } from '../space/context';

/** `?today=` (the client's local date) drives stats.tasksOverdue; defaults to the server's UTC date. */
const todayQuery = z.object({ today: isoDateSchema.optional() });

/** 409 for a key used by another project, with a field detail so forms can show it inline. */
function keyTaken(key: string): HttpError {
  const message = `The key ${key} is already used by another project`;
  return new HttpError(409, 'conflict', message, [{ path: 'key', message }]);
}

export function projectRoutes({ db }: Deps) {
  const r = new Hono<AppEnv>();

  r.get('/', (c) => {
    const { today = serverToday() } = readQuery(c, todayQuery);
    return c.json(listProjects(db, today));
  });

  r.post('/', async (c) => {
    const { today = serverToday() } = readQuery(c, todayQuery);
    const input = await readJson(c, projectCreateInput);
    const user = currentUser(c);
    const id = db.tx(() => {
      if (input.key !== undefined && isProjectKeyTaken(db, input.key)) throw keyTaken(input.key);
      const key = input.key ?? generateProjectKey(db, input.name);
      const now = nowIso();
      const projectId = db.run(
        `INSERT INTO projects (key, name, name_fold, description, description_fold, color, status, position, task_counter,
                               created_at, updated_at)
         VALUES (:key, :name, :nameFold, :description, :descriptionFold, :color, :status, :position, 0, :now, :now)`,
        {
          key,
          name: input.name,
          nameFold: fold(input.name),
          description: input.description ?? '',
          descriptionFold: fold(input.description ?? ''),
          color: input.color ?? DEFAULT_PROJECT_COLOR,
          status: input.status ?? 'active',
          position: nextPosition(db, 'projects'),
          now,
        },
      ).lastInsertRowid;
      recordActivity(db, {
        userId: user.id,
        projectId,
        taskId: null,
        entityType: 'project',
        entityId: projectId,
        action: 'project.created',
        data: { name: input.name, key },
        createdAt: now,
      });
      return projectId;
    });
    return c.json(getProject(db, id, today), 201);
  });

  /** Body: every project id in the desired order. */
  r.post('/reorder', async (c) => {
    const { ids } = await readJson(c, reorderInput);
    db.tx(() => {
      const all = db.all<{ id: number }>('SELECT id FROM projects');
      assertExactIdSet(
        ids,
        all.map((p) => p.id),
      );
      applyPositions(db, 'projects', ids);
    });
    return c.json({ ok: true as const });
  });

  r.get('/:id', (c) => {
    const id = readId(c);
    const { today = serverToday() } = readQuery(c, todayQuery);
    return c.json(getProject(db, id, today));
  });

  r.patch('/:id', async (c) => {
    const id = readId(c);
    const { today = serverToday() } = readQuery(c, todayQuery);
    const input = await readJson(c, projectUpdateInput);
    const user = currentUser(c);
    db.tx(() => {
      const before = requireProject(db, id);
      const after: ProjectRow = {
        ...before,
        name: input.name ?? before.name,
        key: input.key ?? before.key,
        description: input.description ?? before.description,
        color: input.color ?? before.color,
        status: input.status ?? before.status,
      };
      const changes = projectChanges(before, after);
      if (changes.length === 0) return; // no-op PATCH: nothing written, nothing logged
      if (after.key !== before.key && isProjectKeyTaken(db, after.key, id)) throw keyTaken(after.key);
      const now = nowIso();
      db.run(
        `UPDATE projects
            SET name = :name, name_fold = :nameFold, key = :key, description = :description,
                description_fold = :descriptionFold, color = :color, status = :status, updated_at = :now
          WHERE id = :id`,
        {
          id,
          name: after.name,
          nameFold: fold(after.name),
          key: after.key,
          description: after.description,
          descriptionFold: fold(after.description),
          color: after.color,
          status: after.status,
          now,
        },
      );
      recordActivity(db, {
        userId: user.id,
        projectId: id,
        taskId: null,
        entityType: 'project',
        entityId: id,
        action: 'project.updated',
        data: { changes, name: after.name },
        createdAt: now,
      });
    });
    return c.json(getProject(db, id, today));
  });

  /** Deletes the project and everything in it (FK cascades), then cleans board references. */
  r.delete('/:id', (c) => {
    const id = readId(c);
    const user = currentUser(c);
    db.tx(() => {
      const project = requireProject(db, id);
      const milestoneIds = db.all<{ id: number }>('SELECT id FROM milestones WHERE project_id = :id', { id });
      const epicIds = db.all<{ id: number }>('SELECT id FROM epics WHERE project_id = :id', { id });
      // Tasks moved out of this project keep their earlier history (created, field changes,
      // comments, work logs), recorded while they lived here: re-home those rows to the task's
      // current project so the cascade below only removes this project's own content.
      db.run(
        `UPDATE activity
            SET project_id = (SELECT t.project_id FROM tasks t WHERE t.id = activity.task_id)
          WHERE project_id = :id
            AND task_id IS NOT NULL
            AND task_id IN (SELECT t.id FROM tasks t WHERE t.project_id <> :id)`,
        { id },
      );
      db.run('DELETE FROM projects WHERE id = :id', { id });
      // Remaining boards (global ones and other projects') may reference the project or its
      // cascaded milestones/epics in drop patches and group prefs.
      rewriteBoardRefs(db, 'project', id, null);
      for (const m of milestoneIds) rewriteBoardRefs(db, 'milestone', m.id, null);
      for (const e of epicIds) rewriteBoardRefs(db, 'epic', e.id, null);
      clearDefaultBoardIfMissing(db);
      recordActivity(db, {
        userId: user.id,
        projectId: null,
        taskId: null,
        entityType: 'project',
        entityId: id,
        action: 'project.deleted',
        data: { name: project.name, key: project.key },
      });
    });
    return c.json({ ok: true as const });
  });

  r.get('/:id/milestones', (c) => {
    const id = readId(c);
    requireProject(db, id);
    return c.json(listMilestones(db, id));
  });

  r.get('/:id/epics', (c) => {
    const id = readId(c);
    requireProject(db, id);
    return c.json(listEpics(db, id));
  });

  return r;
}
