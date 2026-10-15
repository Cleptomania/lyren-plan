// First-run defaults and optional sample data.

import { defaultBoardConfig } from '@shared/board';
import { DEFAULT_STATUSES } from '@shared/constants';
import { DEFAULT_SETTINGS } from '@shared/schemas';
import { buildSampleData } from '../services/sampleData';
import type { Db } from './index';

const SEEDED_KEY = '_seeded';

/**
 * Idempotent: creates default statuses, settings and one "All tasks" board the
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
          `INSERT INTO statuses (name, category, color, position, created_at, updated_at)
           VALUES (:name, :category, :color, :position, :now, :now)`,
          { ...s, position: i, now },
        );
      });
    }
    if (seeded) return;
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
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
 * activity and two boards) owned by `userId` — SPEC §11. Runs inside a transaction
 * supplied by the caller.
 */
export function createSampleData(db: Db, userId: number, today?: string): void {
  buildSampleData(db, userId, today);
}
