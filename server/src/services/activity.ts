// Activity history (SPEC §5.8): recording entries, building field-level change lists,
// and reading feeds.

import {
  EPIC_STATUS_LABELS,
  MILESTONE_STATUS_LABELS,
  PRIORITY_META,
  PROJECT_STATUS_LABELS,
} from '@shared/constants';
import { sanitizeActivityData } from '@shared/export';
import type {
  ActivityAction,
  ActivityData,
  ActivityDTO,
  ActivityEntityType,
  ActivityPage,
  FieldChange,
  TagRef,
} from '@shared/types';
import type { Db } from '../db';
import { parseJson } from './mappers';
import type { ActivityRow, EpicRow, MilestoneRow, ProjectRow, TaskRow } from './rows';
import { inJson, jsonList, nowIso } from './sql';
import { truncateText } from './text';

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

export interface ActivityEntry {
  userId: number | null;
  /** null only for project.deleted. */
  projectId: number | null;
  /** The task for task/comment/worklog events (null for task.deleted and structural events). */
  taskId: number | null;
  entityType: ActivityEntityType;
  entityId: number | null;
  action: ActivityAction;
  data?: ActivityData;
  /** Defaults to now. */
  createdAt?: string;
}

/** Insert one activity row (call inside the mutation's transaction). Returns its id. */
export function recordActivity(db: Db, entry: ActivityEntry): number {
  return db.run(
    `INSERT INTO activity (user_id, project_id, task_id, entity_type, entity_id, action, data, created_at)
     VALUES (:userId, :projectId, :taskId, :entityType, :entityId, :action, :data, :createdAt)`,
    {
      userId: entry.userId,
      projectId: entry.projectId,
      taskId: entry.taskId,
      entityType: entry.entityType,
      entityId: entry.entityId,
      action: entry.action,
      data: JSON.stringify(entry.data ?? {}),
      createdAt: entry.createdAt ?? nowIso(),
    },
  ).lastInsertRowid;
}

// ---------------------------------------------------------------------------
// Field changes
// ---------------------------------------------------------------------------

type Scalar = string | number | boolean | null;

/** A changed scalar field with raw values and optional display labels; null when unchanged. */
export function valueChange(
  field: string,
  from: Scalar,
  to: Scalar,
  labels?: { from: string | null; to: string | null },
): FieldChange | null {
  if (from === to) return null;
  const change: FieldChange = { field, from, to };
  if (labels) {
    change.fromLabel = labels.from;
    change.toLabel = labels.to;
  }
  return change;
}

/** A changed field recorded without values (description, color); null when unchanged. */
export function flagChange(field: string, from: Scalar, to: Scalar): FieldChange | null {
  return from === to ? null : { field };
}

/** Set difference by id, recorded as `added` / `removed` names (sorted); null when equal. */
export function setChange(
  field: string,
  before: ReadonlyArray<Pick<TagRef, 'id' | 'name'>>,
  after: ReadonlyArray<Pick<TagRef, 'id' | 'name'>>,
): FieldChange | null {
  const beforeIds = new Set(before.map((t) => t.id));
  const afterIds = new Set(after.map((t) => t.id));
  const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' });
  const added = after.filter((t) => !beforeIds.has(t.id)).map((t) => t.name).sort(byName);
  const removed = before.filter((t) => !afterIds.has(t.id)).map((t) => t.name).sort(byName);
  if (added.length === 0 && removed.length === 0) return null;
  return { field, added, removed };
}

/** Drop the nulls produced by the change helpers. */
export function compactChanges(changes: ReadonlyArray<FieldChange | null>): FieldChange[] {
  return changes.filter((c): c is FieldChange => c !== null);
}

function namesById(db: Db, table: 'statuses' | 'epics' | 'milestones', ids: Array<number | null>): Map<number, string> {
  const wanted = ids.filter((id): id is number => id !== null);
  if (wanted.length === 0) return new Map();
  const rows = db.all<{ id: number; name: string }>(`SELECT id, name FROM ${table} WHERE ${inJson('id', 'ids')}`, {
    ids: jsonList(wanted),
  });
  return new Map(rows.map((r) => [r.id, r.name]));
}

