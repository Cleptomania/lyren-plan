// A Lyren Plan 1.x database for the legacy upgrade's tests (design §3.8, §14.3). The schema is V1 exactly
// as 1.x created it (db/schema.ts at the last 1.x release, copied verbatim, so the fixture stays 1.x's
// whatever db/schema.ts becomes), in WAL mode with user_version 1, and the data covers every table: two
// accounts (the second one, as only manual edits made one), live and expired sessions, the settings
// (preferences, space settings, internal keys and one 1.x never knew), statuses, tags, projects,
// milestones, epics, tasks, task tags, comments, work logs, activity and boards, with gaps in the ids and
// sqlite_sequence values above them, and folded text that is not ASCII. `extraTasks` adds tasks (each with
// a tag) so that the copy reads several batches.

import { DatabaseSync } from 'node:sqlite';
import { defaultBoardConfig } from '@shared/board';
import { sha256Hex } from '../../src/core/crypto';
import { PasswordHasher } from '../../src/directory/passwords';
import { systemClock } from '../../src/core/runtime';

/** db/schema.ts V1 of Lyren Plan 1.x, verbatim. */
export const LEGACY_V1_DDL = /* sql */ `
CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE sessions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash   TEXT NOT NULL UNIQUE,          -- sha256(token) hex; the raw token only lives in the cookie
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  user_agent   TEXT,
  ip           TEXT
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_expires ON sessions(expires_at);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL                          -- JSON
);

CREATE TABLE projects (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  key          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  color        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','on_hold','completed','archived')),
  position     INTEGER NOT NULL DEFAULT 0,
  task_counter INTEGER NOT NULL DEFAULT 0,     -- last task number issued in this project
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE milestones (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','active','completed','cancelled')),
  start_date   TEXT,
  due_date     TEXT,
  position     INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX milestones_project ON milestones(project_id, position);

CREATE TABLE epics (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  milestone_id INTEGER REFERENCES milestones(id) ON DELETE SET NULL,  -- must be in the same project (app-enforced)
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  color        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','done','cancelled')),
  start_date   TEXT,
  due_date     TEXT,
  position     INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX epics_project ON epics(project_id, position);
CREATE INDEX epics_milestone ON epics(milestone_id);

CREATE TABLE statuses (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  category   TEXT NOT NULL CHECK (category IN ('backlog','unstarted','started','completed','cancelled')),
  color      TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE tasks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number       INTEGER NOT NULL,
  epic_id      INTEGER REFERENCES epics(id) ON DELETE SET NULL,      -- must be in the same project (app-enforced)
  status_id    INTEGER NOT NULL REFERENCES statuses(id) ON DELETE RESTRICT,
  title        TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  priority     INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 4),
  start_date   TEXT,
  due_date     TEXT,
  estimate     REAL,
  rank         TEXT NOT NULL,                  -- fractional index (manual order)
  completed_at TEXT,                           -- set while status category is completed/cancelled
  archived_at  TEXT,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE (project_id, number)
);
CREATE INDEX tasks_epic ON tasks(epic_id);
CREATE INDEX tasks_status ON tasks(status_id);
CREATE INDEX tasks_due ON tasks(due_date);
CREATE INDEX tasks_rank ON tasks(rank);
CREATE INDEX tasks_archived ON tasks(archived_at);
CREATE INDEX tasks_updated ON tasks(updated_at);

CREATE TABLE tags (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  color      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE task_tags (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  tag_id  INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, tag_id)
) WITHOUT ROWID;
CREATE INDEX task_tags_tag ON task_tags(tag_id);

CREATE TABLE comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  edited_at  TEXT
);
CREATE INDEX comments_task ON comments(task_id, created_at);

CREATE TABLE work_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  date       TEXT NOT NULL,
  minutes    INTEGER,
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX work_logs_task ON work_logs(task_id, date);
CREATE INDEX work_logs_date ON work_logs(date);

CREATE TABLE activity (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  project_id  INTEGER REFERENCES projects(id) ON DELETE CASCADE,  -- NULL for project.deleted
  task_id     INTEGER REFERENCES tasks(id) ON DELETE CASCADE,     -- NULL for non-task events and task.deleted
  entity_type TEXT NOT NULL,
  entity_id   INTEGER,
  action      TEXT NOT NULL,
  data        TEXT NOT NULL DEFAULT '{}',                         -- JSON (ActivityData)
  created_at  TEXT NOT NULL
);
CREATE INDEX activity_project ON activity(project_id, id);
CREATE INDEX activity_task ON activity(task_id, id);

CREATE TABLE boards (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER REFERENCES projects(id) ON DELETE CASCADE,  -- NULL = global board; else a project board
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  config      TEXT NOT NULL,                  -- JSON (BoardConfig)
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX boards_project ON boards(project_id, position);
`;

