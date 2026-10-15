import { describe, expect, it } from 'vitest';
import { defaultBoardConfig, type BoardConfigInput } from '@shared/board';
import type { Db } from '../src/db';
import { rewriteBoardRefs } from '../src/services/boardRefs';
import { getBoard } from '../src/services/entities';
import { createDb } from './services.fixtures';

const STAMP = '2026-01-01T00:00:00.000Z';

function insertBoard(db: Db, config: BoardConfigInput | string): number {
  return db.run(
    `INSERT INTO boards (project_id, name, config, position, created_at, updated_at)
     VALUES (NULL, 'B', :config, 0, :t, :t)`,
    { config: typeof config === 'string' ? config : JSON.stringify(defaultBoardConfig(config)), t: STAMP },
  ).lastInsertRowid;
}

const rawConfig = (db: Db, id: number) => db.get<{ config: string }>('SELECT config FROM boards WHERE id = :id', { id })!.config;

describe('rewriteBoardRefs', () => {
  function world() {
    const { db } = createDb();
    const tagBoard = insertBoard(db, {
      filter: { tagIds: [5, null, 6], excludeTagIds: [5] },
      columns: {
        groupBy: 'tag',
        prefs: { tag: { order: ['5', '6'], hidden: ['5'], collapsed: ['none', '5'], wipLimits: { '5': 3 } } },
      },
      swimlanes: {
        groupBy: 'custom',
        custom: [
          { id: 'c1', name: 'Bugs', match: { tagIds: [5] }, onDrop: { addTagIds: [5, 8], removeTagIds: [6] } },
          { id: 'c2', name: 'Doing', match: { statusIds: [3] }, onDrop: { statusId: 3 } },
        ],
      },
    });
    const statusBoard = insertBoard(db, {
      filter: { statusIds: [3, 4] },
      columns: { groupBy: 'status', prefs: { status: { order: ['4', '3'], wipLimits: { '3': 2, '4': 9 } } } },
    });
    const untouched = insertBoard(db, { filter: { projectIds: [1] } });
    return { db, tagBoard, statusBoard, untouched };
  }

  it('remaps merged ids everywhere and saves only changed boards (updated_at kept)', () => {
    const { db, tagBoard, statusBoard, untouched } = world();
    const before = rawConfig(db, untouched);
    expect(rewriteBoardRefs(db, 'tag', 5, 7)).toBe(1);
    const cfg = getBoard(db, tagBoard).config;
    expect(cfg.filter.tagIds).toEqual([7, null, 6]);
    expect(cfg.filter.excludeTagIds).toEqual([7]);
    // The merged tag's display prefs are dropped; the target (7) keeps its own (none).
    expect(cfg.columns.prefs.tag).toEqual({ order: ['6'], hidden: [], collapsed: ['none'], wipLimits: {} });
    expect(cfg.swimlanes.custom[0]!.match.tagIds).toEqual([7]);
    expect(cfg.swimlanes.custom[0]!.onDrop).toEqual({ addTagIds: [7, 8], removeTagIds: [6] });
    expect(getBoard(db, tagBoard).updatedAt).toBe(STAMP);
    expect(rawConfig(db, untouched)).toBe(before);

    expect(rewriteBoardRefs(db, 'status', 3, 4)).toBe(2);
    const s = getBoard(db, statusBoard).config;
    expect(s.filter.statusIds).toEqual([4]);
    expect(s.columns.prefs.status).toEqual({ order: ['4'], hidden: [], collapsed: [], wipLimits: { '4': 9 } });
    expect(getBoard(db, tagBoard).config.swimlanes.custom[1]!.onDrop).toEqual({ statusId: 4 });
  });

  it('on delete keeps filter ids but drops them from drop patches and group prefs', () => {
    const { db, tagBoard } = world();
    expect(rewriteBoardRefs(db, 'tag', 5, null)).toBe(1);
    const cfg = getBoard(db, tagBoard).config;
    expect(cfg.filter.tagIds).toEqual([5, null, 6]);
    expect(cfg.swimlanes.custom[0]!.match.tagIds).toEqual([5]);
    expect(cfg.swimlanes.custom[0]!.onDrop).toEqual({ addTagIds: [8], removeTagIds: [6] });
    expect(cfg.columns.prefs.tag).toEqual({ order: ['6'], hidden: [], collapsed: ['none'], wipLimits: {} });
    expect(rewriteBoardRefs(db, 'tag', 5, null)).toBe(0);
    expect(rewriteBoardRefs(db, 'epic', 1234, null)).toBe(0);
  });

  it('status reassignment does not hide or limit the target column', () => {
    const { db } = createDb();
    const id = insertBoard(db, {
      columns: { groupBy: 'status', prefs: { status: { hidden: ['6'], collapsed: ['6'], wipLimits: { '6': 2 } } } },
    });
    expect(rewriteBoardRefs(db, 'status', 6, 5)).toBe(1);
    expect(getBoard(db, id).config.columns.prefs.status).toEqual({ order: [], hidden: [], collapsed: [], wipLimits: {} });
  });

  it('a tag merge never loses custom columns whose drop patch adds one tag and removes the other', () => {
    const { db } = createDb();
    const id = insertBoard(db, {
      columns: {
        groupBy: 'custom',
        custom: [
          { id: 'todo', name: 'To review', match: { tagIds: [1] }, onDrop: { addTagIds: [1], removeTagIds: [2] } },
          { id: 'done', name: 'Reviewed', match: { tagIds: [2] }, onDrop: { addTagIds: [2], removeTagIds: [1] } },
        ],
      },
    });
    expect(rewriteBoardRefs(db, 'tag', 1, 2)).toBe(1);
    const raw = JSON.parse(rawConfig(db, id)) as { columns: { custom: Array<{ id: string; onDrop: unknown }> } };
    expect(raw.columns.custom.map((c) => [c.id, c.onDrop])).toEqual([
      ['todo', { addTagIds: [2] }],
      ['done', { addTagIds: [2] }],
    ]);
    expect(getBoard(db, id).config.columns.custom.map((c) => c.id)).toEqual(['todo', 'done']);
  });

  it('repairs (rather than drops) custom columns already stored with an invalid drop patch', () => {
    const { db } = createDb();
    const stored = defaultBoardConfig({ columns: { groupBy: 'custom', custom: [{ id: 'a', name: 'A', match: { tagIds: [2] } }] } });
    const bad = { ...stored, columns: { ...stored.columns, custom: [{ ...stored.columns.custom[0]!, onDrop: { addTagIds: [2], removeTagIds: [2] } }] } };
    const id = insertBoard(db, JSON.stringify(bad));
    expect(getBoard(db, id).config.columns.custom.map((c) => [c.id, c.onDrop])).toEqual([['a', { addTagIds: [2] }]]);
    expect(rewriteBoardRefs(db, 'tag', 2, 3)).toBe(1);
    expect(getBoard(db, id).config.columns.custom.map((c) => [c.id, c.match.tagIds, c.onDrop])).toEqual([
      ['a', [3], { addTagIds: [3] }],
    ]);
  });

  it('survives corrupt stored configs', () => {
    const { db } = createDb();
    const bad = insertBoard(db, '{not json');
    expect(() => rewriteBoardRefs(db, 'tag', 1, 2)).not.toThrow();
    expect(getBoard(db, bad).config).toEqual(defaultBoardConfig());
  });
});
