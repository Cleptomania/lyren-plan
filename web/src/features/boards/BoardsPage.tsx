// /boards — global boards first (reorderable: drag the grip, or "Move up / down" in the row
// menu), then project boards grouped by project (they open on the project's Board tab).
// "New board" offers templates and an optional project. Viewers (design §12.9) only open boards.

import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { clsx } from 'clsx';
import { ArrowDown, ArrowUp, ExternalLink, GripVertical, Home, MoreHorizontal, Plus, SquareKanban, Star } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { GROUP_FIELD_LABELS, type BoardConfig } from '@shared/board';
import type { BoardDTO, ProjectDTO } from '@shared/types';
import { useLookups } from '../../api/bootstrap';
import { useSpaceId, useSpacePath } from '../../app/space';
import { Page } from '../../components/layout/Page';
import { PageHeader } from '../../components/layout/PageHeader';
import { Badge, Button, EmptyState, IconButton, Menu, type MenuItem } from '../../components/ui';
import { useDocumentTitle } from '../../lib/hooks';
import { boardHref, boardMenuItems, useBoardActions, type BoardActions } from './boardActions';
import { NewBoardDialog } from './NewBoardDialog';

/** "Status columns · Epic lanes · List" */
function configSummary(config: BoardConfig): string {
  const parts = [config.columns.groupBy === 'custom' ? `${config.columns.custom.length} custom columns` : `${GROUP_FIELD_LABELS[config.columns.groupBy]} columns`];
  if (config.layout === 'kanban' && config.swimlanes.groupBy !== 'none') {
    parts.push(config.swimlanes.groupBy === 'custom' ? 'custom lanes' : `${GROUP_FIELD_LABELS[config.swimlanes.groupBy].toLowerCase()} lanes`);
  }
  if (config.layout === 'list') parts.push('list');
  return parts.join(' · ');
}

function BoardRow({
  board,
  index,
  count,
  actions,
  onMove,
}: {
  board: BoardDTO;
  index: number;
  count: number;
  actions: BoardActions;
  onMove: (delta: -1 | 1) => void;
}) {
  const sid = useSpaceId();
  const navigate = useNavigate();
  const sortable = count > 1 && actions.permissions.write;
  const { setNodeRef, setActivatorNodeRef, listeners, attributes, transform, transition, isDragging } = useSortable({ id: board.id, disabled: !sortable });
  const href = boardHref(sid, board);
  const isDefault = actions.isDefault(board);
  const isHome = actions.isHome(board);
  const items: MenuItem[] = [
    { label: 'Open', icon: <ExternalLink />, onSelect: () => navigate(href) },
    ...(sortable
      ? [
          { label: 'Move up', icon: <ArrowUp />, disabled: index === 0, onSelect: () => onMove(-1) },
          { label: 'Move down', icon: <ArrowDown />, disabled: index === count - 1, onSelect: () => onMove(1) },
        ]
      : []),
    { separator: true },
    ...boardMenuItems(board, actions),
  ];
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={clsx('flex min-h-14 items-center gap-1 rounded-lg border border-border bg-surface pr-1.5 shadow-card', isDragging && 'relative z-10 shadow-drag')}
    >
      {sortable ? (
        <button
          type="button"
          ref={setActivatorNodeRef}
          {...listeners}
          {...attributes}
          aria-label={`Reorder ${board.name}`}
          className="flex w-10 shrink-0 cursor-grab touch-manipulation items-center justify-center self-stretch rounded-l-lg text-fg-subtle hover:bg-surface-2 hover:text-fg"
        >
          <GripVertical aria-hidden className="size-4" />
        </button>
      ) : (
        <span className="w-3 shrink-0" />
      )}
      <Link to={href} className="flex min-w-0 flex-1 items-center gap-3 self-stretch rounded-md py-2 pr-2">
        <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent">
          <SquareKanban className="size-4" />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium text-fg">{board.name}</span>
          <span className="block truncate text-xs text-fg-muted">{board.description || configSummary(board.config)}</span>
        </span>
      </Link>
      {isHome ? (
        <Badge variant="accent" size="sm" icon={<Home />} className="shrink-0">
          Home
        </Badge>
      ) : isDefault ? (
        <Badge variant="accent" size="sm" icon={<Star />} className="shrink-0">
          Default
        </Badge>
      ) : null}
      <Menu label={`${board.name} actions`} items={items} trigger={<IconButton aria-label={`${board.name} actions`} icon={<MoreHorizontal />} />} />
    </li>
  );
}

