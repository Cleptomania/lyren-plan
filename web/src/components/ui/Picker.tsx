// Searchable option picker (combobox pattern): single or multi select, optional
// "Create …" row, full keyboard support. Anchored popover on desktop, bottom sheet on
// phones / touch devices. Domain pickers (StatusPicker, TagPicker…) are built on this.

import {
  FloatingFocusManager,
  FloatingPortal,
  useClick,
  useDismiss,
  useFloating,
  useInteractions,
  useMergeRefs,
  useRole,
  useTransitionStatus,
  type Placement,
} from '@floating-ui/react';
import { clsx } from 'clsx';
import { Check, Plus, Search } from 'lucide-react';
import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { useOverlay } from '../../lib/overlays';
import { Button } from './Button';
import { anchoredOptions, TRANSITION } from './internal/floating';
import type { OverlayControls } from './internal/overlayControls';
import { cloneTrigger, elementRef } from './internal/trigger';
import { useSheetMode } from './internal/useSheetMode';
import { canCreateOption, filterPickerOptions, toggleValue } from './pickerFilter';
import { originFor } from './Popover';
import { Sheet } from './Sheet';
import { Spinner } from './Spinner';

export type PickerValue = string | number | null;

export interface PickerOption<V extends PickerValue = PickerValue> {
  value: V;
  label: string;
  /** Leading visual: status icon, color dot, avatar… */
  icon?: ReactNode;
  /** Right-aligned secondary text (e.g. a project key or count). */
  hint?: string;
  /** Extra text matched by the search (not shown). */
  keywords?: string;
  /** Section heading; options of one group must be adjacent. */
  group?: string;
  disabled?: boolean;
}

interface PickerCommonProps<V extends PickerValue> {
  options: ReadonlyArray<PickerOption<V>>;
  /** Accessible name of the list ("Status", "Tags"…); also the sheet title on phones. */
  label: string;
  /** Search field placeholder (default "Search…"). */
  placeholder?: string;
  /** Text when nothing matches (default "No matches"). */
  emptyText?: string;
  /** Show the search field. Default: more than 7 options or onCreate is set. */
  searchable?: boolean;
  /** Enables a "Create “query”" row. Await-able; the query is cleared when it resolves. */
  onCreate?: (query: string) => void | Promise<unknown>;
  /** Text of the create row (default: `Create “${query}”`). */
  createLabel?: (query: string) => string;
}

export interface SinglePickerListProps<V extends PickerValue> extends PickerCommonProps<V> {
  multiple?: false;
  value: V | undefined;
  onChange: (value: V) => void;
}

export interface MultiPickerListProps<V extends PickerValue> extends PickerCommonProps<V> {
  multiple: true;
  value: readonly V[];
  onChange: (value: V[]) => void;
}

export type PickerListProps<V extends PickerValue> = (SinglePickerListProps<V> | MultiPickerListProps<V>) & {
  /** Called after a single-select choice (or a create in single mode): close the container. */
  onDone?: () => void;
  /** Larger rows for touch. */
  touch?: boolean;
  /** Focus the search field (or list) on mount. Default true. */
  autoFocus?: boolean;
  className?: string;
};

interface PickerPopupProps {
  /** Element that opens the picker. */
  trigger: ReactElement;
  /** Controlled open state (optional). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Default 'bottom-start'. */
  placement?: Placement;
  /** Desktop panel classes (default width 16rem). */
  className?: string;
}

export type PickerProps<V extends PickerValue> = (SinglePickerListProps<V> | MultiPickerListProps<V>) & PickerPopupProps;

