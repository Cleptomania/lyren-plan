// Underline tabs: RouteTabs (NavLink-based, for sub-pages) and Tabs (local state).
// Both scroll horizontally on narrow screens, keep the active tab in view and fade the edge
// where more tabs are scrolled out of view (so a hidden last tab is discoverable).

import { clsx } from 'clsx';
import { useLayoutEffect, useRef, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { NavLink, useLocation } from 'react-router';

export interface RouteTab {
  to: string;
  label: ReactNode;
  /** Match the path exactly (for index routes). */
  end?: boolean;
  count?: number;
  icon?: ReactNode;
}

const TAB =
  'relative inline-flex h-10 shrink-0 items-center gap-1.5 whitespace-nowrap px-1 text-sm font-medium transition-colors ' +
  'text-fg-muted hover:text-fg focus-visible:outline-offset-[-2px] [&_svg]:size-4 ' +
  "after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-full after:content-[''] ";
const TAB_ACTIVE = 'text-fg after:bg-accent';

function Count({ value }: { value: number }) {
  return <span className="rounded-full bg-surface-2 px-1.5 text-xs font-medium tabular-nums text-fg-muted">{value}</span>;
}

/** Scroll the selected tab into view when it changes (horizontal only). */
function useActiveInView(container: RefObject<HTMLElement | null>, key: unknown) {
  useLayoutEffect(() => {
    const el = container.current?.querySelector<HTMLElement>('[aria-current="page"], [aria-selected="true"]');
    const box = container.current;
    if (!el || !box) return;
    const left = el.offsetLeft - box.offsetLeft;
    if (left < box.scrollLeft || left + el.offsetWidth > box.scrollLeft + box.clientWidth) {
      box.scrollLeft = left - 16;
    }
  }, [container, key]);
}

/**
 * Sets data-fade-start / data-fade-end on a horizontal scroller while content is hidden past
 * that edge; the `edge-fade` class (index.css) masks those edges.
 */
function useEdgeFade(container: RefObject<HTMLElement | null>, key: string) {
  useLayoutEffect(() => {
    const box = container.current;
    if (!box) return;
    // Compare the tabs themselves with the visible box (padding at the ends doesn't count).
    const update = () => {
      const view = box.getBoundingClientRect();
      const first = box.firstElementChild?.getBoundingClientRect();
      const last = box.lastElementChild?.getBoundingClientRect();
      box.toggleAttribute('data-fade-start', !!first && first.left < view.left - 1);
      box.toggleAttribute('data-fade-end', !!last && last.right > view.right + 1);
    };
    update();
    box.addEventListener('scroll', update, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    // The box resizing, or a tab growing (a count loading), changes what overflows.
    observer?.observe(box);
    for (const child of box.children) observer?.observe(child);
    return () => {
      box.removeEventListener('scroll', update);
      observer?.disconnect();
    };
  }, [container, key]);
}

const STRIP = 'touch-scroll-x no-scrollbar edge-fade flex gap-5 max-md:gap-3.5';

export interface RouteTabsProps {
  tabs: ReadonlyArray<RouteTab>;
  'aria-label'?: string;
  className?: string;
}

/** Navigation tabs for sub-routes (rendered as links in a <nav>). */
export function RouteTabs({ tabs, 'aria-label': ariaLabel = 'Sections', className }: RouteTabsProps) {
  const ref = useRef<HTMLElement>(null);
  useActiveInView(ref, useLocation().pathname);
  useEdgeFade(ref, tabs.map((t) => t.to).join('\n'));
  return (
    <nav ref={ref} aria-label={ariaLabel} className={clsx(STRIP, className)}>
      {tabs.map((t) => (
        <NavLink key={t.to} to={t.to} end={t.end} className={({ isActive }) => clsx(TAB, isActive && TAB_ACTIVE)}>
          {t.icon}
          {t.label}
          {t.count !== undefined && <Count value={t.count} />}
        </NavLink>
      ))}
    </nav>
  );
}

export interface TabItem<T extends string> {
  value: T;
  label: ReactNode;
  count?: number;
  icon?: ReactNode;
  disabled?: boolean;
}

export interface TabsProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  items: ReadonlyArray<TabItem<T>>;
  'aria-label'?: string;
  /** Id prefix; tab i gets id `${id}-tab-${value}` and controls `${id}-panel-${value}`. */
  id?: string;
  className?: string;
}

/**
 * Local tabs (role=tablist, arrow-key navigation). Render the active panel yourself; give it
 * `role="tabpanel"` and `id={`${id}-panel-${value}`}` when you pass `id`.
 */
export function Tabs<T extends string>({ value, onChange, items, 'aria-label': ariaLabel, id, className }: TabsProps<T>) {
  const ref = useRef<HTMLDivElement>(null);
  useActiveInView(ref, value);
  useEdgeFade(ref, items.map((i) => i.value).join('\n'));
  const enabled = items.filter((i) => !i.disabled);
  const onKeyDown = (e: KeyboardEvent) => {
    const idx = enabled.findIndex((i) => i.value === value);
    let next: TabItem<T> | undefined;
    if (e.key === 'ArrowRight') next = enabled[(idx + 1) % enabled.length];
    else if (e.key === 'ArrowLeft') next = enabled[(idx - 1 + enabled.length) % enabled.length];
    else if (e.key === 'Home') next = enabled[0];
    else if (e.key === 'End') next = enabled[enabled.length - 1];
    if (!next) return;
    e.preventDefault();
    onChange(next.value);
    requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus());
  };
  return (
    <div ref={ref} role="tablist" aria-label={ariaLabel} onKeyDown={onKeyDown} className={clsx(STRIP, className)}>
      {items.map((t) => {
        const selected = t.value === value;
        return (
          <button
            key={t.value}
            type="button"
            role="tab"
            id={id ? `${id}-tab-${t.value}` : undefined}
            aria-controls={id ? `${id}-panel-${t.value}` : undefined}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            disabled={t.disabled}
            onClick={() => onChange(t.value)}
            className={clsx(TAB, selected && TAB_ACTIVE, 'disabled:opacity-50')}
          >
            {t.icon}
            {t.label}
            {t.count !== undefined && <Count value={t.count} />}
          </button>
        );
      })}
    </div>
  );
}
