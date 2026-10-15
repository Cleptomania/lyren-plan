// Dropdown menu driven by a MenuItem[] (SPEC §9.1). Anchored dropdown with keyboard
// navigation, typeahead and hover/arrow-key submenus on desktop; a bottom action sheet with
// large rows (submenus drill in) on phones and touch devices.

import {
  FloatingFocusManager,
  FloatingNode,
  FloatingPortal,
  FloatingTree,
  safePolygon,
  useClick,
  useDismiss,
  useFloating,
  useFloatingNodeId,
  useHover,
  useInteractions,
  useMergeRefs,
  useRole,
  useTransitionStatus,
  type Placement,
} from '@floating-ui/react';
import { clsx } from 'clsx';
import { Check, ChevronLeft, ChevronRight } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useId,
  type KeyboardEvent,
  type ReactElement,
} from 'react';
import { useOverlay } from '../../lib/overlays';
import { anchoredOptions, TRANSITION } from './internal/floating';
import type { OverlayControls } from './internal/overlayControls';
import { cloneTrigger, elementRef, mergeTriggerProps } from './internal/trigger';
import { useSheetMode } from './internal/useSheetMode';
import {
  nextEnabled,
  normalizeMenuItems,
  sectionMenuItems,
  typeaheadMatch,
  type MenuAction,
  type MenuItem,
  type MenuItemInput,
} from './menuItems';
import { originFor } from './Popover';
import { Sheet } from './Sheet';

export type { MenuAction, MenuItem, MenuItemInput } from './menuItems';

export interface MenuProps {
  /** Element that opens the menu (typically an IconButton or Button). */
  trigger: ReactElement;
  /** Falsy entries are ignored, separators are tidied up, empty submenus dropped. */
  items: ReadonlyArray<MenuItemInput>;
  /** Desktop placement relative to the trigger. Default 'bottom-end'. */
  placement?: Placement;
  /** Accessible name of the menu; shown as the sheet title on phones. */
  label?: string;
  /** Controlled open state (optional). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Extra classes for the desktop panel (e.g. a min width). */
  className?: string;
}

export function Menu({ trigger, items, placement = 'bottom-end', label, open: openProp, onOpenChange, className }: MenuProps) {
  const sheetMode = useSheetMode();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = openProp ?? uncontrolledOpen;
  const setOpen = useCallback(
    (next: boolean) => {
      if (openProp === undefined) setUncontrolledOpen(next);
      onOpenChange?.(next);
    },
    [openProp, onOpenChange],
  );
  const normalized = normalizeMenuItems(items);

  if (sheetMode) {
    return <SheetMenu trigger={trigger} items={normalized} label={label} open={open} setOpen={setOpen} />;
  }
  return (
    <FloatingTree>
      <DropdownMenu
        trigger={trigger}
        items={normalized}
        placement={placement}
        label={label}
        open={open}
        setOpen={setOpen}
        className={className}
      />
    </FloatingTree>
  );
}

// ---------------------------------------------------------------------------------------
// Desktop dropdown
// ---------------------------------------------------------------------------------------

type FocusIntent = 'first' | 'last' | 'panel';

interface DropdownProps {
  trigger: ReactElement;
  items: MenuItem[];
  placement: Placement;
  label: string | undefined;
  open: boolean;
  setOpen: (open: boolean) => void;
  className: string | undefined;
}

function DropdownMenu({ trigger, items, placement, label, open, setOpen, className }: DropdownProps) {
  const nodeId = useFloatingNodeId();
  const intent = useRef<FocusIntent>('panel');
  const { refs, floatingStyles, context } = useFloating({ nodeId, open, onOpenChange: setOpen, ...anchoredOptions(placement) });
  const click = useClick(context);
  const dismiss = useDismiss(context, { escapeKey: false });
  const role = useRole(context, { role: 'menu' });
  const { getReferenceProps, getFloatingProps } = useInteractions([click, dismiss, role]);
  const { isMounted, status } = useTransitionStatus(context, { duration: TRANSITION.pop });
  useOverlay(open, () => setOpen(false));

  const triggerRef = useMergeRefs([refs.setReference, elementRef<HTMLElement>(trigger)]);
  const triggerProps = mergeTriggerProps(trigger, {
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        intent.current = e.key === 'ArrowDown' ? 'first' : 'last';
        setOpen(true);
      } else if (e.key === 'Enter' || e.key === ' ') {
        intent.current = 'first';
      }
    },
    onPointerDown: () => {
      intent.current = 'panel';
    },
  });
  const triggerEl = cloneTrigger(trigger, getReferenceProps(triggerProps), triggerRef);

  const selectAction = (action: MenuAction) => {
    // Focus goes back to the trigger BEFORE the action runs, so a dialog opened by the
    // action restores focus to the trigger when it closes.
    (refs.domReference.current as HTMLElement | null)?.focus({ preventScroll: true });
    setOpen(false);
    action.onSelect?.();
  };

  return (
    <FloatingNode id={nodeId}>
      {triggerEl}
      {isMounted && (
        <FloatingPortal>
          <FloatingFocusManager context={context} modal={false} initialFocus={-1}>
            <div
              ref={refs.setFloating}
              style={floatingStyles}
              className="z-50 outline-none"
              aria-label={label}
              {...getFloatingProps()}
            >
              <MenuPanel
                items={items}
                intent={intent.current}
                status={status}
                origin={originFor(context.placement)}
                onSelectAction={selectAction}
                onCloseLevel={() => setOpen(false)}
                nested={false}
                className={className}
              />
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      )}
    </FloatingNode>
  );
}

