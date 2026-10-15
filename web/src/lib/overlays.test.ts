// History integration of the overlay stack (lib/overlays.ts), against a simulated browser
// history: history.back() is asynchronous (a task, then popstate), like in real browsers.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (e: { type: string }) => void;

class FakeWindow {
  entries: Array<{ state: unknown; url: string }>;
  index = 0;
  private listeners: Array<{ type: string; fn: Listener; capture: boolean }> = [];
  history: {
    readonly state: unknown;
    readonly length: number;
    pushState(state: unknown, unused: string, url?: string | null): void;
    replaceState(state: unknown, unused: string, url?: string | null): void;
    back(): void;
  };

  constructor(url: string) {
    this.entries = [{ state: { idx: 0 }, url }];
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const win = this;
    const resolve = (url: string | null | undefined) => (url == null ? win.location.href : new URL(url, win.location.href).href);
    class FakeHistory {
      get state() {
        return win.entries[win.index]!.state;
      }
      get length() {
        return win.entries.length;
      }
      pushState(state: unknown, _unused: string, url?: string | null) {
        win.entries.splice(win.index + 1);
        win.entries.push({ state: structuredClone(state), url: resolve(url) });
        win.index++;
      }
      replaceState(state: unknown, _unused: string, url?: string | null) {
        win.entries[win.index] = { state: structuredClone(state), url: resolve(url) };
      }
      back() {
        setTimeout(() => {
          if (win.index === 0) return;
          win.index--;
          win.dispatch('popstate');
        }, 1);
      }
    }
    this.history = new FakeHistory();
  }

  get location() {
    return new URL(this.entries[this.index]!.url);
  }

  addEventListener(type: string, fn: Listener, capture?: boolean | AddEventListenerOptions) {
    const c = typeof capture === 'boolean' ? capture : !!capture?.capture;
    this.listeners.push({ type, fn, capture: c });
  }

  removeEventListener(type: string, fn: Listener, capture?: boolean | EventListenerOptions) {
    const c = typeof capture === 'boolean' ? capture : !!capture?.capture;
    const i = this.listeners.findIndex((l) => l.type === type && l.fn === fn && l.capture === c);
    if (i >= 0) this.listeners.splice(i, 1);
  }

  /** At the target, capturing listeners run before the others. */
  dispatch(type: string) {
    const all = this.listeners.filter((l) => l.type === type);
    for (const l of [...all.filter((l) => l.capture), ...all.filter((l) => !l.capture)]) l.fn({ type });
  }

  /** What the address bar shows, plus the overlay marker of the current entry (if any). */
  get here() {
    const u = this.location;
    return u.pathname + u.search;
  }
  marker(i = this.index): string | undefined {
    const s = this.entries[i]!.state as Record<string, unknown> | null;
    return s?.__lyrenOverlay as string | undefined;
  }
  /** The browser's Back button / gesture. */
  userBack() {
    this.history.back();
  }
  /** The browser's Forward button. */
  userForward() {
    setTimeout(() => {
      if (this.index >= this.entries.length - 1) return;
      this.index++;
      this.dispatch('popstate');
    }, 1);
  }
}

let win: FakeWindow;
let mod: typeof import('./overlays');

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  win = new FakeWindow('https://plan.test/projects/1/tasks');
  (globalThis as { window?: unknown }).window = win;
  mod = await import('./overlays');
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as { window?: unknown }).window;
});

/** Let deferred pushes, back() traversals and flushes run. */
const settle = () => vi.advanceTimersByTime(50);

function openOverlay(id: string, opts: { history?: boolean } = { history: true }) {
  const onClose = vi.fn();
  const entry = new mod.OverlayEntry(id, onClose);
  const cleanup = entry.open(opts);
  return { entry, onClose, cleanup };
}

