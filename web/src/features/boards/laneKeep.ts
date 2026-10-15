// Lane keeping for phone touch drags on boards with lanes (SPEC §8.3). Phones stack each
// column's lanes separately, so whatever lane happens to sit under the finger in the next
// column is rarely the card's own: a drag that reaches another column keeps the card's lane
// until the finger moves up or down on purpose (LANE_SLOP) inside that column.

import type { CellRef } from './grouping';

/** Vertical finger travel (px) after entering another column that releases the kept lane. */
export const LANE_SLOP = 32;

export interface LaneLock {
  /** The column the card is visiting. */
  col: string;
  /** Finger y when it entered that column. */
  y: number;
  /** The finger moved vertically past LANE_SLOP: the cell under it wins from now on. */
  released: boolean;
}

/**
 * `raw` is the cell under the finger, `source` the card's own cell. Returns the cell to
 * target, the next lock, and whether the card just entered another column (the caller then
 * scrolls the kept lane under the finger).
 */
export function keepLaneTarget(
  raw: CellRef | null,
  source: CellRef,
  lock: LaneLock | null,
  y: number,
  canDrop: (cell: CellRef) => boolean,
): { target: CellRef | null; lock: LaneLock | null; entered: boolean } {
  if (!raw || raw.col === source.col) return { target: raw, lock: null, entered: false };
  const entered = !lock || lock.col !== raw.col;
  const next: LaneLock = entered ? { col: raw.col, y, released: false } : { ...lock, released: lock.released || Math.abs(y - lock.y) > LANE_SLOP };
  const kept = { lane: source.lane, col: raw.col };
  if (next.released || raw.lane === source.lane || !canDrop(kept)) return { target: raw, lock: next, entered };
  return { target: kept, lock: next, entered };
}
