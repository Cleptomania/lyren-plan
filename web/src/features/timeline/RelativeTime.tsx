// "5 minutes ago" that stays current. The absolute date/time is in the title (desktop hover)
// and a tap/click toggles it inline, so touch users can see it too.

import { clsx } from 'clsx';
import { useState, useSyncExternalStore } from 'react';
import { formatDateTime, formatRelativeTime } from '../../lib/format';

// One shared ticker for every timestamp on screen (feeds render dozens).
let now = Date.now();
const listeners = new Set<() => void>();
let timer: number | undefined;

function tick() {
  now = Date.now();
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === undefined) {
    now = Date.now();
    timer = window.setInterval(tick, 30_000);
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

const getNow = () => now;

/** Current time in ms, refreshed every 30 s (and when the tab becomes visible). */
export function useNow(): number {
  return useSyncExternalStore(subscribe, getNow, getNow);
}

export interface RelativeTimeProps {
  /** ISO timestamp. */
  iso: string;
  /** Prefix for the title/aria text, e.g. "Edited". */
  label?: string;
  className?: string;
}

export function RelativeTime({ iso, label, className }: RelativeTimeProps) {
  useNow(); // re-render as time passes
  const [absolute, setAbsolute] = useState(false);
  const full = formatDateTime(iso);
  const relative = formatRelativeTime(iso);
  return (
    <time
      dateTime={iso}
      title={label ? `${label} ${full}` : full}
      onClick={(e) => {
        e.stopPropagation();
        setAbsolute((v) => !v);
      }}
      className={clsx('cursor-default whitespace-nowrap tabular-nums', className)}
    >
      {absolute ? full : relative}
    </time>
  );
}
