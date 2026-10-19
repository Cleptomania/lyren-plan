// Comments, work logs and activity (SPEC §5.6, §5.8). Mounted at /api, so paths are full
// sub-paths: /tasks/:id/timeline|comments|worklogs, /comments/:id, /worklogs(/:id), /activity.

import { Hono, type Context } from 'hono';
import { addDays } from '@shared/dates';
import { atLeast, type SpaceRole } from '@shared/roles';
import {
  activityQueryInput,
  commentCreateInput,
  commentUpdateInput,
  worklogCreateInput,
  worklogReportQuery,
  worklogUpdateInput,
} from '@shared/schemas';
import type { ActivityData, CommentDTO, TaskTimelineDTO, WorklogDTO, WorklogReportDTO } from '@shared/types';
import type { Db } from '../db';
import type { AppEnv, Deps } from '../env';
import { badRequest, forbidden, notFound } from '../http/errors';
import { readId, readJson, readQuery } from '../http/validate';
import { commentExcerpt, listActivity, recordActivity, taskActivity } from '../services/activity';
import { requireComment, requireTask, requireWorklog } from '../services/entities';
import { COMMENT_SELECT, toCommentDTO, toWorklogDTO, WORKLOG_SELECT } from '../services/mappers';
import type { AuthorJoin, CommentRow, TaskRow, WorklogRow } from '../services/rows';
import { nowIso, serverToday } from '../services/sql';
import { taskRefOf } from '../services/tasks';
import { currentIdentity, currentUser } from '../space/context';

/** Days covered by the work-log report when `from` is omitted (inclusive of `to`). */
const REPORT_DEFAULT_DAYS = 30;

const WORKLOG_NOTE_REQUIRED = 'Enter time spent or a note';

function commentDTO(db: Db, id: number): CommentDTO {
  const row = db.get<CommentRow & AuthorJoin>(`${COMMENT_SELECT} WHERE c.id = :id`, { id });
  if (!row) throw notFound('Comment');
  return toCommentDTO(row);
}

function worklogDTO(db: Db, id: number): WorklogDTO {
  const row = db.get<WorklogRow & AuthorJoin>(`${WORKLOG_SELECT} WHERE w.id = :id`, { id });
  if (!row) throw notFound('Work log');
  return toWorklogDTO(row);
}

/** Display snapshot of the task kept in comment/work-log activity (readable after renames). */
function taskSnapshot(db: Db, task: TaskRow): Pick<ActivityData, 'title' | 'ref'> {
  return { title: task.title, ref: taskRefOf(db, task) };
}

function worklogData(row: Pick<WorklogRow, 'minutes' | 'date' | 'note'>): ActivityData {
  // The note is a best-effort snapshot like a comment excerpt (notes may be up to 10k chars).
  return { minutes: row.minutes, date: row.date, note: commentExcerpt(row.note) };
}

/**
 * Only the author may edit a comment or work log (design §6.5). Deleting is also allowed for admins and
 * owners (`allowModerator`). Rows of a deleted account (user_id NULL, or a mirror row with deleted = 1)
 * and of placeholders never match an actor, so nobody can edit them.
 */
function assertAuthor(
  row: { user_id: number | null },
  actor: { id: number; role: SpaceRole },
  what: string,
  { allowModerator = false }: { allowModerator?: boolean } = {},
): void {
  if (row.user_id === actor.id) return;
  if (allowModerator && atLeast(actor.role, 'admin')) return;
  throw forbidden(`Only the author can change this ${what}`);
}

/** The acting user and their role in the space, for assertAuthor. */
function actorOf(c: Context<AppEnv>): { id: number; role: SpaceRole } {
  return { id: currentUser(c).id, role: currentIdentity(c).role };
}

