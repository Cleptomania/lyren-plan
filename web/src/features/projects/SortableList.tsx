// Drag-to-reorder for desktop (mouse + keyboard via a grip handle). Touch devices get no
// handle: every sortable item also offers "Move up / Move down" menu items (SPEC §1, §8.3:
// long-press is reserved for scrolling here, so menus are the touch alternative).

import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  MouseSensor,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import {
  rectSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { clsx } from 'clsx';
import { GripVertical } from 'lucide-react';
import { useMemo, type CSSProperties, type HTMLAttributes, type ReactNode, type Ref } from 'react';
import { useIsMobile, useIsTouch } from '../../lib/hooks';

export interface SortableRenderProps {
  /** Ref callback + style for the item's root element. */
  ref: (element: HTMLElement | null) => void;
  style: CSSProperties;
  isDragging: boolean;
  /**
   * The grip button. A same-width spacer when this list has a single item (keeps rows aligned
   * with sortable lists), null on phones / touch devices or when sorting is disabled.
   */
  handle: ReactNode;
}

export interface SortableListProps<T> {
  items: readonly T[];
  getId: (item: T) => number;
  /** Name used in the handle's label and screen-reader announcements. */
  getLabel: (item: T) => string;
  /** Called with the dragged id and the id it was dropped on. */
  onMove: (activeId: number, overId: number) => void;
  renderItem: (item: T, sortable: SortableRenderProps) => ReactNode;
  layout?: 'vertical' | 'grid';
  disabled?: boolean;
  /** Plural noun for instructions ("milestones"). */
  noun: string;
}

const toId = (id: UniqueIdentifier) => Number(id);

export function SortableList<T>({
  items,
  getId,
  getLabel,
  onMove,
  renderItem,
  layout = 'vertical',
  disabled,
  noun,
}: SortableListProps<T>) {
  // Phones and touch devices reorder through the items' Move up / Move down menu entries.
  const touch = useIsTouch();
  const mobile = useIsMobile();
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const ids = useMemo(() => items.map(getId), [items, getId]);
  const labelOf = (id: UniqueIdentifier) => {
    const item = items.find((i) => getId(i) === toId(id));
    return item ? getLabel(item) : 'item';
  };
  const position = (id: UniqueIdentifier) => ids.indexOf(toId(id)) + 1;
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${labelOf(active.id)}, position ${position(active.id)} of ${ids.length}.`,
    onDragOver: ({ active, over }) =>
      over ? `${labelOf(active.id)} is over position ${position(over.id)} of ${ids.length}.` : `${labelOf(active.id)} is not over a position.`,
    onDragEnd: ({ active, over }) =>
      over ? `${labelOf(active.id)} dropped at position ${position(over.id)} of ${ids.length}.` : `${labelOf(active.id)} dropped.`,
    onDragCancel: ({ active }) => `Moving ${labelOf(active.id)} was cancelled.`,
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (over && active.id !== over.id) onMove(toId(active.id), toId(over.id));
  };
  const handlesShown = !disabled && !touch && !mobile;
  const sortingEnabled = handlesShown && items.length > 1;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={onDragEnd}
      accessibility={{
        announcements,
        screenReaderInstructions: {
          draggable: `To reorder ${noun}, press Space or Enter on the handle, use the arrow keys to move, then Space or Enter to drop. Escape cancels.`,
        },
      }}
    >
      <SortableContext items={ids} strategy={layout === 'grid' ? rectSortingStrategy : verticalListSortingStrategy} disabled={!sortingEnabled}>
        {items.map((item) => (
          <SortableItem key={getId(item)} id={getId(item)} label={getLabel(item)} enabled={sortingEnabled} spacer={handlesShown}>
            {(sortable) => renderItem(item, sortable)}
          </SortableItem>
        ))}
      </SortableContext>
    </DndContext>
  );
}

function SortableItem({
  id,
  label,
  enabled,
  spacer,
  children,
}: {
  id: number;
  label: string;
  enabled: boolean;
  /** Render an empty, handle-sized placeholder when not sortable. */
  spacer: boolean;
  children: (sortable: SortableRenderProps) => ReactNode;
}) {
  const { setNodeRef, setActivatorNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({
    id,
    disabled: !enabled,
  });
  const style: CSSProperties = {
    transform: CSS.Translate.toString(transform),
    transition,
    position: 'relative',
    zIndex: isDragging ? 10 : undefined,
  };
  const handle = enabled ? (
    <DragHandle ref={setActivatorNodeRef} label={`Reorder ${label}`} dragging={isDragging} {...attributes} {...listeners} />
  ) : spacer ? (
    <span aria-hidden className="-ml-1 block h-8 w-6 shrink-0" />
  ) : null;
  return <>{children({ ref: setNodeRef, style, isDragging, handle })}</>;
}

interface DragHandleProps extends HTMLAttributes<HTMLButtonElement> {
  ref: Ref<HTMLButtonElement>;
  label: string;
  dragging: boolean;
}

function DragHandle({ ref, label, dragging, className, ...rest }: DragHandleProps) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      {...rest}
      className={clsx(
        '-ml-1 flex h-8 w-6 shrink-0 cursor-grab items-center justify-center rounded text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg-muted',
        'focus-visible:outline-2 focus-visible:outline-offset-1',
        dragging && 'cursor-grabbing',
        className,
      )}
    >
      <GripVertical aria-hidden className="size-4" />
    </button>
  );
}
