import { describe, expect, it } from 'vitest';
import { defaultBoardConfig, type BoardConfigInput } from '@shared/board';
import { DEFAULT_TAG_COLOR } from '@shared/constants';
import type { BoardDTO, TagDTO } from '@shared/types';
import type { Db } from '../src/db';
import { getBoard } from '../src/services/entities';
import { createTestContext } from './helpers';
import { insertProject, insertTask, T0 } from './services.fixtures';

async function setup() {
  const ctx = createTestContext();
  const { client, user } = await ctx.signedIn();
  const projectId = insertProject(ctx.db, 'WEB');
  return { ...ctx, client, user, projectId };
}

function insertBoard(db: Db, config: BoardConfigInput): number {
  return db.run(
    `INSERT INTO boards (project_id, name, config, position, created_at, updated_at)
     VALUES (NULL, 'Tag board', :config, 9, :t, :t)`,
    { config: JSON.stringify(defaultBoardConfig(config)), t: T0 },
  ).lastInsertRowid;
}

const tagIdsOf = (db: Db, taskId: number) =>
  db.all<{ tag_id: number }>('SELECT tag_id FROM task_tags WHERE task_id = :taskId ORDER BY tag_id', { taskId }).map((r) => r.tag_id);
const activityCount = (db: Db) => db.get<{ n: number }>('SELECT COUNT(*) AS n FROM activity')!.n;
const updatedAt = (db: Db, taskId: number) =>
  db.get<{ updated_at: string }>('SELECT updated_at FROM tasks WHERE id = :taskId', { taskId })!.updated_at;

