// Board configs reference statuses/tags/projects/milestones/epics by id inside JSON
// (no foreign keys). Keep them valid when those entities are merged or deleted (SPEC §5.11).

import { boardConfigSchema, parseBoardConfigLenient, remapBoardConfigIds, type BoardRefKind } from '@shared/board';
import type { Db } from '../db';
import { parseJson } from './mappers';
import type { BoardRow } from './rows';
import { getSettings, saveSettings } from './settings';

/**
 * Rewrite every board config after entity `fromId` of `kind` was merged into `toId`
 * (tag merge, status delete with reassignment) or deleted (`toId` null). Call inside the
 * mutation's transaction. Only changed configs are saved; updated_at is left alone
 * (an indirect change). Returns the number of boards rewritten.
 */
export function rewriteBoardRefs(db: Db, kind: BoardRefKind, fromId: number, toId: number | null): number {
  return db.tx(() => {
    let changed = 0;
    for (const row of db.all<Pick<BoardRow, 'id' | 'config'>>('SELECT id, config FROM boards')) {
      const config = parseBoardConfigLenient(parseJson(row.config, {}));
      const next = remapBoardConfigIds(config, kind, fromId, toId);
      if (next === config) continue;
      // Never store a config the strict schema rejects: lenient reads would silently drop the
      // invalid parts (e.g. whole custom columns) and the next save would persist that loss.
      const valid = boardConfigSchema.safeParse(next);
      const toSave = valid.success ? valid.data : parseBoardConfigLenient(next);
      db.run('UPDATE boards SET config = :config WHERE id = :id', { id: row.id, config: JSON.stringify(toSave) });
      changed++;
    }
    return changed;
  });
}

/**
 * Reset settings.defaultBoardId to null when it points at a board that no longer exists
 * (call after deleting a board or a project, whose boards cascade). Returns true when reset.
 */
export function clearDefaultBoardIfMissing(db: Db): boolean {
  const { defaultBoardId } = getSettings(db);
  if (defaultBoardId === null) return false;
  if (db.get('SELECT 1 FROM boards WHERE id = :id', { id: defaultBoardId })) return false;
  saveSettings(db, { defaultBoardId: null });
  return true;
}
