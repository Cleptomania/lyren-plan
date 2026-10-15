import { describe, expect, it } from 'vitest';
import { nextEnabled, normalizeMenuItems, sectionMenuItems, typeaheadMatch, type MenuItem } from './menuItems';

const a = (label: string, extra: Partial<Extract<MenuItem, { label: string }>> = {}): MenuItem => ({ label, ...extra });
const sep: MenuItem = { separator: true };

describe('normalizeMenuItems', () => {
  it('drops falsy entries and stray separators', () => {
    const out = normalizeMenuItems([sep, a('A'), null, sep, sep, false, a('B'), sep, undefined]);
    expect(out).toEqual([a('A'), sep, a('B')]);
  });
  it('drops headings without actions and empty submenus', () => {
    const out = normalizeMenuItems([{ heading: 'Empty' }, sep, a('Sub', { items: [sep] }), { heading: 'H' }, a('X')]);
    expect(out).toEqual([{ heading: 'H' }, a('X')]);
  });
  it('normalizes submenus recursively', () => {
    const out = normalizeMenuItems([a('Sub', { items: [sep, a('Y'), sep] })]);
    expect(out).toEqual([a('Sub', { items: [a('Y')] })]);
  });
});

describe('sectionMenuItems', () => {
  it('splits by headings and numbers actions across sections', () => {
    const { sections, actions } = sectionMenuItems([a('A'), { heading: 'H' }, a('B'), sep, a('C')]);
    expect(actions.map((x) => x.label)).toEqual(['A', 'B', 'C']);
    expect(sections).toHaveLength(2);
    expect(sections[1]!.heading).toBe('H');
    expect(sections[1]!.entries.map((e) => (e.kind === 'action' ? e.index : '-'))).toEqual([1, '-', 2]);
  });
});

describe('keyboard helpers', () => {
  const list = [a('Apple'), a('Banana', { disabled: true }), a('Blueberry'), a('Cherry')].filter(
    (x): x is Extract<MenuItem, { label: string }> => 'label' in x,
  );
  it('nextEnabled skips disabled items and wraps', () => {
    expect(nextEnabled(list, 0, 1)).toBe(2);
    expect(nextEnabled(list, 3, 1)).toBe(0);
    expect(nextEnabled(list, 0, -1)).toBe(3);
  });
  it('typeaheadMatch finds the next enabled prefix match', () => {
    expect(typeaheadMatch(list, 'b', -1)).toBe(2);
    expect(typeaheadMatch(list, 'c', 0)).toBe(3);
    expect(typeaheadMatch(list, 'z', 0)).toBe(-1);
  });
});
