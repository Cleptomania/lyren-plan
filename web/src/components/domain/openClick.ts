// Cards and rows open their task on a click anywhere — except on nested controls (status
// picker, checkbox, "⋯" menu…) and on events bubbling through React portals (menu items).

import type { MouseEvent } from 'react';

/** Marks the element that may open the task even though it is a button (the title). */
export const OPEN_TASK_ATTR = 'data-open-task';
export const OPEN_TASK_PROPS = { [OPEN_TASK_ATTR]: '' } as const;

const CONTROLS =
  'a[href], button, input, select, textarea, label, summary, [role="button"], [role="menuitem"], [role="menuitemcheckbox"], [role="option"], [role="checkbox"], [contenteditable="true"], [data-no-open]';

/** True when a click on a card/row root should open the task. */
export function isOpenClick(e: MouseEvent<HTMLElement>): boolean {
  if (e.defaultPrevented || e.button !== 0) return false;
  const root = e.currentTarget;
  const target = e.target;
  // Clicks inside portaled overlays still bubble through the React tree; ignore them.
  if (!(target instanceof Element) || !root.contains(target)) return false;
  const control = target.closest(CONTROLS);
  return !control || control === root || !root.contains(control) || control.hasAttribute(OPEN_TASK_ATTR);
}

/**
 * Keys a card/row root or dnd-kit's KeyboardSensor act on (open, pick up, move): stopped at
 * nested controls. Everything else bubbles on, so global shortcuts (mod+K, '/', 'c', '?') still
 * work while focus is on a row's "⋯", status chip or checkbox — where focus returns after
 * closing their menus and pickers.
 */
export function isCardKey(key: string): boolean {
  return key === 'Enter' || key === ' ' || key === 'Spacebar' || key.startsWith('Arrow');
}

/** Stops pointer/keyboard events at a nested control so they neither open the task nor start a drag. */
export const stopCardEvents = {
  onClick: (e: { stopPropagation: () => void }) => e.stopPropagation(),
  onPointerDown: (e: { stopPropagation: () => void }) => e.stopPropagation(),
  onMouseDown: (e: { stopPropagation: () => void }) => e.stopPropagation(),
  onTouchStart: (e: { stopPropagation: () => void }) => e.stopPropagation(),
  onKeyDown: (e: { key: string; stopPropagation: () => void }) => {
    if (isCardKey(e.key)) e.stopPropagation();
  },
};
