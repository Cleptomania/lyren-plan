// Recognising failed lazy-chunk loads (offline, or stale chunk names after a server upgrade)
// and guarding the one automatic reload that recovers from them.

import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

/** Messages browsers / Vite use when a dynamic import (or its preloaded CSS) fails to load. */
const CHUNK_ERROR =
  /dynamically imported module|Importing a module script failed|Failed to fetch module|Unable to preload CSS|Loading (CSS )?chunk [\w-]+ failed/i;

export function isChunkLoadError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'ChunkLoadError' || CHUNK_ERROR.test(err.message);
}

export const AUTO_RELOAD_KEY = 'lyren.chunkReloadAt';
/** At most one automatic reload per this many ms, so a chunk that is really missing can't loop. */
export const AUTO_RELOAD_COOLDOWN_MS = 30_000;

type ReloadStore = Pick<Storage, 'getItem' | 'setItem'>;

/**
 * True when an automatic reload may run now, and records it. False when one ran within the
 * cooldown or storage is unavailable (then the user reloads by hand).
 */
export function claimAutoReload(storage: ReloadStore | null | undefined, now: number = Date.now()): boolean {
  if (!storage) return false;
  try {
    const last = Number(storage.getItem(AUTO_RELOAD_KEY));
    if (Number.isFinite(last) && last > 0 && now - last >= 0 && now - last < AUTO_RELOAD_COOLDOWN_MS) return false;
    storage.setItem(AUTO_RELOAD_KEY, String(now));
    return true;
  } catch {
    return false;
  }
}

/**
 * React.lazy whose failed import is not cached forever: after a rejection the next render
 * (the error page's "Try again", or navigating back to the route) imports again.
 */
export function retryableLazy<P extends object>(load: () => Promise<{ default: ComponentType<P> }>): {
  /** Current lazy component; replaced after a failed load. */
  current: () => LazyExoticComponent<ComponentType<P>>;
} {
  let component = create();
  function create(): LazyExoticComponent<ComponentType<P>> {
    return lazy(() =>
      load().catch((err: unknown) => {
        component = create();
        throw err;
      }),
    );
  }
  return { current: () => component };
}
