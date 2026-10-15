import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@shared/schemas';
import { HttpError } from '../src/http/errors';
import { clearDefaultBoardIfMissing } from '../src/services/boardRefs';
import { getSettings, saveSettings } from '../src/services/settings';
import { createDb } from './services.fixtures';

describe('settings service', () => {
  it('merges stored values over the defaults', () => {
    const { db } = createDb();
    db.run('DELETE FROM settings');
    expect(getSettings(db)).toEqual(DEFAULT_SETTINGS);
    db.run("INSERT INTO settings (key, value) VALUES ('weekStartsOn', '0'), ('estimateUnit', '\"hours\"')");
    expect(getSettings(db)).toEqual({ ...DEFAULT_SETTINGS, weekStartsOn: 0, estimateUnit: 'hours' });
  });

  it('ignores invalid, unknown and internal stored values', () => {
    const { db } = createDb();
    db.run('DELETE FROM settings');
    db.run(
      `INSERT INTO settings (key, value) VALUES
         ('weekStartsOn', '5'), ('estimateUnit', 'not json'), ('homePage', '"default_board"'),
         ('_seeded', 'true'), ('somethingElse', '1')`,
    );
    const s = getSettings(db);
    expect(s).toEqual({ ...DEFAULT_SETTINGS, homePage: 'default_board' });
    expect(Object.keys(s).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
  });

  it('saves a partial patch and validates defaultBoardId', () => {
    const { db } = createDb();
    const boardId = getSettings(db).defaultBoardId;
    expect(typeof boardId).toBe('number');
    const next = saveSettings(db, { weekStartsOn: 0, estimateUnit: undefined });
    expect(next.weekStartsOn).toBe(0);
    expect(next.defaultBoardId).toBe(boardId);
    expect(saveSettings(db, { defaultBoardId: null }).defaultBoardId).toBeNull();
    let err: unknown;
    try {
      saveSettings(db, { defaultBoardId: 4242, weekStartsOn: 1 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).details?.[0]?.path).toBe('defaultBoardId');
    expect(getSettings(db).weekStartsOn).toBe(0); // nothing saved
    expect(db.get("SELECT value FROM settings WHERE key = '_seeded'")).toEqual({ value: 'true' });
  });

  it('clearDefaultBoardIfMissing resets a dangling default board', () => {
    const { db } = createDb();
    const boardId = getSettings(db).defaultBoardId!;
    expect(clearDefaultBoardIfMissing(db)).toBe(false);
    db.run('DELETE FROM boards WHERE id = :id', { id: boardId });
    expect(clearDefaultBoardIfMissing(db)).toBe(true);
    expect(getSettings(db).defaultBoardId).toBeNull();
    expect(clearDefaultBoardIfMissing(db)).toBe(false);
  });
});
