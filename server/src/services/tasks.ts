// Task reading: hydration to TaskDTO, lookups by id/ref, and the SQL implementation of
// TaskFilter / TaskSort. buildTaskWhere and taskOrderBy are exact SQL equivalents of
// matchesTaskFilter / compareTasks in shared/src/filter.ts (cross-checked by
// server/test/services.filter.test.ts on randomized data) — keep them in lockstep.

import { LIMITS } from '@shared/constants';
import { resolveDuePreset, type ISODate, type WeekStart } from '@shared/dates';
import { searchTokens } from '@shared/filter';
import type { TaskFilter, TaskQueryInput, TaskSort } from '@shared/schemas';
import type { TagRef, TaskDTO, TaskQueryResult } from '@shared/types';
import type { Db, SqlValue } from '../db';
import { notFound } from '../http/errors';
import { compareTagNames, toTagRef } from './mappers';
import type { TaskRow } from './rows';
import { getSettings } from './settings';
import { CLOSED_CATEGORIES_SQL, inJson, jsonList, serverToday } from './sql';

/**
 * FROM clause every task query uses. buildTaskWhere / taskOrderBy reference its aliases:
 * t = tasks, p = the task's project, s = its status, e = its epic (NULL when none).
 */
export const TASK_FROM = `tasks t
  JOIN projects p ON p.id = t.project_id
  JOIN statuses s ON s.id = t.status_id
  LEFT JOIN epics e ON e.id = t.epic_id`;

/** SQL expression for a task's ref ('KEY-42') within TASK_FROM. */
export const TASK_REF_SQL = "p.key || '-' || t.number";

/** SQL condition: the task's status category is closed (completed/cancelled). */
export const TASK_CLOSED_SQL = `s.category IN ${CLOSED_CATEGORIES_SQL}`;

export const DEFAULT_TASK_SORT: TaskSort = { field: 'manual', dir: 'asc' };

// ---------------------------------------------------------------------------
// Hydration
// ---------------------------------------------------------------------------

/**
 * Rows -> TaskDTOs, preserving input order. Batched: a fixed number of queries for any
 * number of rows (project keys, epic milestones, tags, comment counts, work-log sums).
 */
export function hydrateTasks(db: Db, rows: readonly TaskRow[]): TaskDTO[] {
  if (rows.length === 0) return [];
  const taskIds = jsonList(rows.map((r) => r.id));
  const keys = new Map(
    db
      .all<{ id: number; key: string }>(`SELECT id, key FROM projects WHERE ${inJson('id', 'ids')}`, {
        ids: jsonList(rows.map((r) => r.project_id)),
      })
      .map((p) => [p.id, p.key]),
  );
  const epicIds = rows.map((r) => r.epic_id).filter((id): id is number => id !== null);
  const milestones = new Map(
    epicIds.length === 0
      ? []
      : db
          .all<{ id: number; milestone_id: number | null }>(
            `SELECT id, milestone_id FROM epics WHERE ${inJson('id', 'ids')}`,
            { ids: jsonList(epicIds) },
          )
          .map((e) => [e.id, e.milestone_id]),
  );
  const tags = new Map<number, TagRef[]>();
  for (const r of db.all<{ task_id: number; id: number; name: string; color: string }>(
    `SELECT tt.task_id, g.id, g.name, g.color
       FROM task_tags tt JOIN tags g ON g.id = tt.tag_id
      WHERE ${inJson('tt.task_id', 'ids')}`,
    { ids: taskIds },
  )) {
    const list = tags.get(r.task_id);
    if (list) list.push(toTagRef(r));
    else tags.set(r.task_id, [toTagRef(r)]);
  }
  for (const list of tags.values()) list.sort(compareTagNames);
  const comments = new Map(
    db
      .all<{ task_id: number; n: number }>(
        `SELECT task_id, COUNT(*) AS n FROM comments WHERE ${inJson('task_id', 'ids')} GROUP BY task_id`,
        { ids: taskIds },
      )
      .map((c) => [c.task_id, c.n]),
  );
  const minutes = new Map(
    db
      .all<{ task_id: number; n: number }>(
        `SELECT task_id, COALESCE(SUM(minutes), 0) AS n FROM work_logs WHERE ${inJson('task_id', 'ids')} GROUP BY task_id`,
        { ids: taskIds },
      )
      .map((w) => [w.task_id, w.n]),
  );

  return rows.map((r) => ({
    id: r.id,
    projectId: r.project_id,
    number: r.number,
    ref: `${keys.get(r.project_id) ?? '?'}-${r.number}`,
    epicId: r.epic_id,
    milestoneId: r.epic_id === null ? null : (milestones.get(r.epic_id) ?? null),
    statusId: r.status_id,
    priority: r.priority,
    title: r.title,
    description: r.description,
    startDate: r.start_date,
    dueDate: r.due_date,
    estimate: r.estimate,
    rank: r.rank,
    completedAt: r.completed_at,
    archivedAt: r.archived_at,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    tags: tags.get(r.id) ?? [],
    commentCount: comments.get(r.id) ?? 0,
    worklogMinutes: minutes.get(r.id) ?? 0,
  }));
}

