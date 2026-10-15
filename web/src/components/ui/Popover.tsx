// Anchored panel for small interactive content (filters, color picker, date presets…).
// On phones / touch devices it renders as a bottom Sheet instead (sheetOnMobile).

import {
  FloatingFocusManager,
  FloatingPortal,
  useClick,
  useDismiss,
  useFloating,
  useInteractions,
  useMergeRefs,
  useRole,
  useTransitionStatus,
  type Placement,
} from '@floating-ui/react';
import { clsx } from 'clsx';
import { useCallback, useMemo, useState, type ReactElement, type ReactNode, type RefObject } from 'react';
import { useOverlay } from '../../lib/overlays';
import { anchoredOptions, TRANSITION } from './internal/floating';
import { OverlayControlsContext, type OverlayControls } from './internal/overlayControls';
import { cloneTrigger, elementRef } from './internal/trigger';
import { useSheetMode } from './internal/useSheetMode';
import { Sheet } from './Sheet';

export interface PopoverProps {
  /** The element that toggles the popover (a Button, IconButton…). */
  trigger: ReactElement;
  /** Content, or a render function receiving `close`. */
  children: ReactNode | ((api: { close: () => void }) => ReactNode);
  /** Controlled open state (optional). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Default 'bottom-start'. */
  placement?: Placement;
  /** Accessible name; also the sheet heading on phones. */
  title?: string;
  /** Render as a bottom sheet on phones / touch devices (default true). */
  sheetOnMobile?: boolean;
  /** Element to focus on open (default: the first focusable element). */
  initialFocus?: RefObject<HTMLElement | null>;
  /** Classes for the panel (default 'w-72 p-3'). */
  className?: string;
}

/** Transform origin so the pop animation grows out of the trigger. */
export function originFor(placement: Placement): string {
  const [side, align] = placement.split('-') as [string, string | undefined];
  const opposite: Record<string, string> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };
  const vertical = side === 'top' || side === 'bottom';
  const cross = align === 'start' ? (vertical ? 'left' : 'top') : align === 'end' ? (vertical ? 'right' : 'bottom') : 'center';
  return vertical ? `${cross} ${opposite[side]}` : `${opposite[side]} ${cross}`;
}

export function Popover({
  trigger,
  children,
  open: openProp,
  onOpenChange,
  placement = 'bottom-start',
  title,
  sheetOnMobile = true,
  initialFocus,
  className,
}: PopoverProps) {
  const sheetMode = useSheetMode() && sheetOnMobile;
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = openProp ?? uncontrolledOpen;
  const setOpen = useCallback(
    (next: boolean) => {
      if (openProp === undefined) setUncontrolledOpen(next);
      onOpenChange?.(next);
    },
    [openProp, onOpenChange],
  );
  const close = useCallback(() => setOpen(false), [setOpen]);

  const { refs, floatingStyles, context } = useFloating({ open, onOpenChange: setOpen, ...anchoredOptions(placement) });
  const click = useClick(context);
  const dismiss = useDismiss(context, { escapeKey: false, enabled: !sheetMode });
  const role = useRole(context, { role: 'dialog' });
  const { getReferenceProps, getFloatingProps } = useInteractions([click, dismiss, role]);
  const { isMounted, status } = useTransitionStatus(context, { duration: TRANSITION.pop });
  useOverlay(open && !sheetMode, close);
  // Desktop panel (no history entry): everything can run right away.
  const controls = useMemo<OverlayControls>(
    () => ({
      close,
      closeForNavigation: () => {
        close();
        return false;
      },
      closeThen: (run) => {
        close();
        run();
      },
      afterClose: (run) => run(),
    }),
    [close],
  );

  const triggerRef = useMergeRefs([refs.setReference, elementRef<HTMLElement>(trigger)]);
  const triggerEl = cloneTrigger(trigger, getReferenceProps(trigger.props as Record<string, unknown>), triggerRef);
  const content = typeof children === 'function' ? children({ close }) : children;

  if (sheetMode) {
    return (
      <>
        {triggerEl}
        <Sheet open={open} onClose={close} title={title} aria-label={title ? undefined : 'Options'} initialFocus={initialFocus}>
          <div className="px-4 pb-2 pt-1">{content}</div>
        </Sheet>
      </>
    );
  }

  return (
    <>
      {triggerEl}
      {isMounted && (
        <FloatingPortal>
          <FloatingFocusManager context={context} modal={false} initialFocus={initialFocus ?? 0}>
            <div
              ref={refs.setFloating}
              style={floatingStyles}
              className="z-50 outline-none"
              aria-label={title ?? 'Options'}
              {...getFloatingProps()}
            >
              <div
                data-status={status}
                style={{ transformOrigin: originFor(context.placement) }}
                className={clsx(
                  'ui-pop max-h-[var(--available-height)] max-w-[var(--available-width)] overflow-y-auto overscroll-contain rounded-lg border border-border bg-popover text-fg shadow-pop',
                  className ?? 'w-72 p-3',
                )}
              >
                <OverlayControlsContext.Provider value={controls}>{content}</OverlayControlsContext.Provider>
              </div>
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      )}
    </>
  );
}