/** The tables of V1 (with their sqlite_sequence, the AUTOINCREMENT ones but task_tags and settings). */
export const LEGACY_TABLES = [
  'users', 'sessions', 'settings', 'projects', 'milestones', 'epics', 'statuses', 'tasks', 'tags', 'task_tags', 'comments',
  'work_logs', 'activity', 'boards',
] as const;

export const LEGACY_PASSWORD = 'legacy password 1';
/** The session cookies' tokens (1.x: 32 random bytes, base64url) of the owner (live), the owner (expired) and the helper. */
export const LIVE_TOKEN = 'L'.repeat(43);
export const EXPIRED_TOKEN = 'E'.repeat(43);
export const HELPER_TOKEN = 'H'.repeat(43);
/** The ids the fixture uses, with gaps (deleted rows) below its sqlite_sequence values. */
export const OWNER_ID = 2;
export const HELPER_ID = 5;
export const OWNER_NAME = 'Ärger Öwner';
export const DEFAULT_BOARD_ID = 4;

export interface LegacyFixtureOptions {
  /** No account (an install that was never set up): only the seeds 1.x wrote at its first start. */
  noUsers?: boolean;
  /** Settings to write instead of the fixture's (JSON text values); null removes one. */
  settings?: Record<string, string | null>;
  /** More tasks in project OPS, each with tag 1. */
  extraTasks?: number;
  /** Leave the connection open (as a running 1.x server would): the caller closes it. */
  keepOpen?: boolean;
}

