// Bottom sheet (phones and touch devices): action sheets for menus, pickers and popovers,
// the mobile "More" navigation sheet, or any short modal content. On wide screens it is a
// centered card anchored to the bottom edge.

import { FloatingFocusManager, FloatingOverlay, FloatingPortal } from '@floating-ui/react';
import { clsx } from 'clsx';
import { X } from 'lucide-react';
import { useId, useRef, type CSSProperties, type ReactNode, type Ref, type RefObject } from 'react';
import { IconButton } from './Button';
import { SheetHandle } from './Dialog';
import { TRANSITION } from './internal/floating';
import { OverlayControlsContext, type OverlayControls } from './internal/overlayControls';
import { useInitialFocus, useModal, useScrimClose } from './internal/useModal';

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  /** Heading shown at the top (also the accessible name). */
  title?: ReactNode;
  /** Accessible name when there is no visible title. */
  'aria-label'?: string;
  children: ReactNode;
  /** Pinned row at the bottom (e.g. a "Done" button). */
  footer?: ReactNode;
  /** Show an X button in the header (default: only when there is a title). */
  showClose?: boolean;
  /**
   * Push a history entry so Back closes the sheet (default true: SPEC §1/§9, Back closes the
   * top overlay only). Content that navigates or opens another overlay must not race with the
   * sheet's history.back(): use the controls (useOverlayControls / controlsRef) —
   * `navigate(url, { replace: closeForNavigation() })` or `closeThen(action)`.
   */
  history?: boolean;
  /** Element to focus on open (default: the sheet itself, so no keyboard pops up). */
  initialFocus?: RefObject<HTMLElement | null>;
  controlsRef?: Ref<OverlayControls>;
  /**
   * Space left free below the sheet (a CSS length), for chrome that stays usable above the
   * scrim (the phone tab bar under the "More" sheet). Phones only; the height cap shrinks to match.
   */
  bottomInset?: string;
  className?: string;
  bodyClassName?: string;
}

export function Sheet({
  open,
  onClose,
  title,
  'aria-label': ariaLabel,
  children,
  footer,
  showClose,
  history = true,
  initialFocus,
  controlsRef,
  bottomInset,
  className,
  bodyClassName,
}: SheetProps) {
  const { refs, context, isMounted, status, controls, close } = useModal(open, onClose, {
    history,
    duration: TRANSITION.sheet,
    controlsRef,
  });
  const titleId = useId();
  const bodyRef = useRef<HTMLDivElement>(null);
  const focusTarget = useInitialFocus(initialFocus, bodyRef, refs.floating, false);
  const scrim = useScrimClose(true, close);
  const withClose = showClose ?? !!title;

  if (!isMounted) return null;

  return (
    <FloatingPortal>
      <FloatingOverlay lockScroll className="z-50 flex items-end justify-center">
        <div aria-hidden data-status={status} className="ui-fade fixed inset-0 bg-overlay" {...scrim} />
        <FloatingFocusManager context={context} initialFocus={focusTarget}>
          <div
            ref={refs.setFloating}
            role="dialog"
            aria-modal="true"
            aria-labelledby={title && !ariaLabel ? titleId : undefined}
            aria-label={ariaLabel}
            tabIndex={-1}
            data-status={status}
            style={bottomInset ? ({ '--sheet-inset': bottomInset } as CSSProperties) : undefined}
            className={clsx(
              'ui-sheet relative flex w-full flex-col rounded-t-2xl border-t border-border bg-popover text-fg shadow-pop outline-none',
              bottomInset ? 'mb-[var(--sheet-inset)] max-h-[calc(85dvh-var(--sheet-inset))]' : 'max-h-[85dvh]',
              'md:mb-4 md:max-h-[85dvh] md:max-w-lg md:rounded-2xl md:border',
              className,
            )}
          >
            <SheetHandle />
            {(title || withClose) && (
              <header className="flex shrink-0 items-center gap-2 px-4 pb-1 pt-2">
                <h2 id={titleId} className="min-w-0 flex-1 truncate text-[15px] font-semibold text-fg">
                  {title}
                </h2>
                {withClose && <IconButton aria-label="Close" tooltip={false} icon={<X />} onClick={close} className="-mr-2" />}
              </header>
            )}
            <div
              ref={bodyRef}
              // With a bottom inset, the chrome below the sheet clears the safe area.
              className={clsx('min-h-0 flex-1 overflow-y-auto overscroll-contain', !footer && (bottomInset ? 'pb-3 md:pb-safe-3' : 'pb-safe-3'), bodyClassName)}
            >
              <OverlayControlsContext.Provider value={controls}>{children}</OverlayControlsContext.Provider>
            </div>
            {footer && (
              <footer
                className={clsx(
                  'flex shrink-0 items-center justify-end gap-2 border-t border-border px-4 pt-3',
                  bottomInset ? 'pb-3 md:pb-safe-3' : 'pb-safe-3',
                )}
              >
                <OverlayControlsContext.Provider value={controls}>{footer}</OverlayControlsContext.Provider>
              </footer>
            )}
          </div>
        </FloatingFocusManager>
      </FloatingOverlay>
    </FloatingPortal>
  );
}
