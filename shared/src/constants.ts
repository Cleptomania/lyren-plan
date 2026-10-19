// Domain constants shared by the server and the web client.
// This module must stay free of Node and DOM APIs.

export const APP_NAME = 'Lyren Plan';

// ---------------------------------------------------------------------------
// Priorities
// ---------------------------------------------------------------------------

export const PRIORITY_VALUES = [0, 1, 2, 3, 4] as const;
export type Priority = (typeof PRIORITY_VALUES)[number];

export const PRIORITY_META: Record<Priority, { key: string; label: string; color: string }> = {
  0: { key: 'none', label: 'No priority', color: '#94a3b8' },
  1: { key: 'low', label: 'Low', color: '#3b82f6' },
  2: { key: 'medium', label: 'Medium', color: '#eab308' },
  3: { key: 'high', label: 'High', color: '#f97316' },
  4: { key: 'urgent', label: 'Urgent', color: '#ef4444' },
};

// ---------------------------------------------------------------------------
// Task statuses (user-configurable; every status belongs to a fixed category)
// ---------------------------------------------------------------------------

export const STATUS_CATEGORIES = ['backlog', 'unstarted', 'started', 'completed', 'cancelled'] as const;
export type StatusCategory = (typeof STATUS_CATEGORIES)[number];

export const STATUS_CATEGORY_META: Record<StatusCategory, { label: string; description: string }> = {
  backlog: { label: 'Backlog', description: 'Ideas and work not yet planned' },
  unstarted: { label: 'To do', description: 'Planned but not started' },
  started: { label: 'In progress', description: 'Actively being worked on' },
  completed: { label: 'Done', description: 'Finished successfully' },
  cancelled: { label: 'Cancelled', description: 'Will not be done' },
};

/** Categories that count as "closed" (task.completedAt is set while in one of these). */
export const CLOSED_STATUS_CATEGORIES: readonly StatusCategory[] = ['completed', 'cancelled'];

export function isClosedCategory(category: StatusCategory): boolean {
  return category === 'completed' || category === 'cancelled';
}

/** Statuses created on first run. */
export const DEFAULT_STATUSES: ReadonlyArray<{ name: string; category: StatusCategory; color: string }> = [
  { name: 'Backlog', category: 'backlog', color: '#94a3b8' },
  { name: 'Todo', category: 'unstarted', color: '#64748b' },
  { name: 'In Progress', category: 'started', color: '#3b82f6' },
  { name: 'In Review', category: 'started', color: '#a855f7' },
  { name: 'Done', category: 'completed', color: '#22c55e' },
  { name: 'Cancelled', category: 'cancelled', color: '#ef4444' },
];

// ---------------------------------------------------------------------------
// Project / milestone / epic lifecycle
// ---------------------------------------------------------------------------

export const PROJECT_STATUSES = ['active', 'on_hold', 'completed', 'archived'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  active: 'Active',
  on_hold: 'On hold',
  completed: 'Completed',
  archived: 'Archived',
};

