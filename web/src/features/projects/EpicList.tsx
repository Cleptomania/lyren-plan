// Epics of one group (a milestone, or "without milestone") with progress, inline status,
// menu and manual order. On the overview each epic expands to show its tasks.

import { clsx } from 'clsx';
import { ChevronRight, MoreHorizontal } from 'lucide-react';
import { useCallback, useId } from 'react';
import { Link, useNavigate } from 'react-router';
import type { EpicDTO, MilestoneDTO } from '@shared/types';
import { EpicDot } from '../../components/domain';
import { IconButton, Menu, toast } from '../../components/ui';
import { epicUrl } from '../../lib/taskLinks';
import { TaskList } from '../tasks/TaskList';
import { DateRange, InlineProgress } from './EntityMeta';
import { isEpicClosed, moveWithinSubset, reorderSubset } from './hierarchy';
import { epicMenuItems } from './hierarchyMenus';
import { LifecyclePicker } from './LifecycleStatus';
import { SortableList, type SortableRenderProps } from './SortableList';
import type { HierarchyDialogs } from './useHierarchyDialogs';
import { useReorder, useSaveEpic } from './useHierarchyMutations';

export interface EpicListProps {
  projectId: number;
  /** This group's epics in position order. */
  epics: readonly EpicDTO[];
  /** Every epic id of the project in position order (reorder sends the full set). */
  allEpicIds: readonly number[];
  /** The project's milestones (for "Milestone ▸"). */
  milestones: readonly MilestoneDTO[];
  dialogs: HierarchyDialogs;
  /** Expand rows to show the epic's tasks (overview). */
  expandable?: boolean;
  isExpanded?: (epicId: number) => boolean;
  onExpandedChange?: (epicId: number, expanded: boolean) => void;
  emptyText?: string;
}

const epicId = (e: EpicDTO) => e.id;
const epicName = (e: EpicDTO) => e.name;

export function EpicList({
  projectId,
  epics,
  allEpicIds,
  milestones,
  dialogs,
  expandable = false,
  isExpanded,
  onExpandedChange,
  emptyText = 'No epics yet.',
}: EpicListProps) {
  const navigate = useNavigate();
  const reorder = useReorder('epics');
  const save = useSaveEpic();
  const groupIds = epics.map(epicId);

  const apply = useCallback(
    (ids: number[] | null) => {
      if (ids) void reorder(ids);
    },
    [reorder],
  );

  if (epics.length === 0) return <p className="px-3 py-3 text-sm text-fg-muted md:px-4">{emptyText}</p>;

  return (
    <div className="flex flex-col">
      <SortableList
        items={epics}
        getId={epicId}
        getLabel={epicName}
        noun="epics"
        onMove={(activeId, overId) => apply(reorderSubset(allEpicIds, groupIds, activeId, overId))}
        renderItem={(epic, sortable) => (
          <EpicRow
            epic={epic}
            projectId={projectId}
            sortable={sortable}
            expandable={expandable}
            expanded={expandable && (isExpanded?.(epic.id) ?? false)}
            onExpandedChange={(open) => onExpandedChange?.(epic.id, open)}
            onStatus={(status) => void save(epic, { status })}
            menu={epicMenuItems(epic, {
              open: () => navigate(epicUrl(projectId, epic.id)),
              edit: () => dialogs.editEpic(epic),
              setStatus: (status) => void save(epic, { status }),
              milestones,
              setMilestone: (milestoneId) => {
                const target = milestones.find((m) => m.id === milestoneId);
                void save(epic, { milestoneId }).then((saved) => {
                  if (saved) toast.success(target ? `Moved “${epic.name}” to ${target.name}` : `Removed “${epic.name}” from its milestone`);
                });
              },
              move: {
                up: groupIds.indexOf(epic.id) > 0 ? () => apply(moveWithinSubset(allEpicIds, groupIds, epic.id, -1)) : null,
                down:
                  groupIds.indexOf(epic.id) < groupIds.length - 1
                    ? () => apply(moveWithinSubset(allEpicIds, groupIds, epic.id, 1))
                    : null,
              },
              remove: () => dialogs.deleteEpic(epic),
            })}
          />
        )}
      />
    </div>
  );
}

function EpicRow({
  epic,
  projectId,
  sortable,
  expandable,
  expanded,
  onExpandedChange,
  onStatus,
  menu,
}: {
  epic: EpicDTO;
  projectId: number;
  sortable: SortableRenderProps;
  expandable: boolean;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onStatus: (status: EpicDTO['status']) => void;
  menu: ReturnType<typeof epicMenuItems>;
}) {
  const panelId = useId();
  const closed = isEpicClosed(epic.status);
  const statusPicker = <LifecyclePicker kind="epic" value={epic.status} onChange={onStatus} subject={epic.name} />;
  return (
    <div
      ref={sortable.ref}
      style={sortable.style}
      className={clsx(
        'border-b border-border last:border-b-0',
        sortable.isDragging && 'rounded-md border-transparent bg-surface shadow-drag',
      )}
    >
      <div className="flex items-start gap-1 px-2 py-1.5 md:px-3">
        {sortable.handle && <div className="mt-1.5">{sortable.handle}</div>}
        {expandable && (
          <IconButton
            size="sm"
            aria-label={`${expanded ? 'Hide' : 'Show'} tasks of ${epic.name}`}
            aria-expanded={expanded}
            aria-controls={panelId}
            tooltip={false}
            onClick={() => onExpandedChange(!expanded)}
            icon={<ChevronRight className={clsx('transition-transform duration-150 motion-reduce:transition-none', expanded && 'rotate-90')} />}
          />
        )}
        <div className="min-w-0 flex-1 py-1.5">
          <div className="flex min-w-0 items-center gap-2">
            <EpicDot color={epic.color} />
            {/* Touch: a 40px tall target over the whole name line (padding cancelled by margins). */}
            <Link
              to={epicUrl(projectId, epic.id)}
              className={clsx(
                'min-w-0 truncate text-sm font-medium hover:underline pointer-coarse:-my-2.5 pointer-coarse:flex-1 pointer-coarse:py-2.5',
                closed ? 'text-fg-muted' : 'text-fg',
              )}
            >
              <span className="sr-only">Epic </span>
              {epic.name}
            </Link>
          </div>
          {/* Touch: room for the name's 40px target above the status picker's own (it is on this line below md). */}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-fg-muted pointer-coarse:mt-2.5 max-md:pointer-coarse:mt-4.5">
            {/* Phones: the status sits in the meta line so the name keeps the full width. */}
            <span className="md:hidden">{statusPicker}</span>
            <InlineProgress stats={epic.stats} label={`${epic.name} progress`} color={epic.color} />
            <DateRange start={epic.startDate} due={epic.dueDate} closed={closed} />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5 pt-1.5">
          <span className="hidden md:inline-flex">{statusPicker}</span>
          <Menu
            label={epic.name}
            items={menu}
            trigger={<IconButton size="sm" aria-label={`Actions for ${epic.name}`} icon={<MoreHorizontal />} tooltip={false} className="-my-1" />}
          />
        </div>
      </div>
      {expandable && (
        <div id={panelId} hidden={!expanded} className="pb-3 pl-3 pr-2 md:pl-12 md:pr-3">
          {expanded && (
            <TaskList
              filter={{ projectIds: [projectId], epicIds: [epic.id] }}
              toolbar={false}
              createDefaults={{ projectId, epicId: epic.id }}
              hide={['project', 'epic', 'milestone']}
              emptyMessage="No tasks in this epic yet."
            />
          )}
        </div>
      )}
    </div>
  );
}
