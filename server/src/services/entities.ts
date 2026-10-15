// Entity lookups shared by every route: DTO lists/getters (with stats), row-or-404
// guards, and small helpers for keys, positions, numbering and reorder validation.

import { LIMITS } from '@shared/constants';
import type { BoardDTO, EpicDTO, MilestoneDTO, ProjectDTO, StatusDTO, TagDTO } from '@shared/types';
import type { Db } from '../db';
import { badRequest, conflict, notFound } from '../http/errors';
import { compareTagNames, toBoardDTO, toEpicDTO, toMilestoneDTO, toProjectDTO, toStatusDTO, toTagDTO } from './mappers';
import type {
  BoardRow,
  CommentRow,
  EpicRow,
  MilestoneRow,
  ProjectRow,
  StatusRow,
  TagRow,
  TaskRow,
  WorklogRow,
} from './rows';
import { inJson, jsonList } from './sql';
import {
  emptyMilestoneStats,
  emptyProgressStats,
  emptyProjectStats,
  epicStats,
  milestoneStats,
  projectStats,
  statusTaskCounts,
  tagTaskCounts,
} from './stats';

// ---------------------------------------------------------------------------
// Row or 404
// ---------------------------------------------------------------------------

interface RowTypes {
  projects: ProjectRow;
  milestones: MilestoneRow;
  epics: EpicRow;
  statuses: StatusRow;
  tags: TagRow;
  tasks: TaskRow;
  boards: BoardRow;
  comments: CommentRow;
  work_logs: WorklogRow;
}

function requireRow<K extends keyof RowTypes>(db: Db, table: K, label: string, id: number): RowTypes[K] {
  const row = db.get<RowTypes[K]>(`SELECT * FROM ${table} WHERE id = :id`, { id });
  if (!row) throw notFound(label);
  return row;
}

export const requireProject = (db: Db, id: number): ProjectRow => requireRow(db, 'projects', 'Project', id);
export const requireMilestone = (db: Db, id: number): MilestoneRow => requireRow(db, 'milestones', 'Milestone', id);
export const requireEpic = (db: Db, id: number): EpicRow => requireRow(db, 'epics', 'Epic', id);
export const requireStatus = (db: Db, id: number): StatusRow => requireRow(db, 'statuses', 'Status', id);
export const requireTag = (db: Db, id: number): TagRow => requireRow(db, 'tags', 'Tag', id);
export const requireTask = (db: Db, id: number): TaskRow => requireRow(db, 'tasks', 'Task', id);
export const requireBoard = (db: Db, id: number): BoardRow => requireRow(db, 'boards', 'Board', id);
export const requireComment = (db: Db, id: number): CommentRow => requireRow(db, 'comments', 'Comment', id);
export const requireWorklog = (db: Db, id: number): WorklogRow => requireRow(db, 'work_logs', 'Work log', id);

/**
 * Validate a list of tag ids: duplicates are dropped, unknown ids -> 400 listing them
 * (detail path `path`, default 'tagIds'). Returns the tag rows in input order.
 */
export function requireTagIds(db: Db, ids: readonly number[], path = 'tagIds'): TagRow[] {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const rows = db.all<TagRow>(`SELECT * FROM tags WHERE ${inJson('id', 'ids')}`, { ids: jsonList(unique) });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const missing = unique.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    const message = `Unknown tag id${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`;
    throw badRequest(message, [{ path, message }]);
  }
  return unique.map((id) => byId.get(id)!);
}

// ---------------------------------------------------------------------------
// DTO lists / getters
// ---------------------------------------------------------------------------

/** All projects (archived included) ordered by position; `today` drives stats.tasksOverdue. */
export function listProjects(db: Db, today: string): ProjectDTO[] {
  const rows = db.all<ProjectRow>('SELECT * FROM projects ORDER BY position, id');
  const stats = projectStats(db, today);
  return rows.map((r) => toProjectDTO(r, stats.get(r.id) ?? emptyProjectStats()));
}

/** One project with stats, or 404. */
export function getProject(db: Db, id: number, today: string): ProjectDTO {
  const row = requireProject(db, id);
  return toProjectDTO(row, projectStats(db, today, [id]).get(id) ?? emptyProjectStats());
}

