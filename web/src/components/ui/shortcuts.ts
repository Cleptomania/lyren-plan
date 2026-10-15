// Keyboard-shortcut labels. Combos use the same syntax as useHotkey: 'mod+k', 'shift+d', '?'.

/** True on Apple platforms (⌘ instead of Ctrl). */
export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform ?? nav.platform ?? '';
  return /mac|iphone|ipad|ipod/i.test(platform);
}

const APPLE: Record<string, string> = { mod: '⌘', shift: '⇧', alt: '⌥', ctrl: '⌃', enter: '↵', escape: 'Esc' };
const OTHER: Record<string, string> = { mod: 'Ctrl', shift: 'Shift', alt: 'Alt', ctrl: 'Ctrl', enter: 'Enter', escape: 'Esc' };

/** Key labels for a combo: formatShortcutKeys('mod+k', true) → ['⌘', 'K']. */
export function formatShortcutKeys(combo: string, apple: boolean = isApplePlatform()): string[] {
  const names = apple ? APPLE : OTHER;
  // '+' itself can be a key ('mod++'), so split on '+' only between non-empty parts.
  const parts = combo === '+' ? ['+'] : combo.split(/\+(?!$)/);
  return parts.map((p) => {
    const lower = p.toLowerCase();
    if (names[lower]) return names[lower]!;
    if (lower === 'arrowup') return '↑';
    if (lower === 'arrowdown') return '↓';
    if (lower === 'arrowleft') return '←';
    if (lower === 'arrowright') return '→';
    return p.length === 1 ? p.toUpperCase() : p[0]!.toUpperCase() + p.slice(1);
  });
}

/** Single string for hints and menu `hint`s: '⌘K' on Apple, 'Ctrl K' elsewhere. */
export function formatShortcut(combo: string, apple: boolean = isApplePlatform()): string {
  return formatShortcutKeys(combo, apple).join(apple ? '' : ' ');
}
