// Shared floating-ui configuration for anchored panels (menus, popovers, pickers).

import { autoUpdate, flip, offset, shift, size, type Placement, type UseFloatingOptions } from '@floating-ui/react';

const VIEWPORT_PADDING = 8;

/**
 * Position options for an anchored panel: flips/shifts to stay on screen and caps the
 * panel height to the available space (exposed as --available-height, used by panels
 * with max-h-[var(--available-height)]).
 */
export function anchoredOptions(
  placement: Placement,
  opts: { gap?: number; alignOffset?: number; matchWidth?: boolean } = {},
): Pick<UseFloatingOptions, 'placement' | 'middleware' | 'whileElementsMounted' | 'strategy'> {
  return {
    placement,
    strategy: 'fixed',
    whileElementsMounted: autoUpdate,
    middleware: [
      offset({ mainAxis: opts.gap ?? 4, alignmentAxis: opts.alignOffset ?? 0 }),
      flip({ padding: VIEWPORT_PADDING, fallbackAxisSideDirection: 'end' }),
      shift({ padding: VIEWPORT_PADDING }),
      size({
        padding: VIEWPORT_PADDING,
        apply({ availableHeight, availableWidth, rects, elements }) {
          const style = elements.floating.style;
          style.setProperty('--available-height', `${Math.max(120, Math.floor(availableHeight))}px`);
          style.setProperty('--available-width', `${Math.floor(availableWidth)}px`);
          if (opts.matchWidth) style.minWidth = `${Math.round(rects.reference.width)}px`;
        },
      }),
    ],
  };
}

/** Exit-transition durations (ms) shared with the CSS in index.css. */
export const TRANSITION = { pop: 120, dialog: 180, sheet: 220 } as const;