/** Milestones of one project (by position) or of all projects (by project position, then position). */
export function listMilestones(db: Db, projectId?: number): MilestoneDTO[] {
  const rows =
    projectId === undefined
      ? db.all<MilestoneRow>(
          `SELECT m.* FROM milestones m JOIN projects p ON p.id = m.project_id
            ORDER BY p.position, p.id, m.position, m.id`,
        )
      : db.all<MilestoneRow>('SELECT * FROM milestones WHERE project_id = :projectId ORDER BY position, id', {
          projectId,
        });
  const stats = milestoneStats(db, projectId === undefined ? undefined : rows.map((r) => r.id));
  return rows.map((r) => toMilestoneDTO(r, stats.get(r.id) ?? emptyMilestoneStats()));
}

export function getMilestone(db: Db, id: number): MilestoneDTO {
  const row = requireMilestone(db, id);
  return toMilestoneDTO(row, milestoneStats(db, [id]).get(id) ?? emptyMilestoneStats());
}

/** Epics of one project (by position) or of all projects (by project position, then position). */
export function listEpics(db: Db, projectId?: number): EpicDTO[] {
  const rows =
    projectId === undefined
      ? db.all<EpicRow>(
          `SELECT e.* FROM epics e JOIN projects p ON p.id = e.project_id
            ORDER BY p.position, p.id, e.position, e.id`,
        )
      : db.all<EpicRow>('SELECT * FROM epics WHERE project_id = :projectId ORDER BY position, id', { projectId });
  const stats = epicStats(db, projectId === undefined ? undefined : rows.map((r) => r.id));
  return rows.map((r) => toEpicDTO(r, stats.get(r.id) ?? emptyProgressStats()));
}

export function getEpic(db: Db, id: number): EpicDTO {
  const row = requireEpic(db, id);
  return toEpicDTO(row, epicStats(db, [id]).get(id) ?? emptyProgressStats());
}

/** Statuses by position; taskCount includes archived tasks. */
export function listStatuses(db: Db): StatusDTO[] {
  const rows = db.all<StatusRow>('SELECT * FROM statuses ORDER BY position, id');
  const counts = statusTaskCounts(db);
  return rows.map((r) => toStatusDTO(r, counts.get(r.id) ?? 0));
}

export function getStatus(db: Db, id: number): StatusDTO {
  const row = requireStatus(db, id);
  return toStatusDTO(row, statusTaskCounts(db, [id]).get(id) ?? 0);
}

/** Tags by name (case-insensitive); taskCount counts non-archived tasks. */
export function listTags(db: Db): TagDTO[] {
  const rows = db.all<TagRow>('SELECT * FROM tags');
  const counts = tagTaskCounts(db);
  return rows.sort(compareTagNames).map((r) => toTagDTO(r, counts.get(r.id) ?? 0));
}

export function getTag(db: Db, id: number): TagDTO {
  const row = requireTag(db, id);
  return toTagDTO(row, tagTaskCounts(db, [id]).get(id) ?? 0);
}

/**
 * Boards: `projectId` undefined = every board (global ones first, then per project);
 * null = global boards only; a number = that project's boards. Each scope by position.
 */
export function listBoards(db: Db, projectId?: number | null): BoardDTO[] {
  const rows =
    projectId === undefined
      ? db.all<BoardRow>('SELECT * FROM boards ORDER BY project_id IS NOT NULL, project_id, position, id')
      : db.all<BoardRow>('SELECT * FROM boards WHERE project_id IS :projectId ORDER BY position, id', { projectId });
  return rows.map(toBoardDTO);
}

export function getBoard(db: Db, id: number): BoardDTO {
  return toBoardDTO(requireBoard(db, id));
}

// ---------------------------------------------------------------------------
// Statuses, keys, numbering, positions
// ---------------------------------------------------------------------------

/** Status for new tasks: the first 'unstarted' status by position, else the first status. */
export function defaultStatusId(db: Db): number {
  const row = db.get<{ id: number }>(
    "SELECT id FROM statuses ORDER BY category <> 'unstarted', position, id LIMIT 1",
  );
  if (!row) throw conflict('No task status exists; create one first');
  return row.id;
}

/** True when another project (other than `exceptId`) already uses `key` (case-insensitive). */
export function isProjectKeyTaken(db: Db, key: string, exceptId?: number): boolean {
  return (
    db.get('SELECT 1 FROM projects WHERE key = :key AND id IS NOT :exceptId', { key, exceptId: exceptId ?? null }) !==
    undefined
  );
}