/** One reorderable scope (all global boards, or one project's boards). */
function BoardList({ boards, actions }: { boards: BoardDTO[]; actions: BoardActions }) {
  // Optimistic order while the reorder request is in flight.
  const [order, setOrder] = useState<number[] | null>(null);
  const idsKey = boards.map((b) => b.id).join(',');
  useEffect(() => setOrder(null), [idsKey]);
  const shown = useMemo(() => {
    if (!order) return boards;
    const byId = new Map(boards.map((b) => [b.id, b]));
    const list = order.map((id) => byId.get(id)).filter((b): b is BoardDTO => !!b);
    return list.length === boards.length ? list : boards;
  }, [boards, order]);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const commit = (ids: number[]) => {
    setOrder(ids);
    actions.reorder(ids);
  };
  const move = (id: number, delta: -1 | 1) => {
    const ids = shown.map((b) => b.id);
    const from = ids.indexOf(id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= ids.length) return;
    ids.splice(from, 1);
    ids.splice(to, 0, id);
    commit(ids);
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const ids = shown.map((b) => b.id);
    const from = ids.indexOf(Number(active.id));
    const to = ids.indexOf(Number(over.id));
    if (from < 0 || to < 0) return;
    ids.splice(from, 1);
    ids.splice(to, 0, Number(active.id));
    commit(ids);
  };
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={shown.map((b) => b.id)} strategy={verticalListSortingStrategy}>
        <ul className="flex flex-col gap-2">
          {shown.map((b, i) => (
            <BoardRow key={b.id} board={b} index={i} count={shown.length} actions={actions} onMove={(d) => move(b.id, d)} />
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  );
}

function ProjectHeading({ project }: { project: ProjectDTO }) {
  const sp = useSpacePath();
  return (
    <h3 className="mb-2 flex min-w-0 items-center gap-2 text-[13px] font-medium text-fg-muted">
      <span aria-hidden className="size-2.5 shrink-0 rounded-[3px]" style={{ backgroundColor: project.color }} />
      <Link to={sp(`/projects/${project.id}/board`)} className="truncate hover:text-fg hover:underline">
        {project.name}
      </Link>
      <span className="shrink-0 font-mono text-[11px] text-fg-subtle">{project.key}</span>
      {project.status === 'archived' && <Badge size="sm">Archived</Badge>}
    </h3>
  );
}

export default function BoardsPage() {
  useDocumentTitle('Boards');
  const lookups = useLookups();
  const actions = useBoardActions();
  const [newOpen, setNewOpen] = useState(false);
  const globalBoards = useMemo(() => lookups.boards.filter((b) => b.projectId === null), [lookups.boards]);
  const byProject = useMemo(
    () =>
      lookups.projects
        .map((project) => ({ project, boards: lookups.boards.filter((b) => b.projectId === project.id) }))
        .filter((g) => g.boards.length > 0),
    [lookups.projects, lookups.boards],
  );
  const empty = globalBoards.length === 0 && byProject.length === 0;
  const { write } = actions.permissions;

  return (
    <Page
      width="default"
      header={
        <PageHeader
          title="Boards"
          subtitle="Saved, configurable views over your tasks"
          icon={<SquareKanban />}
          actions={
            write && (
              <Button variant="primary" icon={<Plus />} hideLabelOnMobile onClick={() => setNewOpen(true)}>
                New board
              </Button>
            )
          }
        />
      }
    >
      {empty ? (
        <EmptyState
          icon={<SquareKanban />}
          title="No boards yet"
          body="Boards show tasks as columns — by status, priority, epic, due date or your own custom columns."
          action={
            write && (
              <Button variant="primary" icon={<Plus />} onClick={() => setNewOpen(true)}>
                New board
              </Button>
            )
          }
        />
      ) : (
        <div className="flex flex-col gap-8">
          <section aria-labelledby="boards-global" className="flex flex-col gap-2">
            <div>
              <h2 id="boards-global" className="text-sm font-semibold text-fg">
                Across projects
              </h2>
              <p className="text-xs text-fg-muted">{write ? 'Shown in the sidebar. Drag the handle or use the menu to reorder.' : 'Shown in the sidebar.'}</p>
            </div>
            {globalBoards.length > 0 ? (
              <BoardList boards={globalBoards} actions={actions} />
            ) : (
              <p className="rounded-lg border border-dashed border-border-strong px-4 py-5 text-center text-[13px] text-fg-muted">
                No boards across projects.{' '}
                {write && (
                  <button type="button" className="font-medium text-accent hover:underline" onClick={() => setNewOpen(true)}>
                    Create one
                  </button>
                )}
              </p>
            )}
          </section>
          <section aria-labelledby="boards-projects" className="flex flex-col gap-2">
            <div>
              <h2 id="boards-projects" className="text-sm font-semibold text-fg">
                Project boards
              </h2>
              <p className="text-xs text-fg-muted">They open on each project’s Board tab.</p>
            </div>
            {byProject.length > 0 ? (
              <div className="flex flex-col gap-5">
                {byProject.map(({ project, boards }) => (
                  <div key={project.id}>
                    <ProjectHeading project={project} />
                    <BoardList boards={boards} actions={actions} />
                  </div>
                ))}
              </div>
            ) : (
              <p className="rounded-lg border border-dashed border-border-strong px-4 py-5 text-center text-[13px] text-fg-muted">
                No project boards yet.{write && ' Every project has a Board tab — configuring it saves a board here.'}
              </p>
            )}
          </section>
        </div>
      )}
      {write && <NewBoardDialog open={newOpen} onClose={() => setNewOpen(false)} />}
    </Page>
  );
}
