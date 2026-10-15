import { describe, expect, it } from 'vitest';
import { LIMITS } from '@shared/constants';
import { duplicateBoardName } from '../src/routes/boards';
import { commentExcerpt } from '../src/services/activity';
import { copyTitle } from '../src/services/taskMutations';
import { truncateText } from '../src/services/text';
import { createTestContext } from './helpers';

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('truncateText', () => {
  it('cuts to at most max UTF-16 units without splitting a surrogate pair', () => {
    expect(truncateText('abc', 5)).toBe('abc');
    expect(truncateText('abcdef', 3)).toBe('abc');
    expect(truncateText('a😀b', 2)).toBe('a'); // the cut would land inside the emoji
    expect(truncateText('a😀b', 3)).toBe('a😀');
    expect(truncateText('😀', 1)).toBe('');
    expect(truncateText('', 0)).toBe('');
  });

  it('copyTitle, duplicateBoardName and commentExcerpt never leave half an emoji', () => {
    const title = copyTitle('ab' + '😀'.repeat(249));
    expect(title.length).toBeLessThanOrEqual(LIMITS.titleMax);
    expect(title).toMatch(/😀 \(copy\)$/);
    expect(title).not.toMatch(LONE_SURROGATE);

    const board = duplicateBoardName('b' + '😀'.repeat(40));
    expect(board.length).toBeLessThanOrEqual(LIMITS.boardNameMax);
    expect(board).toMatch(/😀 copy$/);
    expect(board).not.toMatch(LONE_SURROGATE);

    const excerpt = commentExcerpt('x' + '😀'.repeat(120));
    expect(excerpt.length).toBeLessThanOrEqual(200);
    expect(excerpt).not.toMatch(LONE_SURROGATE);
    expect(excerpt.endsWith('😀')).toBe(true);
  });
});

describe('API: truncated snapshots keep whole characters', () => {
  it('duplicate titles and comment / work-log excerpts', async () => {
    const ctx = createTestContext();
    const { client } = await ctx.signedIn();
    const project = (await client.post<{ id: number }>('/api/projects', { name: 'Emoji', key: 'EMO' })).body;
    const task = await client.post<{ id: number }>('/api/tasks', { projectId: project.id, title: 'ab' + '😀'.repeat(249) });
    expect(task.status).toBe(201);

    const copy = await client.post<{ id: number; title: string }>(`/api/tasks/${task.body.id}/duplicate`);
    expect(copy.status).toBe(201);
    expect(copy.body.title).not.toContain('�');
    expect(copy.body.title).toMatch(/😀 \(copy\)$/);
    const stored = ctx.db.get<{ title: string }>('SELECT title FROM tasks WHERE id = :id', { id: copy.body.id })!.title;
    expect(stored).toBe(copy.body.title);

    expect((await client.post(`/api/tasks/${task.body.id}/comments`, { body: 'x' + '😀'.repeat(120) })).status).toBe(201);
    expect((await client.post(`/api/tasks/${task.body.id}/worklogs`, { date: '2026-05-01', note: 'y' + '😀'.repeat(120) })).status).toBe(201);
    const feed = (await client.get<{ items: Array<{ action: string; data: { excerpt?: string; note?: string } }> }>(
      `/api/activity?taskId=${task.body.id}&limit=2`,
    )).body.items;
    const excerpt = feed.find((a) => a.action === 'comment.created')!.data.excerpt!;
    const note = feed.find((a) => a.action === 'worklog.created')!.data.note!;
    for (const text of [excerpt, note]) {
      expect(text).not.toMatch(LONE_SURROGATE);
      expect(text).not.toContain('�');
      expect(text.endsWith('😀')).toBe(true);
    }
  });
});
