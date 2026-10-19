// Quick filters in the board header (SPEC §8): text search (debounced), tags (any of),
// priorities and "hide closed" — URL view state, ANDed with the saved filter, never saved.
// Also hosts the select-mode toggle and, on phones, the per-device "show as list" toggle.
// Phones have no room for three chips next to the board's buttons: there tags, priority and
// "hide closed" sit in a "Filters" sheet behind one button that counts the active ones. That
// button sits outside the scrolling strip, so it never scrolls away or hides under the fade;
// a set search query shrinks to the room that is left instead (the project board's row also
// holds Configure and ⋯). While the search is in use the button shows only its icon / count,
// and while it is being typed the list toggle and Select step aside to make room.

import { clsx } from 'clsx';
import { CheckCircle2, Columns3, Flag, ListChecks, ListFilter, Rows3, Search, Tags, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { LIMITS, PRIORITY_META } from '@shared/constants';
import { usePriorityOptions, useTagOptions } from '../../components/domain';
import { Button, IconButton, Input, Picker, PickerList, Sheet, Spinner, Switch } from '../../components/ui';
import { useIsMobile } from '../../lib/hooks';
import { EMPTY_QUICK_FILTERS, hasQuickFilters, quickFilterCount, type QuickFilters } from './filters';
import { useLookups } from '../../api/bootstrap';
import { useSpace } from '../../app/space';

export interface QuickFilterBarProps {
  value: QuickFilters;
  onChange: (next: QuickFilters) => void;
  refreshing?: boolean;
  selectMode: boolean;
  onSelectModeChange: (on: boolean) => void;
  /** Phones: the per-device list toggle (undefined hides it). */
  mobileList?: { value: boolean; onChange: (on: boolean) => void };
  className?: string;
}

const SEARCH_DEBOUNCE_MS = 300;

function summary(names: string[], fallback: string): string {
  if (names.length === 0) return fallback;
  if (names.length === 1) return names[0]!;
  return `${names[0]} +${names.length - 1}`;
}

export function QuickFilterBar({ value, onChange, refreshing, selectMode, onSelectModeChange, mobileList, className }: QuickFilterBarProps) {
  const lookups = useLookups();
  // Select mode is for bulk edits, which viewers cannot make (design §12.9).
  const { write } = useSpace().permissions;
  const tagOptions = useTagOptions();
  const priorityOptions = usePriorityOptions();
  const [text, setText] = useState(value.q);
  const latest = useRef(value);
  latest.current = value;

  // Follow external changes (back/forward, "Clear").
  useEffect(() => setText(value.q), [value.q]);
  useEffect(() => {
    if (text === latest.current.q) return;
    const id = window.setTimeout(() => onChange({ ...latest.current, q: text }), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [text, onChange]);

  const mobile = useIsMobile();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [searchFocused, setSearchFocused] = useState(false);
  // Phones: a query set or being typed gets the room; Filters shows only its icon / count.
  const searchInUse = text !== '' || searchFocused;
  const scroller = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => {
      // Without the fade's padding, so adding it can't keep it on by itself.
      const pad = parseFloat(getComputedStyle(el).paddingRight) || 0;
      setOverflowing(el.scrollWidth - pad > el.clientWidth - pad + 1);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    for (const child of el.children) ro.observe(child);
    return () => ro.disconnect();
  }, [mobile]);
  const active = hasQuickFilters(value);
  const count = quickFilterCount(value);
  const tagNames = value.tagIds.map((id) => lookups.tagById.get(id)?.name ?? '(deleted)');
  const prioNames = value.priorities.map((p) => PRIORITY_META[p].label);
  const chip = (on: boolean) => clsx(on && 'border-accent/60 bg-accent-soft text-fg hover:bg-accent-soft');

  return (
    <div className={clsx('flex min-w-0 items-center gap-2 py-2', className)}>
      <div
        ref={scroller}
        className={clsx(
          'no-scrollbar relative flex min-w-0 flex-1 items-center gap-2 overflow-x-auto',
          // Phones: fade the end only when something is cut off (e.g. while a search is typed).
          overflowing && 'max-md:pr-4 max-md:[mask-image:linear-gradient(to_right,#000_calc(100%-1.25rem),transparent)]',
        )}
      >
        {/* Phones: just the magnifier while empty (the quick filters stay in view), the whole
            row while typing, the query while set (shrinking to the room left by the buttons). */}
        <div
          onFocus={() => setSearchFocused(true)}
          onBlur={() => {
            setSearchFocused(false);
            // Typing may have scrolled the strip; show the query from its start again.
            if (scroller.current) scroller.current.scrollLeft = 0;
          }}
          className={clsx(
            'shrink-0 transition-[width] duration-150 max-md:focus-within:w-full md:w-56',
            text ? 'max-md:w-28 max-md:min-w-0 max-md:shrink' : 'max-md:w-10',
          )}
        >
          <Input
            size="sm"
            type="search"
            aria-label="Filter tasks on this board"
            placeholder="Filter…"
            value={text}
            maxLength={LIMITS.searchMax}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onChange({ ...value, q: text });
            }}
            leadingIcon={<Search />}
            // Collapsed (phones, empty, unfocused): room for the magnifier only. Set but unfocused
            // (phones): tighter padding and no room kept for the (then invisible) clear button, and
            // the active-filter look of the chips, so a query squeezed to a few letters still reads
            // as "filtering".
            inputClassName={
              text
                ? 'max-md:not-focus:pl-8 max-md:not-focus:pr-1.5 max-md:not-focus:[&::-webkit-search-cancel-button]:hidden max-md:not-focus:border-accent/60 max-md:not-focus:bg-accent-soft'
                : 'max-md:not-focus:pr-0 max-md:not-focus:placeholder:text-transparent'
            }
          />
        </div>
        {!mobile && (
          <>
            <Picker<number>
              multiple
              label="Tags"
              options={tagOptions}
              value={value.tagIds}
              onChange={(tagIds) => onChange({ ...value, tagIds })}
              emptyText="No tags yet"
              trigger={
                <Button
                  size="sm"
                  icon={<Tags />}
                  aria-label={tagNames.length > 0 ? `Tags: ${tagNames.join(', ')}` : undefined}
                  className={clsx('shrink-0', chip(value.tagIds.length > 0))}
                >
                  <span className="max-w-32 truncate">{summary(tagNames, 'Tags')}</span>
                </Button>
              }
            />
            <Picker<0 | 1 | 2 | 3 | 4>
              multiple
              label="Priority"
              options={priorityOptions}
              value={value.priorities}
              onChange={(priorities) => onChange({ ...value, priorities })}
              trigger={
                <Button
                  size="sm"
                  icon={<Flag />}
                  aria-label={prioNames.length > 0 ? `Priority: ${prioNames.join(', ')}` : undefined}
                  className={clsx('shrink-0', chip(value.priorities.length > 0))}
                >
                  <span className="max-w-32 truncate">{summary(prioNames, 'Priority')}</span>
                </Button>
              }
            />
            <Button
              size="sm"
              icon={<CheckCircle2 />}
              aria-pressed={value.hideClosed}
              onClick={() => onChange({ ...value, hideClosed: !value.hideClosed })}
              className={clsx('shrink-0', chip(value.hideClosed))}
            >
              Hide closed
            </Button>
            {active && (
              <Button size="sm" variant="ghost" icon={<X />} onClick={() => onChange(EMPTY_QUICK_FILTERS)} className="shrink-0">
                Clear
              </Button>
            )}
          </>
        )}
        {refreshing && <Spinner size="sm" label="Updating" className="shrink-0 text-fg-subtle" />}
      </div>
      {mobile && (
        <Button
          size="sm"
          // The active count takes the icon's place, so the button keeps its width.
          icon={
            count > 0 ? (
              <span aria-hidden className="-mx-0.5 flex size-5 items-center justify-center rounded-full bg-accent text-[11px] font-semibold text-accent-fg tabular-nums">
                {count}
              </span>
            ) : (
              <ListFilter />
            )
          }
          aria-label={count > 0 ? `Filters, ${count} active` : 'Filters'}
          aria-haspopup="dialog"
          aria-expanded={sheetOpen}
          // Pressed while the search has focus, the button must not move under the finger: the
          // blur would bring back the list toggle and Select before the click lands. So keep the
          // focus until the click, then take it (the sheet returns focus here when it closes).
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.currentTarget.focus();
            setSheetOpen(true);
          }}
          className={clsx(
            'shrink-0',
            chip(count > 0),
            // Icon (or count) only on narrow phones and while the search is in use.
            searchInUse ? 'max-md:w-10 max-md:gap-0 max-md:px-0' : 'max-[22rem]:w-10 max-[22rem]:gap-0 max-[22rem]:px-0',
          )}
        >
          <span className={searchInUse ? 'hidden' : 'max-[22rem]:hidden'}>Filters</span>
        </Button>
      )}
      {/* Typing on a phone: the list toggle and Select step aside (back once the search loses
          focus), so the search gets the row while Filters stays at hand. */}
      <div className={clsx(mobile && searchFocused ? 'hidden' : 'flex', 'shrink-0 items-center gap-1')}>
        {mobileList && (
          <IconButton
            size="sm"
            aria-label={mobileList.value ? 'Show as board on this device' : 'Show as list on this device'}
            icon={mobileList.value ? <Columns3 /> : <Rows3 />}
            pressed={mobileList.value}
            onClick={() => mobileList.onChange(!mobileList.value)}
          />
        )}
        {write && (
          <Button
            size="sm"
            variant={selectMode ? 'primary' : 'secondary'}
            icon={<ListChecks />}
            aria-pressed={selectMode}
            hideLabelOnMobile
            onClick={() => onSelectModeChange(!selectMode)}
          >
            Select
          </Button>
        )}
      </div>
      {mobile && (
        <QuickFilterSheet open={sheetOpen} onClose={() => setSheetOpen(false)} value={value} onChange={onChange} />
      )}
    </div>
  );
}