export function Picker<V extends PickerValue>(props: PickerProps<V>) {
  const { trigger, open: openProp, onOpenChange, placement = 'bottom-start', className, ...listProps } = props;
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

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    ...anchoredOptions(placement, { matchWidth: false }),
  });
  const click = useClick(context);
  const dismiss = useDismiss(context, { escapeKey: false, enabled: !sheetMode });
  const role = useRole(context, { role: 'dialog' });
  const { getReferenceProps, getFloatingProps } = useInteractions([click, dismiss, role]);
  const { isMounted, status } = useTransitionStatus(context, { duration: TRANSITION.pop });
  useOverlay(open && !sheetMode, () => setOpen(false));

  const triggerRef = useMergeRefs([refs.setReference, elementRef<HTMLElement>(trigger)]);
  const triggerEl = cloneTrigger(trigger, getReferenceProps(trigger.props as Record<string, unknown>), triggerRef);

  // Sheet mode, single select: the choice is applied once the sheet's history entry has been
  // popped (closeThen), so an onChange that navigates, rewrites the URL or opens a dialog
  // doesn't interleave with the sheet's history.back().
  const sheet = useRef<OverlayControls>(null);
  const pendingChoice = useRef<(() => void) | null>(null);
  const done = () => {
    (refs.domReference.current as HTMLElement | null)?.focus({ preventScroll: true });
    const run = pendingChoice.current;
    pendingChoice.current = null;
    if (run && sheet.current) sheet.current.closeThen(run);
    else {
      setOpen(false);
      run?.();
    }
  };
  const shownProps = (
    sheetMode && !listProps.multiple
      ? {
          ...listProps,
          onChange: (value: V) => {
            const onChange = listProps.onChange;
            pendingChoice.current = () => onChange(value);
          },
        }
      : listProps
  ) as PickerListProps<V>;
  const list = (touch: boolean) => <PickerList<V> {...shownProps} touch={touch} autoFocus={!touch} onDone={done} />;

  if (sheetMode) {
    return (
      <>
        {triggerEl}
        <Sheet
          controlsRef={sheet}
          open={open}
          onClose={() => setOpen(false)}
          title={listProps.label}
          footer={
            listProps.multiple ? (
              <Button variant="primary" fullWidth onClick={() => setOpen(false)}>
                Done
              </Button>
            ) : undefined
          }
          bodyClassName="flex flex-col"
        >
          {list(true)}
        </Sheet>
      </>
    );
  }

  return (
    <>
      {triggerEl}
      {isMounted && (
        <FloatingPortal>
          <FloatingFocusManager context={context} modal={false} initialFocus={-1}>
            <div
              ref={refs.setFloating}
              style={floatingStyles}
              className="z-50 outline-none"
              {...getFloatingProps({ 'aria-label': listProps.label })}
            >
              <div
                data-status={status}
                style={{ transformOrigin: originFor(context.placement) }}
                className={clsx(
                  'ui-pop flex max-h-[min(24rem,var(--available-height))] max-w-[var(--available-width)] flex-col overflow-hidden',
                  'rounded-lg border border-border bg-popover text-fg shadow-pop',
                  className ?? 'w-64',
                )}
              >
                {list(false)}
              </div>
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      )}
    </>
  );
}

type Row<V extends PickerValue> = { kind: 'option'; option: PickerOption<V> } | { kind: 'create'; query: string };

/**
 * The search field + listbox used inside Picker. Exported for embedding in other surfaces
 * (a Popover with extra controls, a settings panel…).
 */
