// Kanban layouts (SPEC §8.3).
//  - Desktop without swimlanes: side-by-side columns (~18.5rem), each scrolling vertically.
//  - Desktop with swimlanes: one 2-D scroller; sticky column headers; lanes are collapsible
//    horizontal bands whose cells align with the columns.
//  - Phones: 85vw columns in a scroll-snap row with a sticky strip of column chips; swimlanes
//    become collapsible sections inside each column.
// Collapsed columns render as narrow vertical strips (name + count) and still accept drops.
// Every scroller here is `relative`: otherwise absolutely positioned descendants (sr-only
// labels) escape its clipping and make the page scroller around the board scrollable, which
// drag auto-scroll then scrolled sideways instead of the board.

import { clsx } from 'clsx';
import { ChevronDown, ChevronRight, MoreHorizontal, Plus } from 'lucide-react';
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { TaskDTO } from '@shared/types';
import { Button, IconButton } from '../../components/ui';
import { scrollBehavior } from '../../lib/motion';
import { useBoardDisplay, useBoardSelection, useBoardUi } from './boardUi';
import { CellSortable, SortableCard, useCellDragState, useCellDroppable, useIsDragging } from './dnd';
import { cardDndId, cellKey, cellPageSize, cellTasks, NO_LANE, type BoardGrid, type BoardGroup, type GroupField } from './grouping';
import { LazyMenu } from './LazyMenu';
import { GroupCount, GroupIcon, GroupLabel, InsertionLine } from './parts';

/** Cards rendered per cell before "Show N more" (SPEC §8.3 performance). */
export const CARD_PAGE = 50;

const COLUMN_W = 'w-[18.5rem]';

/**
 * Short viewports scroll the page chrome away (FULL_BLEED_MAIN): there a vertical scroll that
 * reaches the end of a card list chains to that outer scroller, so pulling down at the top of
 * a column brings the header back.
 */
export const CHAIN_ON_SHORT = '[@media(max-height:600px)]:overscroll-y-auto';

interface AxisFields {
  colField: GroupField;
  laneField: GroupField;
}

// ---------------------------------------------------------------------------
// Cell
// ---------------------------------------------------------------------------

interface KanbanCellProps {
  lane: string;
  col: string;
  tasks: readonly TaskDTO[];
  /** "Column" or "Lane · Column", for the add button. */
  label: string;
  /** Grow to fill the column (single-lane layouts). */
  fill?: boolean;
  /** Show a "+ Add task" row at the end. */
  showAdd?: boolean;
  /** Cards rendered before "Show N more" (default CARD_PAGE; boards with lanes share a budget, see cellPageSize). */
  pageSize?: number;
  className?: string;
}

export const KanbanCell = memo(function KanbanCell({ lane, col, tasks, label, fill, showAdd, pageSize = CARD_PAGE, className }: KanbanCellProps) {
  const ui = useBoardUi();
  const display = useBoardDisplay();
  const selection = useBoardSelection();
  const [extra, setExtra] = useState(0);
  const limit = pageSize + extra;
  const shown = tasks.length > limit ? tasks.slice(0, limit) : tasks;
  const ids = useMemo(() => shown.map((t) => cardDndId(lane, col, t.id)), [shown, lane, col]);
  const drag = useCellDragState(lane, col, display.manualSort);
  const { setNodeRef } = useCellDroppable(lane, col, shown.length);
  const menu = ui.menuFor(lane, col);
  const rest = tasks.length - shown.length;

  return (
    <div
      ref={setNodeRef}
      data-board-cell={cellKey(lane, col)}
      className={clsx(
        'flex flex-col gap-2 rounded-lg p-1.5 transition-[background-color,opacity,box-shadow] duration-150',
        fill ? 'min-h-full' : 'min-h-16',
        drag.dragging && !drag.canDrop && 'opacity-40',
        drag.isOver && drag.canDrop && 'bg-accent-soft ring-1 ring-accent/40',
        className,
      )}
    >
      <CellSortable ids={ids}>
        {shown.map((task, i) => (
          <Fragment key={task.id}>
            {drag.indicator === i && <InsertionLine />}
            <SortableCard
              task={task}
              lane={lane}
              col={col}
              index={i}
              fields={display.fields}
              density={display.density}
              colorBy={display.colorBy}
              onOpen={ui.openTask}
              extraMenuItems={menu}
              selected={selection.active && selection.ids.has(task.id)}
            />
          </Fragment>
        ))}
        {drag.indicator === shown.length && shown.length > 0 && <InsertionLine />}
      </CellSortable>
      {rest > 0 && (
        <Button size="sm" variant="ghost" fullWidth onClick={() => setExtra((n) => n + CARD_PAGE)}>
          Show {Math.min(CARD_PAGE, rest)} more
          <span className="text-fg-subtle">({rest} hidden)</span>
        </Button>
      )}
      {/* Hidden, not removed, while dragging: unmounting it shifted every lane below the
          source by its height, so drop targets jumped under the pointer. */}
      {showAdd && (
        <button
          type="button"
          onClick={() => ui.quickAdd(lane, col)}
          className={clsx(
            'flex h-10 shrink-0 items-center gap-1.5 rounded-md px-2 text-[13px] text-fg-subtle transition-colors hover:bg-surface-3 hover:text-fg md:h-8',
            drag.dragging && 'invisible',
          )}
        >
          <Plus aria-hidden className="size-4" />
          Add task<span className="sr-only"> to {label}</span>
        </button>
      )}
    </div>
  );
});