/** One task as DTO, or 404. */
export function getTaskDTO(db: Db, id: number): TaskDTO {
  const row = db.get<TaskRow>('SELECT * FROM tasks WHERE id = :id', { id });
  if (!row) throw notFound('Task');
  return hydrateTasks(db, [row])[0]!;
}

/** Tasks by id as DTOs in the order of `ids` (unknown ids are skipped). */
export function getTaskDTOs(db: Db, ids: readonly number[]): TaskDTO[] {
  if (ids.length === 0) return [];
  const rows = new Map(
    db.all<TaskRow>(`SELECT * FROM tasks WHERE ${inJson('id', 'ids')}`, { ids: jsonList(ids) }).map((r) => [r.id, r]),
  );
  const ordered = [...new Set(ids)].map((id) => rows.get(id)).filter((r): r is TaskRow => r !== undefined);
  return hydrateTasks(db, ordered);
}

/** Current ref ('KEY-42') of a task row — for activity snapshots such as `{ title, ref }`. */
export function taskRefOf(db: Db, row: Pick<TaskRow, 'project_id' | 'number'>): string {
  const project = db.get<{ key: string }>('SELECT key FROM projects WHERE id = :id', { id: row.project_id });
  if (!project) throw notFound('Project');
  return `${project.key}-${row.number}`;
}

const REF_RE = /^([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,15})$/;

/** Split 'web-3' into { key: 'WEB', number: 3 }; null when it is not a ref. */
export function parseTaskRef(ref: string): { key: string; number: number } | null {
  const m = REF_RE.exec(ref.trim());
  if (!m) return null;
  const number = Number(m[2]);
  return Number.isSafeInteger(number) && number > 0 ? { key: m[1]!.toUpperCase(), number } : null;
}

/** Task by human ref ('WEB-3', case-insensitive), or null. */
export function findTaskByRef(db: Db, ref: string): TaskDTO | null {
  const parsed = parseTaskRef(ref);
  if (!parsed) return null;
  const row = db.get<TaskRow>(
    'SELECT t.* FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.key = :key AND t.number = :number',
    parsed,
  );
  return row ? hydrateTasks(db, [row])[0]! : null;
}

// ---------------------------------------------------------------------------
// Filtering & sorting (SQL twins of shared/src/filter.ts)
// ---------------------------------------------------------------------------

export interface TaskWhereContext {
  /** The client's calendar date, for due presets. */
  today: ISODate;
  weekStartsOn: WeekStart;
  /** Epoch ms for closedWithinDays. */
  nowMs: number;
}

export interface SqlFragment {
  sql: string;
  params: Record<string, SqlValue>;
}

function nonEmpty<T>(arr: readonly T[] | undefined): arr is readonly T[] {
  return Array.isArray(arr) && arr.length > 0;
}

/**
 * WHERE condition (over TASK_FROM aliases) equivalent to matchesTaskFilter(task, filter, ctx).
 * Parameter names are f0, f1, … — don't reuse them in the surrounding statement.
 */
