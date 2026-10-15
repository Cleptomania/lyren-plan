import { describe, expect, it } from 'vitest';
import { axisDistance, isOverBoard, nearestToPoint } from './pointerTarget';

const rect = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom });

describe('axisDistance', () => {
  it('is 0 on an axis where the point is within the rectangle’s span', () => {
    const r = rect(100, 100, 200, 300);
    expect(axisDistance({ x: 150, y: 200 }, r)).toEqual({ dx: 0, dy: 0 });
    expect(axisDistance({ x: 150, y: 340 }, r)).toEqual({ dx: 0, dy: 40 });
    expect(axisDistance({ x: 230, y: 50 }, r)).toEqual({ dx: 30, dy: 50 });
  });
});

describe('nearestToPoint', () => {
  // A lane band after auto-scrolling to the end: To do holds three cards (tall cell), In progress
  // is empty (a short cell). The pointer is held below the board under In progress.
  const band = [
    { key: 'me|unstarted', rect: rect(572, 511, 868, 763) },
    { key: 'me|started', rect: rect(880, 511, 1176, 575) },
    { key: 'me|completed', rect: rect(1188, 511, 1484, 659) },
    { key: 'web|started', rect: rect(880, 100, 1176, 480) },
  ];

  it('picks the pointer’s own column, then the cell in it nearest to the pointer', () => {
    expect(nearestToPoint({ x: 1028, y: 964 }, band)?.key).toBe('me|started');
    expect(nearestToPoint({ x: 1028, y: 490 }, band)?.key).toBe('web|started');
  });

  it('in the gap between two columns, takes the nearer one', () => {
    expect(nearestToPoint({ x: 871, y: 600 }, band)?.key).toBe('me|unstarted');
    expect(nearestToPoint({ x: 878, y: 540 }, band)?.key).toBe('me|started');
  });

  it('returns null without droppables', () => {
    expect(nearestToPoint({ x: 0, y: 0 }, [])).toBeNull();
  });
});

describe('isOverBoard', () => {
  // Desktop: a 240px sidebar on the left, the board's header and toolbar above y = 120; the
  // board area reaches the window's right and bottom edges.
  const viewport = { width: 1280, height: 800 };
  const area = rect(240, 120, 1280, 800);

  it('is true over the board area', () => {
    expect(isOverBoard({ x: 600, y: 400 }, area, viewport)).toBe(true);
    expect(isOverBoard({ x: 240, y: 120 }, area, viewport)).toBe(true);
  });

  it('is false over the sidebar or the header (a release there cancels the drag)', () => {
    expect(isOverBoard({ x: 120, y: 300 }, area, viewport)).toBe(false);
    expect(isOverBoard({ x: 400, y: 30 }, area, viewport)).toBe(false);
    expect(isOverBoard({ x: 239, y: 500 }, area, viewport)).toBe(false);
  });

  it('stays true past an edge the board shares with the window (held there to auto-scroll)', () => {
    expect(isOverBoard({ x: 700, y: 950 }, area, viewport)).toBe(true);
    expect(isOverBoard({ x: 1400, y: 400 }, area, viewport)).toBe(true);
    // ...but not past the sidebar's side of the board.
    expect(isOverBoard({ x: 120, y: 950 }, area, viewport)).toBe(false);
  });

  it('a phone board: the tab bar counts as the window edge (usable bottom), the toolbar above does not', () => {
    const board = rect(0, 150, 390, 788);
    const usable = { width: 390, height: 788 }; // 844 minus the 56px tab bar
    expect(isOverBoard({ x: -5, y: 400 }, board, usable)).toBe(true);
    expect(isOverBoard({ x: 200, y: 820 }, board, usable)).toBe(true);
    expect(isOverBoard({ x: 200, y: 120 }, board, usable)).toBe(false);
    // A board that stops short of the bottom ends at its own edge.
    expect(isOverBoard({ x: 200, y: 820 }, rect(0, 150, 390, 700), usable)).toBe(false);
  });
});