export function PickerList<V extends PickerValue>(props: PickerListProps<V>) {
  const { options, label, placeholder = 'Search…', emptyText = 'No matches', onCreate, createLabel, onDone, touch = false, autoFocus = true, className } = props;
  const searchable = props.searchable ?? (options.length > 7 || !!onCreate);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const listboxId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const isSelected = useCallback(
    (v: V) => (props.multiple ? props.value.includes(v) : props.value === v),
    [props.multiple, props.value],
  );

  const rows = useMemo<Row<V>[]>(() => {
    const filtered = filterPickerOptions(options, query);
    const out: Row<V>[] = filtered.map((option) => ({ kind: 'option', option }));
    if (onCreate && canCreateOption(options, query)) out.push({ kind: 'create', query: query.trim() });
    return out;
  }, [options, query, onCreate]);

  const enabled = (r: Row<V> | undefined) => !!r && (r.kind === 'create' || !r.option.disabled);
  const initialActive = () => {
    if (!props.multiple && props.value !== undefined) {
      const i = rows.findIndex((r) => r.kind === 'option' && r.option.value === props.value);
      if (i >= 0) return i;
    }
    return rows.findIndex((r) => enabled(r));
  };
  const [active, setActive] = useState<number>(initialActive);
  const keyboardNav = useRef(false);

  // Typing resets the highlight to the first match.
  useEffect(() => {
    if (query) setActive(rows.findIndex((r) => enabled(r)));
    // rows changes with query; only react to query edits.
  }, [query]);

  useLayoutEffect(() => {
    if (!autoFocus) return;
    const id = requestAnimationFrame(() => (searchable ? inputRef.current : listRef.current)?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(id);
  }, [autoFocus, searchable]);

  useLayoutEffect(() => {
    if (!keyboardNav.current || active < 0) return;
    document.getElementById(`${listboxId}-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active, listboxId]);

  const move = (from: number, dir: 1 | -1) => {
    const n = rows.length;
    for (let step = 1; step <= n; step++) {
      const i = (((from + dir * step) % n) + n) % n;
      if (enabled(rows[i])) return i;
    }
    return -1;
  };

  const choose = async (row: Row<V>) => {
    if (row.kind === 'create') {
      if (!onCreate || creating) return;
      setCreating(true);
      try {
        await onCreate(row.query);
        setQuery('');
        if (!props.multiple) onDone?.();
      } catch {
        // The caller reports the error (toast); keep the query so it can be retried.
      } finally {
        setCreating(false);
      }
      return;
    }
    const { option } = row;
    if (option.disabled) return;
    if (props.multiple) {
      props.onChange(toggleValue(props.value, option.value));
    } else {
      props.onChange(option.value);
      onDone?.();
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.nativeEvent.isComposing) return;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        keyboardNav.current = true;
        setActive((a) => move(a, 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        keyboardNav.current = true;
        setActive((a) => move(a < 0 ? rows.length : a, -1));
        break;
      case 'Home':
        if (searchable) break;
        e.preventDefault();
        keyboardNav.current = true;
        setActive(move(-1, 1));
        break;
      case 'End':
        if (searchable) break;
        e.preventDefault();
        keyboardNav.current = true;
        setActive(move(rows.length, -1));
        break;
      case 'Enter': {
        const row = rows[active];
        if (row) {
          e.preventDefault();
          void choose(row);
        }
        break;
      }
      case ' ':
        if (!searchable && rows[active]) {
          e.preventDefault();
          void choose(rows[active]!);
        }
        break;
    }
  };

  const activeId = active >= 0 && rows[active] ? `${listboxId}-${active}` : undefined;
  const showCheckColumn = props.multiple || options.some((o) => isSelected(o.value));
  let lastGroup: string | undefined;

  return (
    <div className={clsx('flex min-h-0 flex-1 flex-col', className)}>
      {searchable && (
        <div className={clsx('relative shrink-0 border-b border-border', touch && 'px-3 pb-2')}>
          <Search
            aria-hidden
            className={clsx('pointer-events-none absolute top-1/2 size-4 -translate-y-1/2 text-fg-subtle', touch ? 'left-6 -mt-1' : 'left-3')}
          />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listboxId}
            aria-activedescendant={activeId}
            aria-autocomplete="list"
            aria-label={`Search ${label.toLocaleLowerCase()}`}
            placeholder={placeholder}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="done"
            className={clsx(
              'w-full bg-transparent text-fg outline-none placeholder:text-fg-subtle',
              touch ? 'h-10 rounded-md border border-border-control bg-surface pl-9 pr-3 text-base' : 'h-9 pl-9 pr-3 text-[13px]',
            )}
          />
        </div>
      )}
      <div
        ref={listRef}
        id={listboxId}
        role="listbox"
        aria-label={label}
        aria-multiselectable={props.multiple || undefined}
        aria-activedescendant={searchable ? undefined : activeId}
        tabIndex={searchable ? -1 : 0}
        onKeyDown={searchable ? undefined : onKeyDown}
        className={clsx('min-h-0 flex-1 overflow-y-auto overscroll-contain outline-none scrollbar-thin', touch ? 'py-1' : 'p-1')}
      >
        {rows.length === 0 && <div className="px-3 py-6 text-center text-sm text-fg-muted">{emptyText}</div>}
        {rows.map((row, i) => {
          const id = `${listboxId}-${i}`;
          const isActive = i === active;
          if (row.kind === 'create') {
            return (
              <div
                key="__create"
                id={id}
                role="option"
                aria-selected={false}
                data-active={isActive || undefined}
                onPointerMove={() => {
                  keyboardNav.current = false;
                  setActive(i);
                }}
                onClick={() => void choose(row)}
                className={clsx(rowClasses(touch), 'text-accent')}
              >
                {showCheckColumn && <span className="w-4" />}
                <span aria-hidden className="flex w-4 justify-center">
                  {creating ? <Spinner size="xs" label={null} /> : <Plus />}
                </span>
                <span className="min-w-0 flex-1 truncate">{createLabel ? createLabel(row.query) : `Create “${row.query}”`}</span>
              </div>
            );
          }
          const { option } = row;
          const selected = isSelected(option.value);
          const heading = option.group !== undefined && option.group !== lastGroup ? option.group : undefined;
          lastGroup = option.group;
          return (
            <Fragment key={`${String(option.value)}`}>
              {heading && (
                <div role="presentation" className={clsx('px-3 pb-1 text-[11px] font-medium uppercase tracking-wide text-fg-subtle', i > 0 ? 'pt-3' : 'pt-1.5')}>
                  {heading}
                </div>
              )}
              <div
                id={id}
                role="option"
                aria-selected={selected}
                aria-disabled={option.disabled || undefined}
                data-active={isActive || undefined}
                onPointerMove={() => {
                  if (option.disabled) return;
                  keyboardNav.current = false;
                  setActive(i);
                }}
                onClick={() => void choose(row)}
                className={rowClasses(touch)}
              >
                {showCheckColumn && (
                  <span aria-hidden className="flex w-4 justify-center">
                    {props.multiple ? (
                      <span
                        className={clsx(
                          'flex size-4 items-center justify-center rounded-[4px] border',
                          selected ? 'border-accent bg-accent text-accent-fg' : 'border-border-control bg-surface',
                        )}
                      >
                        {selected && <Check strokeWidth={3} className="size-3" />}
                      </span>
                    ) : (
                      selected && <Check className="text-accent" />
                    )}
                  </span>
                )}
                {option.icon !== undefined && (
                  <span aria-hidden className="flex w-4 shrink-0 justify-center">
                    {option.icon}
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                {option.hint && <span className="shrink-0 pl-2 text-xs text-fg-subtle">{option.hint}</span>}
              </div>
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}

function rowClasses(touch: boolean): string {
  return clsx(
    'flex cursor-pointer select-none items-center gap-2 text-fg data-[active]:bg-surface-2',
    'aria-disabled:cursor-default aria-disabled:opacity-45 [&_svg]:size-4 [&_svg]:shrink-0',
    touch ? 'min-h-12 px-4 text-[15px]' : 'h-8 rounded-md px-2 text-[13px]',
  );
}