export function buildTaskWhere(filter: TaskFilter, ctx: TaskWhereContext): SqlFragment {
  const clauses: string[] = [];
  const params: Record<string, SqlValue> = {};
  const param = (value: SqlValue): string => {
    const name = `f${Object.keys(params).length}`;
    params[name] = value;
    return `:${name}`;
  };
  const inList = (column: string, values: Iterable<number | string>): string =>
    `${column} IN (SELECT value FROM json_each(${param(jsonList(values))}))`;
  const anyOf = (parts: string[]): string => (parts.length === 1 ? parts[0]! : `(${parts.join(' OR ')})`);
  /** IN never matches NULL: a null entry becomes `column IS NULL`. */
  const nullableIn = (column: string, ids: readonly (number | null)[]): string => {
    const values = ids.filter((id): id is number => id !== null);
    const parts: string[] = [];
    if (values.length > 0) parts.push(inList(column, values));
    if (ids.includes(null)) parts.push(`${column} IS NULL`);
    return anyOf(parts);
  };
  const tagged = (ids?: readonly number[]): string =>
    `EXISTS (SELECT 1 FROM task_tags tt WHERE tt.task_id = t.id${ids ? ` AND ${inList('tt.tag_id', ids)}` : ''})`;

  if (nonEmpty(filter.ids)) clauses.push(inList('t.id', filter.ids));
  // Projects: an explicit list wins; otherwise archived projects are hidden unless requested.
  if (nonEmpty(filter.projectIds)) clauses.push(inList('t.project_id', filter.projectIds));
  else if (!filter.includeArchivedProjects) clauses.push("p.status <> 'archived'");

  if (nonEmpty(filter.milestoneIds)) clauses.push(nullableIn('e.milestone_id', filter.milestoneIds));
  if (nonEmpty(filter.epicIds)) clauses.push(nullableIn('t.epic_id', filter.epicIds));
  if (nonEmpty(filter.statusIds)) clauses.push(inList('t.status_id', filter.statusIds));
  if (nonEmpty(filter.statusCategories)) clauses.push(inList('s.category', filter.statusCategories));
  if (nonEmpty(filter.priorities)) clauses.push(inList('t.priority', filter.priorities));

  if (nonEmpty(filter.tagIds)) {
    const wanted = [...new Set(filter.tagIds.filter((id): id is number => id !== null))];
    const wantsUntagged = filter.tagIds.includes(null);
    if ((filter.tagMode ?? 'any') === 'all') {
      if (wanted.length > 0) {
        // task_tags has PRIMARY KEY (task_id, tag_id), so COUNT(*) counts distinct matches.
        clauses.push(
          `(SELECT COUNT(*) FROM task_tags tt WHERE tt.task_id = t.id AND ${inList('tt.tag_id', wanted)}) = ${param(wanted.length)}`,
        );
      } else if (wantsUntagged) {
        clauses.push(`NOT ${tagged()}`);
      }
    } else {
      const parts: string[] = [];
      if (wanted.length > 0) parts.push(tagged(wanted));
      if (wantsUntagged) parts.push(`NOT ${tagged()}`);
      clauses.push(anyOf(parts));
    }
  }
  if (nonEmpty(filter.excludeTagIds)) clauses.push(`NOT ${tagged(filter.excludeTagIds)}`);

  if (nonEmpty(filter.due)) {
    const parts = [...new Set(filter.due)].map((preset) => {
      const r = resolveDuePreset(preset, ctx.today, ctx.weekStartsOn);
      switch (r.kind) {
        case 'overdue':
          return `(t.due_date < ${param(r.before)} AND NOT ${TASK_CLOSED_SQL})`;
        case 'none':
          return 't.due_date IS NULL';
        case 'any':
          return 't.due_date IS NOT NULL';
        case 'range': {
          const range = ['t.due_date IS NOT NULL'];
          if (r.from !== null) range.push(`t.due_date >= ${param(r.from)}`);
          if (r.to !== null) range.push(`t.due_date <= ${param(r.to)}`);
          return `(${range.join(' AND ')})`;
        }
      }
    });
    clauses.push(anyOf(parts));
  }
  if (filter.dueFrom || filter.dueTo) {
    clauses.push('t.due_date IS NOT NULL');
    if (filter.dueFrom) clauses.push(`t.due_date >= ${param(filter.dueFrom)}`);
    if (filter.dueTo) clauses.push(`t.due_date <= ${param(filter.dueTo)}`);
  }

  // Same haystack as the JS reference (`${title}\n${description}\n${ref}`), lower-cased by
  // lyren_lower (= JS toLowerCase) so Unicode folding is identical.
  for (const token of searchTokens(filter.search)) {
    clauses.push(
      `instr(lyren_lower(t.title || char(10) || t.description || char(10) || ${TASK_REF_SQL}), ${param(token)}) > 0`,
    );
  }

  const archived = filter.archived ?? 'exclude';
  if (archived === 'exclude') clauses.push('t.archived_at IS NULL');
  else if (archived === 'only') clauses.push('t.archived_at IS NOT NULL');

  const days = filter.closedWithinDays;
  if (days !== undefined && days !== null) {
    if (days === 0) {
      clauses.push(`NOT ${TASK_CLOSED_SQL}`);
    } else {
      const cutoffIso = new Date(ctx.nowMs - days * 86_400_000).toISOString();
      clauses.push(`(NOT ${TASK_CLOSED_SQL} OR t.completed_at IS NULL OR t.completed_at >= ${param(cutoffIso)})`);
    }
  }

  return { sql: clauses.length > 0 ? clauses.join('\n AND ') : '1', params };
}

