// The local calendar date, shared by every subscriber through ONE timer (task cards and
// rows render by the hundreds; lib/hooks useToday() runs an interval per component).

import { useSyncExternalStore } from 'react';
import { localToday, type ISODate } from '@shared/dates';

let current = localToday();
const listeners = new Set<() => void>();
let timer: number | undefined;

function tick() {
  const next = localToday();
  if (next === current) return;
  current = next;
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === undefined) {
    tick();
    timer = window.setInterval(tick, 60_000);
    // Background tabs throttle timers: re-check as soon as the app is visible again.
    document.addEventListener('visibilitychange', tick);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== undefined) {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
      timer = undefined;
    }
  };
}

const getSnapshot = () => current;

/** The local date ('YYYY-MM-DD'); re-renders subscribers when the day changes. */
export function useSharedToday(): ISODate {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
