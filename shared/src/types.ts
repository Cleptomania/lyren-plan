// API response shapes (DTOs). All timestamps are ISO-8601 UTC strings
// ('2026-10-13T20:15:00.000Z'); all calendar dates are 'YYYY-MM-DD'.
// Field names are camelCase; database columns are snake_case.

import type { BoardConfig } from './board';
import type {
  EpicStatus,
  MilestoneStatus,
  Priority,
  ProjectStatus,
  StatusCategory,
} from './constants';
import type { Settings } from './schemas';

export interface UserDTO {
  id: number;
  username: string;
  displayName: string;
  createdAt: string;
}

export interface SessionDTO {
  id: number;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  userAgent: string | null;
  ip: string | null;
  /** True for the session making the request. */
  current: boolean;
}

/** Minimal author/actor reference embedded in comments, work logs and activity. */
export interface UserRef {
  id: number;
  displayName: string;
}

/**
 * Progress counts every non-archived task plus archived CLOSED tasks, so archiving finished work
 * never moves progress backwards. An archived OPEN task is abandoned work and counts nowhere.
 */
export interface ProjectStats {
  /** Counted tasks: non-archived, or archived with a closed status. */
  tasksTotal: number;
  /** Non-archived tasks whose status category is not closed. */
  tasksOpen: number;
  /** Tasks (archived or not) whose status category is completed or cancelled. */
  tasksClosed: number;
  /** Open, non-archived tasks with dueDate < the request's `today` (?today=, else server UTC date). */
  tasksOverdue: number;
  milestonesTotal: number;
  milestonesCompleted: number;
  epicsTotal: number;
  epicsDone: number;
}

export interface ProjectDTO {
  id: number;
  key: string;
  name: string;
  description: string;
  color: string;
  status: ProjectStatus;
  position: number;
  createdAt: string;
  updatedAt: string;
  stats: ProjectStats;
}

/** Progress of the tasks under a milestone or epic (non-archived ones plus archived closed ones; see ProjectStats). */
export interface ProgressStats {
  tasksTotal: number;
  tasksClosed: number;
  /** Sum of estimates of those tasks (null estimates count as 0). */
  estimateTotal: number;
  estimateClosed: number;
}

export interface MilestoneDTO {
  id: number;
  projectId: number;
  name: string;
  description: string;
  status: MilestoneStatus;
  startDate: string | null;
  dueDate: string | null;
  position: number;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  stats: ProgressStats & { epicsTotal: number; epicsDone: number };
}

export interface EpicDTO {
  id: number;
  projectId: number;
  milestoneId: number | null;
  name: string;
  description: string;
  color: string;
  status: EpicStatus;
  startDate: string | null;
  dueDate: string | null;
  position: number;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  stats: ProgressStats;
}

export interface StatusDTO {
  id: number;
  name: string;
  category: StatusCategory;
  color: string;
  position: number;
  /** Number of tasks (including archived) using this status. */
  taskCount: number;
}

export interface TagRef {
  id: number;
  name: string;
  color: string;
}

export interface TagDTO extends TagRef {
  /** Number of non-archived tasks with this tag. */
  taskCount: number;
  createdAt: string;
}

export interface TaskDTO {
  id: number;
  projectId: number;
  /** Per-project sequence number; together with the project key forms `ref`. */
  number: number;
  /** Human reference, e.g. 'LYR-42' (project key + number). */
  ref: string;
  epicId: number | null;
  /** Derived from the epic (tasks belong to milestones only through epics). */
  milestoneId: number | null;
  statusId: number;
  priority: Priority;
  title: string;
  description: string;
  startDate: string | null;
  dueDate: string | null;
  estimate: number | null;
  /** Fractional-index string; ascending rank = manual order. */
  rank: string;
  /** Set while the task's status category is completed/cancelled. */
  completedAt: string | null;
  archivedAt: string | null;
  createdBy: number | null;
  createdAt: string;
  updatedAt: string;
  /** Sorted by tag name (case-insensitive). */
  tags: TagRef[];
  commentCount: number;
  /** Sum of minutes across the task's work logs. */
  worklogMinutes: number;
}

export interface TaskQueryResult {
  tasks: TaskDTO[];
  /** Total matching tasks ignoring limit/offset. */
  total: number;
}

export interface CommentDTO {
  id: number;
  taskId: number;
  body: string;
  author: UserRef | null;
  createdAt: string;
  updatedAt: string;
  /** Set when the body was edited after creation. */
  editedAt: string | null;
}

