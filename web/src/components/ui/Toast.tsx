// Toasts: <Toaster /> is mounted once (AuthedApp); call toast.success / error / info anywhere.
//   toast.success('Task deleted', { action: { label: 'Undo', onClick: restore } })
//   toast.error(err)  // ApiError, Error or string → readable message (nothing for a declined re-auth)
//
// Toasts draw above overlays, so Undo / Open stay reachable, and move out of the way of an open
// panel (above a sheet, beside the desktop drawer, else to the top: toastPlacement.ts).

import { clsx } from 'clsx';
import { CircleAlert, CircleCheck, Info, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { errorMessage, isReauthDeclined } from '../../api/client';
import { getToastObstacles, subscribeToastObstacles } from './internal/toastObstacles';
import {
  activeObstacles,
  CONTROL_SELECTOR,
  DEFAULT_PLACEMENT,
  placeToasts,
  samePlacement,
  settledPanel,
  type Box,
  type ToastPlacement,
} from './toastPlacement';
import { createToastStore, type ToastItem, type ToastKind, type ToastOptions } from './toastStore';

export type { ToastOptions } from './toastStore';

const store = createToastStore(3);

export const toast = {
  success: (message: string, opts?: ToastOptions): number => store.show('success', message, opts),
  /**
   * Accepts a message or anything thrown (uses errorMessage from api/client). A re-auth the person declined
   * (they closed the dialog themselves) shows nothing and answers 0.
   */
  error: (messageOrError: unknown, opts?: ToastOptions): number =>
    isReauthDeclined(messageOrError)
      ? 0
      : store.show('error', typeof messageOrError === 'string' ? messageOrError : errorMessage(messageOrError), opts),
  info: (message: string, opts?: ToastOptions): number => store.show('info', message, opts),
  dismiss: (id: number): void => store.dismiss(id),
};

const ICONS: Record<ToastKind, typeof Info> = { success: CircleCheck, error: CircleAlert, info: Info };
const ICON_COLORS: Record<ToastKind, string> = { success: 'text-success', error: 'text-danger', info: 'text-accent' };

/** The region's horizontal extent (the probe below shares it). */
const REGION_X = 'inset-x-3 md:inset-x-auto md:right-4 md:w-[22rem]';

export function Toaster() {
  const items = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const list = useRef<HTMLOListElement>(null);
  const probe = useRef<HTMLDivElement>(null);
  const placement = useToastPlacement(items.length > 0, list, probe);
  return createPortal(
    <>
      {/* The usual spot (bottom edge, width) and the highest allowed top edge, from the CSS. */}
      <div ref={probe} aria-hidden className={clsx('toast-region toast-probe pointer-events-none invisible fixed', REGION_X)} />
      <section
        aria-label="Notifications"
        data-placement={placement.mode}
        style={placementStyle(placement)}
        className={clsx('toast-region pointer-events-none fixed z-[60] flex flex-col items-stretch gap-2', REGION_X)}
      >
        {/* At the top edge the newest toast comes first, as at the bottom edge it comes last. */}
        <ol ref={list} aria-live="polite" className={clsx('flex gap-2', placement.mode === 'top' ? 'flex-col-reverse' : 'flex-col')}>
          {items.map((t) => (
            <ToastView key={t.id} toast={t} />
          ))}
        </ol>
      </section>
    </>,
    document.body,
  );
}

const GAP = 8;

function placementStyle(p: ToastPlacement): CSSProperties | undefined {
  switch (p.mode) {
    case 'default':
      return undefined;
    case 'above':
      return { bottom: p.bottom };
    case 'beside':
      return { right: p.right, left: 'auto' };
    case 'top':
      return { top: 'calc(env(safe-area-inset-top) + 0.75rem)', bottom: 'auto' };
  }
}

/**
 * A panel's untransformed border box in viewport pixels: offsetTop / offsetLeft ignore
 * transforms, so this is where a sliding panel settles.
 */
function layoutBox(el: HTMLElement): Box {
  let top = el.offsetTop;
  let left = el.offsetLeft;
  const parent = el.offsetParent;
  if (parent instanceof HTMLElement && parent !== document.body) {
    const p = parent.getBoundingClientRect();
    top += p.top + parent.clientTop - parent.scrollTop;
    left += p.left + parent.clientLeft - parent.scrollLeft;
  } else if (parent === document.body) {
    top -= window.scrollY;
    left -= window.scrollX;
  }
  return { top, left, bottom: top + el.offsetHeight, right: left + el.offsetWidth };
}

/** The panels' settled boxes and their visible controls (buttons, fields, links…). */
function measurePanels(panels: readonly HTMLElement[], viewportHeight: number): { obstacles: Box[]; controls: Box[] } {
  const obstacles: Box[] = [];
  const controls: Box[] = [];
  for (const panel of panels) {
    const drawn: Box[] = [];
    for (const el of panel.querySelectorAll(CONTROL_SELECTOR)) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) drawn.push(r);
    }
    const settled = settledPanel({ rect: panel.getBoundingClientRect(), layout: layoutBox(panel), controls: drawn }, viewportHeight);
    obstacles.push(settled.obstacle);
    controls.push(...settled.controls);
  }
  return { obstacles, controls };
}

