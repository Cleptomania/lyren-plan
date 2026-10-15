// Sticky action bar of TaskList's selection mode: set status / priority / due date / epic,
// add or remove tags, archive and delete the selected tasks (one all-or-nothing request each;
// the menu items come from useBulkTaskActions, shared with a board's select mode).

import { CalendarDays, CircleDashed, ListChecks, MoreHorizontal, X } from 'lucide-react';
import { useLayoutEffect, useRef, type RefObject } from 'react';
import type { TaskDTO } from '@shared/types';
import { PriorityIcon } from '../../components/domain';
import { Button, IconButton, Menu, Spinner, type MenuItem } from '../../components/ui';
import { useBulkTaskActions } from './bulkActions';

export interface BulkActionBarProps {
  /** The selected tasks (as currently listed). */
  tasks: readonly TaskDTO[];
  /** Number of tasks listed (for "Select all"). */
  listedCount: number;
  onSelectAll: () => void;
  onClearSelection: () => void;
  /** Leave selection mode. */
  onExit: () => void;
}

// Toasts stack above the bar while it is mounted (index.css .toast-region adds
// --selection-bar-h), so the result of one bulk action never covers the next one's buttons.
const SELECTION_BAR_VAR = '--selection-bar-h';
/** Gap between the bar's top edge and the lowest toast. */
const TOAST_GAP_PX = 8;
const mountedBars = new Map<object, number>();

function publishBarHeights() {
  const root = document.documentElement;
  if (mountedBars.size === 0) root.style.removeProperty(SELECTION_BAR_VAR);
  else root.style.setProperty(SELECTION_BAR_VAR, `${Math.ceil(Math.max(...mountedBars.values())) + TOAST_GAP_PX}px`);
}

function usePublishedBarHeight(ref: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const key = {};
    const measure = () => {
      mountedBars.set(key, el.getBoundingClientRect().height);
      publishBarHeights();
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      ro.disconnect();
      mountedBars.delete(key);
      publishBarHeights();
    };
  }, [ref]);
}

export function BulkActionBar({ tasks, listedCount, onSelectAll, onClearSelection, onExit }: BulkActionBarProps) {
  const actions = useBulkTaskActions(tasks, { onDeleted: onClearSelection });
  const { busy, disabled, onMenuOpenChange } = actions;
  const count = tasks.length;
  const barRef = useRef<HTMLDivElement>(null);
  usePublishedBarHeight(barRef);

  const moreItems: MenuItem[] = [
    { label: `Select all (${listedCount})`, icon: <ListChecks />, disabled: count === listedCount, onSelect: onSelectAll },
    { label: 'Clear selection', icon: <X />, disabled: count === 0, onSelect: onClearSelection },
    { separator: true },
    actions.epicItem,
    ...actions.tagItems,
    { separator: true },
    ...actions.archiveItems,
    actions.deleteItem,
  ];

  return (
    <div
      role="region"
      aria-label="Bulk actions"
      className="sticky z-20 mt-1"
      style={{ bottom: 'calc(var(--bottom-bar-h) + var(--offline-h) + 0.75rem)' }}
    >
      <div ref={barRef} className="flex min-h-12 items-center gap-1 rounded-xl border border-border bg-popover px-1.5 py-1 shadow-pop">
        <IconButton aria-label="Exit selection" tooltip="Done (Esc)" icon={<X />} onClick={onExit} />
        <span className="flex min-w-0 items-center gap-2 pr-1 text-sm font-medium text-fg" aria-live="polite">
          {count === 0 ? (
            <span className="truncate">Select tasks</span>
          ) : (
            <span className="truncate">
              <span className="tabular-nums">{count}</span>
              <span className="max-[380px]:sr-only"> selected</span>
            </span>
          )}
          {busy && <Spinner size="sm" label="Saving" />}
        </span>
        <Button size="sm" variant="ghost" className="max-md:hidden" disabled={count === listedCount} onClick={onSelectAll}>
          Select all
        </Button>
        <div className="ml-auto flex shrink-0 items-center gap-0.5 md:gap-1">
          <Menu
            label="Set status"
            onOpenChange={onMenuOpenChange}
            items={actions.statusItems}
            placement="top-end"
            trigger={
              <Button size="sm" variant="ghost" hideLabelOnMobile disabled={disabled} icon={<CircleDashed />} aria-label="Set status">
                Status
              </Button>
            }
          />
          <Menu
            label="Set priority"
            onOpenChange={onMenuOpenChange}
            items={actions.priorityItems}
            placement="top-end"
            trigger={
              <Button size="sm" variant="ghost" hideLabelOnMobile disabled={disabled} icon={<PriorityIcon priority={3} label={null} />} aria-label="Set priority">
                Priority
              </Button>
            }
          />
          <Menu
            label="Set due date"
            onOpenChange={onMenuOpenChange}
            items={actions.dueItems}
            placement="top-end"
            trigger={
              <Button size="sm" variant="ghost" hideLabelOnMobile disabled={disabled} icon={<CalendarDays />} aria-label="Set due date">
                Due
              </Button>
            }
          />
          <Menu
            label="More bulk actions"
            onOpenChange={onMenuOpenChange}
            items={moreItems}
            placement="top-end"
            trigger={<IconButton aria-label="More bulk actions" tooltip="More" icon={<MoreHorizontal />} disabled={busy} />}
          />
        </div>
      </div>

      {actions.dialogs}
    </div>
  );
}