export interface WorklogDTO {
  id: number;
  taskId: number;
  date: string;
  minutes: number | null;
  note: string;
  author: UserRef | null;
  createdAt: string;
  updatedAt: string;
}

export type ActivityEntityType = 'project' | 'milestone' | 'epic' | 'task' | 'comment' | 'worklog';

export type ActivityAction =
  | 'project.created' | 'project.updated' | 'project.deleted'
  | 'milestone.created' | 'milestone.updated' | 'milestone.deleted'
  | 'epic.created' | 'epic.updated' | 'epic.deleted'
  | 'task.created' | 'task.updated' | 'task.moved' | 'task.deleted'
  | 'comment.created' | 'comment.updated' | 'comment.deleted'
  | 'worklog.created' | 'worklog.updated' | 'worklog.deleted';

/**
 * One changed field in an `*.updated` activity entry. `from`/`to` hold raw values
 * (ids, dates, numbers, booleans); `fromLabel`/`toLabel` hold display snapshots
 * taken at the time of the change (e.g. status/epic names) so history stays
 * readable after renames or deletions. For `tags`, `added`/`removed` hold tag names.
 * For `description`, from/to are omitted (only the fact that it changed is kept).
 */
export interface FieldChange {
  field: string;
  from?: string | number | boolean | null;
  to?: string | number | boolean | null;
  fromLabel?: string | null;
  toLabel?: string | null;
  added?: string[];
  removed?: string[];
}

/** `data` payloads per action family (all optional fields are best-effort snapshots). */
export interface ActivityData {
  /** *.updated */
  changes?: FieldChange[];
  /** Display snapshot of the subject at the time (task title, milestone name ...). */
  title?: string;
  name?: string;
  /** task.*: the task ref at the time, e.g. 'LYR-12'. */
  ref?: string;
  /** task.moved */
  fromProjectId?: number;
  toProjectId?: number;
  fromProjectName?: string;
  toProjectName?: string;
  fromRef?: string;
  toRef?: string;
  /** comment.* : first ~200 chars of the body. */
  excerpt?: string;
  /** worklog.* */
  minutes?: number | null;
  date?: string;
  note?: string;
  [key: string]: unknown;
}

export interface ActivityDTO {
  id: number;
  action: ActivityAction;
  entityType: ActivityEntityType;
  entityId: number | null;
  projectId: number | null;
  taskId: number | null;
  data: ActivityData;
  actor: UserRef | null;
  createdAt: string;
  /** Current task reference when the task still exists. */
  task: { id: number; ref: string; title: string } | null;
}

export interface ActivityPage {
  items: ActivityDTO[];
  /** Pass as `before` to fetch the next (older) page; null when exhausted. */
  nextBefore: number | null;
}

export interface WorklogReportDTO {
  /** Newest date first, then newest created first. */
  items: Array<WorklogDTO & { task: { id: number; ref: string; title: string; projectId: number } }>;
  totalMinutes: number;
}

export interface TaskTimelineDTO {
  comments: CommentDTO[];
  worklogs: WorklogDTO[];
  activity: ActivityDTO[];
}