/**
 * ORDER BY list (over TASK_FROM aliases) equivalent to compareTasks(a, b, sort):
 * nulls (and priority 0) always last, ties broken by rank then id (both ascending);
 * 'manual' is rank, id in the requested direction.
 *
 * Known edge: titles compare as UTF-8 bytes in SQLite but UTF-16 code units in JS, which
 * only differ for supplementary-plane characters vs U+E000–U+FFFF at the same position.
 */
export function taskOrderBy(sort: TaskSort): string {
  const dir = sort.dir === 'desc' ? 'DESC' : 'ASC';
  const tie = 't.rank ASC, t.id ASC';
  switch (sort.field) {
    case 'manual':
      return `t.rank ${dir}, t.id ${dir}`;
    case 'priority':
      return `t.priority = 0, t.priority ${dir}, ${tie}`;
    case 'dueDate':
      return `t.due_date IS NULL, t.due_date ${dir}, ${tie}`;
    case 'startDate':
      return `t.start_date IS NULL, t.start_date ${dir}, ${tie}`;
    case 'estimate':
      return `t.estimate IS NULL, t.estimate ${dir}, ${tie}`;
    case 'createdAt':
      return `t.created_at ${dir}, ${tie}`;
    case 'updatedAt':
      return `t.updated_at ${dir}, ${tie}`;
    case 'title':
      // NOCASE folds ASCII only, like the reference's asciiLower().
      return `t.title COLLATE NOCASE ${dir}, ${tie}`;
    case 'number':
      return `t.project_id ${dir}, t.number ${dir}, ${tie}`;
    case 'status':
      return `s.position ${dir}, ${tie}`;
  }
}

export interface TaskQueryOptions {
  /** Epoch ms for closedWithinDays (default Date.now()). */
  nowMs?: number;
  /** Fallback when input.today is absent (default: server UTC date). */
  today?: ISODate;
  /** Fallback when input.weekStartsOn is absent (default: settings.weekStartsOn). */
  weekStartsOn?: WeekStart;
}

/**
 * POST /api/tasks/query. Filter default {} (which still hides archived tasks and archived
 * projects), sort default manual/asc, limit default LIMITS.queryLimitDefault, offset 0.
 */
export function queryTasks(db: Db, input: TaskQueryInput = {}, opts: TaskQueryOptions = {}): TaskQueryResult {
  const ctx: TaskWhereContext = {
    today: input.today ?? opts.today ?? serverToday(),
    weekStartsOn: input.weekStartsOn ?? opts.weekStartsOn ?? getSettings(db).weekStartsOn,
    nowMs: opts.nowMs ?? Date.now(),
  };
  const where = buildTaskWhere(input.filter ?? {}, ctx);
  const limit = Math.min(Math.max(1, input.limit ?? LIMITS.queryLimitDefault), LIMITS.queryLimitMax);
  const offset = Math.max(0, input.offset ?? 0);
  const rows = db.all<TaskRow>(
    `SELECT t.* FROM ${TASK_FROM}
      WHERE ${where.sql}
      ORDER BY ${taskOrderBy(input.sort ?? DEFAULT_TASK_SORT)}
      LIMIT :limit OFFSET :offset`,
    { ...where.params, limit, offset },
  );
  const complete = rows.length < limit && (offset === 0 || rows.length > 0);
  const total = complete
    ? offset + rows.length
    : db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${TASK_FROM} WHERE ${where.sql}`, where.params)!.n;
  return { tasks: hydrateTasks(db, rows), total };
}