describe('tags API', () => {
  it('creates tags with defaults, trims names and lower-cases colors', async () => {
    const { client } = await setup();
    const a = await client.post<TagDTO>('/api/tags', { name: '  bug  ' });
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({ name: 'bug', color: DEFAULT_TAG_COLOR, taskCount: 0 });
    expect(typeof a.body.id).toBe('number');
    expect(a.body.createdAt).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);

    const b = await client.post<TagDTO>('/api/tags', { name: 'Idea', color: '#AABBCC' });
    expect(b.status).toBe(201);
    expect(b.body.color).toBe('#aabbcc');
  });

  it('lists tags by name (case-insensitive) with non-archived task counts', async () => {
    const { client, db, projectId } = await setup();
    const zeta = (await client.post<TagDTO>('/api/tags', { name: 'zeta' })).body;
    const alpha = (await client.post<TagDTO>('/api/tags', { name: 'Alpha' })).body;
    const beta = (await client.post<TagDTO>('/api/tags', { name: 'beta' })).body;
    insertTask(db, { projectId, tagIds: [alpha.id, beta.id] });
    insertTask(db, { projectId, tagIds: [alpha.id] });
    insertTask(db, { projectId, tagIds: [alpha.id], archivedAt: T0 });

    const res = await client.get<TagDTO[]>('/api/tags');
    expect(res.status).toBe(200);
    expect(res.body.map((t) => [t.name, t.taskCount])).toEqual([
      ['Alpha', 2],
      ['beta', 1],
      ['zeta', 0],
    ]);
    expect(res.body.find((t) => t.id === zeta.id)).toMatchObject({ color: DEFAULT_TAG_COLOR });
  });

  it('rejects invalid input with 400 and duplicate names (any case, Unicode) with 409', async () => {
    const { client } = await setup();
    expect((await client.post('/api/tags', { name: '' })).status).toBe(400);
    expect((await client.post('/api/tags', { name: '   ' })).status).toBe(400);
    expect((await client.post('/api/tags', { name: 'x'.repeat(41) })).status).toBe(400);
    const badColor = await client.post('/api/tags', { name: 'ok', color: 'red' });
    expect(badColor.status).toBe(400);
    expect(badColor.body.error.details[0].path).toBe('color');
    expect((await client.request('POST', '/api/tags', '{not json')).status).toBe(400);

    expect((await client.post('/api/tags', { name: 'Bug' })).status).toBe(201);
    const dup = await client.post('/api/tags', { name: 'bUG' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('conflict');

    expect((await client.post('/api/tags', { name: 'Äpfel' })).status).toBe(201);
    expect((await client.post('/api/tags', { name: 'äPFEL' })).status).toBe(409);
  });

  it('renames and recolors; case-only self-rename is allowed; conflicts and 404s', async () => {
    const { client, db } = await setup();
    const bug = (await client.post<TagDTO>('/api/tags', { name: 'bug' })).body;
    const idea = (await client.post<TagDTO>('/api/tags', { name: 'idea' })).body;

    const renamed = await client.patch<TagDTO>(`/api/tags/${bug.id}`, { name: 'Bug', color: '#EF4444' });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ id: bug.id, name: 'Bug', color: '#ef4444' });

    const taken = await client.patch(`/api/tags/${bug.id}`, { name: 'IDEA' });
    expect(taken.status).toBe(409);
    expect((await client.get<TagDTO[]>('/api/tags')).body.map((t) => t.name)).toEqual(['Bug', 'idea']);

    expect((await client.patch('/api/tags/9999', { name: 'x' })).status).toBe(404);
    expect((await client.patch('/api/tags/abc', { name: 'x' })).status).toBe(400);
    expect((await client.patch(`/api/tags/${idea.id}`, { color: 'blue' })).status).toBe(400);

    // A no-op patch changes nothing (updated_at kept).
    const before = db.get<{ updated_at: string }>('SELECT updated_at FROM tags WHERE id = :id', { id: idea.id })!.updated_at;
    db.run('UPDATE tags SET updated_at = :t WHERE id = :id', { id: idea.id, t: T0 });
    const same = await client.patch<TagDTO>(`/api/tags/${idea.id}`, { name: 'idea' });
    expect(same.status).toBe(200);
    expect(db.get<{ updated_at: string }>('SELECT updated_at FROM tags WHERE id = :id', { id: idea.id })!.updated_at).toBe(T0);
    expect(before).not.toBe(T0);
  });

  it('deletes a tag: untags tasks without touching them, cleans board drop patches/prefs, keeps filter ids', async () => {
    const { client, db, projectId } = await setup();
    const bug = (await client.post<TagDTO>('/api/tags', { name: 'bug' })).body;
    const idea = (await client.post<TagDTO>('/api/tags', { name: 'idea' })).body;
    const task = insertTask(db, { projectId, tagIds: [bug.id, idea.id] });
    const boardId = insertBoard(db, {
      filter: { tagIds: [bug.id, idea.id] },
      columns: { groupBy: 'tag', prefs: { tag: { order: [String(bug.id), String(idea.id)], wipLimits: { [bug.id]: 3 } } } },
      swimlanes: {
        groupBy: 'custom',
        custom: [{ id: 'c1', name: 'Bugs', match: { tagIds: [bug.id] }, onDrop: { addTagIds: [bug.id, idea.id] } }],
      },
    });
    const activityBefore = activityCount(db);

    const res = await client.delete(`/api/tags/${bug.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(tagIdsOf(db, task)).toEqual([idea.id]);
    expect(updatedAt(db, task)).toBe(T0);
    expect(activityCount(db)).toBe(activityBefore);
    expect((await client.get<TagDTO[]>('/api/tags')).body.map((t) => t.id)).toEqual([idea.id]);

    const cfg = getBoard(db, boardId).config;
    expect(cfg.filter.tagIds).toEqual([bug.id, idea.id]);
    expect(cfg.columns.prefs.tag?.order).toEqual([String(idea.id)]);
    expect(cfg.columns.prefs.tag?.wipLimits).toEqual({});
    expect(cfg.swimlanes.custom[0]!.onDrop).toEqual({ addTagIds: [idea.id] });
    expect(getBoard(db, boardId).updatedAt).toBe(T0);

    expect((await client.delete(`/api/tags/${bug.id}`)).status).toBe(404);
  });

  it('merges a tag into another: retags without duplicates, deletes the source, remaps boards', async () => {
    const { client, db, projectId } = await setup();
    const bug = (await client.post<TagDTO>('/api/tags', { name: 'bug' })).body;
    const defect = (await client.post<TagDTO>('/api/tags', { name: 'defect' })).body;
    const other = (await client.post<TagDTO>('/api/tags', { name: 'other' })).body;
    const both = insertTask(db, { projectId, tagIds: [bug.id, defect.id] });
    const onlyDefect = insertTask(db, { projectId, tagIds: [defect.id, other.id] });
    const archived = insertTask(db, { projectId, tagIds: [defect.id], archivedAt: T0 });
    const untouched = insertTask(db, { projectId, tagIds: [other.id] });
    const boardId = insertBoard(db, {
      filter: { tagIds: [defect.id], excludeTagIds: [defect.id, bug.id] },
      columns: { groupBy: 'tag', prefs: { tag: { hidden: [String(defect.id)] } } },
    });
    const activityBefore = activityCount(db);

    const res = await client.post<TagDTO>(`/api/tags/${defect.id}/merge`, { targetId: bug.id });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: bug.id, name: 'bug', taskCount: 2 });
    expect(tagIdsOf(db, both)).toEqual([bug.id]);
    expect(tagIdsOf(db, onlyDefect)).toEqual([bug.id, other.id]);
    expect(tagIdsOf(db, archived)).toEqual([bug.id]);
    expect(tagIdsOf(db, untouched)).toEqual([other.id]);
    for (const id of [both, onlyDefect, archived]) expect(updatedAt(db, id)).toBe(T0);
    expect(activityCount(db)).toBe(activityBefore);
    expect(db.get('SELECT 1 FROM tags WHERE id = :id', { id: defect.id })).toBeUndefined();

    const board: BoardDTO = getBoard(db, boardId);
    expect(board.config.filter.tagIds).toEqual([bug.id]);
    expect(board.config.filter.excludeTagIds).toEqual([bug.id]);
    // The source's "hidden" pref is dropped, never copied onto the (visible) target tag.
    expect(board.config.columns.prefs.tag?.hidden).toEqual([]);
  });

  it('validates merges: self → 400, unknown target → 400, unknown source → 404', async () => {
    const { client } = await setup();
    const a = (await client.post<TagDTO>('/api/tags', { name: 'a' })).body;
    const self = await client.post(`/api/tags/${a.id}/merge`, { targetId: a.id });
    expect(self.status).toBe(400);
    expect(self.body.error.details[0].path).toBe('targetId');
    const unknown = await client.post(`/api/tags/${a.id}/merge`, { targetId: 999 });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.details[0].path).toBe('targetId');
    expect((await client.post(`/api/tags/999/merge`, { targetId: a.id })).status).toBe(404);
    expect((await client.post(`/api/tags/${a.id}/merge`, {})).status).toBe(400);
    expect((await client.post(`/api/tags/${a.id}/merge`, { targetId: 'x' })).status).toBe(400);
    expect((await client.get<TagDTO[]>('/api/tags')).body).toHaveLength(1);
  });

  it('requires a session and the CSRF header', async () => {
    const { client, app, path } = await setup();
    const anon = await app.request(path('/api/tags'));
    expect(anon.status).toBe(401);
    const noCsrf = await client.request('POST', '/api/tags', { name: 'x' }, { 'X-Lyren-Request': '' });
    expect(noCsrf.status).toBe(403);
  });
});
