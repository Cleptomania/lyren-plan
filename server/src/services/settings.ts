// The space's settings (design §3.6): one JSON value per key in the `settings` table, merged over
// DEFAULT_SPACE_SETTINGS. Keys starting with '_' are internal and never exposed. The per-user keys
// (weekStartsOn, homePage) are the account's preferences in the directory, not stored here.

import {
  DEFAULT_SPACE_SETTINGS,
  spaceSettingsSchema,
  type SpaceSettings,
  type SpaceSettingsUpdateInput,
} from '@shared/schemas';
import type { Db } from '../db';
import { badRequest } from '../http/errors';
import { parseJson } from './mappers';
import type { SettingRow } from './rows';

const SETTING_KEYS = Object.keys(DEFAULT_SPACE_SETTINGS) as Array<keyof SpaceSettings>;

function isSettingKey(key: string): key is keyof SpaceSettings {
  return (SETTING_KEYS as string[]).includes(key);
}

/** DEFAULT_SPACE_SETTINGS merged with the stored values; invalid or unknown stored values are ignored. */
export function getSettings(db: Db): SpaceSettings {
  const out: Record<string, unknown> = { ...DEFAULT_SPACE_SETTINGS };
  for (const row of db.all<SettingRow>("SELECT key, value FROM settings WHERE substr(key, 1, 1) <> '_'")) {
    if (!isSettingKey(row.key)) continue;
    const parsed = spaceSettingsSchema.shape[row.key].safeParse(parseJson(row.value, undefined));
    if (parsed.success) out[row.key] = parsed.data;
  }
  return out as SpaceSettings;
}

/**
 * Store the given keys (undefined values and other keys are skipped) and return the merged settings.
 * `defaultBoardId` must reference an existing board (400, path 'defaultBoardId').
 */
export function saveSettings(db: Db, patch: SpaceSettingsUpdateInput): SpaceSettings {
  return db.tx(() => {
    if (typeof patch.defaultBoardId === 'number') {
      const exists = db.get('SELECT 1 FROM boards WHERE id = :id', { id: patch.defaultBoardId });
      if (!exists) {
        throw badRequest('Default board does not exist', [{ path: 'defaultBoardId', message: 'Board not found' }]);
      }
    }
    for (const key of SETTING_KEYS) {
      const value = patch[key];
      if (value === undefined) continue;
      db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (:key, :value)', { key, value: JSON.stringify(value) });
    }
    return getSettings(db);
  });
}