describe('overlay history entries', () => {
  it('pushes a same-URL entry on open and pops it when closed from the UI', () => {
    const sheet = openOverlay('sheet');
    settle();
    expect(win.entries).toHaveLength(2);
    expect(win.marker()).toBe(sheet.entry.marker);
    expect(win.here).toBe('/projects/1/tasks');

    sheet.cleanup();
    settle();
    expect(win.index).toBe(0);
    expect(sheet.onClose).not.toHaveBeenCalled();
  });

  it('Back closes only the top overlay', () => {
    const dialog = openOverlay('dialog');
    settle();
    const sheet = openOverlay('sheet');
    settle();
    expect(win.index).toBe(2);

    win.userBack();
    settle();
    expect(sheet.onClose).toHaveBeenCalledTimes(1);
    expect(dialog.onClose).not.toHaveBeenCalled();
    sheet.cleanup(); // the sheet closes in response; its entry is already gone
    settle();
    expect(win.index).toBe(1);
    expect(win.marker()).toBe(dialog.entry.marker);
  });

  it('afterClose runs only once the entry has been popped', () => {
    const sheet = openOverlay('sheet');
    settle();
    const action = vi.fn(() => win.index);
    sheet.entry.afterClose(action);
    sheet.cleanup();
    expect(action).not.toHaveBeenCalled();
    settle();
    expect(action).toHaveBeenCalledTimes(1);
    expect(action.mock.results[0]!.value).toBe(0); // ran on the page's own entry
  });

  it('an action that navigates after the sheet closed leaves no dead entry', () => {
    const sheet = openOverlay('sheet');
    settle();
    sheet.entry.afterClose(() => win.history.pushState({ idx: 1 }, '', '/tasks/WEB-11'));
    sheet.cleanup();
    settle();
    expect(win.entries.map((e) => new URL(e.url).pathname)).toEqual(['/projects/1/tasks', '/tasks/WEB-11']);
    expect(win.entries.every((_, i) => win.marker(i) === undefined)).toBe(true);
  });

  it('an overlay opened while another one pops its entry keeps its own entry', () => {
    // E.g. ⋯ → "Delete…": the sheet closes and the confirm opens in the same tick.
    const sheet = openOverlay('sheet');
    settle();
    sheet.cleanup();
    const confirm = openOverlay('confirm');
    settle();
    expect(confirm.onClose).not.toHaveBeenCalled();
    expect(win.entries).toHaveLength(2);
    expect(win.index).toBe(1);
    expect(win.marker()).toBe(confirm.entry.marker);

    win.userBack(); // Back cancels the confirm
    settle();
    expect(confirm.onClose).toHaveBeenCalledTimes(1);
    expect(win.index).toBe(0);
  });

  it('closeForNavigation + replace: the destination takes the entry', () => {
    const dialog = openOverlay('dialog');
    settle();
    expect(dialog.entry.dismissForNavigation()).toBe(true);
    // The router's navigate(url, { replace: true }):
    win.history.replaceState({ idx: 0, usr: null }, '', '/projects/3');
    dialog.cleanup();
    settle();
    // Back from the new page returns to the page the dialog was opened on (no dead entry).
    expect(win.entries.map((e) => new URL(e.url).pathname)).toEqual(['/projects/1/tasks', '/projects/3']);
    expect(win.marker()).toBeUndefined();
    expect(win.marker(0)).toBeUndefined();
  });

  it('dismissForNavigation reports false while the entry is not pushed yet', () => {
    const dialog = openOverlay('dialog');
    expect(dialog.entry.dismissForNavigation()).toBe(false);
    dialog.cleanup();
    settle();
    expect(win.entries).toHaveLength(1);
  });

  it('a URL updated in place under a sheet survives closing it with Back', () => {
    const sheet = openOverlay('tags');
    settle();
    // Quick filter toggled in the sheet: setSearchParams(..., { replace: true }).
    win.history.replaceState({ idx: 0, key: 'k2' }, '', '/projects/1/tasks?tags=3');
    expect(win.marker()).toBe(sheet.entry.marker);
    win.userBack();
    settle();
    expect(sheet.onClose).toHaveBeenCalledTimes(1);
    sheet.cleanup();
    settle();
    expect(win.index).toBe(0);
    expect(win.here).toBe('/projects/1/tasks?tags=3');
    expect(win.marker()).toBeUndefined();
  });

  it('a URL updated in place under a sheet survives closing it from the UI', () => {
    const sheet = openOverlay('tags');
    settle();
    win.history.replaceState({ idx: 0, key: 'k2' }, '', '/projects/1/tasks?pri=1');
    sheet.cleanup();
    settle();
    expect(win.entries).toHaveLength(2); // the popped entry stays as a forward entry
    expect(win.index).toBe(0);
    expect(win.here).toBe('/projects/1/tasks?pri=1');
  });

  it('a replace to another page is a navigation: the overlay does not pop it', () => {
    const sheet = openOverlay('sheet');
    settle();
    win.history.replaceState({ idx: 0 }, '', '/projects');
    expect(win.marker()).toBeUndefined();
    sheet.cleanup();
    settle();
    expect(win.here).toBe('/projects');
    expect(win.index).toBe(1);
  });

  it('"Keep editing": the dialog gets a new entry once the confirm’s entry is gone', () => {
    const dialog = openOverlay('create');
    settle();
    let confirm: ReturnType<typeof openOverlay> | undefined;
    // Back on the dialog asks "Discard this task?" instead of closing.
    dialog.onClose.mockImplementation(() => {
      confirm = openOverlay('confirm');
    });
    win.userBack();
    settle();
    expect(confirm).toBeDefined();
    expect(win.marker()).toBe(confirm!.entry.marker);
    const resolved = vi.fn();
    confirm!.entry.afterClose(resolved);
    confirm!.cleanup(); // "Keep editing"
    expect(resolved).not.toHaveBeenCalled();
    settle();
    expect(resolved).toHaveBeenCalledTimes(1);
    expect(win.entries).toHaveLength(2);
    expect(win.index).toBe(1);
    expect(win.marker()).toBe(dialog.entry.marker);

    // The next Back closes the dialog again (asks again).
    dialog.onClose.mockClear();
    dialog.onClose.mockImplementation(() => {});
    win.userBack();
    settle();
    expect(dialog.onClose).toHaveBeenCalledTimes(1);
  });

  it('whenHistoryIdle waits for a pending pop, or gives up after the timeout', () => {
    const sheet = openOverlay('sheet');
    settle();
    sheet.cleanup();
    const run = vi.fn();
    mod.whenHistoryIdle(run);
    expect(run).not.toHaveBeenCalled();
    settle();
    expect(run).toHaveBeenCalledTimes(1);

    // A back() whose popstate never arrives.
    const other = openOverlay('other');
    settle();
    win.history.back = () => {};
    other.cleanup();
    const late = vi.fn();
    mod.whenHistoryIdle(late);
    vi.advanceTimersByTime(mod.POP_TIMEOUT_MS - 10);
    expect(late).not.toHaveBeenCalled();
    vi.advanceTimersByTime(20);
    expect(late).toHaveBeenCalledTimes(1);
  });

  it('runs right away when nothing is pending', () => {
    const run = vi.fn();
    mod.whenHistoryIdle(run);
    expect(run).toHaveBeenCalledTimes(1);
    const plain = openOverlay('menu', { history: false });
    settle();
    expect(win.entries).toHaveLength(1);
    const after = vi.fn();
    plain.entry.afterClose(after);
    plain.cleanup();
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('markers are unique per page load', () => {
    const a = new mod.OverlayEntry('«r1»', () => {});
    expect(a.marker).not.toBe('«r1»');
    expect(a.marker.endsWith('«r1»')).toBe(true);
  });
});

describe('dead overlay entries (no open overlay owns them)', () => {
  /** A fresh page load whose current entry is a stale overlay entry from an earlier load. */
  async function reloadOnStaleEntry(staleUrl = 'https://plan.test/projects/1/tasks') {
    vi.resetModules();
    win = new FakeWindow('https://plan.test/projects/1/tasks');
    win.entries.push({ state: { idx: 0, key: 'k1', __lyrenOverlay: 'oldload:«r5»' }, url: staleUrl });
    win.index = 1;
    (globalThis as { window?: unknown }).window = win;
    mod = await import('./overlays');
  }

  it('a reload with an overlay open steps off its entry: one Back then leaves the page', async () => {
    await reloadOnStaleEntry();
    expect(mod.historyBusy()).toBe(true);
    settle();
    expect(win.index).toBe(0);
    expect(win.here).toBe('/projects/1/tasks');
    expect(win.marker()).toBeUndefined();
    expect(mod.historyBusy()).toBe(false);
  });

  it('keeps a URL that was set in place on the stale entry', async () => {
    await reloadOnStaleEntry('https://plan.test/projects/1/tasks?tags=3');
    settle();
    expect(win.index).toBe(0);
    expect(win.here).toBe('/projects/1/tasks?tags=3');
    expect(win.marker()).toBeUndefined();
  });

  it('an overlay opened right at load waits for the step and then gets its own entry', async () => {
    await reloadOnStaleEntry();
    const dialog = openOverlay('dialog');
    settle();
    expect(win.index).toBe(1);
    expect(win.marker()).toBe(dialog.entry.marker);
    win.userBack();
    settle();
    expect(dialog.onClose).toHaveBeenCalledTimes(1);
    expect(win.index).toBe(0);
  });

  it('Forward onto the entry of an overlay that Back closed bounces back', () => {
    const sheet = openOverlay('sheet');
    settle();
    win.userBack();
    settle();
    expect(sheet.onClose).toHaveBeenCalledTimes(1);
    sheet.cleanup();
    settle();
    expect(win.index).toBe(0);
    win.userForward();
    settle();
    expect(win.index).toBe(0);
    expect(win.marker()).toBeUndefined();
    expect(sheet.onClose).toHaveBeenCalledTimes(1);
  });

  it('Back onto an entry left behind by a navigation skips it', () => {
    const sheet = openOverlay('sheet');
    settle();
    // A push navigation without closeForNavigation (the overlay's entry stays below it).
    win.history.pushState({ idx: 1 }, '', '/projects/2');
    sheet.cleanup();
    settle();
    expect(win.index).toBe(2);
    win.userBack();
    settle();
    expect(win.index).toBe(0);
    expect(win.here).toBe('/projects/1/tasks');
  });

  it('Back onto an entry an open overlay owns is not skipped', () => {
    const dialog = openOverlay('dialog');
    settle();
    const sheet = openOverlay('sheet');
    settle();
    win.userBack();
    settle();
    expect(sheet.onClose).toHaveBeenCalledTimes(1);
    expect(dialog.onClose).not.toHaveBeenCalled();
    expect(win.index).toBe(1);
    expect(win.marker()).toBe(dialog.entry.marker);
  });
});
