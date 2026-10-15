// A board: notices ("Showing N of M", "N tasks in hidden groups"), loading / error / empty
// states, drag & drop, the kanban or list layout and the select-mode bulk action bar.
// Used by BoardPage (/boards/:id) and ProjectBoardPage (project Board tab).

import { clsx } from 'clsx';
import { CalendarDays, CircleDashed, EyeOff, Info, MoreHorizontal, SearchX, SlidersHorizontal, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { BoardConfig } from '@shared/board';
import type { TaskDTO } from '@shared/types';
import { PriorityIcon } from '../../components/domain';
import { Button, EmptyState, ErrorState, Menu, Skeleton, type MenuItemInput } from '../../components/ui';
import { pluralize } from '../../lib/format';
import { useOverlay } from '../../lib/overlays';
import { useBulkTaskActions } from '../tasks/bulkActions';
import { BoardUiProvider, type BoardSelection, type ConfigSection } from './boardUi';
import { BoardDnd } from './dnd';
import { hiddenGroupsAxis } from './grouping';
import { KanbanBoard } from './Kanban';
import { ListLayout } from './ListLayout';
import type { ConfigUpdate } from './useBoardConfig';
import type { BoardModel } from './useBoardModel';

export interface BoardViewProps {
  config: BoardConfig;
  setConfig: (update: ConfigUpdate) => void;
  model: BoardModel;
  /** Project board scope (quick-add defaults). */
  projectId: number | null;
  /** Phone layout (< md). */
  mobile: boolean;
  quickFiltersActive: boolean;
  onClearQuickFilters: () => void;
  onConfigure: (section?: ConfigSection) => void;
  selectMode: boolean;
  onSelectModeChange: (on: boolean) => void;
}

function BoardSkeleton({ mobile }: { mobile: boolean }) {
  return (
    <div className="flex h-full gap-3 overflow-hidden px-4 pt-3 md:px-6" aria-busy="true" aria-label="Loading board">
      {Array.from({ length: mobile ? 1 : 4 }, (_, i) => (
        <div key={i} className="flex h-full w-[85vw] max-w-[22rem] shrink-0 flex-col gap-2 rounded-xl border border-border/70 bg-surface-2 p-2 md:w-[18.5rem]">
          <Skeleton className="mb-1 h-6 w-32" />
          {Array.from({ length: 4 - (i % 2) }, (_, j) => (
            <Skeleton key={j} className="h-20 w-full rounded-lg" />
          ))}
        </div>
      ))}
    </div>
  );
}

function Notice({ icon, children, action }: { icon: ReactNode; children: ReactNode; action?: ReactNode }) {
  return (
    <div role="status" className="flex min-h-9 items-center gap-2 border-b border-border bg-surface px-4 py-1 text-[13px] text-fg-muted md:px-6">
      <span aria-hidden className="shrink-0 [&_svg]:size-4">
        {icon}
      </span>
      <span className="min-w-0 flex-1">{children}</span>
      {action}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Select mode
// ---------------------------------------------------------------------------

function SelectionBar({ ids, tasks, onClear, onDone }: { ids: ReadonlySet<number>; tasks: TaskDTO[]; onClear: () => void; onDone: () => void }) {
  const selected = useMemo(() => tasks.filter((t) => ids.has(t.id)), [tasks, ids]);
  const count = ids.size;
  // The same items as the task lists' bulk bar (features/tasks/bulkActions.tsx).
  const actions = useBulkTaskActions(selected, { onDeleted: onClear });
  const items: MenuItemInput[] = [
    { label: 'Status', icon: <CircleDashed />, items: actions.statusItems },
    { label: 'Priority', icon: <PriorityIcon priority={3} label={null} />, items: actions.priorityItems },
    { label: 'Due date', icon: <CalendarDays />, items: actions.dueItems },
    actions.epicItem,
    ...actions.tagItems,
    { separator: true },
    ...actions.archiveItems,
    actions.deleteItem,
  ];

  return (
    <div role="region" aria-label="Selection" className="flex min-h-12 items-center gap-2 border-b border-border bg-accent-soft px-4 py-1.5 md:px-6">
      {/* Narrow phones (like the task lists' bulk bar): "2", an icon-only Actions button. */}
      <span className="flex min-w-0 text-[13px] font-medium text-fg" aria-live="polite">
        {count === 0 ? (
          <span className="truncate">Select tasks</span>
        ) : (
          <span className="truncate">
            <span className="tabular-nums">{count}</span>
            <span className="max-[22rem]:sr-only"> selected</span>
          </span>
        )}
      </span>
      {count > 0 && (
        <Button size="sm" variant="ghost" onClick={onClear} aria-label="Clear selection">
          Clear
        </Button>
      )}
      <span className="flex-1" />
      <Menu
        label="Selected tasks"
        items={items}
        onOpenChange={actions.onMenuOpenChange}
        trigger={
          <Button
            size="sm"
            icon={<MoreHorizontal />}
            loading={actions.busy}
            disabled={count === 0}
            aria-label="Actions"
            className="max-[22rem]:w-10 max-[22rem]:gap-0 max-[22rem]:px-0"
          >
            <span className="max-[22rem]:hidden">Actions</span>
          </Button>
        }
      />
      <Button size="sm" variant="primary" onClick={onDone}>
        Done
      </Button>
      {actions.dialogs}
    </div>
  );
}

// ---------------------------------------------------------------------------

export function BoardView({
  config,
  setConfig,
  model,
  projectId,
  mobile,
  quickFiltersActive,
  onClearQuickFilters,
  onConfigure,
  selectMode,
  onSelectModeChange,
}: BoardViewProps) {
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<number>>(() => new Set());
  useEffect(() => {
    if (!selectMode) setSelectedIds(new Set());
  }, [selectMode]);
  // Like TaskList's selection: Esc leaves select mode and single-key hotkeys pause meanwhile.
  useOverlay(selectMode, () => onSelectModeChange(false));
  // Drop ids that left the board.
  useEffect(() => {
    setSelectedIds((cur) => {
      if (cur.size === 0) return cur;
      const present = new Set(model.tasks.map((t) => t.id));
      const next = new Set([...cur].filter((id) => present.has(id)));
      return next.size === cur.size ? cur : next;
    });
  }, [model.tasks]);

  const selection = useMemo<BoardSelection>(() => ({ active: selectMode, ids: selectedIds }), [selectMode, selectedIds]);
  const onToggleSelected = useCallback((task: TaskDTO, on: boolean) => {
    setSelectedIds((cur) => {
      const next = new Set(cur);
      if (on) next.add(task.id);
      else next.delete(task.id);
      return next;
    });
  }, []);

  const { grid, layout } = model;
  const configure = useCallback((section?: ConfigSection) => onConfigure(section), [onConfigure]);

  let body: ReactNode;
  if (model.loading) body = <BoardSkeleton mobile={mobile} />;
  else if (model.error) {
    body = (
      <div className="flex h-full items-center justify-center p-6">
        <ErrorState error={model.error} onRetry={model.refetch} title="Could not load this board" />
      </div>
    );
  } else if (grid.visibleColumns.length === 0) {
    body = (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState
          icon={quickFiltersActive ? <SearchX /> : <EyeOff />}
          title={grid.total === 0 ? 'No tasks match this board' : 'Every group is hidden'}
          body={
            grid.total === 0
              ? quickFiltersActive
                ? 'Nothing matches the quick filters.'
                : 'Empty groups are hidden. Show them, or change the board’s filter.'
              : `${pluralize(grid.hiddenTaskCount, 'task')} ${grid.hiddenTaskCount === 1 ? 'is' : 'are'} in hidden groups.`
          }
          action={
            quickFiltersActive && grid.total === 0 ? (
              <Button onClick={onClearQuickFilters} icon={<X />}>
                Clear quick filters
              </Button>
            ) : (
              <Button onClick={() => configure('columns')} icon={<SlidersHorizontal />}>
                Configure columns
              </Button>
            )
          }
        />
      </div>
    );
  } else {
    body = (
      <BoardDnd config={config} model={model}>
        {layout === 'list' ? (
          <ListLayout grid={grid} colField={config.columns.groupBy} />
        ) : (
          <KanbanBoard grid={grid} mobile={mobile} colField={config.columns.groupBy} laneField={config.swimlanes.groupBy} />
        )}
      </BoardDnd>
    );
  }

  const showNotices = !model.loading && !model.error;
  return (
    <BoardUiProvider
      config={config}
      setConfig={setConfig}
      model={model}
      projectId={projectId}
      selection={selection}
      onToggleSelected={onToggleSelected}
      onConfigure={configure}
    >
      <div className="flex h-full min-h-0 flex-col">
        {selectMode && (
          <SelectionBar ids={selectedIds} tasks={model.tasks} onClear={() => setSelectedIds(new Set())} onDone={() => onSelectModeChange(false)} />
        )}
        {showNotices && model.truncatedTotal !== null && (
          <Notice icon={<Info />}>
            Showing {model.tasks.length.toLocaleString()} of {model.truncatedTotal.toLocaleString()} tasks — narrow the filter.
          </Notice>
        )}
        {showNotices && model.filters.local && model.truncatedTotal !== null && (
          <Notice icon={<Info />}>Some matching tasks may be missing because the result was truncated.</Notice>
        )}
        {showNotices && grid.hiddenTaskCount > 0 && grid.visibleColumns.length > 0 && (
          <Notice
            icon={<EyeOff />}
            action={
              <Button size="sm" variant="ghost" onClick={() => configure(hiddenGroupsAxis(grid) === 'swimlanes' ? 'lanes' : 'columns')}>
                Show
              </Button>
            }
          >
            {pluralize(grid.hiddenTaskCount, 'task')} in hidden groups
          </Notice>
        )}
        {showNotices && quickFiltersActive && grid.total === 0 && grid.visibleColumns.length > 0 && (
          <Notice
            icon={<SearchX />}
            action={
              <Button size="sm" variant="ghost" onClick={onClearQuickFilters}>
                Clear filters
              </Button>
            }
          >
            No tasks match the quick filters.
          </Notice>
        )}
        {/* The board area (dnd.tsx BOARD_AREA_ATTR): a drag released outside it is cancelled. */}
        <div data-board-area="" className={clsx('relative min-h-0 flex-1', model.refreshing && 'opacity-80 transition-opacity')}>
          {body}
        </div>
      </div>
    </BoardUiProvider>
  );
}
