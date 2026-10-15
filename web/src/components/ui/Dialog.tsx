// Modal dialog: centered on desktop; on phones full-screen (default), a bottom sheet or a
// compact centered card. Focus is trapped and restored, page scroll is locked, Esc (top
// overlay only) and the scrim close it, and on phones Back closes it.

import { FloatingFocusManager, FloatingOverlay, FloatingPortal } from '@floating-ui/react';
import { clsx } from 'clsx';
import { X } from 'lucide-react';
import { useId, useRef, type FormEvent, type ReactNode, type Ref, type RefObject } from 'react';
import { useIsMobile } from '../../lib/hooks';
import { IconButton } from './Button';
import { TRANSITION } from './internal/floating';
import { OverlayControlsContext, type OverlayControls } from './internal/overlayControls';
import { useInitialFocus, useModal, useScrimClose } from './internal/useModal';

export type DialogSize = 'sm' | 'md' | 'lg' | 'xl';
export type DialogMobileLayout = 'fullscreen' | 'sheet' | 'center';

export interface DialogProps {
  open: boolean;
  /** Called for Esc, the close button, a scrim click and (full-screen phone dialogs) Back. */
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  /** Body content (scrolls when tall). */
  children?: ReactNode;
  /** Action row at the bottom (buttons, right-aligned). */
  footer?: ReactNode;
  /** When set, header/body/footer are wrapped in a <form>; submit buttons in the footer work. */
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  /** Desktop width: sm 24rem · md 32rem (default) · lg 42rem · xl 56rem. */
  size?: DialogSize;
  /** Layout below md. Default 'fullscreen'. */
  mobileLayout?: DialogMobileLayout;
  /** Element to focus on open. Default: first form field in the body, else the dialog itself. */
  initialFocus?: RefObject<HTMLElement | null>;
  /**
   * Push a history entry so Back closes the dialog. Default: true on phones (every mobile
   * layout: Back closes the top overlay, SPEC §9). Pass false when the dialog's own actions
   * navigate without `closeForNavigation`.
   */
  history?: boolean;
  /** Close when clicking the scrim (default true). Set false for forms with unsaved input. */
  closeOnOutsideClick?: boolean;
  /** Extra elements in the header next to the close button. */
  headerActions?: ReactNode;
  hideCloseButton?: boolean;
  /** Imperative handle: { close, closeForNavigation } (also available inside via useOverlayControls). */
  controlsRef?: Ref<OverlayControls>;
  className?: string;
  bodyClassName?: string;
}

const SIZES: Record<DialogSize, string> = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
};

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  onSubmit,
  size = 'md',
  mobileLayout = 'fullscreen',
  initialFocus,
  history,
  closeOnOutsideClick = true,
  headerActions,
  hideCloseButton,
  controlsRef,
  className,
  bodyClassName,
}: DialogProps) {
  const isMobile = useIsMobile();
  const layout: DialogMobileLayout | 'desktop' = isMobile ? mobileLayout : 'desktop';
  const fullscreen = layout === 'fullscreen';
  const { refs, context, isMounted, status, controls, close } = useModal(open, onClose, {
    history: history ?? layout !== 'desktop',
    duration: layout === 'desktop' || layout === 'center' ? TRANSITION.dialog : TRANSITION.sheet,
    controlsRef,
  });
  const titleId = useId();
  const descId = useId();
  const bodyRef = useRef<HTMLDivElement>(null);
  const focusTarget = useInitialFocus(initialFocus, bodyRef, refs.floating, true);
  const scrim = useScrimClose(closeOnOutsideClick, close);

  if (!isMounted) return null;

  const header = (
    <header
      className={clsx(
        'flex shrink-0 items-start gap-3 px-4 md:px-5',
        fullscreen ? 'border-b border-border pb-3 pt-safe-3' : 'pb-2 pt-4 md:pt-5',
      )}
    >
      <div className="min-w-0 flex-1 pt-1">
        <h2 id={titleId} className="text-base font-semibold leading-6 text-fg">
          {title}
        </h2>
        {description && (
          <p id={descId} className="mt-0.5 text-sm text-fg-muted">
            {description}
          </p>
        )}
      </div>
      {headerActions}
      {!hideCloseButton && <IconButton aria-label="Close" tooltip={false} icon={<X />} onClick={close} className="-mr-2 -mt-0.5" />}
    </header>
  );

  const body = (
    <div
      ref={bodyRef}
      className={clsx(
        'min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3 md:px-5',
        !footer && layout !== 'desktop' ? 'pb-safe-3' : !footer && 'pb-5',
        bodyClassName,
      )}
    >
      {children}
    </div>
  );

  const foot = footer && (
    <footer
      className={clsx(
        'flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border px-4 pt-3 md:px-5',
        layout === 'desktop' ? 'pb-3' : 'pb-safe-3',
      )}
    >
      {footer}
    </footer>
  );

  const content = onSubmit ? (
    <form
      noValidate
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        // React bubbles synthetic events through portals: a form inside a popover opened from
        // this dialog (e.g. the due-date or estimate picker's "Set") must not submit the dialog.
        if (e.target !== e.currentTarget) return;
        onSubmit(e);
      }}
    >
      {header}
      {body}
      {foot}
    </form>
  ) : (
    <>
      {header}
      {body}
      {foot}
    </>
  );

  return (
    <FloatingPortal>
      <FloatingOverlay
        lockScroll
        className={clsx(
          'z-50 flex',
          layout === 'desktop' && 'items-center justify-center p-4 md:p-8',
          layout === 'fullscreen' && 'items-stretch',
          layout === 'sheet' && 'items-end',
          layout === 'center' && 'items-center justify-center p-4',
        )}
      >
        <div aria-hidden data-status={status} className="ui-fade fixed inset-0 bg-overlay" {...scrim} />
        <FloatingFocusManager context={context} initialFocus={focusTarget}>
          <div
            ref={refs.setFloating}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={description ? descId : undefined}
            tabIndex={-1}
            data-status={status}
            className={clsx(
              'relative flex flex-col bg-popover text-fg shadow-pop outline-none',
              layout === 'desktop' && ['ui-dialog max-h-full w-full rounded-xl border border-border', SIZES[size]],
              layout === 'fullscreen' && 'ui-sheet h-full w-full',
              layout === 'sheet' && 'ui-sheet max-h-[92dvh] w-full rounded-t-2xl border-t border-border',
              layout === 'center' && 'ui-dialog max-h-full w-full max-w-sm rounded-xl border border-border',
              className,
            )}
          >
            {layout === 'sheet' && <SheetHandle />}
            <OverlayControlsContext.Provider value={controls}>{content}</OverlayControlsContext.Provider>
          </div>
        </FloatingFocusManager>
      </FloatingOverlay>
    </FloatingPortal>
  );
}

/** The small grab bar at the top of bottom sheets (decorative). */
export function SheetHandle() {
  return <div aria-hidden className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-border-strong" />;
}
