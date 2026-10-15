import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createToastStore, TOAST_EXIT_MS } from './toastStore';

describe('toast store', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('applies default durations', () => {
    const s = createToastStore();
    s.show('success', 'a');
    s.show('error', 'b');
    s.show('info', 'c', { action: { label: 'Undo', onClick: () => {} } });
    expect(s.getSnapshot().map((t) => t.durationMs)).toEqual([4000, 6000, 6000]);
  });

  it('refreshes an identical visible toast instead of stacking it', () => {
    const s = createToastStore();
    const id1 = s.show('error', 'Offline');
    const id2 = s.show('error', 'Offline');
    expect(id2).toBe(id1);
    expect(s.getSnapshot()).toHaveLength(1);
    expect(s.getSnapshot()[0]).toMatchObject({ count: 2, version: 1 });
  });

  it('keeps at most maxVisible toasts, dropping the oldest', () => {
    const s = createToastStore(2);
    s.show('info', '1');
    s.show('info', '2');
    s.show('info', '3');
    expect(s.getSnapshot().map((t) => t.message)).toEqual(['2', '3']);
  });

  it('animates out before removing on dismiss and notifies subscribers', () => {
    const s = createToastStore();
    const listener = vi.fn();
    s.subscribe(listener);
    const id = s.show('success', 'Saved');
    s.dismiss(id);
    expect(s.getSnapshot()[0]?.closing).toBe(true);
    vi.advanceTimersByTime(TOAST_EXIT_MS);
    expect(s.getSnapshot()).toHaveLength(0);
    expect(listener).toHaveBeenCalledTimes(3);
  });
});