interface MenuPanelProps {
  items: MenuItem[];
  intent: FocusIntent;
  status: string;
  origin: string;
  onSelectAction: (action: MenuAction) => void;
  /** Close this level only (ArrowLeft in a submenu, Tab). */
  onCloseLevel: () => void;
  nested: boolean;
  className?: string;
}

function MenuPanel({ items, intent, status, origin, onSelectAction, onCloseLevel, nested, className }: MenuPanelProps) {
  const { sections, actions } = sectionMenuItems(items);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const panelRef = useRef<HTMLDivElement>(null);
  const [openSub, setOpenSub] = useState<number | null>(null);
  const typeahead = useRef({ text: '', timer: 0 });
  const hasCheck = actions.some((a) => a.checked !== undefined);
  const hasIcon = actions.some((a) => a.icon !== undefined);
  const idPrefix = useId();

  const focusIndex = useCallback((i: number) => {
    if (i >= 0) itemRefs.current[i]?.focus();
  }, []);
  const currentIndex = () => itemRefs.current.findIndex((el) => el !== null && el === document.activeElement);

  useLayoutEffect(() => {
    // After floating-ui positioned the panel (next frame) to avoid scrolling the page.
    const id = requestAnimationFrame(() => {
      if (intent === 'first') focusIndex(nextEnabled(actions, -1, 1));
      else if (intent === 'last') focusIndex(nextEnabled(actions, actions.length, -1));
      else panelRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(id);
    // Only on mount: later item changes must not steal focus.
  }, []);
  useEffect(() => () => window.clearTimeout(typeahead.current.timer), []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Key events from a submenu (portaled) bubble here through the React tree; ignore them.
    if (!e.currentTarget.contains(e.target as Node)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const cur = currentIndex();
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        focusIndex(nextEnabled(actions, cur, 1));
        return;
      case 'ArrowUp':
        e.preventDefault();
        focusIndex(nextEnabled(actions, cur === -1 ? actions.length : cur, -1));
        return;
      case 'Home':
      case 'PageUp':
        e.preventDefault();
        focusIndex(nextEnabled(actions, -1, 1));
        return;
      case 'End':
      case 'PageDown':
        e.preventDefault();
        focusIndex(nextEnabled(actions, actions.length, -1));
        return;
      case 'ArrowLeft':
        if (nested) {
          e.preventDefault();
          onCloseLevel();
        }
        return;
      case 'Tab':
        e.preventDefault();
        onCloseLevel();
        return;
    }
    if (e.key.length === 1 && e.key !== ' ') {
      const t = typeahead.current;
      window.clearTimeout(t.timer);
      t.text += e.key;
      t.timer = window.setTimeout(() => (t.text = ''), 600);
      const match = typeaheadMatch(actions, t.text, t.text.length > 1 ? cur - 1 : cur);
      if (match >= 0) focusIndex(match);
    }
  };

  const renderAction = (item: MenuAction, index: number) => {
    const common = {
      item,
      index,
      hasCheck,
      hasIcon,
      registerRef: (el: HTMLButtonElement | null) => {
        itemRefs.current[index] = el;
      },
      onPointerEnter: () => {
        if (!item.disabled) focusIndex(index);
        if (!item.items && openSub !== null) setOpenSub(null);
      },
    };
    if (item.items) {
      return (
        <SubmenuItem
          key={index}
          {...common}
          open={openSub === index}
          onOpenChange={(o) => setOpenSub((prev) => (o ? index : prev === index ? null : prev))}
          onSelectAction={onSelectAction}
        />
      );
    }
    return <ActionRow key={index} {...common} onActivate={() => !item.disabled && onSelectAction(item)} />;
  };

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      data-status={status}
      style={{ transformOrigin: origin }}
      onKeyDown={onKeyDown}
      className={clsx(
        'ui-pop max-h-[var(--available-height)] min-w-48 max-w-[min(20rem,var(--available-width))] overflow-y-auto overscroll-contain',
        'rounded-lg border border-border bg-popover p-1 text-fg shadow-pop outline-none scrollbar-thin',
        className,
      )}
    >
      {sections.map((section, si) => {
        const body = section.entries.map((entry, ei) =>
          entry.kind === 'separator' ? (
            <div key={`s${ei}`} role="separator" className="-mx-1 my-1 h-px bg-border" />
          ) : (
            renderAction(entry.item, entry.index)
          ),
        );
        if (!section.heading) return <div key={si}>{body}</div>;
        const headingId = `${idPrefix}-h${si}`;
        return (
          <div key={si} role="group" aria-labelledby={headingId}>
            <div id={headingId} className="px-2 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-fg-subtle">
              {section.heading}
            </div>
            {body}
          </div>
        );
      })}
    </div>
  );
}

interface RowProps {
  item: MenuAction;
  index: number;
  hasCheck: boolean;
  hasIcon: boolean;
  registerRef: (el: HTMLButtonElement | null) => void;
  onPointerEnter: () => void;
}

const ROW =
  'flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-[13px] outline-none ' +
  'focus:bg-surface-2 aria-expanded:bg-surface-2 aria-disabled:cursor-default aria-disabled:opacity-45 [&_svg]:size-4 [&_svg]:shrink-0';

function RowContent({ item, hasCheck, hasIcon, submenu }: { item: MenuAction; hasCheck: boolean; hasIcon: boolean; submenu?: boolean }) {
  return (
    <>
      {hasCheck && <span className="flex w-4 justify-center text-accent">{item.checked && <Check aria-hidden />}</span>}
      {hasIcon && (
        <span aria-hidden className={clsx('flex w-4 justify-center', item.danger ? 'text-danger' : 'text-fg-muted')}>
          {item.icon}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {item.hint && <span className="shrink-0 pl-3 text-xs text-fg-subtle">{item.hint}</span>}
      {submenu && <ChevronRight aria-hidden className="-mr-0.5 text-fg-subtle" />}
    </>
  );
}

function ActionRow({ item, hasCheck, hasIcon, registerRef, onPointerEnter, onActivate }: RowProps & { onActivate: () => void }) {
  return (
    <button
      ref={registerRef}
      type="button"
      role={item.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'}
      aria-checked={item.checked}
      aria-disabled={item.disabled || undefined}
      tabIndex={-1}
      onPointerEnter={onPointerEnter}
      onClick={onActivate}
      className={clsx(ROW, item.danger ? 'text-danger focus:bg-danger-soft' : 'text-fg')}
    >
      <RowContent item={item} hasCheck={hasCheck} hasIcon={hasIcon} />
    </button>
  );
}

interface SubmenuItemProps extends RowProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectAction: (action: MenuAction) => void;
}

function SubmenuItem({ item, hasCheck, hasIcon, registerRef, onPointerEnter, open, onOpenChange, onSelectAction }: SubmenuItemProps) {
  const nodeId = useFloatingNodeId();
  const intent = useRef<FocusIntent>('panel');
  const { refs, floatingStyles, context } = useFloating({
    nodeId,
    open,
    onOpenChange,
    ...anchoredOptions('right-start', { gap: 2, alignOffset: -5 }),
  });
  const hover = useHover(context, {
    enabled: !item.disabled,
    delay: { open: 60 },
    handleClose: safePolygon({ blockPointerEvents: true }),
  });
  const dismiss = useDismiss(context, { escapeKey: false });
  const role = useRole(context, { role: 'menu' });
  const { getReferenceProps, getFloatingProps } = useInteractions([hover, dismiss, role]);
  const { isMounted, status } = useTransitionStatus(context, { duration: TRANSITION.pop });
  const closeAndFocusParent = () => {
    onOpenChange(false);
    (refs.domReference.current as HTMLElement | null)?.focus();
  };
  useOverlay(open, closeAndFocusParent);
  const ref = useMergeRefs<HTMLButtonElement>([refs.setReference, registerRef]);

  const items = item.items ?? [];
  return (
    <FloatingNode id={nodeId}>
      <button
        ref={ref}
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-disabled={item.disabled || undefined}
        tabIndex={-1}
        className={clsx(ROW, 'text-fg')}
        {...getReferenceProps({
          onPointerEnter,
          onClick: (e) => {
            if (item.disabled) return;
            intent.current = e.detail === 0 ? 'first' : 'panel';
            onOpenChange(true);
          },
          onKeyDown: (e) => {
            if (e.key === 'ArrowRight' && !item.disabled) {
              e.preventDefault();
              intent.current = 'first';
              onOpenChange(true);
            }
          },
        })}
      >
        <RowContent item={item} hasCheck={hasCheck} hasIcon={hasIcon} submenu />
      </button>
      {isMounted && (
        <FloatingPortal>
          <FloatingFocusManager context={context} modal={false} initialFocus={-1} returnFocus={false}>
            <div ref={refs.setFloating} style={floatingStyles} className="z-50 outline-none" aria-label={item.label} {...getFloatingProps()}>
              <MenuPanel
                items={items}
                intent={intent.current}
                status={status}
                origin={originFor(context.placement)}
                onSelectAction={onSelectAction}
                onCloseLevel={closeAndFocusParent}
                nested
              />
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      )}
    </FloatingNode>
  );
}

// ---------------------------------------------------------------------------------------
// Phones / touch: bottom action sheet
// ---------------------------------------------------------------------------------------

interface SheetMenuProps {
  trigger: ReactElement;
  items: MenuItem[];
  label: string | undefined;
  open: boolean;
  setOpen: (open: boolean) => void;
}

function SheetMenu({ trigger, items, label, open, setOpen }: SheetMenuProps) {
  const [path, setPath] = useState<MenuAction[]>([]);
  const triggerRef = useRef<HTMLElement | null>(null);
  const ref = useMergeRefs([triggerRef, elementRef<HTMLElement>(trigger)]);
  const triggerEl = cloneTrigger(
    trigger,
    mergeTriggerProps(trigger, {
      'aria-haspopup': 'menu',
      'aria-expanded': open,
      onClick: () => {
        setPath([]);
        setOpen(!open);
      },
    }),
    ref,
  );
  const level = path[path.length - 1];
  const current = level?.items ?? items;
  const { sections, actions } = sectionMenuItems(current);
  const hasIcon = actions.some((a) => a.icon !== undefined);

  const sheet = useRef<OverlayControls>(null);
  const select = (action: MenuAction) => {
    if (action.disabled) return;
    if (action.items) {
      setPath((p) => [...p, action]);
      return;
    }
    // Focus goes back to the trigger first, so a dialog opened by the action restores focus
    // there. The action runs once the sheet's history entry is popped: it may navigate, open
    // a dialog or another sheet, which must not interleave with that history.back().
    triggerRef.current?.focus({ preventScroll: true });
    const run = () => action.onSelect?.();
    if (sheet.current) sheet.current.closeThen(run);
    else {
      setOpen(false);
      run();
    }
  };

  return (
    <>
      {triggerEl}
      <Sheet
        controlsRef={sheet}
        open={open}
        onClose={() => setOpen(false)}
        title={level ? undefined : label}
        aria-label={level ? level.label : label ? undefined : 'Menu'}
        showClose={false}
      >
        {level && (
          <button
            type="button"
            onClick={() => setPath((p) => p.slice(0, -1))}
            className="flex h-12 w-full items-center gap-2 px-3 text-left text-[15px] font-semibold text-fg active:bg-surface-2"
          >
            <ChevronLeft aria-hidden className="size-5 text-fg-muted" />
            <span className="truncate">{level.label}</span>
          </button>
        )}
        <div role="menu" aria-label={level?.label ?? label} className="pb-1">
          {sections.map((section, si) => (
            <div key={si} role={section.heading ? 'group' : undefined} aria-label={section.heading}>
              {section.heading && (
                <div className="px-4 pb-1 pt-3 text-xs font-medium uppercase tracking-wide text-fg-subtle">{section.heading}</div>
              )}
              {section.entries.map((entry, ei) =>
                entry.kind === 'separator' ? (
                  <div key={`s${ei}`} role="separator" className="my-1 h-px bg-border" />
                ) : (
                  <SheetRow key={entry.index} item={entry.item} hasIcon={hasIcon} onSelect={() => select(entry.item)} />
                ),
              )}
            </div>
          ))}
        </div>
      </Sheet>
    </>
  );
}

function SheetRow({ item, hasIcon, onSelect }: { item: MenuAction; hasIcon: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      role={item.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'}
      aria-checked={item.checked}
      aria-disabled={item.disabled || undefined}
      aria-haspopup={item.items ? 'menu' : undefined}
      onClick={onSelect}
      className={clsx(
        'flex min-h-12 w-full items-center gap-3 px-4 text-left text-[15px] active:bg-surface-2 aria-disabled:opacity-45 [&_svg]:size-5 [&_svg]:shrink-0',
        item.danger ? 'text-danger' : 'text-fg',
      )}
    >
      {hasIcon && (
        <span aria-hidden className={clsx('flex w-5 shrink-0 justify-center', item.danger ? 'text-danger' : 'text-fg-muted')}>
          {item.icon}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {item.hint && <span className="shrink-0 text-sm text-fg-subtle">{item.hint}</span>}
      {item.checked && <Check aria-hidden className="text-accent" />}
      {item.items && <ChevronRight aria-hidden className="text-fg-subtle" />}
    </button>
  );
}
