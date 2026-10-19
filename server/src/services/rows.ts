// Row shapes of every table of a space's database (space/schema.ts), exactly as the Db returns them
// (snake_case columns; INTEGER/REAL -> number; TEXT -> string; NULL -> null). *_fold columns hold
// fold(value) of their column (core/fold.ts, design §3.4): every write of the column writes its fold.

import type { EpicStatus, MilestoneStatus, Priority, ProjectStatus, StatusCategory } from '@shared/constants';

/** The users mirror (design §3.5): a directory account (id > 0) or an import's placeholder (id < 0). */
export interface MirrorUserRow {
  id: number;
  kind: 'account' | 'placeholder';
  display_name: string;
  /** Accounts only; null after the account was deleted. */
  email: string | null;
  is_member: number;
  /** The directory account no longer exists. */
  deleted: number;
  updated_at: string;
}

export interface SettingRow {
  key: string;
  /** JSON-encoded value. */
  value: string;
}

export interface ProjectRow {
  id: number;
  key: string;
  name: string;
  name_fold: string;
  description: string;
  description_fold: string;
  color: string;
  status: ProjectStatus;
  position: number;
  /** Last task number issued in this project. */
  task_counter: number;
  created_at: string;
  updated_at: string;
}

export interface MilestoneRow {
  id: number;
  project_id: number;
  name: string;
  name_fold: string;
  description: string;
  description_fold: string;
  status: MilestoneStatus;
  start_date: string | null;
  due_date: string | null;
  position: number;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface EpicRow {
  id: number;
  project_id: number;
  milestone_id: number | null;
  name: string;
  name_fold: string;
  description: string;
  description_fold: string;
  color: string;
  status: EpicStatus;
  start_date: string | null;
  due_date: string | null;
  position: number;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface StatusRow {
  id: number;
  name: string;
  name_fold: string;
  category: StatusCategory;
  color: string;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface TaskRow {
  id: number;
  project_id: number;
  number: number;
  epic_id: number | null;
  status_id: number;
  title: string;
  title_fold: string;
  description: string;
  description_fold: string;
  priority: Priority;
  start_date: string | null;
  due_date: string | null;
  estimate: number | null;
  rank: string;
  completed_at: string | null;
  archived_at: string | null;
  created_by: number | null;
  created_at: string;
  updated_at: string;
  /** JSON array of the task's tag ids, ascending: kept from task_tags by triggers (space/schema.ts, migration 2). */
  tag_ids: string;
  /** Its comments, and the minutes of its work logs: kept by triggers (space/schema.ts, migration 3). */
  comment_count: number;
  worklog_minutes: number;
}

export interface TagRow {
  id: number;
  name: string;
  name_fold: string;
  color: string;
  created_at: string;
  updated_at: string;
}

export interface TaskTagRow {
  task_id: number;
  tag_id: number;
}

export interface CommentRow {
  id: number;
  task_id: number;
  user_id: number | null;
  body: string;
  created_at: string;
  updated_at: string;
  edited_at: string | null;
  /** Import provenance (design §8.6): the importer, when the import attributed the row to someone else. */
  imported_by: number | null;
  imported_at: string | null;
}

export interface WorklogRow {
  id: number;
  task_id: number;
  user_id: number | null;
  date: string;
  minutes: number | null;
  note: string;
  created_at: string;
  updated_at: string;
  imported_by: number | null;
  imported_at: string | null;
}

export interface ActivityRow {
  id: number;
  user_id: number | null;
  project_id: number | null;
  task_id: number | null;
  entity_type: string;
  entity_id: number | null;
  action: string;
  /** JSON-encoded ActivityData. */
  data: string;
  created_at: string;
  imported_by: number | null;
  imported_at: string | null;
}

export interface BoardRow {
  id: number;
  project_id: number | null;
  name: string;
  description: string;
  /** JSON-encoded BoardConfig (parse with parseBoardConfigLenient via toBoardDTO). */
  config: string;
  position: number;
  created_at: string;
  updated_at: string;
}

/**
 * Author columns joined onto comment / work-log rows: `LEFT JOIN users u ON u.id = c.user_id` selecting
 * `u.display_name AS author_name`, and `LEFT JOIN users ib ON ib.id = c.imported_by` selecting
 * `ib.display_name AS imported_by_name`.
 */
export interface AuthorJoin {
  author_name: string | null;
  imported_by_name: string | null;
}
