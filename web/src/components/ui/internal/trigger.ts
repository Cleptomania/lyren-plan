// Helpers for components that take a `trigger` element (Menu, Popover, Picker, Tooltip):
// attach a ref and extra props to the caller's element without clobbering its own
// ref and event handlers.

import { cloneElement, isValidElement, type ReactElement, type Ref } from 'react';

export type AnyProps = Record<string, unknown>;

/** The ref the caller put on the element (React 19 passes it as a regular prop). */
export function elementRef<T>(el: ReactElement): Ref<T> | undefined {
  return (el.props as { ref?: Ref<T> }).ref;
}

/**
 * The element's own props plus `extra`. Event handlers (`on*`) present on both are chained
 * (the element's own handler runs first; if it calls preventDefault() ours is skipped).
 * Other keys in `extra` win. The element's `ref` is left out (merge it separately).
 */
export function mergeTriggerProps(el: ReactElement, extra: AnyProps): AnyProps {
  const own = el.props as AnyProps;
  const merged: AnyProps = {};
  for (const [key, value] of Object.entries(own)) if (key !== 'ref') merged[key] = value;
  for (const [key, ours] of Object.entries(extra)) {
    const theirs = own[key];
    if (/^on[A-Z]/.test(key) && typeof theirs === 'function' && typeof ours === 'function') {
      merged[key] = (event: { defaultPrevented?: boolean }, ...rest: unknown[]) => {
        (theirs as (...a: unknown[]) => void)(event, ...rest);
        if (!event?.defaultPrevented) (ours as (...a: unknown[]) => void)(event, ...rest);
      };
    } else {
      merged[key] = ours;
    }
  }
  return merged;
}

/**
 * Clone a trigger element with a complete prop set (already merged with its own props,
 * e.g. via mergeTriggerProps or floating-ui's getReferenceProps(el.props)) and a ref.
 */
export function cloneTrigger(el: ReactElement, props: AnyProps, ref: Ref<HTMLElement>): ReactElement {
  if (!isValidElement(el)) throw new Error('trigger must be a single React element');
  return cloneElement(el, { ...props, ref } as AnyProps);
}
