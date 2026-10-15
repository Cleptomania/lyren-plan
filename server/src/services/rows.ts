// Row shapes of every table in db/schema.ts, exactly as node:sqlite returns them
// (snake_case columns; INTEGER/REAL -> number; TEXT -> string; NULL -> null).

import type { EpicStatus, MilestoneStatus, Priority, ProjectStatus, StatusCategory } from '@shared/constants';

export type { SessionRow, UserRow } from '../auth/sessions';

export interface SettingRow {
  key: string;
  /** JSON-encoded value. */
  value: string;
}

export interface ProjectRow {
  id: number;
  key: string;
  name: string;
  description: string;
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
  description: string;
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
  description: string;
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
  description: string;
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
}

export interface TagRow {
  id: number;
  name: string;
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
 * Author columns joined onto comment / work-log rows:
 * `LEFT JOIN users u ON u.id = c.user_id` selecting `u.display_name AS author_name`.
 */
export interface AuthorJoin {
  author_name: string | null;
}
