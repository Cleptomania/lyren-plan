// /api/statuses — user-configurable task statuses with fixed categories (SPEC §5.4).
//
// The stored order (position) drives board columns, pickers and status grouping, and Settings shows
// statuses grouped by category. A new status is therefore inserted at the end of its category's
// group (not appended after Done/Cancelled), so both orders agree.
//
// Category changes and reassignment on delete are indirect changes for the affected tasks:
// their completedAt follows the new category, but updated_at is not bumped and no task
// activity is written (§5.8). Board configs follow a deleted status to its replacement (§5.11).

import { Hono } from 'hono';
import { DEFAULT_STATUS_COLOR, isClosedCategory, STATUS_CATEGORIES, type StatusCategory } from '@shared/constants';
import { reorderInput, statusCreateInput, statusDeleteQuery, statusUpdateInput } from '@shared/schemas';
import type { Db } from '../db';
import type { AppEnv, Deps } from '../env';
import { badRequest, conflict } from '../http/errors';
import { readId, readJson, readQuery } from '../http/validate';
import { rewriteBoardRefs } from '../services/boardRefs';
import {
  applyPositions,
  assertExactIdSet,
  getStatus,
  listStatuses,
  requireStatus,
} from '../services/entities';
import type { StatusRow } from '../services/rows';
import { nowIso } from '../services/sql';

/** 409 when another status (other than `exceptId`) already has this name, compared case-insensitively. */
function assertStatusNameFree(db: Db, name: string, exceptId: number | null = null): void {
  const taken = db.get(
    'SELECT 1 FROM statuses WHERE lyren_lower(name) = lyren_lower(:name) AND id IS NOT :exceptId',
    { name, exceptId },
  );
  if (taken) throw conflict(`A status named “${name}” already exists`);
}

function taskCount(db: Db, statusId: number): number {
  return db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks WHERE status_id = :statusId', { statusId })!.n;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Where a new status of `category` goes in the stored order (ids by position, id): right after the
 * last status whose category comes no later in STATUS_CATEGORIES, else first.
 */
export function insertionIndex(ordered: ReadonlyArray<{ category: StatusCategory }>, category: StatusCategory): number {
  const rank = STATUS_CATEGORIES.indexOf(category);
  let index = 0;
  ordered.forEach((s, i) => {
    if (STATUS_CATEGORIES.indexOf(s.category) <= rank) index = i + 1;
  });
  return index;
}

export function statusRoutes({ db }: Deps) {
  const r = new Hono<AppEnv>();

  r.get('/', (c) => c.json(listStatuses(db)));

  r.post('/', async (c) => {
    const input = await readJson(c, statusCreateInput);
    const status = db.tx(() => {
      assertStatusNameFree(db, input.name);
      const ordered = db.all<{ id: number; category: StatusCategory }>(
        'SELECT id, category FROM statuses ORDER BY position, id',
      );
      const index = insertionIndex(ordered, input.category);
      const now = nowIso();
      const { lastInsertRowid } = db.run(
        `INSERT INTO statuses (name, category, color, position, created_at, updated_at)
         VALUES (:name, :category, :color, :position, :now, :now)`,
        {
          name: input.name,
          category: input.category,
          color: input.color ?? DEFAULT_STATUS_COLOR,
          position: index,
          now,
        },
      );
      // Dense positions in the new order (later statuses shift by one; updated_at untouched).
      const ids = ordered.map((s) => s.id);
      ids.splice(index, 0, lastInsertRowid);
      applyPositions(db, 'statuses', ids);
      return getStatus(db, lastInsertRowid);
    });
    return c.json(status, 201);
  });

  // Registered before '/:id' routes for clarity (POST /:id does not exist, so there is no clash).
  r.post('/reorder', async (c) => {
    const { ids } = await readJson(c, reorderInput);
    db.tx(() => {
      const all = db.all<{ id: number }>('SELECT id FROM statuses').map((s) => s.id);
      assertExactIdSet(ids, all);
      applyPositions(db, 'statuses', ids);
    });
    return c.json({ ok: true as const });
  });

  r.patch('/:id', async (c) => {
    const id = readId(c);
    const input = await readJson(c, statusUpdateInput);
    const status = db.tx(() => {
      const row = requireStatus(db, id);
      const next: Pick<StatusRow, 'name' | 'category' | 'color'> = {
        name: input.name ?? row.name,
        category: input.category ?? row.category,
        color: input.color ?? row.color,
      };
      if (next.name === row.name && next.category === row.category && next.color === row.color) {
        return getStatus(db, id);
      }
      // A case-only rename of the status itself is allowed.
      if (next.name !== row.name) assertStatusNameFree(db, next.name, id);
      const now = nowIso();
      db.run(
        'UPDATE statuses SET name = :name, category = :category, color = :color, updated_at = :now WHERE id = :id',
        { id, ...next, now },
      );
      const wasClosed = isClosedCategory(row.category);
      const isClosed = isClosedCategory(next.category);
      if (!wasClosed && isClosed) {
        db.run('UPDATE tasks SET completed_at = :now WHERE status_id = :id AND completed_at IS NULL', { id, now });
      } else if (wasClosed && !isClosed) {
        db.run('UPDATE tasks SET completed_at = NULL WHERE status_id = :id AND completed_at IS NOT NULL', { id });
      }
      return getStatus(db, id);
    });
    return c.json(status);
  });

  r.delete('/:id', (c) => {
    const id = readId(c);
    const { reassignTo } = readQuery(c, statusDeleteQuery);
    db.tx(() => {
      const row = requireStatus(db, id);
      const statusCount = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM statuses')!.n;
      if (statusCount <= 1) throw conflict('The last status cannot be deleted; at least one status must exist');

      let target: StatusRow | undefined;
      if (reassignTo !== undefined) {
        if (reassignTo === id) {
          throw badRequest('Tasks cannot be reassigned to the status being deleted', [
            { path: 'query.reassignTo', message: 'Choose a different status' },
          ]);
        }
        target = db.get<StatusRow>('SELECT * FROM statuses WHERE id = :reassignTo', { reassignTo });
        if (!target) {
          throw badRequest('Status to reassign to not found', [
            { path: 'query.reassignTo', message: 'Status not found' },
          ]);
        }
      }

      const count = taskCount(db, id);
      if (count > 0) {
        if (!target) {
          throw conflict(
            `${plural(count, 'task')} ${count === 1 ? 'uses' : 'use'} the status “${row.name}”; ` +
              'choose a status to move them to (reassignTo)',
          );
        }
        // Indirect change: completedAt follows the target category; updated_at and activity untouched.
        if (isClosedCategory(target.category)) {
          db.run(
            'UPDATE tasks SET status_id = :to, completed_at = COALESCE(completed_at, :now) WHERE status_id = :id',
            { id, to: target.id, now: nowIso() },
          );
        } else {
          db.run('UPDATE tasks SET status_id = :to, completed_at = NULL WHERE status_id = :id', { id, to: target.id });
        }
      }

      rewriteBoardRefs(db, 'status', id, target?.id ?? null);
      db.run('DELETE FROM statuses WHERE id = :id', { id });
    });
    return c.json({ ok: true as const });
  });

  return r;
}
