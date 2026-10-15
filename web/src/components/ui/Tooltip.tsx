// Desktop-only hint bubble. Never the only way to get information: tooltips don't show on
// touch devices, so whatever they say must also be available as text or an aria-label.
//
// Cheap by design (icon buttons on every card use it): until the pointer rests on the
// trigger, no floating-ui machinery is mounted.

import { FloatingPortal, autoUpdate, flip, offset, shift, useFloating, useMergeRefs, type Placement } from '@floating-ui/react';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { cloneTrigger, elementRef, mergeTriggerProps } from './internal/trigger';

export interface TooltipProps {
  content: ReactNode;
  /** Single focusable element (button, link…). */
  children: ReactElement;
  placement?: Placement;
  /** Hover delay before showing (ms). Default 450. */
  delay?: number;
  /** Add aria-describedby (use when the content adds information beyond the accessible name). */
  describe?: boolean;
  disabled?: boolean;
}

export function Tooltip({ content, children, placement = 'top', delay = 450, describe = false, disabled }: TooltipProps) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const id = useId();
  const ref = useMergeRefs([setAnchor, elementRef<HTMLElement>(children)]);
  const childProps = children.props as Record<string, unknown>;
  const suppressed = disabled || childProps['aria-expanded'] === true || childProps['aria-expanded'] === 'true' || !content;

  const clear = () => window.clearTimeout(timer.current);
  const show = (wait: number) => {
    clear();
    timer.current = window.setTimeout(() => setOpen(true), wait);
  };
  const hide = () => {
    clear();
    setOpen(false);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => {
    if (!suppressed) return;
    window.clearTimeout(timer.current);
    setOpen(false);
  }, [suppressed]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onScroll = () => setOpen(false);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, { capture: true });
    };
  }, [open]);

  const trigger = cloneTrigger(
    children,
    mergeTriggerProps(children, {
      onPointerEnter: (e: PointerEvent) => {
        if (e.pointerType === 'mouse' && !suppressed) show(delay);
      },
      onPointerLeave: hide,
      onPointerDown: hide,
      onFocus: (e: FocusEvent<HTMLElement>) => {
        // Keyboard focus only: :focus-visible is false after a mouse click or tap.
        if (!suppressed && e.currentTarget.matches(':focus-visible')) show(150);
      },
      onBlur: hide,
      ...(describe && open ? { 'aria-describedby': id } : {}),
    }),
    ref,
  );

  return (
    <>
      {trigger}
      {open && !suppressed && anchor && (
        <TooltipBubble id={id} anchor={anchor} placement={placement}>
          {content}
        </TooltipBubble>
      )}
    </>
  );
}

function TooltipBubble({ id, anchor, placement, children }: { id: string; anchor: HTMLElement; placement: Placement; children: ReactNode }) {
  const { refs, floatingStyles } = useFloating({
    elements: { reference: anchor },
    placement,
    strategy: 'fixed',
    whileElementsMounted: autoUpdate,
    middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })],
  });
  return (
    <FloatingPortal>
      <div ref={refs.setFloating} style={floatingStyles} className="pointer-events-none z-[70]">
        <div
          id={id}
          role="tooltip"
          className="max-w-64 rounded-md bg-fg px-2 py-1 text-xs font-medium leading-snug text-bg shadow-pop"
        >
          {children}
        </div>
      </div>
    </FloatingPortal>
  );
}
