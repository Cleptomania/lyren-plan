// /api/tags — global, colored tags (SPEC §5.7). Tag changes are not logged as activity;
// deleting or merging a tag is an indirect change for its tasks (no updated_at bump) and
// rewrites board configs that reference it (§5.11).

import { Hono } from 'hono';
import { DEFAULT_TAG_COLOR } from '@shared/constants';
import { tagCreateInput, tagMergeInput, tagUpdateInput } from '@shared/schemas';
import type { Db } from '../db';
import type { AppEnv, Deps } from '../env';
import { badRequest, conflict } from '../http/errors';
import { readId, readJson } from '../http/validate';
import { rewriteBoardRefs } from '../services/boardRefs';
import { getTag, listTags, requireTag } from '../services/entities';
import type { TagRow } from '../services/rows';
import { nowIso } from '../services/sql';

/** 409 when another tag (other than `exceptId`) already has this name, compared case-insensitively. */
function assertTagNameFree(db: Db, name: string, exceptId: number | null = null): void {
  const taken = db.get(
    'SELECT 1 FROM tags WHERE lyren_lower(name) = lyren_lower(:name) AND id IS NOT :exceptId',
    { name, exceptId },
  );
  if (taken) throw conflict(`A tag named “${name}” already exists`);
}

export function tagRoutes({ db }: Deps) {
  const r = new Hono<AppEnv>();

  r.get('/', (c) => c.json(listTags(db)));

  r.post('/', async (c) => {
    const input = await readJson(c, tagCreateInput);
    const tag = db.tx(() => {
      assertTagNameFree(db, input.name);
      const now = nowIso();
      const { lastInsertRowid } = db.run(
        'INSERT INTO tags (name, color, created_at, updated_at) VALUES (:name, :color, :now, :now)',
        { name: input.name, color: input.color ?? DEFAULT_TAG_COLOR, now },
      );
      return getTag(db, lastInsertRowid);
    });
    return c.json(tag, 201);
  });

  r.patch('/:id', async (c) => {
    const id = readId(c);
    const input = await readJson(c, tagUpdateInput);
    const tag = db.tx(() => {
      const row = requireTag(db, id);
      const next: Pick<TagRow, 'name' | 'color'> = { name: input.name ?? row.name, color: input.color ?? row.color };
      if (next.name === row.name && next.color === row.color) return getTag(db, id);
      // A case-only rename of the tag itself ("bug" → "Bug") is allowed.
      if (next.name !== row.name) assertTagNameFree(db, next.name, id);
      db.run('UPDATE tags SET name = :name, color = :color, updated_at = :now WHERE id = :id', {
        id,
        ...next,
        now: nowIso(),
      });
      return getTag(db, id);
    });
    return c.json(tag);
  });

  r.delete('/:id', (c) => {
    const id = readId(c);
    db.tx(() => {
      requireTag(db, id);
      rewriteBoardRefs(db, 'tag', id, null);
      // task_tags rows cascade; the tasks themselves are not touched (indirect change).
      db.run('DELETE FROM tags WHERE id = :id', { id });
    });
    return c.json({ ok: true as const });
  });

  /** Re-tag every task tagged :id with targetId (no duplicates), delete :id, return the target. */
  r.post('/:id/merge', async (c) => {
    const id = readId(c);
    const { targetId } = await readJson(c, tagMergeInput);
    const tag = db.tx(() => {
      requireTag(db, id);
      if (targetId === id) {
        throw badRequest('A tag cannot be merged into itself', [
          { path: 'targetId', message: 'Choose a different tag' },
        ]);
      }
      if (!db.get('SELECT 1 FROM tags WHERE id = :targetId', { targetId })) {
        throw badRequest('Target tag not found', [{ path: 'targetId', message: 'Tag not found' }]);
      }
      db.run(
        `INSERT OR IGNORE INTO task_tags (task_id, tag_id)
         SELECT task_id, :targetId FROM task_tags WHERE tag_id = :id`,
        { id, targetId },
      );
      rewriteBoardRefs(db, 'tag', id, targetId);
      db.run('DELETE FROM tags WHERE id = :id', { id });
      return getTag(db, targetId);
    });
    return c.json(tag);
  });

  return r;
}
