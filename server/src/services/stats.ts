// Batched aggregate queries. Each function runs a fixed number of queries no matter
// how many entities it covers (one per aggregate kind, never one per entity).
// "Closed" = completed/cancelled status. Progress counts every non-archived task plus archived
// CLOSED tasks: archiving finished work (tidying a board) must not move progress backwards,
// while an archived OPEN task is abandoned work and counts nowhere (not open, not overdue).

import type { MilestoneDTO, ProgressStats, ProjectStats } from '@shared/types';
import type { Db } from '../db';
import { CLOSED_CATEGORIES_SQL, idScope } from './sql';

export type MilestoneStats = MilestoneDTO['stats'];

export function emptyProjectStats(): ProjectStats {
  return {
    tasksTotal: 0,
    tasksOpen: 0,
    tasksClosed: 0,
    tasksOverdue: 0,
    milestonesTotal: 0,
    milestonesCompleted: 0,
    epicsTotal: 0,
    epicsDone: 0,
  };
}

export function emptyProgressStats(): ProgressStats {
  return { tasksTotal: 0, tasksClosed: 0, estimateTotal: 0, estimateClosed: 0 };
}

export function emptyMilestoneStats(): MilestoneStats {
  return { ...emptyProgressStats(), epicsTotal: 0, epicsDone: 0 };
}

interface CountRow {
  id: number;
  total: number;
  done: number;
}

interface ProgressRow {
  id: number;
  tasks_total: number;
  tasks_closed: number;
  estimate_total: number;
  estimate_closed: number;
}

/** Tasks that count towards progress: not archived, or archived after being closed. */
const COUNTED_TASK_SQL = `(t.archived_at IS NULL OR s.category IN ${CLOSED_CATEGORIES_SQL})`;

const PROGRESS_COLUMNS = `
  COUNT(*) AS tasks_total,
  COALESCE(SUM(CASE WHEN s.category IN ${CLOSED_CATEGORIES_SQL} THEN 1 ELSE 0 END), 0) AS tasks_closed,
  COALESCE(SUM(t.estimate), 0) AS estimate_total,
  COALESCE(SUM(CASE WHEN s.category IN ${CLOSED_CATEGORIES_SQL} THEN t.estimate ELSE 0 END), 0) AS estimate_closed`;

function toProgress(row: ProgressRow): ProgressStats {
  return {
    tasksTotal: row.tasks_total,
    tasksClosed: row.tasks_closed,
    estimateTotal: row.estimate_total,
    estimateClosed: row.estimate_closed,
  };
}

/**
 * ProjectStats keyed by project id (projects without tasks/milestones/epics get zeros).
 * `today` ('YYYY-MM-DD') decides tasksOverdue. `projectIds` limits the scope (default: all).
 */
export function projectStats(db: Db, today: string, projectIds?: readonly number[]): Map<number, ProjectStats> {
  const out = new Map<number, ProjectStats>();
  const entry = (id: number): ProjectStats => {
    let s = out.get(id);
    if (!s) out.set(id, (s = emptyProjectStats()));
    return s;
  };

  const tasks = idScope('t.project_id', projectIds);
  const taskRows = db.all<{ id: number; total: number; closed: number; overdue: number }>(
    `SELECT t.project_id AS id,
            COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN s.category IN ${CLOSED_CATEGORIES_SQL} THEN 1 ELSE 0 END), 0) AS closed,
            COALESCE(SUM(CASE WHEN s.category NOT IN ${CLOSED_CATEGORIES_SQL} AND t.due_date < :today THEN 1 ELSE 0 END), 0) AS overdue
       FROM tasks t JOIN statuses s ON s.id = t.status_id
      WHERE ${COUNTED_TASK_SQL} AND ${tasks.sql}
      GROUP BY t.project_id`,
    { ...tasks.params, today },
  );
  for (const r of taskRows) {
    const s = entry(r.id);
    s.tasksTotal = r.total;
    s.tasksClosed = r.closed;
    s.tasksOpen = r.total - r.closed;
    s.tasksOverdue = r.overdue;
  }

  // milestones and epics both have a project_id column, so one scope serves both.
  const byProject = idScope('project_id', projectIds);
  for (const r of db.all<CountRow>(
    `SELECT project_id AS id, COUNT(*) AS total, COALESCE(SUM(status = 'completed'), 0) AS done
       FROM milestones WHERE ${byProject.sql} GROUP BY project_id`,
    byProject.params,
  )) {
    const s = entry(r.id);
    s.milestonesTotal = r.total;
    s.milestonesCompleted = r.done;
  }

  for (const r of db.all<CountRow>(
    `SELECT project_id AS id, COUNT(*) AS total, COALESCE(SUM(status = 'done'), 0) AS done
       FROM epics WHERE ${byProject.sql} GROUP BY project_id`,
    byProject.params,
  )) {
    const s = entry(r.id);
    s.epicsTotal = r.total;
    s.epicsDone = r.done;
  }
  return out;
}