/** Phones: tags, priority and "hide closed" in one sheet; changes apply at once. */
function QuickFilterSheet({
  open,
  onClose,
  value,
  onChange,
}: {
  open: boolean;
  onClose: () => void;
  value: QuickFilters;
  onChange: (next: QuickFilters) => void;
}) {
  const tagOptions = useTagOptions();
  const priorityOptions = usePriorityOptions();
  const count = quickFilterCount(value);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Filters"
      bodyClassName="flex flex-col gap-4 px-4 pb-4 pt-1"
      footer={
        <div className="flex w-full gap-2">
          <Button
            icon={<X />}
            disabled={count === 0}
            onClick={() => onChange({ ...value, tagIds: [], priorities: [], hideClosed: false })}
            className="flex-1"
          >
            Clear
          </Button>
          <Button variant="primary" onClick={onClose} className="flex-1">
            Done
          </Button>
        </div>
      }
    >
      <Switch
        label="Hide closed tasks"
        checked={value.hideClosed}
        onCheckedChange={(hideClosed) => onChange({ ...value, hideClosed })}
      />
      <section aria-label="Priority" className="flex flex-col gap-1.5">
        <h3 className="text-[13px] font-medium text-fg-muted">Priority</h3>
        <div className="overflow-hidden rounded-lg border border-border bg-surface">
          <PickerList<0 | 1 | 2 | 3 | 4>
            multiple
            label="Priority"
            options={priorityOptions}
            value={value.priorities}
            onChange={(priorities) => onChange({ ...value, priorities })}
            searchable={false}
            autoFocus={false}
            touch
          />
        </div>
      </section>
      <section aria-label="Tags" className="flex flex-col gap-1.5">
        <h3 className="text-[13px] font-medium text-fg-muted">Tags</h3>
        <div className="flex max-h-80 min-h-40 flex-col overflow-hidden rounded-lg border border-border bg-surface">
          <PickerList<number>
            multiple
            label="Tags"
            options={tagOptions}
            value={value.tagIds}
            onChange={(tagIds) => onChange({ ...value, tagIds })}
            emptyText="No tags yet"
            autoFocus={false}
            touch
          />
        </div>
      </section>
    </Sheet>
  );
}
