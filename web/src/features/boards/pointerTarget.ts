// The drop target when the pointer is over no droppable at all: in the gap between two cells,
// or past the board's edge while it auto-scrolls. Boards stack cards in columns, so the target
// is the nearest COLUMN to the pointer first (horizontal distance), then the nearest cell in it
// (vertical distance). dnd-kit's closestCorners measured from the dragged card instead, whose
// corners reach into the next column, and a plain straight-line distance prefers a tall cell of
// the neighbouring column over a short one right above the pointer.
//
// That fallback applies only while the pointer is over the board (isOverBoard): released over
// the sidebar, the header or a toolbar, a drag is cancelled instead of moving the card to
// whichever cell happens to be nearest. Pure, for tests.

export interface PointLike {
  x: number;
  y: number;
}

export interface RectLike {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Horizontal and vertical distance from a point to a rectangle (0 when within its span). */
export function axisDistance(p: PointLike, r: RectLike): { dx: number; dy: number } {
  return { dx: Math.max(r.left - p.x, 0, p.x - r.right), dy: Math.max(r.top - p.y, 0, p.y - r.bottom) };
}

/** The entry nearest to `p`: smallest horizontal distance, then smallest vertical (the first on a tie). */
export function nearestToPoint<T>(p: PointLike, entries: Iterable<{ key: T; rect: RectLike }>): { key: T; dx: number; dy: number } | null {
  let best: { key: T; dx: number; dy: number } | null = null;
  for (const { key, rect } of entries) {
    const { dx, dy } = axisDistance(p, rect);
    if (!best || dx < best.dx - 0.5 || (Math.abs(dx - best.dx) <= 0.5 && dy < best.dy)) best = { key, dx, dy };
  }
  return best;
}

/** Slack (px) for "the board's edge is the window's edge" (scrollbars, rounding). */
const VIEWPORT_EDGE_PX = 2;

/**
 * True when the pointer is over the board's area — or past one of its edges that is also the
 * window's edge: a mouse held below or right of the window keeps the board auto-scrolling, and
 * a release there still drops on the nearest cell. Past any other edge (the sidebar, the page
 * header, the board's toolbar) the pointer is off the board. `viewport.height` is the usable
 * bottom (above a phone's tab bar), so a finger pushed onto the tab bar counts as past the edge.
 */
export function isOverBoard(p: PointLike, area: RectLike, viewport: { width: number; height: number }): boolean {
  const left = area.left <= VIEWPORT_EDGE_PX ? -Infinity : area.left;
  const top = area.top <= VIEWPORT_EDGE_PX ? -Infinity : area.top;
  const right = area.right >= viewport.width - VIEWPORT_EDGE_PX ? Infinity : area.right;
  const bottom = area.bottom >= viewport.height - VIEWPORT_EDGE_PX ? Infinity : area.bottom;
  return p.x >= left && p.x <= right && p.y >= top && p.y <= bottom;
}