/** Longest panel enter transition (index.css: sheets 220ms) plus a frame or two. */
const SETTLE_MS = 300;

/**
 * Re-placed whenever toasts come or go, a panel opens, settles, closes or resizes, its content
 * changes (a composer expanding, a field mounting late) or gets focus, or the window resizes —
 * at most once a frame, and not while a panel scrolls (a stack jumping under the finger would
 * be worse).
 */
function useToastPlacement(
  shown: boolean,
  list: RefObject<HTMLElement | null>,
  probe: RefObject<HTMLElement | null>,
): ToastPlacement {
  const all = useSyncExternalStore(subscribeToastObstacles, getToastObstacles, getToastObstacles);
  const panels = useMemo(() => activeObstacles(all), [all]);
  const [placement, setPlacement] = useState<ToastPlacement>(DEFAULT_PLACEMENT);

  useLayoutEffect(() => {
    const stack = list.current;
    if (!shown || panels.length === 0 || !stack) {
      setPlacement(DEFAULT_PLACEMENT);
      return;
    }
    const update = () => {
      const usual = probe.current?.getBoundingClientRect();
      if (!usual) return;
      const root = document.documentElement;
      const viewport = { width: root.clientWidth, height: root.clientHeight };
      const next = placeToasts({
        viewport,
        slot: { top: usual.bottom - stack.offsetHeight, right: usual.right, bottom: usual.bottom, left: usual.left },
        ...measurePanels(panels, viewport.height),
        minTop: usual.top,
        gap: GAP,
      });
      setPlacement((prev) => (samePlacement(prev, next) ? prev : next));
    };
    let frame = 0;
    const schedule = () => {
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          update();
        });
      }
    };
    update();
    // A panel that just opened is still sliding in and may mount content late: measure again
    // when its transition ends, and after the longest one in any case.
    const settle = window.setTimeout(update, SETTLE_MS);
    const onTransitionEnd = (e: Event) => {
      if (panels.includes(e.target as HTMLElement)) schedule();
    };
    const resize = new ResizeObserver(schedule);
    resize.observe(stack);
    const mutations = new MutationObserver(schedule);
    for (const el of panels) {
      resize.observe(el);
      mutations.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden', 'aria-expanded', 'data-status'] });
      el.addEventListener('transitionend', onTransitionEnd);
      el.addEventListener('focusin', schedule);
    }
    window.addEventListener('resize', schedule);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(settle);
      resize.disconnect();
      mutations.disconnect();
      for (const el of panels) {
        el.removeEventListener('transitionend', onTransitionEnd);
        el.removeEventListener('focusin', schedule);
      }
      window.removeEventListener('resize', schedule);
    };
  }, [shown, panels, list, probe]);

  return placement;
}

function ToastView({ toast: t }: { toast: ToastItem }) {
  const [entered, setEntered] = useState(false);
  const [paused, setPaused] = useState(false);
  const remaining = useRef(t.durationMs);
  const Icon = ICONS[t.kind];

  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // A duplicate re-show restarts the full duration.
  useEffect(() => {
    remaining.current = t.durationMs;
  }, [t.version, t.durationMs]);

  useEffect(() => {
    if (paused || t.closing || t.durationMs <= 0) return;
    const started = Date.now();
    const timer = window.setTimeout(() => store.dismiss(t.id), remaining.current);
    return () => {
      window.clearTimeout(timer);
      remaining.current = Math.max(800, remaining.current - (Date.now() - started));
    };
  }, [paused, t.closing, t.durationMs, t.id, t.version]);

  const status = t.closing ? 'close' : entered ? 'open' : 'initial';
  return (
    <li
      role={t.kind === 'error' ? 'alert' : 'status'}
      data-status={status}
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      className="ui-toast pointer-events-auto flex items-start gap-2.5 rounded-lg border border-border bg-popover py-2.5 pl-3 pr-1.5 text-sm text-fg shadow-pop"
    >
      <Icon aria-hidden className={clsx('mt-0.5 size-4 shrink-0', ICON_COLORS[t.kind])} />
      <p className="line-clamp-4 min-w-0 flex-1 py-px break-words">
        {t.message}
        {t.count > 1 && <span className="ml-1.5 text-xs font-medium text-fg-subtle">×{t.count}</span>}
      </p>
      {t.action && (
        <button
          type="button"
          onClick={() => {
            t.action?.onClick();
            store.dismiss(t.id);
          }}
          className="-my-1 shrink-0 rounded-md px-2 py-1 text-sm font-semibold text-accent hover:bg-accent-soft"
        >
          {t.action.label}
        </button>
      )}
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => store.dismiss(t.id)}
        className="-my-1 flex size-7 shrink-0 items-center justify-center rounded-md text-fg-subtle hover:bg-surface-2 hover:text-fg"
      >
        <X aria-hidden className="size-4" />
      </button>
    </li>
  );
}
