// /api/settings — server-side preferences (SPEC §5.9). Theme is per device (web localStorage).

import { Hono } from 'hono';
import { settingsUpdateInput } from '@shared/schemas';
import type { AppEnv, Deps } from '../env';
import { readJson } from '../http/validate';
import { getSettings, saveSettings } from '../services/settings';

export function settingsRoutes({ db }: Deps) {
  const r = new Hono<AppEnv>();

  r.get('/', (c) => c.json(getSettings(db)));

  /** Partial update; `defaultBoardId` must reference an existing board (400, path defaultBoardId). */
  r.patch('/', async (c) => {
    const input = await readJson(c, settingsUpdateInput);
    return c.json(saveSettings(db, input));
  });

  return r;
}