/** `base` if free, else base + 2, 3, … (truncated so the key stays within LIMITS.projectKeyMax). */
export function uniqueProjectKey(db: Db, base: string): string {
  if (!isProjectKeyTaken(db, base)) return base;
  for (let n = 2; ; n++) {
    const suffix = String(n);
    const candidate = base.slice(0, LIMITS.projectKeyMax - suffix.length) + suffix;
    if (!isProjectKeyTaken(db, candidate)) return candidate;
  }
}

/**
 * Key derived from a project name (SPEC §5.1): initials of up to 4 words when the name has
 * at least two words, else its first 3 characters; ASCII letters/digits only (diacritics are
 * stripped), uppercase; prefixed with 'P' unless it starts with a letter; padded with 'X'
 * to the minimum length; made unique by appending 2, 3, …
 */
export function generateProjectKey(db: Db, name: string): string {
  return uniqueProjectKey(db, baseProjectKey(name));
}

/** The deterministic part of generateProjectKey (before the uniqueness suffix). */
export function baseProjectKey(name: string): string {
  const words = name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  let key = words.length >= 2 ? words.slice(0, 4).map((w) => w.charAt(0)).join('') : (words[0] ?? '').slice(0, 3);
  key = key.toUpperCase();
  if (!/^[A-Z]/.test(key)) key = `P${key}`;
  return key.padEnd(LIMITS.projectKeyMin, 'X').slice(0, LIMITS.projectKeyMax);
}

/** Issue the next task number of a project (`++projects.task_counter`). Call inside the task's transaction. */
export function nextTaskNumber(db: Db, projectId: number): number {
  const row = db.get<{ task_counter: number }>(
    'UPDATE projects SET task_counter = task_counter + 1 WHERE id = :projectId RETURNING task_counter',
    { projectId },
  );
  if (!row) throw notFound('Project');
  return row.task_counter;
}

type PositionedTable = 'projects' | 'statuses' | 'milestones' | 'epics' | 'boards';

/** Position for a new row appended to its scope (max + 1, or 0 when empty). */
export function nextPosition(db: Db, table: 'projects' | 'statuses'): number;
export function nextPosition(db: Db, table: 'milestones' | 'epics', projectId: number): number;
/** Boards: projectId null = the global scope. */
export function nextPosition(db: Db, table: 'boards', projectId: number | null): number;
export function nextPosition(db: Db, table: PositionedTable, projectId?: number | null): number {
  const scoped = table === 'milestones' || table === 'epics' || table === 'boards';
  const row = db.get<{ n: number }>(
    `SELECT COALESCE(MAX(position), -1) + 1 AS n FROM ${table} WHERE ${scoped ? 'project_id IS :projectId' : '1'}`,
    { projectId: projectId ?? null },
  );
  return row?.n ?? 0;
}

/**
 * Persist a reorder: position = index in `ids`. Validate the id set with assertExactIdSet first.
 * Does not touch updated_at. Runs in its own (nested) transaction.
 */
export function applyPositions(db: Db, table: PositionedTable, ids: readonly number[]): void {
  db.tx(() => {
    ids.forEach((id, position) => db.run(`UPDATE ${table} SET position = :position WHERE id = :id`, { id, position }));
  });
}

/**
 * Reorder endpoints must receive exactly the ids of their scope, each once.
 * Throws 400 (detail path `path`) naming duplicates, unknown and missing ids.
 */
export function assertExactIdSet(ids: readonly number[], expectedIds: Iterable<number>, path = 'ids'): void {
  const expected = new Set(expectedIds);
  const seen = new Set<number>();
  const duplicates = new Set<number>();
  for (const id of ids) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  const unknown = [...seen].filter((id) => !expected.has(id));
  const missing = [...expected].filter((id) => !seen.has(id));
  const problems: string[] = [];
  if (duplicates.size > 0) problems.push(`duplicate ids: ${[...duplicates].join(', ')}`);
  if (unknown.length > 0) problems.push(`unknown ids: ${unknown.join(', ')}`);
  if (missing.length > 0) problems.push(`missing ids: ${missing.join(', ')}`);
  if (problems.length === 0) return;
  const message = `The list must contain every id of the scope exactly once (${problems.join('; ')})`;
  throw badRequest(message, [{ path, message }]);
}