function labelled(names: Map<number, string>, id: number | null): string | null {
  return id === null ? null : (names.get(id) ?? null);
}

/**
 * Field changes between two versions of a task (for `task.updated`), in SPEC order:
 * title, description, status, priority, epic, startDate, dueDate, estimate, tags, archived.
 * Pass `tags` when the tag set may have changed. Status/epic names are looked up now
 * (call while both still exist, i.e. inside the mutation).
 */
export function taskChanges(
  db: Db,
  before: TaskRow,
  after: TaskRow,
  tags?: { before: ReadonlyArray<Pick<TagRef, 'id' | 'name'>>; after: ReadonlyArray<Pick<TagRef, 'id' | 'name'>> },
): FieldChange[] {
  const statuses = before.status_id !== after.status_id ? namesById(db, 'statuses', [before.status_id, after.status_id]) : null;
  const epics = before.epic_id !== after.epic_id ? namesById(db, 'epics', [before.epic_id, after.epic_id]) : null;
  return compactChanges([
    valueChange('title', before.title, after.title),
    flagChange('description', before.description, after.description),
    statuses &&
      valueChange('status', before.status_id, after.status_id, {
        from: labelled(statuses, before.status_id),
        to: labelled(statuses, after.status_id),
      }),
    valueChange('priority', before.priority, after.priority, {
      from: PRIORITY_META[before.priority].label,
      to: PRIORITY_META[after.priority].label,
    }),
    epics &&
      valueChange('epic', before.epic_id, after.epic_id, {
        from: labelled(epics, before.epic_id),
        to: labelled(epics, after.epic_id),
      }),
    valueChange('startDate', before.start_date, after.start_date),
    valueChange('dueDate', before.due_date, after.due_date),
    valueChange('estimate', before.estimate, after.estimate),
    tags ? setChange('tags', tags.before, tags.after) : null,
    valueChange('archived', before.archived_at !== null, after.archived_at !== null),
  ]);
}

/** Changes for `project.updated`: name, key, status (labels), color and description (no values). */
export function projectChanges(before: ProjectRow, after: ProjectRow): FieldChange[] {
  return compactChanges([
    valueChange('name', before.name, after.name),
    valueChange('key', before.key, after.key),
    valueChange('status', before.status, after.status, {
      from: PROJECT_STATUS_LABELS[before.status],
      to: PROJECT_STATUS_LABELS[after.status],
    }),
    flagChange('color', before.color, after.color),
    flagChange('description', before.description, after.description),
  ]);
}

/** Changes for `milestone.updated`: name, status (labels), startDate, dueDate, description (no values). */
export function milestoneChanges(before: MilestoneRow, after: MilestoneRow): FieldChange[] {
  return compactChanges([
    valueChange('name', before.name, after.name),
    valueChange('status', before.status, after.status, {
      from: MILESTONE_STATUS_LABELS[before.status],
      to: MILESTONE_STATUS_LABELS[after.status],
    }),
    valueChange('startDate', before.start_date, after.start_date),
    valueChange('dueDate', before.due_date, after.due_date),
    flagChange('description', before.description, after.description),
  ]);
}

/**
 * Changes for `epic.updated`: name, status (labels), milestone (ids + names), startDate,
 * dueDate, color and description (no values).
 */
export function epicChanges(db: Db, before: EpicRow, after: EpicRow): FieldChange[] {
  const milestones =
    before.milestone_id !== after.milestone_id
      ? namesById(db, 'milestones', [before.milestone_id, after.milestone_id])
      : null;
  return compactChanges([
    valueChange('name', before.name, after.name),
    valueChange('status', before.status, after.status, {
      from: EPIC_STATUS_LABELS[before.status],
      to: EPIC_STATUS_LABELS[after.status],
    }),
    milestones &&
      valueChange('milestone', before.milestone_id, after.milestone_id, {
        from: labelled(milestones, before.milestone_id),
        to: labelled(milestones, after.milestone_id),
      }),
    valueChange('startDate', before.start_date, after.start_date),
    valueChange('dueDate', before.due_date, after.due_date),
    flagChange('color', before.color, after.color),
    flagChange('description', before.description, after.description),
  ]);
}