const hasher = new PasswordHasher({ target: { kdf: 'scrypt', scryptP: 1 }, clock: systemClock });

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** Create the 1.x database `file` (see the header). Returns the open connection when `keepOpen`, else null. */
export async function createLegacyDb(file: string, o: LegacyFixtureOptions = {}): Promise<DatabaseSync | null> {
  // 1.x's hash format (scrypt$16384$8$1$…) is the target with p = 1.
  const hash = await hasher.hash(LEGACY_PASSWORD);
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('BEGIN');
  db.exec(LEGACY_V1_DDL);
  db.exec('PRAGMA user_version = 1');
  db.exec('COMMIT');
  const now = Date.now();
  const t = iso(now - 10 * DAY);
  const run = (sql: string, ...params: Array<string | number | null>) => db.prepare(sql).run(...params);
  db.exec('BEGIN');
  // ensureDefaults of 1.x: the statuses, the settings and the "All tasks" board, then _seeded.
  const statuses: Array<[number, string, string, string]> = [
    [1, 'Backlog', 'backlog', '#94a3b8'],
    [2, 'Todo', 'unstarted', '#64748b'],
    [3, 'In Progress', 'started', '#3b82f6'],
    [5, 'Done', 'completed', '#22c55e'],
    [6, 'Cancelled', 'cancelled', '#ef4444'],
    [8, 'Überprüfung', 'started', '#a855f7'],
  ];
  const status = 'INSERT INTO statuses (id, name, category, color, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)';
  statuses.forEach(([id, name, category, color], i) => run(status, id, name, category, color, i, t, t));
  run(
    'INSERT INTO boards (id, project_id, name, description, config, position, created_at, updated_at) VALUES (?, NULL, ?, ?, ?, 0, ?, ?)',
    DEFAULT_BOARD_ID, 'All tasks', 'Every open task across all projects, grouped by status.', JSON.stringify(defaultBoardConfig()), t, t,
  );
  const settings: Record<string, string | null> = {
    weekStartsOn: '0',
    estimateUnit: '"hours"',
    defaultBoardId: String(DEFAULT_BOARD_ID),
    homePage: '"default_board"',
    _seeded: 'true',
    _note: '"an internal key"',
    theme: '"dark"',
    ...o.settings,
  };
  for (const [key, value] of Object.entries(settings)) if (value !== null) run('INSERT INTO settings (key, value) VALUES (?, ?)', key, value);

  if (!o.noUsers) {
    const user = 'INSERT INTO users (id, username, display_name, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)';
    run(user, OWNER_ID, 'owner', OWNER_NAME, hash, t, t);
    run(user, HELPER_ID, 'Helper', 'Helper', hash, t, t);
    const session = (id: number, token: string, userId: number, expires: number) =>
      run(
        'INSERT INTO sessions (id, token_hash, user_id, created_at, last_seen_at, expires_at, user_agent, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        id, sha256Hex(token), userId, t, iso(now - DAY), iso(expires), 'Mozilla/5.0 (1.x)', '192.0.2.7',
      );
    session(3, LIVE_TOKEN, OWNER_ID, now + 20 * DAY);
    session(4, EXPIRED_TOKEN, OWNER_ID, now - DAY);
    session(7, HELPER_TOKEN, HELPER_ID, now + 20 * DAY);

    run('INSERT INTO tags (id, name, color, created_at, updated_at) VALUES (1, ?, ?, ?, ?)', 'Frontend', '#3b82f6', t, t);
    run('INSERT INTO tags (id, name, color, created_at, updated_at) VALUES (3, ?, ?, ?, ?)', 'ÄRGER', '#ef4444', t, t);
    run(
      `INSERT INTO projects (id, key, name, description, color, status, position, task_counter, created_at, updated_at)
       VALUES (1, 'WEB', 'Website Ünïcode', 'Désc ΣΑΣ', '#3b82f6', 'active', 0, 3, ?, ?)`,
      t, t,
    );
    run(
      `INSERT INTO projects (id, key, name, description, color, status, position, task_counter, created_at, updated_at)
       VALUES (4, 'OPS', 'Ops', '', '#22c55e', 'archived', 1, ?, ?, ?)`,
      1 + (o.extraTasks ?? 0), t, t,
    );
    run(
      `INSERT INTO milestones (id, project_id, name, description, status, start_date, due_date, position, completed_at, created_at, updated_at)
       VALUES (2, 1, 'Launch İstanbul', 'Großes Ziel', 'active', '2026-10-01', '2026-11-01', 0, NULL, ?, ?)`,
      t, t,
    );
    run(
      `INSERT INTO epics (id, project_id, milestone_id, name, description, color, status, start_date, due_date, position, completed_at,
         created_at, updated_at)
       VALUES (3, 1, 2, 'Checkout', 'Ça marche', '#a855f7', 'in_progress', NULL, '2026-10-20', 0, NULL, ?, ?)`,
      t, t,
    );
    const task = (id: number, project: number, num: number, o2: { epic?: number | null; status: number; title: string; estimate?: number | null;
      createdBy: number | null; archived?: string | null; completed?: string | null }) =>
      run(
        `INSERT INTO tasks (id, project_id, number, epic_id, status_id, title, description, priority, start_date, due_date, estimate, rank,
           completed_at, archived_at, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 2, '2026-10-02', '2026-10-30', ?, ?, ?, ?, ?, ?, ?)`,
        id, project, num, o2.epic ?? null, o2.status, o2.title, `Beschreibung für ${o2.title}`, o2.estimate ?? null, `a${id}`,
        o2.completed ?? null, o2.archived ?? null, o2.createdBy, t, t,
      );
    task(10, 1, 1, { epic: 3, status: 3, title: 'Straße prüfen', estimate: 2.5, createdBy: OWNER_ID });
    task(11, 1, 3, { status: 5, title: 'Pay ΣΟΦΙΑ', estimate: 0.1, createdBy: HELPER_ID, completed: t });
    task(12, 4, 1, { status: 1, title: 'Old ops task', createdBy: null, archived: t });
    for (let i = 0; i < (o.extraTasks ?? 0); i++) task(100 + i, 4, 2 + i, { status: 2, title: `Extra ${i}`, createdBy: OWNER_ID });
    run('INSERT INTO task_tags (task_id, tag_id) VALUES (10, 1), (10, 3), (11, 3)');
    for (let i = 0; i < (o.extraTasks ?? 0); i++) run('INSERT INTO task_tags (task_id, tag_id) VALUES (?, 1)', 100 + i);
    const comment = 'INSERT INTO comments (id, task_id, user_id, body, created_at, updated_at, edited_at) VALUES (?, ?, ?, ?, ?, ?, ?)';
    run(comment, 5, 10, OWNER_ID, 'First **comment**', t, t, null);
    run(comment, 6, 10, HELPER_ID, 'Edited', t, t, t);
    run(comment, 8, 11, null, 'By a deleted account', t, t, null);
    const worklog = 'INSERT INTO work_logs (id, task_id, user_id, date, minutes, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';
    run(worklog, 2, 10, OWNER_ID, '2026-10-05', 90, 'Morning', t, t);
    run(worklog, 3, 11, HELPER_ID, '2026-10-06', null, '', t, t);
    run(
      `INSERT INTO activity (id, user_id, project_id, task_id, entity_type, entity_id, action, data, created_at)
       VALUES (1, ?, 1, NULL, 'project', 1, 'created', '{}', ?)`,
      OWNER_ID, t,
    );
    run(
      `INSERT INTO activity (id, user_id, project_id, task_id, entity_type, entity_id, action, data, created_at)
       VALUES (2, ?, 1, 10, 'task', 10, 'created', '{"title":"Straße prüfen"}', ?)`,
      OWNER_ID, t,
    );
    run(
      `INSERT INTO activity (id, user_id, project_id, task_id, entity_type, entity_id, action, data, created_at)
       VALUES (4, ?, NULL, NULL, 'project', 9, 'deleted', '{"name":"Gone"}', ?)`,
      HELPER_ID, t,
    );
    run(
      'INSERT INTO boards (id, project_id, name, description, config, position, created_at, updated_at) VALUES (6, 1, ?, ?, ?, 1, ?, ?)',
      'Website board', '', JSON.stringify(defaultBoardConfig()), t, t,
    );
  }
  // Rows deleted at the end of each table: AUTOINCREMENT never issues those ids again.
  for (const [name, seq] of Object.entries({ users: 9, sessions: 12, statuses: 9, boards: 8, tags: 4, projects: 6, milestones: 3, epics: 5,
    tasks: 200 + (o.extraTasks ?? 0), comments: 9, work_logs: 4, activity: 7 })) {
    run('UPDATE sqlite_sequence SET seq = ? WHERE name = ?', seq, name);
    if (Number(db.prepare('SELECT changes() AS n').get()!.n) === 0) run('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)', name, seq);
  }
  db.exec('COMMIT');
  if (o.keepOpen) return db;
  db.close();
  return null;
}

/** Every row of every V1 table of a database, for comparing two of them (read-only). */
export function dumpLegacy(file: string): Record<string, unknown[]> {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const dump: Record<string, unknown[]> = {};
    for (const table of [...LEGACY_TABLES, 'sqlite_sequence']) {
      const order = table === 'task_tags' ? 'task_id, tag_id' : table === 'settings' || table === 'sqlite_sequence' ? 1 : 'id';
      dump[table] = db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all().map((r) => ({ ...r }));
    }
    return dump;
  } finally {
    db.close();
  }
}
