// Context exposed by Dialog / Drawer / Sheet to their content (see useOverlayControls).

import { createContext, useContext } from 'react';

export interface OverlayControls {
  /** Close the overlay (same as the user pressing Esc / the close button). */
  close: () => void;
  /**
   * Close the overlay because the app is about to navigate (call navigate() right after).
   * Skips the history.back() that overlays with a history entry (full-screen phone dialogs,
   * sheets) otherwise use to drop it, which would race with the navigation. Returns true when
   * that entry is the current one: navigate with `{ replace: true }` then, so the destination
   * takes its place and Back from it returns to the page under the overlay (no dead entry).
   *
   *   navigate(url, { replace: controls.closeForNavigation() });
   */
  closeForNavigation: () => boolean;
  /**
   * Close the overlay, then run `run` once its history entry (if any) has been popped —
   * right away when there is none. For actions that navigate, open another overlay or change
   * the URL: they must not interleave with the overlay's history.back().
   */
  closeThen: (run: () => void) => void;
  /** Run `run` once the overlay has closed and its history entry is gone (does not close it). */
  afterClose: (run: () => void) => void;
}

export const OverlayControlsContext = createContext<OverlayControls | null>(null);

/**
 * Controls of the nearest enclosing Dialog / Drawer / Sheet, or null outside of one.
 * Typical use in a form inside a dialog: `navigate(url, { replace: closeForNavigation() })`.
 */
export function useOverlayControls(): OverlayControls | null {
  return useContext(OverlayControlsContext);
}