export function timelineRoutes({ db }: Deps) {
  const r = new Hono<AppEnv>();

  // ---- Task timeline ------------------------------------------------------------------

  r.get('/tasks/:id/timeline', (c) => {
    const id = readId(c);
    requireTask(db, id);
    const body: TaskTimelineDTO = {
      comments: db
        .all<CommentRow & AuthorJoin>(`${COMMENT_SELECT} WHERE c.task_id = :id ORDER BY c.created_at, c.id`, { id })
        .map(toCommentDTO),
      // Oldest work first: by the day the work happened, then by when it was logged.
      worklogs: db
        .all<WorklogRow & AuthorJoin>(`${WORKLOG_SELECT} WHERE w.task_id = :id ORDER BY w.date, w.created_at, w.id`, { id })
        .map(toWorklogDTO),
      activity: taskActivity(db, id),
    };
    return c.json(body);
  });

  // ---- Comments -----------------------------------------------------------------------

  r.post('/tasks/:id/comments', async (c) => {
    const taskId = readId(c);
    const input = await readJson(c, commentCreateInput);
    const user = currentUser(c);
    const id = db.tx(() => {
      const task = requireTask(db, taskId);
      const now = nowIso();
      const commentId = db.run(
        `INSERT INTO comments (task_id, user_id, body, created_at, updated_at, edited_at)
         VALUES (:taskId, :userId, :body, :now, :now, NULL)`,
        { taskId, userId: user.id, body: input.body, now },
      ).lastInsertRowid;
      recordActivity(db, {
        userId: user.id,
        projectId: task.project_id,
        taskId,
        entityType: 'comment',
        entityId: commentId,
        action: 'comment.created',
        data: { excerpt: commentExcerpt(input.body), ...taskSnapshot(db, task) },
        createdAt: now,
      });
      return commentId;
    });
    return c.json(commentDTO(db, id), 201);
  });

  r.patch('/comments/:id', async (c) => {
    const id = readId(c);
    const input = await readJson(c, commentUpdateInput);
    const user = currentUser(c);
    db.tx(() => {
      const row = requireComment(db, id);
      assertAuthor(row, actorOf(c), 'comment');
      if (row.body === input.body) return; // no-op: not marked edited, nothing logged
      const task = requireTask(db, row.task_id);
      const now = nowIso();
      db.run('UPDATE comments SET body = :body, updated_at = :now, edited_at = :now WHERE id = :id', {
        id,
        body: input.body,
        now,
      });
      recordActivity(db, {
        userId: user.id,
        projectId: task.project_id,
        taskId: task.id,
        entityType: 'comment',
        entityId: id,
        action: 'comment.updated',
        data: { excerpt: commentExcerpt(input.body), ...taskSnapshot(db, task) },
        createdAt: now,
      });
    });
    return c.json(commentDTO(db, id));
  });

  r.delete('/comments/:id', (c) => {
    const id = readId(c);
    const user = currentUser(c);
    db.tx(() => {
      const row = requireComment(db, id);
      assertAuthor(row, actorOf(c), 'comment', { allowModerator: true });
      const task = requireTask(db, row.task_id);
      db.run('DELETE FROM comments WHERE id = :id', { id });
      recordActivity(db, {
        userId: user.id,
        projectId: task.project_id,
        taskId: task.id,
        entityType: 'comment',
        entityId: id,
        action: 'comment.deleted',
        data: { excerpt: commentExcerpt(row.body), ...taskSnapshot(db, task) },
      });
    });
    return c.json({ ok: true as const });
  });

  // ---- Work logs ----------------------------------------------------------------------

  r.post('/tasks/:id/worklogs', async (c) => {
    const taskId = readId(c);
    const input = await readJson(c, worklogCreateInput);
    const user = currentUser(c);
    const id = db.tx(() => {
      const task = requireTask(db, taskId);
      const now = nowIso();
      const values = { date: input.date, minutes: input.minutes ?? null, note: input.note ?? '' };
      const worklogId = db.run(
        `INSERT INTO work_logs (task_id, user_id, date, minutes, note, created_at, updated_at)
         VALUES (:taskId, :userId, :date, :minutes, :note, :now, :now)`,
        { taskId, userId: user.id, ...values, now },
      ).lastInsertRowid;
      recordActivity(db, {
        userId: user.id,
        projectId: task.project_id,
        taskId,
        entityType: 'worklog',
        entityId: worklogId,
        action: 'worklog.created',
        data: { ...worklogData(values), ...taskSnapshot(db, task) },
        createdAt: now,
      });
      return worklogId;
    });
    return c.json(worklogDTO(db, id), 201);
  });

  r.patch('/worklogs/:id', async (c) => {
    const id = readId(c);
    const input = await readJson(c, worklogUpdateInput);
    const user = currentUser(c);
    db.tx(() => {
      const row = requireWorklog(db, id);
      assertAuthor(row, actorOf(c), 'work log');
      const next = {
        date: input.date ?? row.date,
        minutes: input.minutes !== undefined ? input.minutes : row.minutes,
        note: input.note ?? row.note,
      };
      // "Time spent or a note" must hold for the merged entry, not just the patch.
      if (!((next.minutes ?? 0) > 0 || next.note.length > 0)) {
        throw badRequest(WORKLOG_NOTE_REQUIRED, [{ path: 'note', message: WORKLOG_NOTE_REQUIRED }]);
      }
      if (next.date === row.date && next.minutes === row.minutes && next.note === row.note) return; // no-op
      const task = requireTask(db, row.task_id);
      const now = nowIso();
      db.run('UPDATE work_logs SET date = :date, minutes = :minutes, note = :note, updated_at = :now WHERE id = :id', {
        id,
        ...next,
        now,
      });
      recordActivity(db, {
        userId: user.id,
        projectId: task.project_id,
        taskId: task.id,
        entityType: 'worklog',
        entityId: id,
        action: 'worklog.updated',
        data: { ...worklogData(next), ...taskSnapshot(db, task) },
        createdAt: now,
      });
    });
    return c.json(worklogDTO(db, id));
  });

  r.delete('/worklogs/:id', (c) => {
    const id = readId(c);
    const user = currentUser(c);
    db.tx(() => {
      const row = requireWorklog(db, id);
      assertAuthor(row, actorOf(c), 'work log', { allowModerator: true });
      const task = requireTask(db, row.task_id);
      db.run('DELETE FROM work_logs WHERE id = :id', { id });
      recordActivity(db, {
        userId: user.id,
        projectId: task.project_id,
        taskId: task.id,
        entityType: 'worklog',
        entityId: id,
        action: 'worklog.deleted',
        data: { ...worklogData(row), ...taskSnapshot(db, task) },
      });
    });
    return c.json({ ok: true as const });
  });

  // ---- Work-log report ----------------------------------------------------------------

  r.get('/worklogs', (c) => {
    const q = readQuery(c, worklogReportQuery);
    const today = q.today ?? serverToday();
    const to = q.to ?? today;
    const from = q.from ?? addDays(to, -(REPORT_DEFAULT_DAYS - 1));
    if (from > to) {
      throw badRequest('The start date must be on or before the end date', [
        { path: 'query.from', message: 'Must be on or before the end date' },
      ]);
    }
    const projectFilter = q.projectId !== undefined ? 'AND t.project_id = :projectId' : '';
    const userFilter = q.userId !== undefined ? 'AND w.user_id = :userId' : '';
    const rows = db.all<WorklogRow & AuthorJoin & { task_title: string; task_ref: string; task_project_id: number }>(
      `SELECT w.*, u.display_name AS author_name, ib.display_name AS imported_by_name,
              t.title AS task_title, t.project_id AS task_project_id, p.key || '-' || t.number AS task_ref
         FROM work_logs w
         JOIN tasks t ON t.id = w.task_id
         JOIN projects p ON p.id = t.project_id
         LEFT JOIN users u ON u.id = w.user_id
         LEFT JOIN users ib ON ib.id = w.imported_by
        WHERE w.date >= :from AND w.date <= :to ${projectFilter} ${userFilter}
        ORDER BY w.date DESC, w.created_at DESC, w.id DESC`,
      { from, to, projectId: q.projectId, userId: q.userId },
    );
    const body: WorklogReportDTO = {
      items: rows.map((row) => ({
        ...toWorklogDTO(row),
        task: { id: row.task_id, ref: row.task_ref, title: row.task_title, projectId: row.task_project_id },
      })),
      totalMinutes: rows.reduce((sum, row) => sum + (row.minutes ?? 0), 0),
    };
    return c.json(body);
  });

  // ---- Activity feed ------------------------------------------------------------------

  r.get('/activity', (c) => {
    const q = readQuery(c, activityQueryInput);
    return c.json(listActivity(db, q));
  });

  return r;
}
