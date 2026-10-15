// GET /api/dashboard?today= — the home page in one request: open tasks by due date, work in
// progress, recently closed tasks, the latest activity and the time logged today / this week.
// The task lists are capped (DASHBOARD_LIMITS); `counts` carries each section's uncapped total
// and `inProgressProjects` the number of projects with started work, so tiles never guess.
//
// Every task list uses the shared filter semantics (buildTaskWhere): archived tasks and tasks of
// archived projects are left out; "open" means the status category is not completed/cancelled.

import { Hono } from 'hono';
import { isClosedCategory, STATUS_CATEGORIES, type StatusCategory } from '@shared/constants';
import { addDays, endOfWeek, startOfWeek } from '@shared/dates';
import { dashboardQueryInput, type TaskFilter } from '@shared/schemas';
import type { DashboardDTO, TaskDTO } from '@shared/types';
import type { Db } from '../db';
import type { AppEnv, Deps } from '../env';
import { readQuery } from '../http/validate';
import { listActivity } from '../services/activity';
import type { TaskRow } from '../services/rows';
import { getSettings } from '../services/settings';
import { serverToday } from '../services/sql';
import { buildTaskWhere, hydrateTasks, TASK_FROM, type TaskWhereContext } from '../services/tasks';

/** Caps and windows of the dashboard lists (DashboardDTO documents them). */
export const DASHBOARD_LIMITS = {
  /** overdue / dueToday / dueSoon / inProgress */
  list: 50,
  recentlyClosed: 20,
  recentActivity: 15,
  /** dueSoon covers today+1 … today+N. */
  dueSoonDays: 7,
  /** recentlyClosed covers completedAt >= now − N days. */
  recentlyClosedDays: 7,
} as const;

const OPEN_CATEGORIES: StatusCategory[] = STATUS_CATEGORIES.filter((c) => !isClosedCategory(c));
const CLOSED_CATEGORIES: StatusCategory[] = STATUS_CATEGORIES.filter((c) => isClosedCategory(c));

// ORDER BY fragments over TASK_FROM aliases (trusted constants). Within one due date the most
// urgent task comes first (priority 4 → 1, "no priority" last), then the manual order.
const BY_PRIORITY = 't.priority = 0, t.priority DESC, t.rank ASC, t.id ASC';
const ORDER = {
  overdue: `t.due_date ASC, ${BY_PRIORITY}`,
  dueToday: BY_PRIORITY,
  dueSoon: `t.due_date ASC, ${BY_PRIORITY}`,
  inProgress: 't.updated_at DESC, t.id DESC',
  // A closed task without completedAt counts as recent (filter semantics) but sorts last.
  recentlyClosed: 't.completed_at IS NULL, t.completed_at DESC, t.id DESC',
} as const;

function selectTasks(db: Db, filter: TaskFilter, ctx: TaskWhereContext, orderBy: string, limit: number): TaskDTO[] {
  const where = buildTaskWhere(filter, ctx);
  const rows = db.all<TaskRow>(
    `SELECT t.* FROM ${TASK_FROM}
      WHERE ${where.sql}
      ORDER BY ${orderBy}
      LIMIT :limit`,
    { ...where.params, limit },
  );
  return hydrateTasks(db, rows);
}

/** Uncapped number of matching tasks and of distinct projects they belong to. */
function countTasks(db: Db, filter: TaskFilter, ctx: TaskWhereContext): { tasks: number; projects: number } {
  const where = buildTaskWhere(filter, ctx);
  const row = db.get<{ tasks: number; projects: number }>(
    `SELECT COUNT(*) AS tasks, COUNT(DISTINCT t.project_id) AS projects FROM ${TASK_FROM} WHERE ${where.sql}`,
    where.params,
  );
  return { tasks: row?.tasks ?? 0, projects: row?.projects ?? 0 };
}

