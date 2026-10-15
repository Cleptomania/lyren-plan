import { describe, expect, it } from 'vitest';
import { activePrefs, boardConfigSchema, defaultBoardConfig } from '@shared/board';
import {
  addCustomGroup,
  clashesWithColumns,
  mergeGroupOrder,
  moveAmongVisible,
  moveGroup,
  parseWipLimit,
  removeCustomGroup,
  setColumnsGroupBy,
  setGroupCollapsed,
  setGroupHidden,
  setGroupOrder,
  setLanesGroupBy,
  setWipLimit,
  updateCustomGroup,
  WIP_LIMIT_MAX,
} from './configOps';

const custom = (id: string) => ({ id, name: id.toUpperCase(), color: null, match: {}, onDrop: null });

describe('config operations', () => {
  it('detects swimlane fields that clash with the column field', () => {
    expect(clashesWithColumns('status', 'status')).toBe(true);
    expect(clashesWithColumns('status', 'statusCategory')).toBe(true);
    expect(clashesWithColumns('statusCategory', 'status')).toBe(true);
    expect(clashesWithColumns('custom', 'custom')).toBe(false);
    expect(clashesWithColumns('tag', 'none')).toBe(false);
    expect(clashesWithColumns('tag', 'project')).toBe(false);
  });

  it('changing the column field drops clashing swimlanes; clashing lanes are refused', () => {
    const cfg = defaultBoardConfig({ swimlanes: { groupBy: 'priority' } });
    expect(setColumnsGroupBy(cfg, 'priority').swimlanes.groupBy).toBe('none');
    expect(setColumnsGroupBy(cfg, 'epic').swimlanes.groupBy).toBe('priority');
    expect(setLanesGroupBy(cfg, 'statusCategory')).toBe(cfg);
    expect(setLanesGroupBy(cfg, 'tag').swimlanes.groupBy).toBe('tag');
  });

  it('collapses / hides groups in the prefs of the current field', () => {
    let cfg = setGroupCollapsed(defaultBoardConfig(), 'columns', '3', true);
    cfg = setGroupHidden(cfg, 'columns', '5', true);
    expect(activePrefs(cfg.columns)).toMatchObject({ collapsed: ['3'], hidden: ['5'] });
    cfg = setGroupCollapsed(cfg, 'columns', '3', false);
    expect(activePrefs(cfg.columns).collapsed).toEqual([]);
    expect(cfg.columns.prefs.priority).toBeUndefined();
    cfg = setGroupHidden(cfg, 'swimlanes', 'none', true);
    expect(cfg.swimlanes.prefs.none?.hidden).toEqual(['none']);
  });

  it('sets and clears WIP limits', () => {
    let cfg = setWipLimit(defaultBoardConfig(), '3', 4);
    expect(activePrefs(cfg.columns).wipLimits).toEqual({ '3': 4 });
    cfg = setWipLimit(cfg, '3', null);
    expect(activePrefs(cfg.columns).wipLimits).toEqual({});
    expect(activePrefs(setWipLimit(cfg, '3', 0).columns).wipLimits).toEqual({});
  });

  it('parses WIP limit text', () => {
    expect(parseWipLimit('')).toBeNull();
    expect(parseWipLimit('  ')).toBeNull();
    expect(parseWipLimit('3')).toBe(3);
    expect(parseWipLimit(' 12 ')).toBe(12);
    expect(parseWipLimit('0')).toBeUndefined();
    expect(parseWipLimit('-2')).toBeUndefined();
    expect(parseWipLimit('1.5')).toBeUndefined();
    expect(parseWipLimit('abc')).toBeUndefined();
    // Values the config schema (safe integers) would refuse, taking the whole PATCH with them.
    expect(parseWipLimit('99999999999999999999')).toBeUndefined();
    expect(parseWipLimit('1e3')).toBeUndefined();
    expect(parseWipLimit(String(WIP_LIMIT_MAX))).toBe(WIP_LIMIT_MAX);
    expect(parseWipLimit(String(WIP_LIMIT_MAX + 1))).toBeUndefined();
    expect(boardConfigSchema.safeParse(setWipLimit(defaultBoardConfig(), '1', WIP_LIMIT_MAX)).success).toBe(true);
  });

  it('moves a key next to its visible neighbour', () => {
    const all = ['a', 'h', 'b', 'c'];
    const visible = ['a', 'b', 'c'];
    expect(moveAmongVisible(all, visible, 'b', -1)).toEqual(['b', 'a', 'h', 'c']);
    expect(moveAmongVisible(all, visible, 'a', 1)).toEqual(['h', 'b', 'a', 'c']);
    expect(moveAmongVisible(all, visible, 'c', 1)).toEqual(all);
    expect(moveAmongVisible(all, visible, 'h', 1)).toEqual(all);
  });

  it('reorders via prefs.order, or the custom array for custom groups', () => {
    const cfg = defaultBoardConfig();
    const moved = moveGroup(cfg, 'columns', ['1', '2', '3'], ['1', '2', '3'], '3', -1);
    expect(activePrefs(moved.columns).order).toEqual(['1', '3', '2']);
    const c = defaultBoardConfig({ columns: { groupBy: 'custom', custom: [custom('x'), custom('y'), custom('z')] } });
    const m2 = moveGroup(c, 'columns', ['x', 'y', 'z', '__other'], ['x', 'y', 'z', '__other'], 'x', 1);
    expect(m2.columns.custom.map((x) => x.id)).toEqual(['y', 'x', 'z']);
    expect(moveGroup(c, 'columns', [], [], '__other', -1)).toBe(c);
    expect(setGroupOrder(c, 'columns', ['z', '__other', 'x']).columns.custom.map((x) => x.id)).toEqual(['z', 'x', 'y']);
    expect(activePrefs(setGroupOrder(cfg, 'columns', ['2', '1']).columns).order).toEqual(['2', '1']);
  });

  it('merges partial orders into the saved order instead of discarding unlisted groups', () => {
    expect(mergeGroupOrder(['0', '1', '2', '3', '4'], ['4', '3'])).toEqual(['0', '1', '2', '4', '3']);
    expect(mergeGroupOrder(['3', '0', '1', '2', '4'], ['4', '3'])).toEqual(['4', '3', '0', '1', '2']);
    expect(mergeGroupOrder([], ['2', '1'])).toEqual(['2', '1']);
    expect(mergeGroupOrder(['a', 'b'], ['b', 'a', 'c'])).toEqual(['b', 'a', 'c']);
    // A priority board with a saved order; a quick filter shows only High (3) and Urgent (4).
    const cfg = defaultBoardConfig({
      columns: { groupBy: 'priority', prefs: { priority: { order: ['0', '1', '2', '3', '4'] } } },
    });
    const moved = moveGroup(cfg, 'columns', ['3', '4'], ['3', '4'], '4', -1);
    expect(activePrefs(moved.columns).order).toEqual(['0', '1', '2', '4', '3']);
    expect(activePrefs(setGroupOrder(cfg, 'columns', ['4', '3']).columns).order).toEqual(['0', '1', '2', '4', '3']);
  });

  it('adds, updates and removes custom groups (with their prefs)', () => {
    let cfg = defaultBoardConfig({ swimlanes: { groupBy: 'custom' } });
    cfg = addCustomGroup(cfg, 'swimlanes', custom('a'));
    cfg = addCustomGroup(cfg, 'swimlanes', custom('b'));
    cfg = updateCustomGroup(cfg, 'swimlanes', 'a', { name: 'Alpha', id: 'zzz' });
    expect(cfg.swimlanes.custom.map((c) => [c.id, c.name])).toEqual([
      ['a', 'Alpha'],
      ['b', 'B'],
    ]);
    cfg = setGroupCollapsed(cfg, 'swimlanes', 'a', true);
    cfg = removeCustomGroup(cfg, 'swimlanes', 'a');
    expect(cfg.swimlanes.custom.map((c) => c.id)).toEqual(['b']);
    expect(cfg.swimlanes.prefs.custom?.collapsed).toEqual([]);
  });
});
