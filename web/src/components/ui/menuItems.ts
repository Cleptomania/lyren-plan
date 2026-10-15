// MenuItem contract (SPEC §9.1) and pure helpers for Menu.

import type { ReactNode } from 'react';

export interface MenuAction {
  label: string;
  icon?: ReactNode;
  onSelect?: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Checkable item (role=menuitemcheckbox). Leave undefined for plain actions. */
  checked?: boolean;
  /** Right-aligned secondary text (shortcut, count…). */
  hint?: string;
  /** Submenu. */
  items?: MenuItem[];
}

export type MenuItem = MenuAction | { separator: true } | { heading: string };

/** Entries accepted by <Menu items>: falsy entries are skipped (handy for conditional items). */
export type MenuItemInput = MenuItem | false | null | undefined;

export function isSeparator(item: MenuItem): item is { separator: true } {
  return 'separator' in item;
}

export function isHeading(item: MenuItem): item is { heading: string } {
  return 'heading' in item;
}

export function isAction(item: MenuItem): item is MenuAction {
  return !isSeparator(item) && !isHeading(item);
}

/**
 * Drop falsy entries, leading/trailing/duplicate separators, headings with no actions after
 * them, and submenus that end up empty.
 */
export function normalizeMenuItems(input: ReadonlyArray<MenuItemInput>): MenuItem[] {
  const out: MenuItem[] = [];
  for (const raw of input) {
    if (!raw) continue;
    if (isSeparator(raw)) {
      const last = out[out.length - 1];
      if (last && !isSeparator(last)) out.push(raw);
    } else if (isAction(raw) && raw.items) {
      const sub = normalizeMenuItems(raw.items);
      if (sub.some(isAction)) out.push({ ...raw, items: sub });
    } else {
      out.push(raw);
    }
  }
  // Headings followed by nothing actionable (end of list or a separator / another heading).
  const cleaned = out.filter((item, i) => {
    if (!isHeading(item)) return true;
    const next = out[i + 1];
    return next !== undefined && isAction(next);
  });
  while (cleaned.length && isSeparator(cleaned[cleaned.length - 1]!)) cleaned.pop();
  while (cleaned.length && isSeparator(cleaned[0]!)) cleaned.shift();
  // Removing headings can leave adjacent separators.
  return cleaned.filter((item, i) => !(isSeparator(item) && i > 0 && isSeparator(cleaned[i - 1]!)));
}

export interface MenuSection {
  heading?: string;
  /** Entries in order; actions carry their index among all actions of the menu level. */
  entries: Array<{ kind: 'separator' } | { kind: 'action'; item: MenuAction; index: number }>;
}

/** Split a normalized item list into heading-labelled sections and number the actions. */
export function sectionMenuItems(items: MenuItem[]): { sections: MenuSection[]; actions: MenuAction[] } {
  const sections: MenuSection[] = [{ entries: [] }];
  const actions: MenuAction[] = [];
  for (const item of items) {
    if (isHeading(item)) {
      sections.push({ heading: item.heading, entries: [] });
    } else if (isSeparator(item)) {
      sections[sections.length - 1]!.entries.push({ kind: 'separator' });
    } else {
      sections[sections.length - 1]!.entries.push({ kind: 'action', item, index: actions.length });
      actions.push(item);
    }
  }
  return { sections: sections.filter((s) => s.entries.length > 0 || s.heading), actions };
}

/** Index of the next enabled action whose label starts with `query` (typeahead), or -1. */
export function typeaheadMatch(actions: MenuAction[], query: string, from: number): number {
  const q = query.toLocaleLowerCase();
  const n = actions.length;
  for (let step = 1; step <= n; step++) {
    const i = (from + step + n) % n;
    const a = actions[i]!;
    if (!a.disabled && a.label.toLocaleLowerCase().startsWith(q)) return i;
  }
  return -1;
}

/** Next enabled action index from `from` in direction `dir` (wrapping), or -1 when none. */
export function nextEnabled(actions: MenuAction[], from: number, dir: 1 | -1): number {
  const n = actions.length;
  for (let step = 1; step <= n; step++) {
    const i = (((from + dir * step) % n) + n) % n;
    if (!actions[i]!.disabled) return i;
  }
  return -1;
}