/** Collapsed column inside a lane band, or a whole collapsed column: a narrow drop strip. */
function CollapsedCell({ lane, group, count }: { lane: string; group: BoardGroup; count: number }) {
  const drag = useCellDragState(lane, group.key, false);
  const { setNodeRef } = useCellDroppable(lane, group.key, null);
  return (
    <div
      ref={setNodeRef}
      data-board-cell={cellKey(lane, group.key)}
      data-collapsed=""
      className={clsx(
        'flex w-10 shrink-0 justify-center rounded-lg py-2 text-xs tabular-nums text-fg-subtle',
        drag.dragging && !drag.canDrop && 'opacity-40',
        drag.isOver && drag.canDrop && 'bg-accent-soft ring-1 ring-accent/40',
      )}
    >
      {count > 0 ? count : ''}
      {count > 0 && <span className="sr-only"> tasks in {group.label}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

function ColumnHeader({ field, group, grid, dropLane }: { field: GroupField; group: BoardGroup; grid: BoardGrid; dropLane?: string }) {
  const ui = useBoardUi();
  // Single-lane layouts: dropping on the header moves the card without a position.
  const { setNodeRef } = useCellDroppable(dropLane ?? NO_LANE, group.key, null, `head:${dropLane ?? NO_LANE}|${group.key}`);
  return (
    <div ref={dropLane !== undefined ? setNodeRef : undefined} className="flex h-11 min-w-0 items-center gap-1.5 pl-2.5 pr-1 md:h-10">
      <GroupIcon field={field} group={group} />
      <h3 className="flex min-w-0 items-baseline gap-2 text-[13px]">
        <GroupLabel group={group} />
      </h3>
      <GroupCount count={group.count} wip={grid.wip.get(group.key)} />
      <span className="flex-1" />
      <IconButton size="sm" aria-label={`Add task to ${group.label}`} icon={<Plus />} onClick={() => ui.quickAdd(NO_LANE, group.key)} />
      <LazyMenu
        label={`${group.label} column`}
        build={() => ui.groupMenu('columns', group)}
        trigger={<IconButton size="sm" aria-label={`${group.label} column options`} icon={<MoreHorizontal />} />}
      />
    </div>
  );
}

/** A collapsed column: narrow vertical strip with the name and count; click to expand. */
function CollapsedColumn({ field, group, grid, lane, className }: { field: GroupField; group: BoardGroup; grid: BoardGrid; lane?: string; className?: string }) {
  const ui = useBoardUi();
  const drag = useCellDragState(lane ?? NO_LANE, group.key, false);
  const { setNodeRef } = useCellDroppable(lane ?? NO_LANE, group.key, null);
  const wip = grid.wip.get(group.key);
  return (
    <div
      ref={lane !== undefined ? setNodeRef : undefined}
      data-col-key={group.key}
      data-board-cell={lane !== undefined ? cellKey(lane, group.key) : undefined}
      data-collapsed=""
      className={clsx(
        'flex w-10 shrink-0 snap-start flex-col items-center rounded-xl border border-border/70 bg-surface-2',
        drag.dragging && !drag.canDrop && 'opacity-40',
        drag.isOver && drag.canDrop && 'ring-2 ring-accent/50',
        className,
      )}
    >
      <button
        type="button"
        aria-expanded={false}
        aria-label={`Expand ${group.label} (${group.count} ${group.count === 1 ? 'task' : 'tasks'})`}
        onClick={() => ui.toggleCollapsed('columns', group)}
        className="flex min-h-0 w-full flex-1 flex-col items-center gap-2 rounded-xl py-2.5 hover:bg-surface-3"
      >
        <GroupIcon field={field} group={group} />
        <GroupCount count={group.count} wip={wip} className="px-0" />
        <span className="min-h-0 overflow-hidden text-[13px] font-medium text-fg [writing-mode:vertical-rl]">
          <span className="truncate">{group.label}</span>
        </span>
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Desktop: columns only
// ---------------------------------------------------------------------------

function DesktopColumns({ grid, fields }: { grid: BoardGrid; fields: AxisFields }) {
  return (
    <div className="relative flex h-full gap-3 overflow-x-auto overscroll-x-contain px-4 pb-3 pt-3 scrollbar-thin md:px-6">
      {grid.visibleColumns.map((col) =>
        col.collapsed ? (
          <CollapsedColumn key={col.key} field={fields.colField} group={col} grid={grid} lane={NO_LANE} className="h-full" />
        ) : (
          <section
            key={col.key}
            aria-label={`${col.label} column`}
            className={clsx(COLUMN_W, 'flex h-full shrink-0 flex-col rounded-xl border border-border/70 bg-surface-2')}
          >
            <ColumnHeader field={fields.colField} group={col} grid={grid} dropLane={NO_LANE} />
            <div className={clsx('relative min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-1 pb-1 scrollbar-thin', CHAIN_ON_SHORT)}>
              <KanbanCell lane={NO_LANE} col={col.key} tasks={cellTasks(grid, NO_LANE, col.key)} label={col.label} fill />
            </div>
          </section>
        ),
      )}
      <div aria-hidden className="w-px shrink-0" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Desktop: swimlanes (2-D)
// ---------------------------------------------------------------------------

function LaneToggle({ field, lane }: { field: GroupField; lane: BoardGroup }) {
  const ui = useBoardUi();
  return (
    <button
      type="button"
      aria-expanded={!lane.collapsed}
      onClick={() => ui.toggleCollapsed('swimlanes', lane)}
      className="flex min-h-10 min-w-0 items-center gap-2 rounded-md px-1.5 text-left text-[13px] hover:bg-surface-2 md:min-h-8"
    >
      {lane.collapsed ? <ChevronRight aria-hidden className="size-4 shrink-0 text-fg-muted" /> : <ChevronDown aria-hidden className="size-4 shrink-0 text-fg-muted" />}
      <GroupIcon field={field} group={lane} />
      <GroupLabel group={lane} />
      <GroupCount count={lane.count} />
    </button>
  );
}

function LaneBand({ grid, lane, fields, pageSize }: { grid: BoardGrid; lane: BoardGroup; fields: AxisFields; pageSize: number }) {
  const ui = useBoardUi();
  return (
    <section aria-label={`${lane.label} lane`} className="border-b border-border">
      <div className="sticky left-0 z-[5] flex w-fit max-w-[100vw] items-center gap-1 bg-bg py-1 pl-3 pr-2 md:pl-5">
        <LaneToggle field={fields.laneField} lane={lane} />
        <LazyMenu
          label={`${lane.label} lane`}
          build={() => ui.groupMenu('swimlanes', lane)}
          trigger={<IconButton size="sm" aria-label={`${lane.label} lane options`} icon={<MoreHorizontal />} />}
        />
      </div>
      {!lane.collapsed && (
        <div className="flex gap-3 px-4 pb-3 md:px-6">
          {grid.visibleColumns.map((col) =>
            col.collapsed ? (
              <CollapsedCell key={col.key} lane={lane.key} group={col} count={cellTasks(grid, lane.key, col.key).length} />
            ) : (
              <div key={col.key} className={clsx(COLUMN_W, 'shrink-0 rounded-xl bg-surface-2')}>
                <KanbanCell
                  lane={lane.key}
                  col={col.key}
                  tasks={cellTasks(grid, lane.key, col.key)}
                  label={`${lane.label} · ${col.label}`}
                  showAdd
                  pageSize={pageSize}
                />
              </div>
            ),
          )}
        </div>
      )}
    </section>
  );
}

function DesktopLanes({ grid, fields }: { grid: BoardGrid; fields: AxisFields }) {
  const pageSize = useMemo(() => cellPageSize(grid, { page: CARD_PAGE }), [grid]);
  return (
    <div className={clsx('relative h-full overflow-auto overscroll-contain scrollbar-thin', CHAIN_ON_SHORT)}>
      <div className="flex w-max min-w-full flex-col pb-6">
        <div className="sticky top-0 z-10 flex gap-3 border-b border-border bg-bg px-4 pt-2 md:px-6">
          {grid.visibleColumns.map((col) =>
            col.collapsed ? (
              <CollapsedColumn key={col.key} field={fields.colField} group={col} grid={grid} className="mb-2 h-40" />
            ) : (
              <div key={col.key} className={clsx(COLUMN_W, 'shrink-0')}>
                <ColumnHeader field={fields.colField} group={col} grid={grid} />
              </div>
            ),
          )}
        </div>
        {grid.visibleLanes.map((lane) => (
          <LaneBand key={lane.key} grid={grid} lane={lane} fields={fields} pageSize={pageSize} />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phones
// ---------------------------------------------------------------------------

/**
 * An empty lane's one-row header on phones, which is also its drop target. (Expanding empty
 * lanes into full cells when a drag started pushed the dragged card down under the finger.)
 */
function CompactLaneRow({ lane, col, children }: { lane: string; col: string; children: ReactNode }) {
  const drag = useCellDragState(lane, col, false);
  const { setNodeRef } = useCellDroppable(lane, col, null);
  return (
    <div
      ref={setNodeRef}
      data-board-cell={cellKey(lane, col)}
      data-collapsed=""
      className={clsx(
        'flex items-center gap-1 rounded-lg px-1 py-0.5 transition-[background-color,opacity,box-shadow] duration-150',
        drag.dragging && !drag.canDrop && 'opacity-40',
        drag.isOver && drag.canDrop && 'bg-accent-soft ring-1 ring-accent/40',
      )}
    >
      {children}
    </div>
  );
}

function MobileLaneSection({
  grid,
  lane,
  col,
  fields,
  pageSize,
  light,
}: {
  grid: BoardGrid;
  lane: BoardGroup;
  col: BoardGroup;
  fields: AxisFields;
  pageSize: number;
  /** Off-screen column: lane header only, no cards (they mount once the column is near). */
  light: boolean;
}) {
  const ui = useBoardUi();
  const tasks = cellTasks(grid, lane.key, col.key);
  // Empty lanes stay one compact row (with "+"); that row takes drops.
  const compact = tasks.length === 0 && !lane.collapsed;
  const header = (
    <>
      <LaneToggle field={fields.laneField} lane={{ ...lane, count: tasks.length }} />
      <span className="flex-1" />
      {compact && (
        <IconButton size="sm" aria-label={`Add task to ${lane.label} · ${col.label}`} icon={<Plus />} onClick={() => ui.quickAdd(lane.key, col.key)} />
      )}
    </>
  );
  return (
    <section aria-label={`${lane.label} lane`} className="border-t border-border/70 first:border-t-0">
      {compact && !light ? (
        <CompactLaneRow lane={lane.key} col={col.key}>
          {header}
        </CompactLaneRow>
      ) : (
        <div className="flex items-center gap-1 px-1 py-0.5">{header}</div>
      )}
      {!lane.collapsed && !compact && !light && (
        <KanbanCell lane={lane.key} col={col.key} tasks={tasks} label={`${lane.label} · ${col.label}`} showAdd pageSize={pageSize} />
      )}
    </section>
  );
}

function MobileKanban({ grid, fields }: { grid: BoardGrid; fields: AxisFields }) {
  const scroller = useRef<HTMLDivElement>(null);
  const dragging = useIsDragging();
  const [current, setCurrent] = useState<string | null>(grid.visibleColumns[0]?.key ?? null);
  const columnsKey = grid.visibleColumns.map((c) => c.key).join(',');
  const pageSize = useMemo(() => cellPageSize(grid, { page: CARD_PAGE }), [grid]);
  // With swimlanes every column holds a section per lane: only the column in view and its
  // neighbours render cards (swiping reveals a neighbour that is already rendered).
  const currentIndex = Math.max(0, grid.visibleColumns.findIndex((c) => c.key === current));

  const syncCurrent = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const cols = [...el.querySelectorAll<HTMLElement>('[data-col-key]')];
    const left = el.scrollLeft + 24;
    let found = cols[0]?.dataset.colKey ?? null;
    for (const c of cols) if (c.offsetLeft <= left) found = c.dataset.colKey ?? found;
    setCurrent(found);
  }, []);

  useEffect(() => {
    syncCurrent();
  }, [columnsKey, syncCurrent]);

  const onScroll = useRef<number | null>(null);
  const handleScroll = () => {
    if (onScroll.current !== null) return;
    onScroll.current = requestAnimationFrame(() => {
      onScroll.current = null;
      syncCurrent();
    });
  };

  const jump = (key: string) => {
    const el = scroller.current?.querySelector<HTMLElement>(`[data-col-key="${CSS.escape(key)}"]`);
    if (!el || !scroller.current) return;
    scroller.current.scrollTo({ left: el.offsetLeft - 16, behavior: scrollBehavior() });
    setCurrent(key);
  };

  return (
    <div className="flex h-full flex-col">
      <nav aria-label="Columns" className="touch-scroll-x no-scrollbar relative flex shrink-0 gap-1.5 border-b border-border px-4 py-1.5">
        {grid.visibleColumns.map((col) => (
          <button
            key={col.key}
            type="button"
            aria-current={current === col.key ? 'true' : undefined}
            onClick={() => jump(col.key)}
            className={clsx(
              'flex h-10 max-w-48 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[13px] transition-colors',
              current === col.key ? 'border-accent bg-accent-soft text-fg' : 'border-border bg-surface text-fg-muted',
            )}
          >
            <GroupIcon field={fields.colField} group={col} className="[&_svg]:size-3.5" />
            <span className="truncate">{col.label}</span>
            <GroupCount count={col.count} wip={grid.wip.get(col.key)} className="px-0" />
          </button>
        ))}
      </nav>
      <div
        ref={scroller}
        onScroll={handleScroll}
        className={clsx(
          'relative flex min-h-0 flex-1 gap-3 overflow-x-auto overscroll-x-contain px-4 py-3 no-scrollbar',
          dragging ? 'snap-none' : 'snap-x snap-mandatory scroll-px-4',
        )}
      >
        {grid.visibleColumns.map((col, i) =>
          col.collapsed ? (
            <CollapsedColumn key={col.key} field={fields.colField} group={col} grid={grid} lane={grid.hasLanes ? undefined : NO_LANE} className="h-full" />
          ) : (
            <section
              key={col.key}
              data-col-key={col.key}
              aria-label={`${col.label} column`}
              className="flex h-full w-[85vw] max-w-[22rem] shrink-0 snap-start flex-col rounded-xl border border-border/70 bg-surface-2"
            >
              <ColumnHeader field={fields.colField} group={col} grid={grid} dropLane={grid.hasLanes ? undefined : NO_LANE} />
              {/* overscroll-y only: a horizontal swipe on the cards must chain to the column scroller. */}
              <div data-col-body="" className={clsx('relative min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-1 pb-[var(--fab-space)]', CHAIN_ON_SHORT)}>
                {grid.hasLanes ? (
                  grid.visibleLanes.map((lane) => (
                    <MobileLaneSection
                      key={lane.key}
                      grid={grid}
                      lane={lane}
                      col={col}
                      fields={fields}
                      pageSize={pageSize}
                      light={Math.abs(i - currentIndex) > 1}
                    />
                  ))
                ) : (
                  <KanbanCell lane={NO_LANE} col={col.key} tasks={cellTasks(grid, NO_LANE, col.key)} label={col.label} fill />
                )}
              </div>
            </section>
          ),
        )}
        <div aria-hidden className="w-1 shrink-0" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function KanbanBoard({ grid, mobile, colField, laneField }: { grid: BoardGrid; mobile: boolean } & AxisFields) {
  const fields = { colField, laneField };
  if (mobile) return <MobileKanban grid={grid} fields={fields} />;
  return grid.hasLanes ? <DesktopLanes grid={grid} fields={fields} /> : <DesktopColumns grid={grid} fields={fields} />;
}
