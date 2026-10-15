import { describe, expect, it } from 'vitest';
import { keepLaneTarget, LANE_SLOP, type LaneLock } from './laneKeep';

const source = { lane: 'payments', col: 'progress' };
const anyCell = () => true;

describe('keepLaneTarget', () => {
  it('leaves targets in the source column alone and drops the lock', () => {
    const lock: LaneLock = { col: 'todo', y: 300, released: false };
    expect(keepLaneTarget({ lane: 'none', col: 'progress' }, source, lock, 300, anyCell)).toEqual({
      target: { lane: 'none', col: 'progress' },
      lock: null,
      entered: false,
    });
    expect(keepLaneTarget(null, source, lock, 300, anyCell).target).toBeNull();
  });

  it('keeps the card’s lane when a horizontal drag reaches another column', () => {
    const first = keepLaneTarget({ lane: 'none', col: 'todo' }, source, null, 300, anyCell);
    expect(first).toEqual({ target: { lane: 'payments', col: 'todo' }, lock: { col: 'todo', y: 300, released: false }, entered: true });
    // Small vertical jitter in that column: still the source lane, and no new "entered".
    const next = keepLaneTarget({ lane: 'other', col: 'todo' }, source, first.lock, 300 + LANE_SLOP - 1, anyCell);
    expect(next.target).toEqual({ lane: 'payments', col: 'todo' });
    expect(next.entered).toBe(false);
  });

  it('lets a deliberate vertical move pick another lane, and stays released in that column', () => {
    const lock: LaneLock = { col: 'todo', y: 300, released: false };
    const moved = keepLaneTarget({ lane: 'none', col: 'todo' }, source, lock, 300 + LANE_SLOP + 1, anyCell);
    expect(moved.target).toEqual({ lane: 'none', col: 'todo' });
    expect(moved.lock?.released).toBe(true);
    const back = keepLaneTarget({ lane: 'other', col: 'todo' }, source, moved.lock, 300, anyCell);
    expect(back.target).toEqual({ lane: 'other', col: 'todo' });
  });

  it('locks again (and reports entered) in each new column', () => {
    const released: LaneLock = { col: 'todo', y: 300, released: true };
    const next = keepLaneTarget({ lane: 'none', col: 'done' }, source, released, 500, anyCell);
    expect(next).toEqual({ target: { lane: 'payments', col: 'done' }, lock: { col: 'done', y: 500, released: false }, entered: true });
  });

  it('falls back to the cell under the finger when the kept lane can’t take the card there', () => {
    const next = keepLaneTarget({ lane: 'none', col: 'todo' }, source, null, 300, (c) => c.lane !== 'payments');
    expect(next.target).toEqual({ lane: 'none', col: 'todo' });
    expect(next.entered).toBe(true);
  });
});