/** First 200 characters of a comment body for `comment.*` data (never half an emoji). */
export function commentExcerpt(body: string): string {
  return truncateText(body, 200);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export const ACTIVITY_PAGE_DEFAULT = 50;
export const ACTIVITY_PAGE_MAX = 200;

/** Stored data, with anything that doesn't match the ActivityData shapes dropped (SPEC §5.8). */
function asActivityData(text: string): ActivityData {
  return sanitizeActivityData(parseJson(text, {}));
}

/**
 * Activity rows -> DTOs with the actor, the importer (provenance, design §8.6) and the CURRENT task
 * ref/title (null once deleted). Batched.
 */
export function hydrateActivity(db: Db, rows: readonly ActivityRow[]): ActivityDTO[] {
  if (rows.length === 0) return [];
  const userIds = rows.flatMap((r) => [r.user_id, r.imported_by]).filter((id): id is number => id !== null);
  const taskIds = rows.map((r) => r.task_id).filter((id): id is number => id !== null);
  const users = new Map(
    (userIds.length === 0
      ? []
      : db.all<{ id: number; display_name: string }>(`SELECT id, display_name FROM users WHERE ${inJson('id', 'ids')}`, {
          ids: jsonList(userIds),
        })
    ).map((u) => [u.id, u.display_name]),
  );
  const tasks = new Map(
    (taskIds.length === 0
      ? []
      : db.all<{ id: number; title: string; ref: string }>(
          `SELECT t.id, t.title, p.key || '-' || t.number AS ref
             FROM tasks t JOIN projects p ON p.id = t.project_id
            WHERE ${inJson('t.id', 'ids')}`,
          { ids: jsonList(taskIds) },
        )
    ).map((t) => [t.id, { id: t.id, ref: t.ref, title: t.title }]),
  );
  const userRef = (id: number | null) => {
    const displayName = id === null ? undefined : users.get(id);
    return id !== null && displayName !== undefined ? { id, displayName } : null;
  };
  return rows.map((r) => ({
    id: r.id,
    action: r.action as ActivityAction,
    entityType: r.entity_type as ActivityEntityType,
    entityId: r.entity_id,
    projectId: r.project_id,
    taskId: r.task_id,
    data: asActivityData(r.data),
    actor: userRef(r.user_id),
    createdAt: r.created_at,
    task: r.task_id === null ? null : (tasks.get(r.task_id) ?? null),
    importedBy: userRef(r.imported_by),
    importedAt: r.imported_at,
  }));
}

export interface ActivityListQuery {
  projectId?: number;
  taskId?: number;
  /** Cursor: only entries with id < before. */
  before?: number;
  /** Page size (default 50, clamped to 1..200). */
  limit?: number;
}

/** A feed page, newest first (by id); `nextBefore` is the cursor for the next (older) page. */
export function listActivity(db: Db, query: ActivityListQuery = {}): ActivityPage {
  const limit = Math.min(Math.max(Math.trunc(query.limit ?? ACTIVITY_PAGE_DEFAULT), 1), ACTIVITY_PAGE_MAX);
  const where: string[] = [];
  if (query.projectId !== undefined) where.push('project_id = :projectId');
  if (query.taskId !== undefined) where.push('task_id = :taskId');
  if (query.before !== undefined) where.push('id < :before');
  const rows = db.all<ActivityRow>(
    `SELECT * FROM activity ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT :limit`,
    { projectId: query.projectId, taskId: query.taskId, before: query.before, limit: limit + 1 },
  );
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return { items: hydrateActivity(db, page), nextBefore: hasMore ? page[page.length - 1]!.id : null };
}

/** A task's own history (entity_type 'task' only — comments/work logs have their own lists), oldest first. */
export function taskActivity(db: Db, taskId: number): ActivityDTO[] {
  const rows = db.all<ActivityRow>(
    "SELECT * FROM activity WHERE task_id = :taskId AND entity_type = 'task' ORDER BY id",
    { taskId },
  );
  return hydrateActivity(db, rows);
}
