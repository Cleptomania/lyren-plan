// Where the toast stack goes while overlays are open (pure, unit-tested; Toast.tsx measures).
//
// Toasts stay above every overlay (z-index), so their Undo / Open stay reachable, but they move
// so they never sit on a control of the open panel:
//   1. their usual spot (bottom; bottom-right on wide screens) when no panel is there;
//   2. else right above the panel — a bottom sheet or a centred card — over its scrim, next to
//      what the toast is about;
//   3. else beside it, left of a panel docked on the right (the desktop task drawer);
//   4. else (a panel that fills the screen: the phone drawer, the create dialog, the palette)
//      inside it, in the free band nearest the usual spot: no button, field or link of the
//      panel under the stack (often the usual spot itself, above a pinned footer);
//   5. else, with no free band, at the top edge over the panel's header, away from the primary
//      actions, inputs and keyboard at the bottom (the header's close / back also has Back / Esc).

import type { ToastObstacle } from './internal/toastObstacles';

/** A rectangle in viewport pixels. */
export interface Box {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export type ToastPlacement =
  | { mode: 'default' }
  /** `bottom`: distance from the viewport's bottom edge to the stack's bottom edge. */
  | { mode: 'above'; bottom: number }
  /** `right`: distance from the viewport's right edge to the stack's right edge. */
  | { mode: 'beside'; right: number }
  | { mode: 'top' };

export const DEFAULT_PLACEMENT: ToastPlacement = { mode: 'default' };

export interface PlacementInput {
  viewport: { width: number; height: number };
  /** The stack at its usual spot, with its current height. */
  slot: Box;
  /** Panels to keep clear of (see activeObstacles). */
  obstacles: readonly Box[];
  /** Visible controls inside those panels (buttons, fields, links…), for step 4. */
  controls: readonly Box[];
  /** Topmost allowed y of the stack (safe area + margin). */
  minTop: number;
  /** Space kept between the stack and a panel or control. */
  gap: number;
}

const overlaps = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

export function placeToasts({ viewport, slot, obstacles, controls, minTop, gap }: PlacementInput): ToastPlacement {
  const clear = (box: Box) => !obstacles.some((o) => overlaps(box, o));
  if (clear(slot)) return DEFAULT_PLACEMENT;
  const covering = obstacles.filter((o) => overlaps(slot, o));
  const height = slot.bottom - slot.top;
  const width = slot.right - slot.left;

  // 2. Above the panel.
  const above = Math.min(...covering.map((o) => o.top)) - gap;
  if (above - height >= minTop && clear({ ...slot, top: above - height, bottom: above })) {
    return { mode: 'above', bottom: viewport.height - above };
  }
  // 3. Beside it.
  const beside = Math.min(...covering.map((o) => o.left)) - gap;
  if (beside - width >= gap && clear({ ...slot, left: beside - width, right: beside })) {
    return { mode: 'beside', right: viewport.width - beside };
  }
  // 4. Inside it: from the usual spot upwards, hop over the controls in the way (with a little
  // more room than the gap: a control often sits inside a framed box, such as a composer).
  let bottom = slot.bottom;
  while (bottom - height >= minTop) {
    const band = { ...slot, top: bottom - height - gap, bottom: bottom + gap };
    const hits = controls.filter((c) => overlaps(band, c));
    if (hits.length === 0) return bottom === slot.bottom ? DEFAULT_PLACEMENT : { mode: 'above', bottom: viewport.height - bottom };
    bottom = Math.min(bottom - 1, Math.min(...hits.map((c) => c.top)) - 2 * gap);
  }
  // 5. The top edge.
  return { mode: 'top' };
}

/**
 * A panel measured at any moment of its enter transition: `rect` is where it is drawn now,
 * `layout` its untransformed box (where it settles), `controls` the boxes of its visible
 * controls as drawn now. Returns the settled panel and controls. (Reading the computed
 * transform instead went wrong at the start of a slide-in: the rect had already moved on.)
 */
export function settledPanel(
  { rect, layout, controls }: { rect: Box; layout: Box; controls: readonly Box[] },
  viewportHeight: number,
): { obstacle: Box; controls: Box[] } {
  const dx = rect.left - layout.left;
  const dy = rect.top - layout.top;
  const visibleTop = Math.max(0, layout.top);
  const visibleBottom = Math.min(viewportHeight, layout.bottom);
  const settled: Box[] = [];
  for (const c of controls) {
    const box = { top: c.top - dy, right: c.right - dx, bottom: c.bottom - dy, left: c.left - dx };
    if (box.bottom > visibleTop && box.top < visibleBottom) settled.push(box);
  }
  return { obstacle: layout, controls: settled };
}

/**
 * The panels that matter: the topmost modal one (what is under it is inert, so covering it
 * blocks nothing), else every docked panel.
 */
export function activeObstacles(all: readonly ToastObstacle[]): HTMLElement[] {
  for (let i = all.length - 1; i >= 0; i--) if (all[i]!.kind === 'modal') return [all[i]!.el];
  return all.map((o) => o.el);
}

/** What counts as a control of a panel for step 4. */
export const CONTROL_SELECTOR = [
  'a[href]',
  'button',
  'input:not([type=hidden])',
  'select',
  'textarea',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[role=button]',
  '[role=checkbox]',
  '[role=switch]',
  '[role=tab]',
  '[role=option]',
  '[role=menuitem]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function samePlacement(a: ToastPlacement, b: ToastPlacement): boolean {
  if (a.mode !== b.mode) return false;
  if (a.mode === 'above' && b.mode === 'above') return Math.abs(a.bottom - b.bottom) < 1;
  if (a.mode === 'beside' && b.mode === 'beside') return Math.abs(a.right - b.right) < 1;
  return true;
}