/** One dashboard section: its capped list and its total. */
function section(db: Db, filter: TaskFilter, ctx: TaskWhereContext, orderBy: string, limit: number) {
  const tasks = selectTasks(db, filter, ctx, orderBy, limit);
  // Below the cap the list is complete; only a full list needs the COUNT query.
  const total =
    tasks.length < limit
      ? { tasks: tasks.length, projects: new Set(tasks.map((t) => t.projectId)).size }
      : countTasks(db, filter, ctx);
  return { tasks, total };
}

/** Minutes logged on `today` and in the calendar week containing it (all work logs). */
function worklogTotals(db: Db, today: string, weekStartsOn: 0 | 1): DashboardDTO['worklog'] {
  const row = db.get<{ today_minutes: number; week_minutes: number }>(
    `SELECT COALESCE(SUM(CASE WHEN date = :today THEN minutes END), 0) AS today_minutes,
            COALESCE(SUM(minutes), 0) AS week_minutes
       FROM work_logs
      WHERE date >= :weekStart AND date <= :weekEnd`,
    { today, weekStart: startOfWeek(today, weekStartsOn), weekEnd: endOfWeek(today, weekStartsOn) },
  );
  return { todayMinutes: row?.today_minutes ?? 0, weekMinutes: row?.week_minutes ?? 0 };
}

/** The filter behind each dashboard section (POST /api/tasks/query accepts the same filters). */
function dashboardFilters(today: string): Record<keyof DashboardDTO['counts'], TaskFilter> {
  return {
    overdue: { due: ['overdue'] },
    dueToday: { due: ['today'], statusCategories: OPEN_CATEGORIES },
    dueSoon: {
      dueFrom: addDays(today, 1),
      dueTo: addDays(today, DASHBOARD_LIMITS.dueSoonDays),
      statusCategories: OPEN_CATEGORIES,
    },
    inProgress: { statusCategories: ['started'] },
    recentlyClosed: { statusCategories: CLOSED_CATEGORIES, closedWithinDays: DASHBOARD_LIMITS.recentlyClosedDays },
  };
}

function buildDashboard(db: Db, today: string, nowMs: number): DashboardDTO {
  const { weekStartsOn } = getSettings(db);
  const ctx: TaskWhereContext = { today, weekStartsOn, nowMs };
  const { list } = DASHBOARD_LIMITS;
  const filters = dashboardFilters(today);
  const overdue = section(db, filters.overdue, ctx, ORDER.overdue, list);
  const dueToday = section(db, filters.dueToday, ctx, ORDER.dueToday, list);
  const dueSoon = section(db, filters.dueSoon, ctx, ORDER.dueSoon, list);
  const inProgress = section(db, filters.inProgress, ctx, ORDER.inProgress, list);
  const recentlyClosed = section(db, filters.recentlyClosed, ctx, ORDER.recentlyClosed, DASHBOARD_LIMITS.recentlyClosed);
  return {
    today,
    overdue: overdue.tasks,
    dueToday: dueToday.tasks,
    dueSoon: dueSoon.tasks,
    inProgress: inProgress.tasks,
    recentlyClosed: recentlyClosed.tasks,
    counts: {
      overdue: overdue.total.tasks,
      dueToday: dueToday.total.tasks,
      dueSoon: dueSoon.total.tasks,
      inProgress: inProgress.total.tasks,
      recentlyClosed: recentlyClosed.total.tasks,
    },
    inProgressProjects: inProgress.total.projects,
    recentActivity: listActivity(db, { limit: DASHBOARD_LIMITS.recentActivity }).items,
    worklog: worklogTotals(db, today, weekStartsOn),
  };
}

export function dashboardRoutes({ db }: Deps) {
  const r = new Hono<AppEnv>();

  r.get('/', (c) => {
    const { today = serverToday() } = readQuery(c, dashboardQueryInput);
    return c.json(buildDashboard(db, today, Date.now()));
  });

  return r;
}
