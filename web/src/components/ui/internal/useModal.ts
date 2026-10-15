// Shared state for Dialog / Drawer / Sheet: floating-ui context (for FloatingFocusManager),
// enter/exit transition status, overlay-stack registration (Esc, Back), the controls
// exposed to content via useOverlayControls(), and the panel's registration as a surface
// toasts keep clear of (toastObstacles.ts) while it is open.

import { useFloating, useTransitionStatus } from '@floating-ui/react';
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  type MouseEvent,
  type PointerEvent,
  type Ref,
  type RefObject,
} from 'react';
import { useOverlay, whenHistoryIdle } from '../../../lib/overlays';
import type { OverlayControls } from './overlayControls';
import { addToastObstacle, type ToastObstacleKind } from './toastObstacles';

export interface UseModalOptions {
  history: boolean;
  duration: number;
  closeOnEscape?: boolean;
  controlsRef?: Ref<OverlayControls>;
  /** How toasts treat the open panel (default 'modal'; a non-modal desktop drawer is 'docked'). */
  toastObstacle?: ToastObstacleKind;
}

export function useModal(open: boolean, onClose: () => void, opts: UseModalOptions) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const close = useCallback(() => onCloseRef.current(), []);

  const { refs, context, elements } = useFloating({
    open,
    onOpenChange: (next) => {
      if (!next) close();
    },
  });
  // From open until the exit transition starts (a closing panel ignores the pointer anyway).
  const panel = elements.floating;
  const obstacleKind = opts.toastObstacle ?? 'modal';
  useEffect(() => {
    if (!open || !panel) return;
    return addToastObstacle(panel, obstacleKind);
  }, [open, panel, obstacleKind]);
  const { isMounted, status } = useTransitionStatus(context, { duration: opts.duration });
  const overlay = useOverlay(open, close, { history: opts.history, closeOnEscape: opts.closeOnEscape });
  const overlayRef = useRef(overlay);
  overlayRef.current = overlay;

  const controls = useMemo<OverlayControls>(
    () => ({
      close,
      closeForNavigation: () => {
        const replace = overlayRef.current.dismissForNavigation();
        close();
        return replace;
      },
      closeThen: (run) => {
        if (overlayRef.current.ownsHistoryEntry()) {
          overlayRef.current.afterClose(run);
          close();
        } else {
          // No entry to pop: run within the user gesture (clipboard, focus…).
          close();
          whenHistoryIdle(run);
        }
      },
      afterClose: (run) => overlayRef.current.afterClose(run),
    }),
    [close],
  );
  useImperativeHandle(opts.controlsRef, () => controls, [controls]);

  return { refs, context, isMounted, status, controls, close };
}

/**
 * How long a freshly shown overlay ignores pointer input. A quick double tap on an action that
 * opens an overlay (a sheet's "Delete…", "Open") must not land its second tap on what just
 * appeared: on the scrim it would cancel a confirm at once, on a drawer it would hit whatever
 * control is under the finger. Panels get the same guard in CSS (index.css, `tap-guard`).
 */
export const TAP_GUARD_MS = 350;

/** A scrim press counts only once the overlay has been shown for TAP_GUARD_MS. */
export function scrimPressAllowed(shownAt: number, now: number): boolean {
  return now - shownAt >= TAP_GUARD_MS;
}

/**
 * Pointer handlers (and a ref) for a scrim that close only when both press and release land
 * on it, and never for a press within TAP_GUARD_MS of the scrim appearing.
 */
export function useScrimClose(enabled: boolean, close: () => void) {
  const downOnScrim = useRef(false);
  const shownAt = useRef(Number.NEGATIVE_INFINITY);
  // The scrim mounts with the overlay: its mount time is when the overlay was shown.
  const ref = useCallback((el: HTMLElement | null) => {
    if (el) shownAt.current = performance.now();
  }, []);
  return {
    ref,
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      downOnScrim.current = e.target === e.currentTarget && scrimPressAllowed(shownAt.current, performance.now());
    },
    onClick: (e: MouseEvent<HTMLElement>) => {
      if (enabled && downOnScrim.current && e.target === e.currentTarget) close();
      downOnScrim.current = false;
    },
  };
}

const FIELD_SELECTOR =
  '[data-autofocus], [autofocus], input:not([type=hidden]):not(:disabled):not([readonly]), textarea:not(:disabled):not([readonly]), select:not(:disabled)';

/**
 * Element to focus when a dialog opens: an explicit `initialFocus`, else the first form
 * field in `container`, else the panel itself (so screen readers announce the dialog
 * without jumping to the close button).
 *
 * Resolved lazily when FloatingFocusManager reads `.current`: the portal mounts its
 * children a commit after the dialog opens, so nothing can be queried up front.
 */
export function useInitialFocus(
  explicit: RefObject<HTMLElement | null> | undefined,
  container: RefObject<HTMLElement | null>,
  panel: RefObject<HTMLElement | null>,
  autoField: boolean,
): RefObject<HTMLElement | null> {
  const latest = useRef({ explicit, autoField });
  latest.current = { explicit, autoField };
  return useMemo(
    () => ({
      get current(): HTMLElement | null {
        const { explicit: ex, autoField: auto } = latest.current;
        if (ex?.current) return ex.current;
        const field = auto ? container.current?.querySelector<HTMLElement>(FIELD_SELECTOR) : null;
        return field ?? panel.current;
      },
      set current(_value: HTMLElement | null) {
        // Read-only; FloatingFocusManager never assigns.
      },
    }),
    [container, panel],
  );
}
