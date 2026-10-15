import { afterEach, describe, expect, it, vi } from 'vitest';
import { REDUCED_MOTION_QUERY, scrollBehavior } from './motion';

function stubMatchMedia(reduce: boolean) {
  const matchMedia = vi.fn((query: string) => ({ matches: reduce && query === REDUCED_MOTION_QUERY, media: query }));
  vi.stubGlobal('window', { matchMedia });
  return matchMedia;
}

describe('scrollBehavior', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is smooth by default', () => {
    const matchMedia = stubMatchMedia(false);
    expect(scrollBehavior()).toBe('smooth');
    expect(matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');
  });

  it('jumps instantly when the user prefers reduced motion', () => {
    stubMatchMedia(true);
    expect(scrollBehavior()).toBe('auto');
  });

  it('falls back to smooth without matchMedia', () => {
    vi.stubGlobal('window', {});
    expect(scrollBehavior()).toBe('smooth');
  });
});
