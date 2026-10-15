// Global search / command palette host + keyboard-shortcut help. Mounted once in AuthedApp.
//
// Opens the palette on mod+K, '/', the bottom-bar Search tab and the 'command-palette' app event
// (optionally with an initial query); opens the shortcut help on '?'. This module stays tiny:
// the palette UI and the help dialog are lazy chunks loaded on first use (the palette chunk is
// prefetched when the browser is idle so the first mod+K feels instant).

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useAppEvent } from '../../lib/events';
import { useHotkey } from '../../lib/hooks';
import { useLazyOverlay } from './lazyOverlay';
import { useRecentTracking } from './useRecentTracking';

const loadPalette = () => import('./CommandPaletteDialog');
const loadShortcuts = () => import('./ShortcutsDialog');

interface PaletteState {
  open: boolean;
  /** Text the input starts with. */
  query: string;
  /** Bumped on every open, so the dialog resets its query and highlight. */
  session: number;
}

export function CommandPalette() {
  const CommandPaletteDialog = useLazyOverlay(loadPalette, 'search');
  const ShortcutsDialog = useLazyOverlay(loadShortcuts, 'keyboard shortcuts');
  const [palette, setPalette] = useState<PaletteState>({ open: false, query: '', session: 0 });
  const [helpOpen, setHelpOpen] = useState(false);
  // Lazy chunks are mounted from their first use on (and stay mounted for exit transitions).
  const [loaded, setLoaded] = useState({ palette: false, help: false });

  const openPalette = useCallback((query = '') => {
    setLoaded((l) => (l.palette ? l : { ...l, palette: true }));
    setPalette((p) => ({ open: true, query, session: p.session + 1 }));
  }, []);
  const closePalette = useCallback(() => setPalette((p) => (p.open ? { ...p, open: false } : p)), []);
  const openHelp = useCallback(() => {
    setLoaded((l) => (l.help ? l : { ...l, help: true }));
    setHelpOpen(true);
  }, []);
  const closeHelp = useCallback(() => setHelpOpen(false), []);

  useHotkey('mod+k', (e) => {
    e.preventDefault();
    if (palette.open) closePalette();
    else openPalette();
  });
  useHotkey('/', (e) => {
    e.preventDefault();
    openPalette();
  });
  useHotkey('?', (e) => {
    e.preventDefault();
    openHelp();
  });
  useAppEvent('command-palette', ({ query }) => openPalette(query ?? ''));

  useRecentTracking();
  // Mount the closed palette once its chunk is in: React.lazy suspends on its first render even
  // for a cached chunk, and React 19 holds a suspended reveal for ~300 ms (keys typed right
  // after the first mod+K would be lost).
  const paletteLoaded = useCallback(() => setLoaded((l) => (l.palette ? l : { ...l, palette: true })), []);
  usePrefetchWhenIdle(loadPalette, paletteLoaded);

  return (
    <>
      {loaded.palette && (
        <Suspense fallback={null}>
          <CommandPaletteDialog
            open={palette.open}
            initialQuery={palette.query}
            session={palette.session}
            onClose={closePalette}
            onShowShortcuts={openHelp}
          />
        </Suspense>
      )}
      {loaded.help && (
        <Suspense fallback={null}>
          <ShortcutsDialog open={helpOpen} onClose={closeHelp} />
        </Suspense>
      )}
    </>
  );
}

function usePrefetchWhenIdle(load: () => Promise<unknown>, onLoaded: () => void): void {
  useEffect(() => {
    const run = () => void load().then(onLoaded, () => {});
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(run, { timeout: 5000 });
      return () => window.cancelIdleCallback(id);
    }
    const id = window.setTimeout(run, 2500);
    return () => window.clearTimeout(id);
  }, [load, onLoaded]);
}
