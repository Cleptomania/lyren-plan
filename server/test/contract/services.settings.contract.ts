// The settings services (services/settings.ts, clearDefaultBoardIfMissing) on any Db (design §14.4): run on
// NodeDb by server/test/services.settings.test.ts and on DoDb in workerd by server/test-workers/services.test.ts.

import { describe, expect, it } from 'vitest';
import { DEFAULT_SPACE_SETTINGS } from '@shared/schemas';
import { HttpError } from '../../src/http/errors';
import { clearDefaultBoardIfMissing } from '../../src/services/boardRefs';
import { getSettings, saveSettings } from '../../src/services/settings';
import type { WithSpaceDb } from './fixtures';

// A space stores only its own settings (design §3.6); weekStartsOn and homePage are account
// preferences, so stored values of those keys are ignored like any unknown key.
export function defineSettingsContract(kind: string, withSpaceDb: WithSpaceDb): void {
  describe(`settings service (${kind})`, () => {
    it('merges stored values over the defaults', () =>
      withSpaceDb(({ db }) => {
        db.run('DELETE FROM settings');
        expect(getSettings(db)).toEqual(DEFAULT_SPACE_SETTINGS);
        db.run("INSERT INTO settings (key, value) VALUES ('weekStartsOn', '0'), ('estimateUnit', '\"hours\"')");
        expect(getSettings(db)).toEqual({ ...DEFAULT_SPACE_SETTINGS, estimateUnit: 'hours' });
      }));

    it('ignores invalid, unknown and internal stored values', () =>
      withSpaceDb(({ db }) => {
        db.run('DELETE FROM settings');
        db.run(
          `INSERT INTO settings (key, value) VALUES
             ('weekStartsOn', '5'), ('estimateUnit', 'not json'), ('homePage', '"default_board"'),
             ('defaultBoardId', '"x"'), ('_seeded', 'true'), ('somethingElse', '1')`,
        );
        const s = getSettings(db);
        expect(s).toEqual(DEFAULT_SPACE_SETTINGS);
        expect(Object.keys(s).sort()).toEqual(Object.keys(DEFAULT_SPACE_SETTINGS).sort());
      }));

    it('saves a partial patch and validates defaultBoardId', () =>
      withSpaceDb(({ db }) => {
        const boardId = getSettings(db).defaultBoardId;
        expect(typeof boardId).toBe('number');
        const next = saveSettings(db, { estimateUnit: 'hours', defaultBoardId: undefined });
        expect(next.estimateUnit).toBe('hours');
        expect(next.defaultBoardId).toBe(boardId);
        expect(saveSettings(db, { defaultBoardId: null }).defaultBoardId).toBeNull();
        let err: unknown;
        try {
          saveSettings(db, { defaultBoardId: 4242, estimateUnit: 'points' });
        } catch (e) {
          err = e;
        }
        expect(err).toBeInstanceOf(HttpError);
        expect((err as HttpError).details?.[0]?.path).toBe('defaultBoardId');
        expect(getSettings(db).estimateUnit).toBe('hours'); // nothing saved
        expect(db.get("SELECT value FROM settings WHERE key = '_seeded'")).toEqual({ value: 'true' });
      }));

    it('clearDefaultBoardIfMissing resets a dangling default board', () =>
      withSpaceDb(({ db }) => {
        const boardId = getSettings(db).defaultBoardId!;
        expect(clearDefaultBoardIfMissing(db)).toBe(false);
        db.run('DELETE FROM boards WHERE id = :id', { id: boardId });
        expect(clearDefaultBoardIfMissing(db)).toBe(true);
        expect(getSettings(db).defaultBoardId).toBeNull();
        expect(clearDefaultBoardIfMissing(db)).toBe(false);
      }));
  });
}
