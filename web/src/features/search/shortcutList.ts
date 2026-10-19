// Every keyboard shortcut the app defines, for the "Keyboard shortcuts" help dialog ('?').
// Combos use the useHotkey / formatShortcutKeys syntax ('mod+k', 'shift+?', 'arrowup', 'escape').
// Keep this list in sync with the hotkeys registered across the app.

export interface ShortcutEntry {
  /** Combos for the command: alternatives ("A or B") or, with `together`, keys used as a set ("↑ ↓"). */
  combos: string[];
  label: string;
  together?: boolean;
  /** Only for a role that may change the space (viewers create, write and drag nothing, design §12.9). */
  write?: boolean;
}

export interface ShortcutGroup {
  title: string;
  /** Short note under the group title. */
  note?: string;
  /** Every entry needs the write permission. */
  write?: boolean;
  items: ShortcutEntry[];
}

export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  {
    title: 'Anywhere',
    note: 'Single-key shortcuts are paused while you type or while a dialog or menu is open.',
    items: [
      { combos: ['mod+k', '/'], label: 'Search and run commands' },
      { combos: ['c'], label: 'New task', write: true },
      { combos: ['?'], label: 'Show keyboard shortcuts' },
      { combos: ['escape'], label: 'Close the top dialog, drawer or menu' },
    ],
  },
  {
    title: 'Search and commands',
    items: [
      { combos: ['arrowup', 'arrowdown'], label: 'Move through results', together: true },
      { combos: ['enter'], label: 'Open the result or run the command' },
      { combos: ['mod+enter'], label: 'Open a task as a full page' },
      { combos: ['escape'], label: 'Close' },
    ],
  },
  {
    title: 'Lists, menus and pickers',
    items: [
      { combos: ['arrowup', 'arrowdown'], label: 'Move between items', together: true },
      { combos: ['arrowright', 'arrowleft'], label: 'Open or close a submenu', together: true },
      { combos: ['enter'], label: 'Choose the highlighted item, or open the focused task' },
    ],
  },
  {
    title: 'Writing',
    note: 'In the new-task dialog, comments, descriptions and work-log entries.',
    write: true,
    items: [
      { combos: ['mod+enter'], label: 'Save, send or create' },
      { combos: ['mod+b'], label: 'Bold' },
      { combos: ['mod+i'], label: 'Italic' },
      { combos: ['escape'], label: 'Cancel editing' },
    ],
  },
  {
    title: 'Boards',
    write: true,
    items: [
      { combos: ['space', 'enter'], label: 'Pick up or drop the focused card' },
      { combos: ['arrowup', 'arrowdown', 'arrowleft', 'arrowright'], label: 'Move the picked-up card', together: true },
      { combos: ['escape'], label: 'Cancel the move' },
    ],
  },
];

/** The groups and entries the space's role can use (`write`: SpacePermissions.write). */
export function shortcutGroups(write: boolean): ShortcutGroup[] {
  if (write) return [...SHORTCUT_GROUPS];
  return SHORTCUT_GROUPS.filter((g) => !g.write)
    .map((g) => ({ ...g, items: g.items.filter((i) => !i.write) }))
    .filter((g) => g.items.length > 0);
}

const SPOKEN: Record<string, (apple: boolean) => string> = {
  mod: (apple) => (apple ? 'Command' : 'Control'),
  ctrl: () => 'Control',
  shift: () => 'Shift',
  alt: (apple) => (apple ? 'Option' : 'Alt'),
  escape: () => 'Escape',
  enter: () => 'Enter',
  space: () => 'Space',
  tab: () => 'Tab',
  arrowup: () => 'Up arrow',
  arrowdown: () => 'Down arrow',
  arrowleft: () => 'Left arrow',
  arrowright: () => 'Right arrow',
  '?': () => 'Question mark',
  '/': () => 'Slash',
};

/** Screen-reader wording of a combo: spokenCombo('mod+k', true) → 'Command + K'. */
export function spokenCombo(combo: string, apple: boolean): string {
  const parts = combo === '+' ? ['+'] : combo.split(/\+(?!$)/);
  return parts
    .map((p) => {
      const lower = p.toLowerCase();
      const named = SPOKEN[lower];
      if (named) return named(apple);
      return p.length === 1 ? p.toUpperCase() : p[0]!.toUpperCase() + p.slice(1);
    })
    .join(' + ');
}
