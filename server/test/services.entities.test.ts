import { describe, expect, it } from 'vitest';
import { HttpError } from '../src/http/errors';
import {
  applyPositions,
  assertExactIdSet,
  baseProjectKey,
  defaultStatusId,
  generateProjectKey,
  getBoard,
  isProjectKeyTaken,
  listBoards,
  listTags,
  nextPosition,
  nextTaskNumber,
  requireProject,
  requireTagIds,
  requireTask,
  uniqueProjectKey,
} from '../src/services/entities';
import { getTaskDTO, getTaskDTOs, taskRefOf } from '../src/services/tasks';
import { createDb, insertProject, insertStatus, insertTag, insertTask, statusIdByName } from './services.fixtures';

function httpError(fn: () => unknown): HttpError {
  try {
    fn();
  } catch (err) {
    if (err instanceof HttpError) return err;
    throw err;
  }
  throw new Error('expected an HttpError');
}

describe('project keys', () => {
  it.each([
    ['Website Relaunch', 'WR'],
    ['Lyren', 'LYR'],
    ['one two three four five', 'OTTF'],
    ['a', 'AX'],
    ['x', 'XX'],
    ['2026 Roadmap', 'P2R'],
    ['42', 'P42'],
    ['日本語', 'PX'],
    ['', 'PX'],
    ['Été à Paris', 'EAP'],
    ['Ärger', 'ARG'],
    ['  my-app  ', 'MA'],
    ['C++ tools & more', 'CTM'],
  ])('baseProjectKey(%j) = %s', (name, key) => {
    expect(baseProjectKey(name)).toBe(key);
    expect(key).toMatch(/^[A-Z][A-Z0-9]{1,9}$/);
  });

  it('appends 2, 3, … when taken (case-insensitive) and stays within 10 chars', () => {
    const { db } = createDb();
    insertProject(db, 'LYR');
    expect(isProjectKeyTaken(db, 'lyr')).toBe(true);
    expect(generateProjectKey(db, 'Lyren')).toBe('LYR2');
    insertProject(db, 'LYR2');
    expect(generateProjectKey(db, 'lyren')).toBe('LYR3');
    insertProject(db, 'ABCDEFGHIJ');
    expect(uniqueProjectKey(db, 'ABCDEFGHIJ')).toBe('ABCDEFGHI2');
    for (let n = 2; n <= 9; n++) insertProject(db, `ABCDEFGHI${n}`);
    expect(uniqueProjectKey(db, 'ABCDEFGHIJ')).toBe('ABCDEFGH10');
    const own = requireProject(db, 1);
    expect(isProjectKeyTaken(db, 'LYR', own.id)).toBe(false);
  });
});

