// Side panel. Desktop: slides in from the right (or left) with a configurable width, either
// modal (scrim + focus trap, default) or non-modal (no scrim; the page stays interactive —
// used by the task drawer). Phones: always a modal full-screen sheet.

import { FloatingFocusManager, FloatingOverlay, FloatingPortal } from '@floating-ui/react';
import { clsx } from 'clsx';
import { X } from 'lucide-react';
import { useId, useRef, type ReactNode, type Ref, type RefObject } from 'react';
import { useIsMobile } from '../../lib/hooks';
import { IconButton } from './Button';
import { TRANSITION } from './internal/floating';
import { OverlayControlsContext, type OverlayControls } from './internal/overlayControls';
import { useInitialFocus, useModal, useScrimClose } from './internal/useModal';

export interface DrawerProps {
  open: boolean;
  /** Called for Esc (top overlay), the close button, a scrim click (modal) and Back (phones). */
  onClose: () => void;
  /** Title for the default header. Required for accessibility unless `aria-label` is given. */
  title?: ReactNode;
  /** Replaces the default header (title + close button) entirely. Safe-area padding is added on phones. */
  header?: ReactNode;
  /** Scrolling body. The body is the scroll container (sticky children stick to it). */
  children: ReactNode;
  /** Pinned action row at the bottom. */
  footer?: ReactNode;
  /** Desktop width (any CSS length). Default '36rem'; capped to the viewport. */
  width?: string;
  side?: 'right' | 'left';
  /** Desktop only: false = no scrim, no focus trap, page stays usable. Default true. */
  modal?: boolean;
  /** Element to focus on open (default: the panel). Focus returns to the opener on close. */
  initialFocus?: RefObject<HTMLElement | null>;
  /**
   * Push a history entry so Back closes the drawer on phones. Default true on phones.
   * Pass false when the URL already reflects the drawer (e.g. ?task=…).
   */
  history?: boolean;
  'aria-label'?: string;
  controlsRef?: Ref<OverlayControls>;
  className?: string;
  bodyClassName?: string;
}

export function Drawer({
  open,
  onClose,
  title,
  header,
  children,
  footer,
  width = '36rem',
  side = 'right',
  modal = true,
  initialFocus,
  history,
  'aria-label': ariaLabel,
  controlsRef,
  className,
  bodyClassName,
}: DrawerProps) {
  const isMobile = useIsMobile();
  const isModal = isMobile || modal;
  const { refs, context, isMounted, status, controls, close } = useModal(open, onClose, {
    history: history ?? isMobile,
    duration: TRANSITION.sheet,
    controlsRef,
    // Toasts move beside a non-modal drawer (its composer / footer stay usable).
    toastObstacle: isModal ? 'modal' : 'docked',
  });
  const titleId = useId();
  const bodyRef = useRef<HTMLDivElement>(null);
  const focusTarget = useInitialFocus(initialFocus, bodyRef, refs.floating, false);
  const scrim = useScrimClose(true, close);

  if (!isMounted) return null;

  const panel = (
    <FloatingFocusManager context={context} modal={isModal} closeOnFocusOut={false} initialFocus={focusTarget}>
      <div
        ref={refs.setFloating}
        role="dialog"
        aria-modal={isModal || undefined}
        aria-labelledby={!ariaLabel && title && !header ? titleId : undefined}
        aria-label={ariaLabel}
        tabIndex={-1}
        data-status={status}
        style={isMobile ? undefined : { width: `min(${width}, 100vw)` }}
        className={clsx(
          'fixed inset-y-0 z-40 flex flex-col bg-popover text-fg outline-none',
          isMobile ? 'ui-sheet inset-x-0 h-dvh' : ['h-dvh shadow-pop', side === 'right' ? 'right-0 border-l' : 'left-0 border-r'],
          !isMobile && (side === 'right' ? 'ui-slide-right' : 'ui-slide-left'),
          isModal && 'z-50',
          'border-border',
          className,
        )}
      >
        <OverlayControlsContext.Provider value={controls}>
          {header !== undefined ? (
            // `pt-safe` is a plain class (index.css), so a `max-md:` variant of it generates no CSS.
            <div className={clsx('shrink-0', isMobile && 'pt-safe')}>{header}</div>
          ) : (
            <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 pb-2.5 pt-safe-3 md:pt-3">
              <h2 id={titleId} className="min-w-0 flex-1 truncate text-base font-semibold text-fg">
                {title}
              </h2>
              <IconButton aria-label="Close" tooltip={false} icon={<X />} onClick={close} className="-mr-2" />
            </header>
          )}
          <div
            ref={bodyRef}
            className={clsx('min-h-0 flex-1 overflow-y-auto overscroll-contain', !footer && 'pb-safe', bodyClassName)}
          >
            {children}
          </div>
          {footer && (
            <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border px-4 pb-safe-3 pt-3">
              {footer}
            </footer>
          )}
        </OverlayControlsContext.Provider>
      </div>
    </FloatingFocusManager>
  );

  return (
    <FloatingPortal>
      {isModal ? (
        <FloatingOverlay lockScroll className="z-50">
          {!isMobile && <div aria-hidden data-status={status} className="ui-fade fixed inset-0 bg-overlay" {...scrim} />}
          {panel}
        </FloatingOverlay>
      ) : (
        panel
      )}
    </FloatingPortal>
  );
}
