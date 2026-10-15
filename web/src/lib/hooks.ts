// Small shared React hooks.

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { localToday, type ISODate } from '@shared/dates';
import { anyOverlayOpen } from './overlays';

/** Subscribe to a CSS media query. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia(query);
      mq.addEventListener('change', cb);
      return () => mq.removeEventListener('change', cb);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** True below the `md` breakpoint (768px): phone layout. */
export function useIsMobile(): boolean {
  return useMediaQuery('(max-width: 767px)');
}

/** True on devices whose primary pointer is coarse (touch). */
export function useIsTouch(): boolean {
  return useMediaQuery('(pointer: coarse)');
}

/** The local calendar date; re-renders when the day changes. */
export function useToday(): ISODate {
  const [today, setToday] = useState(() => localToday());
  useEffect(() => {
    const id = window.setInterval(() => {
      const t = localToday();
      setToday((prev) => (prev === t ? prev : t));
    }, 60_000);
    return () => window.clearInterval(id);
  }, []);
  return today;
}

/** Debounce a changing value. */
export function useDebouncedValue<T>(value: T, delayMs = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setV(value), delayMs);
    return () => window.clearTimeout(id);
  }, [value, delayMs]);
  return v;
}

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

/**
 * Global keyboard shortcut. `combo` examples: 'c', '/', 'mod+k' (Ctrl or Cmd), '?', 'shift+d', 'Escape'.
 * Single-key (non-mod) shortcuts are ignored while typing in inputs (unless allowInInputs) and
 * while any dialog/drawer/menu is open (unless allowInOverlays). Shift must match exactly,
 * except for shifted punctuation like '?' where the key itself already implies Shift.
 */
export function useHotkey(
  combo: string,
  handler: (e: KeyboardEvent) => void,
  opts: { enabled?: boolean; allowInInputs?: boolean; allowInOverlays?: boolean } = {},
) {
  const ref = useRef(handler);
  ref.current = handler;
  const enabled = opts.enabled ?? true;
  const allowInInputs = opts.allowInInputs ?? false;
  const allowInOverlays = opts.allowInOverlays ?? false;
  useEffect(() => {
    if (!enabled) return;
    const parts = combo.toLowerCase().split('+');
    const key = parts[parts.length - 1]!;
    const needMod = parts.includes('mod');
    const needShift = parts.includes('shift');
    const needAlt = parts.includes('alt');
    const isLetterOrDigit = /^[a-z0-9]$/.test(key);
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const mod = e.metaKey || e.ctrlKey;
      if (needMod !== mod) return;
      if (needAlt !== e.altKey) return;
      if (isLetterOrDigit && needShift !== e.shiftKey) return;
      if (e.key.toLowerCase() !== key) return;
      if (!needMod) {
        if (!allowInInputs && isTypingTarget(e.target)) return;
        if (!allowInOverlays && anyOverlayOpen()) return;
      }
      ref.current(e);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [combo, enabled, allowInInputs, allowInOverlays]);
}

/** Set document.title to "<title> · Lyren" while mounted. */
export function useDocumentTitle(title: string | null | undefined): void {
  useEffect(() => {
    if (!title) return;
    const prev = document.title;
    document.title = `${title} · Lyren`;
    return () => {
      document.title = prev;
    };
  }, [title]);
}