export const MILESTONE_STATUSES = ['planned', 'active', 'completed', 'cancelled'] as const;
export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number];
export const MILESTONE_STATUS_LABELS: Record<MilestoneStatus, string> = {
  planned: 'Planned',
  active: 'Active',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

export const EPIC_STATUSES = ['open', 'in_progress', 'done', 'cancelled'] as const;
export type EpicStatus = (typeof EPIC_STATUSES)[number];
export const EPIC_STATUS_LABELS: Record<EpicStatus, string> = {
  open: 'Open',
  in_progress: 'In progress',
  done: 'Done',
  cancelled: 'Cancelled',
};

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

/** Swatches offered by color pickers. Any #rrggbb value is accepted by the API. */
export const COLOR_PALETTE = [
  '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16', '#22c55e',
  '#10b981', '#14b8a6', '#06b6d4', '#0ea5e9', '#3b82f6', '#6366f1',
  '#8b5cf6', '#a855f7', '#d946ef', '#ec4899', '#f43f5e', '#64748b',
] as const;

export const DEFAULT_PROJECT_COLOR = '#6366f1';
export const DEFAULT_EPIC_COLOR = '#8b5cf6';
export const DEFAULT_TAG_COLOR = '#64748b';
export const DEFAULT_STATUS_COLOR = '#64748b';

// ---------------------------------------------------------------------------
// Due-date presets (filters) and buckets (board grouping)
// ---------------------------------------------------------------------------

/**
 * Due-date filter presets, resolved relative to the *client's* local "today".
 *  - overdue:      dueDate < today AND task not closed
 *  - today:        dueDate == today
 *  - tomorrow:     dueDate == today + 1
 *  - this_week:    startOfWeek(today) <= dueDate <= endOfWeek(today)
 *  - next_week:    the 7 days of the following week
 *  - next_7_days:  today <= dueDate <= today + 6
 *  - next_30_days: today <= dueDate <= today + 29
 *  - no_date:      dueDate IS NULL
 *  - has_date:     dueDate IS NOT NULL
 */
export const DUE_PRESETS = [
  'overdue', 'today', 'tomorrow', 'this_week', 'next_week', 'next_7_days', 'next_30_days', 'no_date', 'has_date',
] as const;
export type DuePreset = (typeof DUE_PRESETS)[number];

export const DUE_PRESET_LABELS: Record<DuePreset, string> = {
  overdue: 'Overdue',
  today: 'Due today',
  tomorrow: 'Due tomorrow',
  this_week: 'Due this week',
  next_week: 'Due next week',
  next_7_days: 'Next 7 days',
  next_30_days: 'Next 30 days',
  no_date: 'No due date',
  has_date: 'Has due date',
};

/**
 * Mutually exclusive buckets used when grouping a board by due date.
 * See dueBucket() in ./dates.ts for the exact rules.
 */
export const DUE_BUCKETS = ['past', 'overdue', 'today', 'tomorrow', 'this_week', 'next_week', 'later', 'no_date'] as const;
export type DueBucket = (typeof DUE_BUCKETS)[number];

export const DUE_BUCKET_LABELS: Record<DueBucket, string> = {
  past: 'Earlier (closed)',
  overdue: 'Overdue',
  today: 'Today',
  tomorrow: 'Tomorrow',
  this_week: 'Later this week',
  next_week: 'Next week',
  later: 'Later',
  no_date: 'No due date',
};

// ---------------------------------------------------------------------------
// Limits (validated by zod schemas; UI should mirror them in maxLength etc.)
// ---------------------------------------------------------------------------

export const LIMITS = {
  usernameMin: 3,
  usernameMax: 32,
  passwordMin: 8,
  passwordMax: 256,
  displayNameMax: 64,
  nameMax: 120,
  titleMax: 500,
  descriptionMax: 100_000,
  commentMax: 50_000,
  worklogNoteMax: 10_000,
  tagNameMax: 40,
  statusNameMax: 40,
  boardNameMax: 80,
  projectKeyMin: 2,
  projectKeyMax: 10,
  searchMax: 200,
  queryLimitDefault: 1000,
  queryLimitMax: 5000,
  bulkMax: 500,
  customColumnsMax: 50,
  worklogMinutesMax: 60 * 24 * 7,
  spaceNameMax: 80,
  /** A normalized address (users.email; RFC 5321's path limit). */
  emailMax: 254,
  /** What a sign-in or email field accepts before normalization (an address, or a legacy username). */
  identifierMax: 320,
  passkeyNameMax: 64,
  passkeysPerUser: 20,
} as const;

export const ESTIMATE_UNITS = ['points', 'hours'] as const;
export type EstimateUnit = (typeof ESTIMATE_UNITS)[number];

// ---------------------------------------------------------------------------
// Accounts (docs/design/multi-user-and-cloudflare.md §5)
// ---------------------------------------------------------------------------

/**
 * Who may create an account (instance setting `signupPolicy`): `open` = anyone, with email
 * verification (needs a transport that delivers mail); `invite_only` = by accepting an invitation;
 * `closed` = only by accepting an instance admin's invitation. First-run setup always works.
 */
export const SIGNUP_POLICIES = ['open', 'invite_only', 'closed'] as const;
export type SignupPolicy = (typeof SIGNUP_POLICIES)[number];

/** How a session was created; 'legacy' = carried over from before the multi-user upgrade. */
export const AUTH_METHODS = ['legacy', 'setup', 'password', 'passkey', 'signup', 'invite'] as const;
export type AuthMethod = (typeof AUTH_METHODS)[number];

/** Header every mutating API request must carry (CSRF defence; see SPEC.md). */
export const CSRF_HEADER = 'X-Lyren-Request';
export const SESSION_COOKIE = 'lyren_session';
/** The session cookie's name on HTTPS: the __Host- prefix stops sibling subdomains from setting it. */
export const SESSION_COOKIE_SECURE = '__Host-lyren_session';

/**
 * URL-fragment parameter carrying the first-run setup code: the desktop app opens
 * `/setup#code=<code>` and SetupPage fills it in and removes it from the address bar. A fragment
 * is never sent to the server, so the code can't end up in a request log.
 */
export const SETUP_CODE_FRAGMENT_PARAM = 'code';

/**
 * URL-fragment parameter carrying the token of an emailed or copied link (`/invite#t=<token>`,
 * `/signup/complete#t=`, `/reset#t=`, `/email/confirm#t=`). The SPA reads it, removes it from the
 * address bar and POSTs it; a fragment never reaches a server log, a Referer or a mail scanner.
 */
export const TOKEN_FRAGMENT_PARAM = 't';
