import { describe, expect, it } from 'vitest';
import { formatShortcutKeys } from '../../components/ui/shortcuts';
import { SHORTCUT_GROUPS, shortcutGroups, spokenCombo } from './shortcutList';

describe('shortcut list', () => {
  it('speaks combos per platform', () => {
    expect(spokenCombo('mod+k', true)).toBe('Command + K');
    expect(spokenCombo('mod+k', false)).toBe('Control + K');
    expect(spokenCombo('?', false)).toBe('Question mark');
    expect(spokenCombo('arrowup', false)).toBe('Up arrow');
    expect(spokenCombo('escape', true)).toBe('Escape');
    expect(spokenCombo('mod+enter', false)).toBe('Control + Enter');
  });

  it('lists the app-wide shortcuts from SPEC §9 with renderable keys', () => {
    const all = SHORTCUT_GROUPS.flatMap((g) => g.items.flatMap((i) => i.combos));
    for (const combo of ['mod+k', '/', 'c', '?', 'escape']) expect(all).toContain(combo);
    for (const combo of all) expect(formatShortcutKeys(combo, false).every((k) => k.length > 0)).toBe(true);
    // Labels are unique within a group (they are React keys).
    for (const g of SHORTCUT_GROUPS) expect(new Set(g.items.map((i) => i.label)).size).toBe(g.items.length);
  });

  it('leaves out what a viewer cannot use (design §12.9): new task, writing, moving cards', () => {
    expect(shortcutGroups(true)).toEqual(SHORTCUT_GROUPS);
    const viewer = shortcutGroups(false);
    const labels = viewer.flatMap((g) => g.items.map((i) => i.label));
    expect(labels).not.toContain('New task');
    expect(viewer.map((g) => g.title)).toEqual(['Anywhere', 'Search and commands', 'Lists, menus and pickers']);
    expect(labels).toContain('Search and run commands');
    expect(viewer.every((g) => g.items.length > 0)).toBe(true);
  });
});
