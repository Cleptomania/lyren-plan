// Browser state the app shell reacts to: connectivity, theme preference, focused text field.

import { onlineManager } from '@tanstack/react-query';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { getStoredTheme, setStoredTheme, type ThemePreference } from '../../lib/theme';

function subscribeOnline(cb: () => void): () => void {
  window.addEventListener('online', cb);
  window.addEventListener('offline', cb);
  const off = onlineManager.subscribe(cb);
  return () => {
    window.removeEventListener('online', cb);
    window.removeEventListener('offline', cb);
    off();
  };
}

/** False when the browser reports no network (navigator.onLine / React Query's onlineManager). */
export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine !== false && onlineManager.isOnline(),
    () => true,
  );
}

/** Same-tab notification between useThemePreference instances (the class may not change, e.g. system → light). */
const THEME_CHANGE_EVENT = 'lyren:theme-change';

/** Theme preference (light / dark / system), kept in sync with changes made elsewhere. */
export function useThemePreference(): [ThemePreference, (pref: ThemePreference) => void, () => void] {
  const [pref, setPref] = useState<ThemePreference>(getStoredTheme);
  const sync = useCallback(() => setPref(getStoredTheme()), []);
  useEffect(() => {
    window.addEventListener('storage', sync);
    window.addEventListener(THEME_CHANGE_EVENT, sync);
    // Account settings → Preferences changes the theme through lib/theme, which toggles <html class="dark">.
    const mo = new MutationObserver(sync);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener(THEME_CHANGE_EVENT, sync);
      mo.disconnect();
    };
  }, [sync]);
  const set = useCallback((next: ThemePreference) => {
    setStoredTheme(next);
    setPref(next);
    window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
  }, []);
  return [pref, set, sync];
}

const NON_TEXT_INPUTS = new Set([
  'checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image',
  'date', 'datetime-local', 'month', 'time', 'week',
]);

function isTextEntry(el: Element | null): boolean {
  if (el instanceof HTMLTextAreaElement) return !el.readOnly;
  if (el instanceof HTMLInputElement) return !el.readOnly && !NON_TEXT_INPUTS.has(el.type);
  return el instanceof HTMLElement && el.isContentEditable;
}

/**
 * True while a text field has focus (on phones: the on-screen keyboard is up). Turning
 * false is debounced so moving between fields doesn't flicker the bottom bar.
 */
export function useTextEntryFocused(enabled: boolean): boolean {
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!enabled) {
      setFocused(false);
      return;
    }
    let timer: number | undefined;
    const update = () => {
      window.clearTimeout(timer);
      if (isTextEntry(document.activeElement)) setFocused(true);
      else timer = window.setTimeout(() => setFocused(isTextEntry(document.activeElement)), 120);
    };
    update();
    document.addEventListener('focusin', update);
    document.addEventListener('focusout', update);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('focusin', update);
      document.removeEventListener('focusout', update);
    };
  }, [enabled]);
  return focused;
}
