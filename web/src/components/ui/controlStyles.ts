// Shared look of text-like form controls (Input, Textarea, Select, DateInput…).

import { clsx } from 'clsx';

export type ControlSize = 'sm' | 'md';

export const CONTROL_HEIGHTS: Record<ControlSize, string> = {
  sm: 'h-10 md:h-8',
  md: 'h-10 md:h-9',
};

/** Border, background, focus ring and invalid state (no height / padding). */
export const CONTROL_SURFACE =
  'rounded-md border border-border-control bg-surface text-fg shadow-card transition-[border-color,box-shadow] duration-150 ' +
  'placeholder:text-fg-subtle hover:border-fg-subtle ' +
  'focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-focus/20 ' +
  'aria-[invalid=true]:border-danger aria-[invalid=true]:focus:ring-danger/20 ' +
  'disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:border-border-control';

/** Same look for a wrapper that contains a borderless control (focus-within). */
export const CONTROL_SURFACE_WITHIN =
  'rounded-md border border-border-control bg-surface text-fg shadow-card transition-[border-color,box-shadow] duration-150 ' +
  'hover:border-fg-subtle focus-within:border-focus focus-within:ring-[3px] focus-within:ring-focus/20 ' +
  'has-[[aria-invalid=true]]:border-danger';

export function controlClasses(size: ControlSize = 'md', className?: string): string {
  return clsx('block w-full min-w-0 px-3 text-sm', CONTROL_HEIGHTS[size], CONTROL_SURFACE, className);
}
