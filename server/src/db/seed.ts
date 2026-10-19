// A new space's defaults and optional sample data (space/init.ts). Pure: they only use the Db, so both
// runtimes run them.

import { defaultBoardConfig } from '@shared/board';
import { DEFAULT_STATUSES } from '@shared/constants';
import { DEFAULT_SPACE_SETTINGS } from '@shared/schemas';
import { fold } from '../core/fold';
import { buildSampleData } from '../services/sampleData';
import type { Db } from './index';

const SEEDED_KEY = '_seeded';

/**
 * Idempotent: creates default statuses, the space's settings and one "All tasks" board the
 * first time it runs. Uses a settings flag so user deletions are not undone.
 * Also guarantees at least one status exists (tasks require a status).
 */
export function ensureDefaults(db: Db): void {
  db.tx(() => {
    const now = new Date().toISOString();
    const seeded = db.get('SELECT 1 FROM settings WHERE key = :key', { key: SEEDED_KEY });
    const statusCount = Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM statuses')!.n);
    if (statusCount === 0) {
      DEFAULT_STATUSES.forEach((s, i) => {
        db.run(
          `INSERT INTO statuses (name, name_fold, category, color, position, created_at, updated_at)
           VALUES (:name, :nameFold, :category, :color, :position, :now, :now)`,
          { ...s, nameFold: fold(s.name), position: i, now },
        );
      });
    }
    if (seeded) return;
    for (const [key, value] of Object.entries(DEFAULT_SPACE_SETTINGS)) {
      db.run('INSERT OR IGNORE INTO settings (key, value) VALUES (:key, :value)', { key, value: JSON.stringify(value) });
    }
    const boardCount = Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM boards')!.n);
    if (boardCount === 0) {
      const { lastInsertRowid } = db.run(
        `INSERT INTO boards (name, description, config, position, created_at, updated_at)
         VALUES (:name, :description, :config, 0, :now, :now)`,
        {
          name: 'All tasks',
          description: 'Every open task across all projects, grouped by status.',
          config: JSON.stringify(defaultBoardConfig()),
          now,
        },
      );
      db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (:key, :value)', {
        key: 'defaultBoardId',
        value: JSON.stringify(lastInsertRowid),
      });
    }
    db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (:key, :value)', { key: SEEDED_KEY, value: 'true' });
  });
}

/**
 * Create the demo projects (milestones, epics, tasks, tags, comments, work logs,
 * activity and two boards) authored by `userId`, a row of the users mirror (the space's
 * owner when a space is created) — SPEC §11. Runs inside a transaction supplied by the caller.
 */
export function createSampleData(db: Db, userId: number, today?: string): void {
  buildSampleData(db, userId, today);
}
