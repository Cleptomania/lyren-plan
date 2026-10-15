import type { ComponentType } from 'react';
import { describe, expect, it } from 'vitest';
import { AUTO_RELOAD_COOLDOWN_MS, AUTO_RELOAD_KEY, claimAutoReload, isChunkLoadError, retryableLazy } from './chunkErrors';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    data,
  };
}

describe('isChunkLoadError', () => {
  it('recognises the browsers’ failed dynamic import messages', () => {
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: https://h/assets/WorklogPage-CVI4naie.js'))).toBe(true);
    expect(isChunkLoadError(new TypeError('error loading dynamically imported module: https://h/assets/A.js'))).toBe(true);
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError(new Error('Unable to preload CSS for /assets/x.css'))).toBe(true);
    const named = new Error('x');
    named.name = 'ChunkLoadError';
    expect(isChunkLoadError(named)).toBe(true);
  });

  it('ignores ordinary errors', () => {
    expect(isChunkLoadError(new Error('useLookups() used before bootstrap data loaded'))).toBe(false);
    expect(isChunkLoadError(new TypeError('Failed to fetch'))).toBe(false);
    expect(isChunkLoadError('Failed to fetch dynamically imported module')).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
  });
});

describe('claimAutoReload', () => {
  it('allows one reload per cooldown and records it', () => {
    const s = memoryStorage();
    expect(claimAutoReload(s, 1_000_000)).toBe(true);
    expect(s.data.get(AUTO_RELOAD_KEY)).toBe('1000000');
    expect(claimAutoReload(s, 1_000_000 + 5_000)).toBe(false);
    expect(claimAutoReload(s, 1_000_000 + AUTO_RELOAD_COOLDOWN_MS)).toBe(true);
  });

  it('ignores garbage or future timestamps', () => {
    expect(claimAutoReload(memoryStorage({ [AUTO_RELOAD_KEY]: 'nope' }), 5)).toBe(true);
    expect(claimAutoReload(memoryStorage({ [AUTO_RELOAD_KEY]: String(10_000_000) }), 5)).toBe(true);
  });

  it('refuses without usable storage', () => {
    expect(claimAutoReload(null)).toBe(false);
    const throwing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => undefined,
    };
    expect(claimAutoReload(throwing)).toBe(false);
  });
});

describe('retryableLazy', () => {
  it('replaces the lazy component after a failed import so the next render retries', async () => {
    let attempts = 0;
    const Page = () => null;
    const loader = retryableLazy((): Promise<{ default: ComponentType }> => {
      attempts++;
      return attempts === 1 ? Promise.reject(new TypeError('Failed to fetch dynamically imported module: x')) : Promise.resolve({ default: Page });
    });
    const first = loader.current();
    // Drive React.lazy's payload the way React does on first render.
    const init = (first as unknown as { _init: (p: unknown) => unknown; _payload: unknown });
    try {
      init._init(init._payload);
    } catch (thenable) {
      await Promise.resolve(thenable).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(attempts).toBe(1);
    const second = loader.current();
    expect(second).not.toBe(first);
    const init2 = second as unknown as { _init: (p: unknown) => unknown; _payload: unknown };
    try {
      init2._init(init2._payload);
    } catch (thenable) {
      await Promise.resolve(thenable);
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(attempts).toBe(2);
    expect(init2._init(init2._payload)).toBe(Page);
    expect(loader.current()).toBe(second);
  });
});
