// Statistics of the lookup lists (design §2.4.1 item 7): each function reads the tasks in its scope in ONE
// scan (STAT_COLUMNS) and aggregates them in JS, with the statuses and the epics (small tables, read once).
// A Durable Object bills every row a statement reads, and the grouped join per statistic these replaced read
// every task once per statistic (§11.2). spaceStats computes all of them from one scan, for bootstrap. The
// results are exactly the SQL ones (server/test/contract/stats.contract.ts keeps those queries as its oracle):
// text compares as SQLite's BINARY order and estimates are summed as SQLite's SUM() does (services/sql.ts).
//
// "Closed" = completed/cancelled status. Progress counts every non-archived task plus archived CLOSED tasks:
// archiving finished work (tidying a board) must not move progress backwards, while an archived OPEN task is
// abandoned work and counts nowhere (not open, not overdue).

import { isClosedCategory, type StatusCategory } from '@shared/constants';
import type { MilestoneDTO, ProgressStats, ProjectStats } from '@shared/types';
import type { Db } from '../db';
import type { TaskRow } from './rows';
import { compareText, idScope, RealSum } from './sql';
import { tagIdsOf } from './tasks';

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

/** Every statistic of the space's lists (bootstrap), from one scan of its tasks. */
export interface SpaceStats {
  projects: Map<number, ProjectStats>;
  milestones: Map<number, MilestoneStats>;
  epics: Map<number, ProgressStats>;
  statuses: Map<number, number>;
  tags: Map<number, number>;
}

type StatTask = Pick<
  TaskRow,
  'id' | 'project_id' | 'epic_id' | 'status_id' | 'archived_at' | 'due_date' | 'estimate' | 'tag_ids'
>;

/** The columns a statistic reads of a task. */
const STAT_COLUMNS = 'id, project_id, epic_id, status_id, archived_at, due_date, estimate, tag_ids';

/** The tasks matching `where` (a condition over tasks), read once. */
function scanTasks(db: Db, where: { sql: string; params: Record<string, string> }): StatTask[] {
  return db.all<StatTask>(`SELECT ${STAT_COLUMNS} FROM tasks WHERE ${where.sql}`, where.params);
}

/**
 * Status category by status id. The queries these replace joined a task's status, so a task whose status is
 * missing (only a broken foreign key could do that) counts nowhere in progress either.
 */
function statusCategories(db: Db): Map<number, StatusCategory> {
  return new Map(db.all<{ id: number; category: StatusCategory }>('SELECT id, category FROM statuses').map((s) => [s.id, s.category]));
}

/** A task that counts towards progress (not archived, or archived after being closed), with whether it is closed. */
function counted(task: StatTask, categories: ReadonlyMap<number, StatusCategory>): { closed: boolean } | null {
  const category = categories.get(task.status_id);
  if (category === undefined) return null;
  const closed = isClosedCategory(category);
  return task.archived_at === null || closed ? { closed } : null;
}

/** Progress of a set of tasks, summed as the SQL did (COUNT, SUM of the estimates, of the closed ones'). */
class Progress {
  tasksTotal = 0;
  tasksClosed = 0;
  private readonly estimateTotal = new RealSum();
  private readonly estimateClosed = new RealSum();

  add(task: StatTask, closed: boolean): void {
    this.tasksTotal++;
    this.estimateTotal.add(task.estimate);
    if (closed) {
      this.tasksClosed++;
      this.estimateClosed.add(task.estimate);
    }
  }

  stats(): ProgressStats {
    return {
      tasksTotal: this.tasksTotal,
      tasksClosed: this.tasksClosed,
      estimateTotal: this.estimateTotal.value,
      estimateClosed: this.estimateClosed.value,
    };
  }
}

/** A map's entry for `id`, created by `make` when missing. */
function entry<K, V>(map: Map<K, V>, id: K, make: () => V): V {
  let value = map.get(id);
  if (value === undefined) map.set(id, (value = make()));
  return value;
}

interface CountRow {
  id: number;
  total: number;
  done: number;
}

function projectsOf(
  db: Db,
  tasks: readonly StatTask[],
  categories: ReadonlyMap<number, StatusCategory>,
  today: string,
  projectIds: readonly number[] | undefined,
): Map<number, ProjectStats> {
  const out = new Map<number, ProjectStats>();
  for (const task of tasks) {
    const c = counted(task, categories);
    if (!c) continue;
    const s = entry(out, task.project_id, emptyProjectStats);
    s.tasksTotal++;
    if (c.closed) s.tasksClosed++;
    else {
      s.tasksOpen++;
      if (task.due_date !== null && compareText(task.due_date, today) < 0) s.tasksOverdue++;
    }
  }

  // milestones and epics both have a project_id column, so one scope serves both.
  const byProject = idScope('project_id', projectIds);
  for (const r of db.all<CountRow>(
    `SELECT project_id AS id, COUNT(*) AS total, COALESCE(SUM(status = 'completed'), 0) AS done
       FROM milestones WHERE ${byProject.sql} GROUP BY project_id`,
    byProject.params,
  )) {
    const s = entry(out, r.id, emptyProjectStats);
    s.milestonesTotal = r.total;
    s.milestonesCompleted = r.done;
  }

  for (const r of db.all<CountRow>(
    `SELECT project_id AS id, COUNT(*) AS total, COALESCE(SUM(status = 'done'), 0) AS done
       FROM epics WHERE ${byProject.sql} GROUP BY project_id`,
    byProject.params,
  )) {
    const s = entry(out, r.id, emptyProjectStats);
    s.epicsTotal = r.total;
    s.epicsDone = r.done;
  }
  return out;
}