describe('entity helpers', () => {
  it('requireX throws 404 for missing rows', () => {
    const { db } = createDb();
    const err = httpError(() => requireTask(db, 123));
    expect(err.status).toBe(404);
    expect(err.message).toBe('Task not found');
    expect(() => getTaskDTO(db, 5)).toThrow(HttpError);
    expect(() => getBoard(db, 999)).toThrow(HttpError);
  });

  it('requireTagIds dedupes and lists unknown ids (400, path tagIds)', () => {
    const { db } = createDb();
    const a = insertTag(db, 'a');
    const b = insertTag(db, 'B');
    expect(requireTagIds(db, [b, a, b]).map((t) => t.id)).toEqual([b, a]);
    expect(requireTagIds(db, [])).toEqual([]);
    const err = httpError(() => requireTagIds(db, [a, 77, 78]));
    expect(err.status).toBe(400);
    expect(err.message).toContain('77, 78');
    expect(err.details).toEqual([{ path: 'tagIds', message: 'Unknown tag ids: 77, 78' }]);
    expect(httpError(() => requireTagIds(db, [9], 'addTagIds')).details?.[0]?.path).toBe('addTagIds');
  });

  it('defaultStatusId prefers the first unstarted status by position', () => {
    const { db } = createDb();
    expect(defaultStatusId(db)).toBe(statusIdByName(db, 'Todo'));
    const early = insertStatus(db, 'Next up', 'unstarted', -1);
    expect(defaultStatusId(db)).toBe(early);
    db.run("DELETE FROM statuses WHERE category = 'unstarted'");
    expect(defaultStatusId(db)).toBe(statusIdByName(db, 'Backlog'));
  });

  it('nextPosition appends within the right scope', () => {
    const { db } = createDb();
    expect(nextPosition(db, 'projects')).toBe(0);
    const p = insertProject(db, 'ONE');
    insertProject(db, 'TWO');
    expect(nextPosition(db, 'projects')).toBe(2);
    expect(nextPosition(db, 'milestones', p)).toBe(0);
    expect(nextPosition(db, 'statuses')).toBe(6);
    // ensureDefaults created one global board at position 0.
    expect(nextPosition(db, 'boards', null)).toBe(1);
    expect(nextPosition(db, 'boards', p)).toBe(0);
  });

  it('applyPositions + listBoards order by scope and position', () => {
    const { db } = createDb();
    const p = insertProject(db, 'ONE');
    const insert = (projectId: number | null, name: string) =>
      db.run(
        `INSERT INTO boards (project_id, name, config, position, created_at, updated_at)
         VALUES (:projectId, :name, '{}', :position, 't', 't')`,
        { projectId, name, position: nextPosition(db, 'boards', projectId) },
      ).lastInsertRowid;
    const g2 = insert(null, 'G2');
    const p1 = insert(p, 'P1');
    const p2 = insert(p, 'P2');
    const [g1] = listBoards(db, null).map((b) => b.id);
    applyPositions(db, 'boards', [p2, p1]);
    expect(listBoards(db, p).map((b) => b.name)).toEqual(['P2', 'P1']);
    expect(listBoards(db).map((b) => b.id)).toEqual([g1, g2, p2, p1]);
    expect(listBoards(db, null).every((b) => b.projectId === null)).toBe(true);
    // A stored '{}' config is completed with defaults.
    expect(getBoard(db, p1).config.columns.groupBy).toBe('status');
  });

  it('assertExactIdSet requires every id exactly once', () => {
    expect(() => assertExactIdSet([3, 1, 2], [1, 2, 3])).not.toThrow();
    const dup = httpError(() => assertExactIdSet([1, 1, 2, 3], [1, 2, 3]));
    expect(dup.status).toBe(400);
    expect(dup.message).toContain('duplicate ids: 1');
    expect(httpError(() => assertExactIdSet([1, 2], [1, 2, 3])).message).toContain('missing ids: 3');
    expect(httpError(() => assertExactIdSet([1, 2, 3, 4], [1, 2, 3])).message).toContain('unknown ids: 4');
    expect(httpError(() => assertExactIdSet([1], [2], 'order')).details?.[0]?.path).toBe('order');
  });

  it('nextTaskNumber increments the project counter', () => {
    const { db } = createDb();
    const p = insertProject(db, 'ONE');
    expect(nextTaskNumber(db, p)).toBe(1);
    expect(nextTaskNumber(db, p)).toBe(2);
    expect(httpError(() => nextTaskNumber(db, 999)).status).toBe(404);
  });

  it('lists tags case-insensitively by name', () => {
    const { db } = createDb();
    for (const name of ['beta', 'Alpha', 'été', 'Zulu', 'alpha2']) insertTag(db, name);
    expect(listTags(db).map((t) => t.name)).toEqual(['Alpha', 'alpha2', 'beta', 'été', 'Zulu']);
  });

  it('getTaskDTOs keeps the requested order and skips unknown ids', () => {
    const { db } = createDb();
    const p = insertProject(db, 'ONE');
    const a = insertTask(db, { projectId: p });
    const b = insertTask(db, { projectId: p });
    expect(getTaskDTOs(db, [b, 999, a, b]).map((t) => t.ref)).toEqual(['ONE-2', 'ONE-1']);
    expect(taskRefOf(db, { project_id: p, number: 7 })).toBe('ONE-7');
  });
});
