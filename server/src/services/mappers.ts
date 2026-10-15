// Row -> DTO mappers. These produce exactly the shapes in shared/src/types.ts.
// Aggregates (stats, counts) are computed by stats.ts and passed in.

import { parseBoardConfigLenient } from '@shared/board';
import type {
  BoardDTO,
  CommentDTO,
  EpicDTO,
  MilestoneDTO,
  ProgressStats,
  ProjectDTO,
  ProjectStats,
  StatusDTO,
  TagDTO,
  TagRef,
  UserRef,
  WorklogDTO,
} from '@shared/types';
import type {
  AuthorJoin,
  BoardRow,
  CommentRow,
  EpicRow,
  MilestoneRow,
  ProjectRow,
  StatusRow,
  TagRow,
  WorklogRow,
} from './rows';

/** SELECT for comments with the author's display name (alias `c`). Append WHERE/ORDER BY. */
export const COMMENT_SELECT =
  'SELECT c.*, u.display_name AS author_name FROM comments c LEFT JOIN users u ON u.id = c.user_id';

/** SELECT for work logs with the author's display name (alias `w`). Append WHERE/ORDER BY. */
export const WORKLOG_SELECT =
  'SELECT w.*, u.display_name AS author_name FROM work_logs w LEFT JOIN users u ON u.id = w.user_id';

/** JSON.parse that never throws (returns `fallback` for malformed input). */
export function parseJson(text: string | null | undefined, fallback: unknown = null): unknown {
  if (text === null || text === undefined) return fallback;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return fallback;
  }
}

export function toUserRef(id: number | null, displayName: string | null): UserRef | null {
  return id !== null && displayName !== null ? { id, displayName } : null;
}

export function toProjectDTO(row: ProjectRow, stats: ProjectStats): ProjectDTO {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    color: row.color,
    status: row.status,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    stats,
  };
}

export function toMilestoneDTO(row: MilestoneRow, stats: MilestoneDTO['stats']): MilestoneDTO {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    description: row.description,
    status: row.status,
    startDate: row.start_date,
    dueDate: row.due_date,
    position: row.position,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    stats,
  };
}

export function toEpicDTO(row: EpicRow, stats: ProgressStats): EpicDTO {
  return {
    id: row.id,
    projectId: row.project_id,
    milestoneId: row.milestone_id,
    name: row.name,
    description: row.description,
    color: row.color,
    status: row.status,
    startDate: row.start_date,
    dueDate: row.due_date,
    position: row.position,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    stats,
  };
}

export function toStatusDTO(row: StatusRow, taskCount: number): StatusDTO {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    color: row.color,
    position: row.position,
    taskCount,
  };
}

export function toTagRef(row: Pick<TagRow, 'id' | 'name' | 'color'>): TagRef {
  return { id: row.id, name: row.name, color: row.color };
}

export function toTagDTO(row: TagRow, taskCount: number): TagDTO {
  return { id: row.id, name: row.name, color: row.color, taskCount, createdAt: row.created_at };
}

/** Case-insensitive tag-name order (same comparator the web client uses), ties by id. */
export function compareTagNames(a: Pick<TagRef, 'id' | 'name'>, b: Pick<TagRef, 'id' | 'name'>): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id - b.id;
}

export function toBoardDTO(row: BoardRow): BoardDTO {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    description: row.description,
    config: parseBoardConfigLenient(parseJson(row.config, {})),
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toCommentDTO(row: CommentRow & AuthorJoin): CommentDTO {
  return {
    id: row.id,
    taskId: row.task_id,
    body: row.body,
    author: toUserRef(row.user_id, row.author_name),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    editedAt: row.edited_at,
  };
}

export function toWorklogDTO(row: WorklogRow & AuthorJoin): WorklogDTO {
  return {
    id: row.id,
    taskId: row.task_id,
    date: row.date,
    minutes: row.minutes,
    note: row.note,
    author: toUserRef(row.user_id, row.author_name),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