function milestonesOf(
  db: Db,
  tasks: readonly StatTask[],
  categories: ReadonlyMap<number, StatusCategory>,
  milestoneIds: readonly number[] | undefined,
): Map<number, MilestoneStats> {
  // Tasks reach a milestone through their epic.
  const epics = idScope('milestone_id', milestoneIds);
  const milestoneOfEpic = new Map(
    db
      .all<{ id: number; milestone_id: number }>(
        `SELECT id, milestone_id FROM epics WHERE milestone_id IS NOT NULL AND ${epics.sql}`,
        epics.params,
      )
      .map((e) => [e.id, e.milestone_id]),
  );
  const progress = new Map<number, Progress>();
  for (const task of tasks) {
    const milestoneId = task.epic_id === null ? undefined : milestoneOfEpic.get(task.epic_id);
    if (milestoneId === undefined) continue;
    const c = counted(task, categories);
    if (c) entry(progress, milestoneId, () => new Progress()).add(task, c.closed);
  }
  const out = new Map<number, MilestoneStats>();
  for (const [id, p] of progress) out.set(id, { ...emptyMilestoneStats(), ...p.stats() });

  for (const r of db.all<CountRow>(
    `SELECT milestone_id AS id, COUNT(*) AS total, COALESCE(SUM(status = 'done'), 0) AS done
       FROM epics WHERE milestone_id IS NOT NULL AND ${epics.sql} GROUP BY milestone_id`,
    epics.params,
  )) {
    const s = entry(out, r.id, emptyMilestoneStats);
    s.epicsTotal = r.total;
    s.epicsDone = r.done;
  }
  return out;
}

function epicsOf(
  tasks: readonly StatTask[],
  categories: ReadonlyMap<number, StatusCategory>,
  epicIds: readonly number[] | undefined,
): Map<number, ProgressStats> {
  const scope = epicIds === undefined ? null : new Set(epicIds);
  const progress = new Map<number, Progress>();
  for (const task of tasks) {
    if (task.epic_id === null || (scope && !scope.has(task.epic_id))) continue;
    const c = counted(task, categories);
    if (c) entry(progress, task.epic_id, () => new Progress()).add(task, c.closed);
  }
  return new Map([...progress].map(([id, p]) => [id, p.stats()]));
}

function statusesOf(tasks: readonly StatTask[], statusIds: readonly number[] | undefined): Map<number, number> {
  const scope = statusIds === undefined ? null : new Set(statusIds);
  const out = new Map<number, number>();
  for (const task of tasks) {
    if (!scope || scope.has(task.status_id)) out.set(task.status_id, (out.get(task.status_id) ?? 0) + 1);
  }
  return out;
}

function tagsOf(tasks: readonly StatTask[], tagIds: readonly number[] | undefined): Map<number, number> {
  const scope = tagIds === undefined ? null : new Set(tagIds);
  const out = new Map<number, number>();
  for (const task of tasks) {
    if (task.archived_at !== null) continue;
    for (const id of tagIdsOf(task)) {
      if (!scope || scope.has(id)) out.set(id, (out.get(id) ?? 0) + 1);
    }
  }
  return out;
}

/** Every statistic of the space's lists (bootstrap): one scan of every task. */
export function spaceStats(db: Db, today: string): SpaceStats {
  const tasks = scanTasks(db, idScope('id', undefined));
  const categories = statusCategories(db);
  return {
    projects: projectsOf(db, tasks, categories, today, undefined),
    milestones: milestonesOf(db, tasks, categories, undefined),
    epics: epicsOf(tasks, categories, undefined),
    statuses: statusesOf(tasks, undefined),
    tags: tagsOf(tasks, undefined),
  };
}

/**
 * ProjectStats keyed by project id (projects without tasks/milestones/epics get zeros).
 * `today` ('YYYY-MM-DD') decides tasksOverdue. `projectIds` limits the scope (default: all).
 */
export function projectStats(db: Db, today: string, projectIds?: readonly number[]): Map<number, ProjectStats> {
  return projectsOf(db, scanTasks(db, idScope('project_id', projectIds)), statusCategories(db), today, projectIds);
}

/** Milestone progress (tasks reach a milestone through their epic) + epic counts, keyed by milestone id. */
export function milestoneStats(db: Db, milestoneIds?: readonly number[]): Map<number, MilestoneStats> {
  const scope = idScope('milestone_id', milestoneIds);
  const tasks = scanTasks(db, {
    sql: milestoneIds === undefined ? '1' : `epic_id IN (SELECT id FROM epics WHERE ${scope.sql})`,
    params: scope.params,
  });
  return milestonesOf(db, tasks, statusCategories(db), milestoneIds);
}

/** Epic progress keyed by epic id. */
export function epicStats(db: Db, epicIds?: readonly number[]): Map<number, ProgressStats> {
  return epicsOf(scanTasks(db, idScope('epic_id', epicIds)), statusCategories(db), epicIds);
}

/** Number of tasks per status id, INCLUDING archived tasks. */
export function statusTaskCounts(db: Db, statusIds?: readonly number[]): Map<number, number> {
  return statusesOf(scanTasks(db, idScope('status_id', statusIds)), statusIds);
}

/** Number of NON-archived tasks per tag id. */
export function tagTaskCounts(db: Db, tagIds?: readonly number[]): Map<number, number> {
  const scope = idScope('tag_id', tagIds);
  const tasks = scanTasks(db, {
    sql: tagIds === undefined ? '1' : `id IN (SELECT task_id FROM task_tags WHERE ${scope.sql})`,
    params: scope.params,
  });
  return tagsOf(tasks, tagIds);
}
