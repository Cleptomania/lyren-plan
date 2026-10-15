// Grouped-list layout (SPEC §8.3): one collapsible section per column group (same order,
// hidden / collapsed / showEmpty / showNone and WIP badge as kanban), rows show `card.fields`
// inline (domain TaskRow). Swimlanes are ignored; dragging rows between sections applies the
// column patch only.

import { clsx } from 'clsx';
import { ChevronDown, ChevronRight, MoreHorizontal, Plus } from 'lucide-react';
import { Fragment, memo, useMemo, useState } from 'react';
import type { TaskDTO } from '@shared/types';
import { Button, IconButton } from '../../components/ui';
import { useBoardDisplay, useBoardSelection, useBoardUi } from './boardUi';
import { CellSortable, SortableRow, useCellDragState, useCellDroppable } from './dnd';
import { cardDndId, cellKey, cellTasks, NO_LANE, type BoardGrid, type BoardGroup, type GroupField } from './grouping';
import { CARD_PAGE, CHAIN_ON_SHORT } from './Kanban';
import { LazyMenu } from './LazyMenu';
import { GroupCount, GroupIcon, GroupLabel } from './parts';

function RowInsertionLine() {
  return (
    <div aria-hidden className="pointer-events-none relative h-0">
      <div className="absolute inset-x-1 -top-[2px] z-[1] h-[3px] rounded-full bg-accent" />
    </div>
  );
}

const ListSection = memo(function ListSection({ field, group, tasks, grid }: { field: GroupField; group: BoardGroup; tasks: readonly TaskDTO[]; grid: BoardGrid }) {
  const ui = useBoardUi();
  const display = useBoardDisplay();
  const selection = useBoardSelection();
  const [limit, setLimit] = useState(CARD_PAGE);
  const shown = tasks.length > limit ? tasks.slice(0, limit) : tasks;
  const ids = useMemo(() => shown.map((t) => cardDndId(NO_LANE, group.key, t.id)), [shown, group.key]);
  const drag = useCellDragState(NO_LANE, group.key, display.manualSort);
  const body = useCellDroppable(NO_LANE, group.key, shown.length);
  const head = useCellDroppable(NO_LANE, group.key, null, `head:${NO_LANE}|${group.key}`);
  const menu = ui.menuFor(NO_LANE, group.key);
  const rest = tasks.length - shown.length;
  const headingId = `board-list-${group.key}`;

  return (
    <section
      aria-labelledby={headingId}
      className={clsx(
        'rounded-xl border border-border bg-surface transition-opacity duration-150',
        drag.dragging && !drag.canDrop && 'opacity-40',
        drag.isOver && drag.canDrop && 'ring-2 ring-accent/40',
      )}
    >
      <div ref={head.setNodeRef} className={clsx('flex min-h-11 items-center gap-1 pl-1 pr-1.5', !group.collapsed && 'border-b border-border')}>
        <button
          type="button"
          aria-expanded={!group.collapsed}
          onClick={() => ui.toggleCollapsed('columns', group)}
          className="flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 text-left text-[13px] hover:bg-surface-2 md:min-h-8"
        >
          {group.collapsed ? (
            <ChevronRight aria-hidden className="size-4 shrink-0 text-fg-muted" />
          ) : (
            <ChevronDown aria-hidden className="size-4 shrink-0 text-fg-muted" />
          )}
          <GroupIcon field={field} group={group} />
          <h3 id={headingId} className="min-w-0">
            <GroupLabel group={group} />
          </h3>
          <GroupCount count={group.count} wip={grid.wip.get(group.key)} />
        </button>
        <IconButton size="sm" aria-label={`Add task to ${group.label}`} icon={<Plus />} onClick={() => ui.quickAdd(NO_LANE, group.key)} />
        <LazyMenu
          label={`${group.label} group`}
          build={() => ui.groupMenu('columns', group)}
          trigger={<IconButton size="sm" aria-label={`${group.label} group options`} icon={<MoreHorizontal />} />}
        />
      </div>
      {!group.collapsed && (
        <div ref={body.setNodeRef} data-board-cell={cellKey(NO_LANE, group.key)} className="flex min-h-12 flex-col pb-1">
          <CellSortable ids={ids}>
            {shown.map((task, i) => (
              <Fragment key={task.id}>
                {drag.indicator === i && <RowInsertionLine />}
                <SortableRow
                  task={task}
                  lane={NO_LANE}
                  col={group.key}
                  index={i}
                  fields={display.fields}
                  onOpen={ui.openTask}
                  extraMenuItems={menu}
                  selectable={selection.active}
                  selected={selection.active && selection.ids.has(task.id)}
                  onSelectedChange={selection.active ? ui.toggleSelected : undefined}
                />
              </Fragment>
            ))}
            {drag.indicator === shown.length && shown.length > 0 && <RowInsertionLine />}
          </CellSortable>
          {shown.length === 0 && <p className="px-4 py-3 text-[13px] text-fg-subtle">No tasks</p>}
          {rest > 0 && (
            <div className="px-2 pt-1">
              <Button size="sm" variant="ghost" fullWidth onClick={() => setLimit((n) => n + CARD_PAGE)}>
                Show {Math.min(CARD_PAGE, rest)} more <span className="text-fg-subtle">({rest} hidden)</span>
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  );
});

export function ListLayout({ grid, colField }: { grid: BoardGrid; colField: GroupField }) {
  return (
    <div className={clsx('relative h-full overflow-y-auto overscroll-contain scrollbar-thin', CHAIN_ON_SHORT)}>
      <div className="mx-auto flex max-w-6xl flex-col gap-3 px-3 pb-[calc(var(--fab-space)+1rem)] pt-3 md:px-6">
        {grid.visibleColumns.map((group) => (
          <ListSection key={group.key} field={colField} group={group} tasks={cellTasks(grid, NO_LANE, group.key)} grid={grid} />
        ))}
      </div>
    </div>
  );
}
