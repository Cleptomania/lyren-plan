// Overlay stack shared by dialogs, drawers, sheets, menus and popovers.
//
// - Only the TOP overlay reacts to Escape (isTopOverlay).
// - Global single-key hotkeys are suppressed while any overlay is open (anyOverlayOpen).
// - Optional history integration (full-screen phone dialogs, drawers and every bottom sheet):
//   opening pushes a same-URL history entry carrying a marker, so the Back gesture closes the
//   top overlay instead of leaving the page (SPEC §9). Closing from the UI pops that entry.
//
// Closing an overlay and then doing something with history (navigating, opening another
// overlay that pushes its own entry) races with that pop, because history.back() is async.
// Two ways to stay clear of it:
//   - `dismissForNavigation()` before an in-app navigation: no history.back(); it returns
//     true when the overlay's entry is the current one, and the caller then navigates with
//     { replace: true } so the destination REPLACES that entry (no dead entry is left behind).
//   - `afterClose(run)` (OverlayControls.closeThen): `run` is called once the overlay has
//     closed and its entry has been popped. Menu / picker / popover sheets run their actions
//     this way, so an action may navigate, open a dialog or another sheet.
// Pushes are serialized behind pending pops too (whenHistoryIdle), so an overlay that opens
// while another one is still popping its entry never has its own entry popped instead.
//
// URL updates in place (replaceState to the same path, e.g. board quick filters toggled in a
// picker sheet) while an overlay's entry is current keep the overlay's marker, and the new URL
// is carried down to the page's own entry when the overlay entry is popped, so Back closes the
// sheet and keeps the filter.
//
// Entries whose marker no open overlay owns (a reload with an overlay open, Forward onto the
// entry of an overlay that Back closed) are dead steps above the same page: they are skipped
// (skipDeadEntry), at load and whenever the user's Back / Forward lands on one.

import { useEffect, useId, useRef, useSyncExternalStore } from 'react';

const stack: string[] = [];
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function anyOverlayOpen(): boolean {
  return stack.length > 0;
}

export function isTopOverlay(id: string): boolean {
  return stack[stack.length - 1] === id;
}

/** Re-renders when the overlay stack changes. */
export function useOverlayStackSize(): number {
  return useSyncExternalStore(subscribe, () => stack.length, () => 0);
}

// ---------------------------------------------------------------------------------------
// History entries
// ---------------------------------------------------------------------------------------

/** history.state key holding the id of the overlay that owns the entry. */
export const OVERLAY_MARKER = '__lyrenOverlay';
/** Give up waiting for the popstate of an overlay's history.back() after this long. */
export const POP_TIMEOUT_MS = 600;
/**
 * Per page load: history.state survives a reload, and useId() values repeat across loads, so
 * a stale entry must never carry the marker of a newly opened overlay.
 */
