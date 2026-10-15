// Fixtures shared by the timeline API tests (comments, work logs, activity). Projects and
// tasks are inserted directly so these tests don't depend on the task routes.

import { SESSION_COOKIE } from '@shared/constants';
import type { ActivityAction, ActivityEntityType } from '@shared/types';
import { createSession } from '../src/auth/sessions';
import type { Db } from '../src/db';
import { recordActivity } from '../src/services/activity';
import type { ActivityRow } from '../src/services/rows';
import { createTestContext, type TestClient } from './helpers';
import { insertProject, insertTask, type TaskFixture } from './services.fixtures';

export type TimelineContext = Awaited<ReturnType<typeof setupTimeline>>;

/** Signed-in owner, two projects (WEB, ME) and one task in WEB. */
export async function setupTimeline() {
  const ctx = createTestContext();
  const { client, user } = await ctx.signedIn();
  const projectId = insertProject(ctx.db, 'WEB', { name: 'Website' });
  const otherProjectId = insertProject(ctx.db, 'ME', { name: 'Personal' });
  const taskId = insertTask(ctx.db, { projectId, title: 'Write the brief' });
  return {
    ...ctx,
    /** Signed-in owner. */
    client,
    /** Build another client (e.g. anonymous, or with a given session cookie). */
    newClient: ctx.client,
    user,
    projectId,
    otherProjectId,
    taskId,
    addTask: (t: Partial<TaskFixture> = {}) => insertTask(ctx.db, { projectId, ...t }),
  };
}

/** A second account with its own session (the app is single-owner, so this goes straight to the DB). */
export function secondUser(ctx: TimelineContext, displayName = 'Guest'): { client: TestClient; userId: number } {
  const now = new Date().toISOString();
  const userId = ctx.db.run(
    `INSERT INTO users (username, display_name, password_hash, created_at, updated_at)
     VALUES (:username, :displayName, 'x', :now, :now)`,
    { username: displayName.toLowerCase(), displayName, now },
  ).lastInsertRowid;
  const { token } = createSession(ctx.db, userId, {}, ctx.config.sessionTtlDays);
  return { client: ctx.newClient(`${SESSION_COOKIE}=${token}`), userId };
}

export function activityRows(db: Db, action?: ActivityAction): ActivityRow[] {
  return action === undefined
    ? db.all<ActivityRow>('SELECT * FROM activity ORDER BY id')
    : db.all<ActivityRow>('SELECT * FROM activity WHERE action = :action ORDER BY id', { action });
}

export function lastActivity(db: Db): ActivityRow & { parsed: Record<string, unknown> } {
  const row = db.get<ActivityRow>('SELECT * FROM activity ORDER BY id DESC LIMIT 1');
  if (!row) throw new Error('no activity recorded');
  return { ...row, parsed: JSON.parse(row.data) as Record<string, unknown> };
}

export function countRows(db: Db, table: 'comments' | 'work_logs' | 'activity'): number {
  return db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)!.n;
}

/** Insert a work log directly (explicit timestamps for ordering tests). */
export function insertWorklog(
  db: Db,
  w: { taskId: number; userId: number | null; date: string; minutes?: number | null; note?: string; createdAt?: string },
): number {
  const at = w.createdAt ?? new Date().toISOString();
  return db.run(
    `INSERT INTO work_logs (task_id, user_id, date, minutes, note, created_at, updated_at)
     VALUES (:taskId, :userId, :date, :minutes, :note, :at, :at)`,
    { taskId: w.taskId, userId: w.userId, date: w.date, minutes: w.minutes ?? null, note: w.note ?? '', at },
  ).lastInsertRowid;
}

/** Insert a comment directly. */
export function insertComment(db: Db, c: { taskId: number; userId: number | null; body: string; createdAt?: string }): number {
  const at = c.createdAt ?? new Date().toISOString();
  return db.run(
    `INSERT INTO comments (task_id, user_id, body, created_at, updated_at) VALUES (:taskId, :userId, :body, :at, :at)`,
    { taskId: c.taskId, userId: c.userId, body: c.body, at },
  ).lastInsertRowid;
}

/** Record an activity entry directly (entity type from the action, entity id defaults to the task). */
export function insertActivity(
  db: Db,
  e: {
    userId: number | null;
    projectId: number | null;
    taskId: number | null;
    action: ActivityAction;
    entityId?: number | null;
    data?: Record<string, unknown>;
  },
): number {
  return recordActivity(db, {
    userId: e.userId,
    projectId: e.projectId,
    taskId: e.taskId,
    entityType: e.action.split('.')[0] as ActivityEntityType,
    entityId: e.entityId !== undefined ? e.entityId : e.taskId,
    action: e.action,
    data: e.data,
  });
}