export interface BoardDTO {
  id: number;
  /** null = global board (Boards page); otherwise a board of that project (project Board tab). */
  projectId: number | null;
  name: string;
  description: string;
  config: BoardConfig;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface BootstrapDTO {
  user: UserDTO;
  settings: Settings;
  version: string;
  statuses: StatusDTO[];
  tags: TagDTO[];
  projects: ProjectDTO[];
  milestones: MilestoneDTO[];
  epics: EpicDTO[];
  boards: BoardDTO[];
  /** Only from the single-file desktop app (SPEC §12.1); absent for the Node build and Docker. */
  desktop?: DesktopDataDTO;
}

export interface AuthStatusDTO {
  /** True when no user exists yet; the UI must show the setup screen. */
  setupRequired: boolean;
  /** Setup must include the one-time code printed in the server log (SETUP_TOKEN). */
  setupCodeRequired: boolean;
  user: UserDTO | null;
  version: string;
  /** Only from the single-file desktop app (SPEC §12.1); absent for the Node build and Docker. */
  desktop?: DesktopAppDTO;
}

/**
 * The client is served by the single-file desktop app, not the Node build or Docker: the sign-in
 * page and Settings → Data show the app's commands. Public (AuthStatusDTO), so no paths.
 */
export interface DesktopAppDTO {
  /** The program's file name as it is on disk, e.g. lyren-plan-0.1.0-win-x64.exe. */
  exe: string;
  /** Windows: commands for Command Prompt. Otherwise for a POSIX shell (Linux, macOS). */
  windows: boolean;
  /**
   * How Lyren Plan is stopped (Windows, SPEC §12.1): 'tray' = it runs without a window, with an
   * icon in the notification area (Quit Lyren Plan in its menu); 'terminal' = in the terminal it was
   * started in (Ctrl+C) and with that icon. Absent: in its own console window (close it), as on
   * Linux and macOS and with --console.
   */
  stopMode?: 'tray' | 'terminal';
}

/** The desktop app and where it keeps the data, for Settings → Data (BootstrapDTO: signed in only). */
export interface DesktopDataDTO extends DesktopAppDTO {
  /** The data folder: lyren.db, desktop.json and backups/ (safety snapshots). */
  dataDir: string;
  /**
   * The database file when DB_PATH makes it anything but lyren.db in the data folder (another
   * folder or another name), else null. The maintenance commands then need `--db-path <dbPath>`.
   */
  dbPath: string | null;
  /**
   * The data folder was chosen with --data-dir or DATA_DIR rather than the per-user default, so
   * the maintenance commands need `--data-dir <dataDir>` to find the same database.
   */
  customDataDir: boolean;
  /** The folder that holds the program; null when it runs from source (npx tsx server/src/sea.ts). */
  exeFolder: string | null;
}

export interface DashboardDTO {
  today: string;
  /** Open tasks with dueDate < today, oldest due first (max 50). */
  overdue: TaskDTO[];
  /** Open tasks due today (max 50). */
  dueToday: TaskDTO[];
  /** Open tasks due in the next 7 days after today (max 50). */
  dueSoon: TaskDTO[];
  /** Tasks in a 'started' status, most recently updated first (max 50). */
  inProgress: TaskDTO[];
  /** Tasks closed in the last 7 days, most recent first (max 20). */
  recentlyClosed: TaskDTO[];
  /**
   * Uncapped number of tasks matching each list above. A list is truncated when its count is
   * larger than its length.
   */
  counts: { overdue: number; dueToday: number; dueSoon: number; inProgress: number; recentlyClosed: number };
  /** Number of distinct projects with tasks in a 'started' status (uncapped, like counts.inProgress). */
  inProgressProjects: number;
  recentActivity: ActivityDTO[];
  worklog: { todayMinutes: number; weekMinutes: number };
}

export interface SearchResultDTO {
  tasks: TaskDTO[];
  projects: ProjectDTO[];
  milestones: MilestoneDTO[];
  epics: EpicDTO[];
}

export interface ApiErrorBody {
  error: {
    code:
      | 'validation_error'
      | 'bad_request'
      | 'unauthorized'
      | 'forbidden'
      | 'not_found'
      | 'conflict'
      | 'rate_limited'
      | 'payload_too_large'
      | 'internal';
    message: string;
    /** For validation errors: [{ path: 'title', message: 'Required' }, ...] */
    details?: Array<{ path: string; message: string }>;
  };
}

/** Full JSON export (GET /api/data/export) and import payload (POST /api/data/import). */
export interface ExportDTO {
  format: 'lyren-plan-export';
  formatVersion: 1;
  exportedAt: string;
  appVersion: string;
  settings: Settings;
  statuses: Array<Omit<StatusDTO, 'taskCount'>>;
  tags: Array<Omit<TagDTO, 'taskCount'>>;
  projects: Array<Omit<ProjectDTO, 'stats'> & { taskCounter: number }>;
  milestones: Array<Omit<MilestoneDTO, 'stats'>>;
  epics: Array<Omit<EpicDTO, 'stats'>>;
  tasks: Array<Omit<TaskDTO, 'ref' | 'milestoneId' | 'tags' | 'commentCount' | 'worklogMinutes'> & { tagIds: number[] }>;
  comments: Array<Omit<CommentDTO, 'author'> & { authorId: number | null }>;
  worklogs: Array<Omit<WorklogDTO, 'author'> & { authorId: number | null }>;
  activity: Array<Omit<ActivityDTO, 'actor' | 'task'> & { actorId: number | null }>;
  boards: BoardDTO[];
}
