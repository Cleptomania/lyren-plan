// Database schema and migrations. PRAGMA user_version tracks the applied version.
// Append new migrations to MIGRATIONS; never edit one that has shipped.
//
// Conventions: snake_case columns; timestamps are ISO-8601 UTC TEXT
// ('2026-10-13T20:15:00.000Z'); calendar dates are TEXT 'YYYY-MM-DD';
// booleans are INTEGER 0/1; JSON is TEXT.

import path from 'node:path';
import type { Db } from './index';
import { DEFAULT_SNAPSHOT_KEEP, logPrune, pruneSnapshots, snapshotStamp } from './snapshots';

const V1 = /* sql */ `
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

const MIGRATIONS: ReadonlyArray<Migration> = [V1];

export const SCHEMA_VERSION = MIGRATIONS.length;

export type Migration = string | ((db: Db) => void);

export interface MigrateOptions {
  /** Pre-upgrade snapshots to keep in backups/ (Config.snapshotKeep; 0 = all). */
  snapshotKeep?: number;
}

export function runMigrations(db: Db, options: MigrateOptions = {}): void {
  applyMigrations(db, MIGRATIONS, options);
}

/** runMigrations() with an explicit migration list (exported for tests). */
export function applyMigrations(db: Db, migrations: ReadonlyArray<Migration>, options: MigrateOptions = {}): void {
  const current = Number(db.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? 0);
  if (current > migrations.length) {
    throw new Error(
      `Database schema version ${current} is newer than this build supports (${migrations.length}). Upgrade the app.`,
    );
  }
  if (current === migrations.length) return;
  // Snapshot an existing database before upgrading it, then drop the oldest pre-upgrade
  // snapshots beyond the retention limit (the new one is always kept).
  if (current > 0 && db.filename !== ':memory:') {
    const dir = path.join(path.dirname(db.filename), 'backups');
    const file = path.join(dir, `lyren-v${current}-before-upgrade-${snapshotStamp()}.db`);
    db.backupTo(file);
    console.log(`[lyren] Database snapshot written to ${file} before upgrading schema v${current} -> v${migrations.length}`);
    const keep = options.snapshotKeep ?? DEFAULT_SNAPSHOT_KEEP;
    logPrune('before-upgrade', dir, keep, pruneSnapshots(dir, 'before-upgrade', keep, file));
  }
  // Table rebuilds must not cascade; foreign_keys can only change outside a transaction.
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    for (let v = current; v < migrations.length; v++) {
      const m = migrations[v]!;
      db.tx(() => {
        if (typeof m === 'string') db.exec(m);
        else m(db);
        const bad = db.all('PRAGMA foreign_key_check');
        if (bad.length > 0) throw new Error(`Migration ${v + 1} left ${bad.length} foreign key violation(s)`);
        db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}
