// /api/boards — saved board views (SPEC §7, §8): list/get/create/update/delete, duplicate and
// reorder. Boards are not activity subjects (§5.8), so nothing is logged here.
//
// Project boards (`projectId` set, immutable) always get config.filter.projectIds = [projectId]
// on create, update and duplicate. Positions are per scope: all global boards, or all boards
// of one project.

import { Hono } from 'hono';
import {
  boardCreateInput,
  boardUpdateInput,
  defaultBoardConfig,
  parseBoardConfigLenient,
  type BoardConfig,
} from '@shared/board';
import { LIMITS } from '@shared/constants';
import { reorderInput } from '@shared/schemas';
import type { Db } from '../db';
import type { AppEnv, Deps } from '../env';
import { badRequest } from '../http/errors';
import { readId, readJson } from '../http/validate';
import { clearDefaultBoardIfMissing } from '../services/boardRefs';
import { applyPositions, assertExactIdSet, getBoard, listBoards, nextPosition, requireBoard } from '../services/entities';
import { parseJson } from '../services/mappers';
import type { BoardRow } from '../services/rows';
import { nowIso } from '../services/sql';
import { truncateText } from '../services/text';

/** A project board's filter is always scoped to its project (SPEC §7 "Boards"). */
export function scopeBoardConfig(config: BoardConfig, projectId: number | null): BoardConfig {
  if (projectId === null) return config;
  return { ...config, filter: { ...config.filter, projectIds: [projectId] } };
}

/** 400 (path `projectId`) when the referenced project does not exist. */
function assertProjectExists(db: Db, projectId: number): void {
  if (db.get('SELECT 1 FROM projects WHERE id = :projectId', { projectId })) return;
  const message = `Unknown project id: ${projectId}`;
  throw badRequest(message, [{ path: 'projectId', message }]);
}

/** "<name> copy", truncated so the result stays within LIMITS.boardNameMax. */
export function duplicateBoardName(name: string): string {
  const suffix = ' copy';
  return `${truncateText(name, LIMITS.boardNameMax - suffix.length).trimEnd()}${suffix}`;
}

function insertBoard(
  db: Db,
  board: { projectId: number | null; name: string; description: string; config: BoardConfig },
): number {
  const now = nowIso();
  return db.run(
    `INSERT INTO boards (project_id, name, description, config, position, created_at, updated_at)
     VALUES (:projectId, :name, :description, :config, :position, :now, :now)`,
    {
      projectId: board.projectId,
      name: board.name,
      description: board.description,
      config: JSON.stringify(scopeBoardConfig(board.config, board.projectId)),
      position: nextPosition(db, 'boards', board.projectId),
      now,
    },
  ).lastInsertRowid;
}

export function boardRoutes({ db }: Deps) {
  const r = new Hono<AppEnv>();

  /** Every board: global boards first, then project boards (by project), each scope by position. */
  r.get('/', (c) => c.json(listBoards(db)));

  r.post('/', async (c) => {
    const input = await readJson(c, boardCreateInput);
    const projectId = input.projectId ?? null;
    const id = db.tx(() => {
      if (projectId !== null) assertProjectExists(db, projectId);
      return insertBoard(db, {
        projectId,
        name: input.name,
        description: input.description ?? '',
        config: input.config ?? defaultBoardConfig(),
      });
    });
    return c.json(getBoard(db, id), 201);
  });

  /**
   * Body: the ids of ONE scope (every global board, or every board of one project) in the
   * desired order. The scope is taken from the first id; the list must then be exactly it.
   */
  r.post('/reorder', async (c) => {
    const { ids } = await readJson(c, reorderInput);
    db.tx(() => {
      const first = db.get<Pick<BoardRow, 'project_id'>>('SELECT project_id FROM boards WHERE id = :id', { id: ids[0]! });
      const scope = first
        ? db.all<{ id: number }>('SELECT id FROM boards WHERE project_id IS :projectId', { projectId: first.project_id })
        : [];
      assertExactIdSet(
        ids,
        scope.map((b) => b.id),
      );
      applyPositions(db, 'boards', ids);
    });
    return c.json({ ok: true as const });
  });

  r.get('/:id', (c) => c.json(getBoard(db, readId(c))));

  /** name / description / complete config; projectId is immutable (ignored if sent). */
  r.patch('/:id', async (c) => {
    const id = readId(c);
    const input = await readJson(c, boardUpdateInput);
    db.tx(() => {
      const before = requireBoard(db, id);
      const name = input.name ?? before.name;
      const description = input.description ?? before.description;
      const config =
        input.config !== undefined ? JSON.stringify(scopeBoardConfig(input.config, before.project_id)) : before.config;
      if (name === before.name && description === before.description && config === before.config) return; // no-op
      db.run(
        `UPDATE boards SET name = :name, description = :description, config = :config, updated_at = :now
          WHERE id = :id`,
        { id, name, description, config, now: nowIso() },
      );
    });
    return c.json(getBoard(db, id));
  });

  /** Clears settings.defaultBoardId when it pointed at this board. */
  r.delete('/:id', (c) => {
    const id = readId(c);
    db.tx(() => {
      requireBoard(db, id);
      db.run('DELETE FROM boards WHERE id = :id', { id });
      clearDefaultBoardIfMissing(db);
    });
    return c.json({ ok: true as const });
  });

  /** Copy named "<name> copy" in the same scope, appended at the end of it. */
  r.post('/:id/duplicate', (c) => {
    const id = readId(c);
    const copyId = db.tx(() => {
      const source = requireBoard(db, id);
      return insertBoard(db, {
        projectId: source.project_id,
        name: duplicateBoardName(source.name),
        description: source.description,
        config: parseBoardConfigLenient(parseJson(source.config, {})),
      });
    });
    return c.json(getBoard(db, copyId), 201);
  });

  return r;
}
