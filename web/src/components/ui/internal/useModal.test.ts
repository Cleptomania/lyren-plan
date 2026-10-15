// The ghost-tap guard of overlay scrims (useScrimClose).

import { describe, expect, it } from 'vitest';
import { scrimPressAllowed, TAP_GUARD_MS } from './useModal';

describe('scrimPressAllowed', () => {
  it('ignores a press right after the overlay appeared (the second tap of a double tap)', () => {
    expect(scrimPressAllowed(1000, 1000)).toBe(false);
    expect(scrimPressAllowed(1000, 1090)).toBe(false);
    expect(scrimPressAllowed(1000, 1250)).toBe(false);
    expect(scrimPressAllowed(1000, 1000 + TAP_GUARD_MS - 1)).toBe(false);
  });

  it('accepts a deliberate press once the guard is over', () => {
    expect(scrimPressAllowed(1000, 1000 + TAP_GUARD_MS)).toBe(true);
    expect(scrimPressAllowed(1000, 5000)).toBe(true);
    // Never mounted (no ref yet): no guard.
    expect(scrimPressAllowed(Number.NEGATIVE_INFINITY, 0)).toBe(true);
  });
});
