// Keeps keyboard focus in a list when the focused item is removed from the page (a deleted
// task row or card): focus moves to the next item, or the previous one when it was the last,
// instead of falling back to <body> (WCAG 2.4.3).

/**
 * Keys of the items to try, best first, after the item `removed` disappears from `keys`
 * (document order): the following items, then the preceding ones nearest first.
 */
export function successorOrder<K>(keys: readonly K[], removed: K): K[] {
  const i = keys.indexOf(removed);
  if (i < 0) return [];
  const after = keys.slice(i + 1);
  const before = keys.slice(0, i).reverse();
  return [...new Set([...after, ...before])].filter((k) => k !== removed);
}

export interface KeepFocusOptions {
  /** Attribute naming each list item's key, e.g. 'data-task-id'. */
  keyAttr: string;
  /** Element to focus inside the chosen item (default: the item itself). */
  focusSelector?: string;
  /** Stop waiting for the removal after this long (default 15 s). */
  timeoutMs?: number;
}

/**
 * Call BEFORE an action that may remove the item (keyed by `keyAttr`) that currently holds
 * focus, e.g. deleting the task whose ⋯ menu was used. Once that item has left the page, if
 * focus was lost with it (it is on <body>), focus goes to its successor. Does nothing when
 * focus is not inside such an item, so a drawer or dialog keeps its own focus.
 * Returns `cancel` (e.g. when the user dismissed the confirmation).
 */
export function keepFocusAfterRemoval(key: string, { keyAttr, focusSelector, timeoutMs = 15_000 }: KeepFocusOptions): () => void {
  const noop = () => {};
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return noop;
  const active = document.activeElement;
  const item = active?.closest(`[${keyAttr}]`);
  if (!item || item.getAttribute(keyAttr) !== key) return noop;

  const scope = item.closest('main') ?? document.body;
  const keys = [...scope.querySelectorAll(`[${keyAttr}]`)].map((el) => el.getAttribute(keyAttr) ?? '');
  const order = successorOrder(keys, key);

  let frame = 0;
  const moveFocus = () => {
    for (const k of order) {
      const next = scope.querySelector<HTMLElement>(`[${keyAttr}="${CSS.escape(k)}"]`);
      if (!next) continue;
      const target = (focusSelector && next.querySelector<HTMLElement>(focusSelector)) || next;
      target.focus();
      if (document.activeElement === target) return;
    }
    document.getElementById('main')?.focus({ preventScroll: true });
  };
  // Focus may still sit in a closing overlay (the confirmation animating out) whose focus
  // return targets the removed item: wait for it to land on <body> before stepping in.
  let deadline = 0;
  const restore = () => {
    const focused = document.activeElement;
    if (!focused || focused === document.body || !focused.isConnected) moveFocus();
    else if (focused.closest('[data-status="close"]') && Date.now() < deadline) frame = requestAnimationFrame(restore);
    // Otherwise focus went somewhere on purpose: leave it.
  };
  const observer = new MutationObserver(() => {
    if (item.isConnected) return;
    stop();
    deadline = Date.now() + 1500;
    frame = requestAnimationFrame(restore);
  });
  const timer = window.setTimeout(() => stop(), timeoutMs);
  function stop() {
    observer.disconnect();
    window.clearTimeout(timer);
  }
  // The item may also vanish with its whole group (last task of a status): watch the tree.
  observer.observe(scope, { childList: true, subtree: true });
  return () => {
    stop();
    cancelAnimationFrame(frame);
  };
}