const LOAD_PREFIX = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}:`;

type State = Record<string, unknown>;

function asState(state: unknown): State {
  return state !== null && typeof state === 'object' ? (state as State) : {};
}

function markerOf(state: unknown): string | undefined {
  const m = asState(state)[OVERLAY_MARKER];
  return typeof m === 'string' ? m : undefined;
}

function withMarker(state: unknown, marker: string): State {
  return { ...asState(state), [OVERLAY_MARKER]: marker };
}

function currentMarker(): string | undefined {
  return markerOf(window.history.state);
}

/** Overlays whose own entry is in the history stack (a same-path replaceState keeps their marker). */
const owners = new Set<string>();
/** Overlay history.back() calls whose popstate has not arrived yet. */
let pendingPops = 0;
let popFallback: ReturnType<typeof setTimeout> | undefined;
let flushScheduled = false;
const idleWaiters: Array<() => void> = [];
/** A URL set in place on an overlay's entry, to carry down when that entry is popped. */
let carried: { marker: string; href: string; pathname: string; state: unknown } | null = null;
let nativeReplace: History['replaceState'] | null = null;

function replaceNative(state: unknown, url?: string | URL | null) {
  (nativeReplace ?? window.history.replaceState).call(window.history, state, '', url);
}

function scheduleFlush() {
  if (flushScheduled) return;
  flushScheduled = true;
  // A macrotask: every popstate listener (the router's included) has seen the pop by then.
  setTimeout(flush, 0);
}

function flush() {
  flushScheduled = false;
  while (pendingPops === 0 && idleWaiters.length > 0) {
    const run = idleWaiters.shift()!;
    try {
      run();
    } catch (err) {
      console.error(err);
    }
  }
}

/** True while an overlay's history.back() is still in flight. */
export function historyBusy(): boolean {
  return pendingPops > 0 || flushScheduled || idleWaiters.length > 0;
}

/**
 * Run `run` once no overlay history.back() is in flight: synchronously when none is, else
 * after its popstate has been handled (or POP_TIMEOUT_MS passed).
 */
export function whenHistoryIdle(run: () => void): void {
  if (!historyBusy()) {
    run();
    return;
  }
  idleWaiters.push(run);
  if (pendingPops === 0) scheduleFlush();
}

/** history.back() for an overlay's own entry, tracked so follow-up work can wait for it. */
function popOwnEntry() {
  pendingPops++;
  clearTimeout(popFallback);
  popFallback = setTimeout(() => {
    if (pendingPops === 0) return;
    pendingPops = 0;
    scheduleFlush();
  }, POP_TIMEOUT_MS);
  window.history.back();
}

function onPopCapture() {
  carryDown();
  if (pendingPops > 0) {
    pendingPops--;
    if (pendingPops === 0) {
      clearTimeout(popFallback);
      scheduleFlush();
    }
    return;
  }
  // The user's Back / Forward landed on an overlay entry no open overlay owns.
  skipDeadEntry();
}

/**
 * An overlay entry nobody owns (left by a reload, or reached with Forward after Back closed
 * its overlay) is a dead step: it sits right above an entry for the same page, so Back from it
 * would seem to do nothing. Step off it: Back skips it, Forward onto it bounces back. Any URL
 * set in place on it is carried down, so the router only ever sees the same location again.
 */
function skipDeadEntry(): boolean {
  const state = window.history.state;
  const marker = markerOf(state);
  if (marker === undefined || owners.has(marker)) return false;
  const below = { ...asState(state) };
  delete below[OVERLAY_MARKER];
  carried = { marker, href: window.location.href, pathname: window.location.pathname, state: below };
  popOwnEntry();
  return true;
}

function sameIndex(a: unknown, b: unknown): boolean {
  const x = asState(a).idx;
  const y = asState(b).idx;
  return typeof x !== 'number' || typeof y !== 'number' || x === y;
}

/** Popped an overlay entry whose URL was updated in place: give the entry below that URL. */
function carryDown() {
  const c = carried;
  if (!c) return;
  const marker = currentMarker();
  if (marker === c.marker) return;
  carried = null;
  // Only the entry right below (same page, same router index), never a far jump.
  if (window.location.pathname !== c.pathname || !sameIndex(window.history.state, c.state)) return;
  replaceNative(marker !== undefined ? withMarker(c.state, marker) : c.state, c.href);
  if (marker !== undefined && owners.has(marker)) carried = { ...c, marker };
}

function install() {
  if (nativeReplace || typeof window === 'undefined' || !window.history) return;
  const history = window.history;
  const native = history.replaceState;
  nativeReplace = native;
  history.replaceState = function replaceState(this: History, data: unknown, unused: string, url?: string | URL | null) {
    const marker = currentMarker();
    if (url != null && marker !== undefined && owners.has(marker) && markerOf(data) === undefined) {
      const target = new URL(String(url), window.location.href);
      if (target.pathname === window.location.pathname) {
        // In-place update of the page under an overlay: the entry stays the overlay's.
        native.call(this, withMarker(data, marker), unused, url);
        carried = { marker, href: window.location.href, pathname: window.location.pathname, state: data };
        return;
      }
      // A real navigation replaced the overlay's entry: it is no longer the overlay's to pop.
      owners.delete(marker);
    }
    native.call(this, data, unused, url);
  };
  // Capture, and registered at load: runs before the router reads the location on popstate.
  window.addEventListener('popstate', onPopCapture, true);
  // Reloaded (or restored) with an overlay open: history.state still carries its marker, but
  // markers are per page load, so no overlay of this load owns it.
  skipDeadEntry();
}

install();

export interface OverlayOptions {
  /** Push a history entry so Back closes the overlay (full-screen phone overlays, sheets). */
  history?: boolean;
  /** Close on Escape when this overlay is on top (default true). */
  closeOnEscape?: boolean;
}

export interface OverlayHandle {
  id: string;
  isTop: () => boolean;
  /**
   * Call right before closing because of an in-app navigation: the overlay won't pop its
   * history entry. Returns true when that entry is the current one; navigate with
   * { replace: true } then, so the destination takes its place.
   */
  dismissForNavigation: () => boolean;
  /** True when the overlay's own history entry is the current one. */
  ownsHistoryEntry: () => boolean;
  /**
   * Run `run` once the overlay has closed and its history entry (if it pushed one) has been
   * popped. Does not close the overlay. Runs right away when the overlay is not open.
   */
  afterClose: (run: () => void) => void;
}

/**
 * One overlay's registration, independent of React (useOverlay drives it; tests drive it
 * directly). `open()` registers it and returns the cleanup that unregisters it.
 */
export class OverlayEntry {
  readonly marker: string;
  onClose: () => void;
  private pushed = false;
  private navigating = false;
  private active = false;
  private afterCloseQueue: Array<() => void> = [];

  constructor(
    readonly id: string,
    onClose: () => void,
  ) {
    this.marker = LOAD_PREFIX + id;
    this.onClose = onClose;
  }

  open({ history = false, closeOnEscape = true }: OverlayOptions = {}): () => void {
    const { id, marker } = this;
    let alive = true;
    this.active = true;
    stack.push(id);
    notify();

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !closeOnEscape || !isTopOverlay(id) || e.defaultPrevented) return;
      e.preventDefault();
      e.stopPropagation();
      this.onClose();
    };
    window.addEventListener('keydown', onKey, true);

    const push = () => {
      window.history.pushState(withMarker(window.history.state, marker), '');
      this.pushed = true;
      owners.add(marker);
    };
    // Back consumed our entry but onClose may keep us open (e.g. "Discard this draft?" →
    // Keep editing). Once an overlay opened after that Back has closed again (and its own
    // entry is gone) and we are still open and on top, push the entry again, so the next Back
    // closes us instead of leaving the page. (If we do close, the cleanup below pops it.)
    let afterPop: { depth: number; sawNewer: boolean } | null = null;
    const onPop = () => {
      if (this.pushed && currentMarker() !== marker) {
        this.pushed = false;
        owners.delete(marker);
        afterPop = { depth: stack.length, sawNewer: false };
        this.onClose();
      }
    };
    const onStackChange = () => {
      if (!afterPop) return;
      if (stack.length > afterPop.depth) afterPop.sawNewer = true;
      else if (afterPop.sawNewer && isTopOverlay(id) && !this.pushed) {
        afterPop = null;
        whenHistoryIdle(() => {
          if (alive && isTopOverlay(id) && !this.pushed) push();
        });
      }
    };
    if (history) listeners.add(onStackChange);
    // Deferred so React StrictMode's mount→unmount→mount in development doesn't push twice,
    // and behind any pop still in flight (e.g. the action sheet that opened this dialog).
    const timer = history
      ? setTimeout(() =>
          whenHistoryIdle(() => {
            if (!alive) return;
            push();
            window.addEventListener('popstate', onPop);
          }),
        )
      : undefined;

    return () => {
      alive = false;
      this.active = false;
      listeners.delete(onStackChange);
      window.removeEventListener('keydown', onKey, true);
      if (timer !== undefined) clearTimeout(timer);
      window.removeEventListener('popstate', onPop);
      // History first: overlays reacting to the stack change below must see the pending pop.
      if (this.pushed) {
        this.pushed = false;
        owners.delete(marker);
        if (currentMarker() === marker) {
          if (this.navigating) {
            // Leave history alone (the navigation replaces or follows the entry); drop the marker.
            const s = { ...asState(window.history.state) };
            delete s[OVERLAY_MARKER];
            replaceNative(s);
          } else {
            popOwnEntry();
          }
        }
      }
      this.navigating = false;
      const i = stack.lastIndexOf(id);
      if (i >= 0) stack.splice(i, 1);
      notify();
      for (const run of this.afterCloseQueue.splice(0)) whenHistoryIdle(run);
    };
  }

  isTop(): boolean {
    return isTopOverlay(this.id);
  }

  /** See OverlayHandle.dismissForNavigation. */
  dismissForNavigation(): boolean {
    this.navigating = true;
    const current = this.ownsHistoryEntry();
    // The navigation's replaceState must consume the entry, not keep our marker on it.
    owners.delete(this.marker);
    return current;
  }

  ownsHistoryEntry(): boolean {
    return this.pushed && currentMarker() === this.marker;
  }

  afterClose(run: () => void): void {
    if (this.active) this.afterCloseQueue.push(run);
    else whenHistoryIdle(run);
  }
}

/**
 * Register an open overlay. `onClose` is called for Escape (top only) and for Back when
 * history is enabled.
 */
export function useOverlay(open: boolean, onClose: () => void, opts: OverlayOptions = {}): OverlayHandle {
  const id = useId();
  const entryRef = useRef<OverlayEntry | null>(null);
  if (entryRef.current?.id !== id) entryRef.current = new OverlayEntry(id, onClose);
  const entry = entryRef.current;
  entry.onClose = onClose;
  const history = opts.history ?? false;
  const closeOnEscape = opts.closeOnEscape ?? true;

  useEffect(() => (open ? entry.open({ history, closeOnEscape }) : undefined), [entry, open, history, closeOnEscape]);

  return {
    id,
    isTop: () => entry.isTop(),
    dismissForNavigation: () => entry.dismissForNavigation(),
    ownsHistoryEntry: () => entry.ownsHistoryEntry(),
    afterClose: (run) => entry.afterClose(run),
  };
}