/** Milestone progress (tasks reach a milestone through their epic) + epic counts, keyed by milestone id. */
export function milestoneStats(db: Db, milestoneIds?: readonly number[]): Map<number, MilestoneStats> {
  const out = new Map<number, MilestoneStats>();
  const entry = (id: number): MilestoneStats => {
    let s = out.get(id);
    if (!s) out.set(id, (s = emptyMilestoneStats()));
    return s;
  };

  const tasks = idScope('e.milestone_id', milestoneIds);
  for (const r of db.all<ProgressRow>(
    `SELECT e.milestone_id AS id, ${PROGRESS_COLUMNS}
       FROM tasks t
       JOIN epics e ON e.id = t.epic_id
       JOIN statuses s ON s.id = t.status_id
      WHERE ${COUNTED_TASK_SQL} AND e.milestone_id IS NOT NULL AND ${tasks.sql}
      GROUP BY e.milestone_id`,
    tasks.params,
  )) {
    Object.assign(entry(r.id), toProgress(r));
  }

  const epics = idScope('milestone_id', milestoneIds);
  for (const r of db.all<CountRow>(
    `SELECT milestone_id AS id, COUNT(*) AS total, COALESCE(SUM(status = 'done'), 0) AS done
       FROM epics WHERE milestone_id IS NOT NULL AND ${epics.sql} GROUP BY milestone_id`,
    epics.params,
  )) {
    const s = entry(r.id);
    s.epicsTotal = r.total;
    s.epicsDone = r.done;
  }
  return out;
}

/** Epic progress keyed by epic id. */
export function epicStats(db: Db, epicIds?: readonly number[]): Map<number, ProgressStats> {
  const scope = idScope('t.epic_id', epicIds);
  const rows = db.all<ProgressRow>(
    `SELECT t.epic_id AS id, ${PROGRESS_COLUMNS}
       FROM tasks t JOIN statuses s ON s.id = t.status_id
      WHERE ${COUNTED_TASK_SQL} AND t.epic_id IS NOT NULL AND ${scope.sql}
      GROUP BY t.epic_id`,
    scope.params,
  );
  return new Map(rows.map((r) => [r.id, toProgress(r)]));
}

/** Number of tasks per status id, INCLUDING archived tasks. */
export function statusTaskCounts(db: Db, statusIds?: readonly number[]): Map<number, number> {
  const scope = idScope('status_id', statusIds);
  const rows = db.all<{ id: number; n: number }>(
    `SELECT status_id AS id, COUNT(*) AS n FROM tasks WHERE ${scope.sql} GROUP BY status_id`,
    scope.params,
  );
  return new Map(rows.map((r) => [r.id, r.n]));
}

/** Number of NON-archived tasks per tag id. */
export function tagTaskCounts(db: Db, tagIds?: readonly number[]): Map<number, number> {
  const scope = idScope('tt.tag_id', tagIds);
  const rows = db.all<{ id: number; n: number }>(
    `SELECT tt.tag_id AS id, COUNT(*) AS n
       FROM task_tags tt JOIN tasks t ON t.id = tt.task_id
      WHERE t.archived_at IS NULL AND ${scope.sql}
      GROUP BY tt.tag_id`,
    scope.params,
  );
  return new Map(rows.map((r) => [r.id, r.n]));
}
