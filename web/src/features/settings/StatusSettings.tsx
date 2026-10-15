// Settings → Statuses: the task workflow. Statuses are shown grouped by category; within a
// category they can be reordered by drag (dnd-kit handle; mouse, touch and keyboard) or with
// the up/down buttons. Name, color and category edit inline (optimistic). Deleting a status
// that tasks use asks where to move them (DELETE ?reassignTo=).

import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type Announcements,
  type CollisionDetection,
  type DragEndEvent,
  type Modifier,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { ArrowDown, ArrowUp, GripVertical, Plus, Trash2 } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import {
  COLOR_PALETTE,
  DEFAULT_STATUS_COLOR,
  isClosedCategory,
  LIMITS,
  STATUS_CATEGORIES,
  STATUS_CATEGORY_META,
  type StatusCategory,
} from '@shared/constants';
import { statusCreateInput } from '@shared/schemas';
import type { StatusDTO } from '@shared/types';
import { useCreateStatus, useDeleteStatus, useReorderStatuses, useUpdateStatus } from '../../api/admin';
import { useLookups } from '../../api/bootstrap';
import { ApiError } from '../../api/client';
import { qk } from '../../api/keys';
import { StatusIcon } from '../../components/domain';
import {
  Button,
  ColorPicker,
  Dialog,
  Field,
  IconButton,
  InlineEdit,
  Input,
  Select,
  apiFieldErrors,
  toast,
  useConfirm,
  zodFieldErrors,
  type FieldErrors,
} from '../../components/ui';
import { pluralize } from '../../lib/format';
import { ColorButton } from './ColorButton';
import { SettingsPage } from './SettingsBlocks';
import {
  displayOrder,
  groupStatuses,
  orderAfterMove,
  orderAfterStep,
  storedOrder,
  suggestedReassignTarget,
  withPositions,
  type StatusGroup,
} from './statusOrder';
import { useOptimisticBootstrap } from './useOptimisticBootstrap';

const CATEGORY_OPTIONS = STATUS_CATEGORIES.map((c) => ({ value: c, label: STATUS_CATEGORY_META[c].label }));

const sameIds = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((id, i) => id === b[i]);

/** Which way the closed state of tasks flips when they move from one category to another. */
function closedFlip(from: StatusCategory, to: StatusCategory): 'close' | 'reopen' | null {
  const a = isClosedCategory(from);
  const b = isClosedCategory(to);
  return a === b ? null : b ? 'close' : 'reopen';
}

// ---------------------------------------------------------------------------
// Mutations (optimistic through the bootstrap cache)
// ---------------------------------------------------------------------------

function useStatusActions() {
  const { statuses } = useLookups();
  const optimistic = useOptimisticBootstrap();
  const update = useUpdateStatus();
  const reorder = useReorderStatuses();
  const confirm = useConfirm();

  const patch = async (status: StatusDTO, input: { name?: string; color?: string }) => {
    const rollback = await optimistic((b) => ({
      ...b,
      statuses: b.statuses.map((s) => (s.id === status.id ? { ...s, ...input } : s)),
    }));
    update.mutate(
      { id: status.id, ...input },
      {
        onError: (err) => {
          rollback();
          toast.error(err);
        },
      },
    );
  };

  const applyOrder = async (ids: number[]) => {
    const rollback = await optimistic((b) => ({ ...b, statuses: withPositions(b.statuses, ids) }));
    reorder.mutate(ids, {
      onError: (err) => {
        rollback();
        toast.error(err);
      },
    });
  };

  const changeCategory = async (status: StatusDTO, category: StatusCategory) => {
    if (category === status.category) return;
    const flip = closedFlip(status.category, category);
    if (flip && status.taskCount > 0) {
      const label = STATUS_CATEGORY_META[category].label;
      const ok = await confirm({
        title: `Move “${status.name}” to ${label}?`,
        body:
          flip === 'close'
            ? `Its ${pluralize(status.taskCount, 'task')} will count as closed (completed today unless already completed).`
            : `Its ${pluralize(status.taskCount, 'task')} will be reopened.`,
        confirmLabel: `Move to ${label}`,
      });
      if (!ok) return;
    }
    // Keep the stored order equal to the grouped order the page shows (board columns use it).
    const next = statuses.map((s) => (s.id === status.id ? { ...s, category } : s));
    const order = displayOrder(next);
    const normalize = !sameIds(order, storedOrder(next));
    const rollback = await optimistic((b) => {
      const moved = b.statuses.map((s) => (s.id === status.id ? { ...s, category } : s));
      return { ...b, statuses: normalize ? withPositions(moved, order) : moved };
    });
    try {
      await update.mutateAsync({ id: status.id, category });
      if (normalize) await reorder.mutateAsync(order);
    } catch (err) {
      rollback();
      toast.error(err);
    }
  };

  return { patch, applyOrder, changeCategory };
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

interface StatusItemProps {
  status: StatusDTO;
  index: number;
  groupSize: number;
  isOnly: boolean;
  onRename: (name: string) => void;
  onColor: (color: string) => void;
  onCategory: (category: StatusCategory) => void;
  onStep: (delta: -1 | 1) => void;
  onDelete: () => void;
}

function StatusItem({ status, index, groupSize, isOnly, onRename, onColor, onCategory, onStep, onDelete }: StatusItemProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: status.id,
    data: { category: status.category },
  });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={clsx(
        // One line from lg: between md and lg (iPad portrait, phones in landscape) the sidebar and
        // settings nav leave too little room and the name was squeezed to one letter per line.
        'flex min-w-0 flex-wrap items-center gap-x-1 gap-y-1 px-2 py-2 lg:flex-nowrap lg:gap-x-2 lg:py-1.5',
        isDragging && 'relative z-10 rounded-md bg-surface shadow-drag',
      )}
    >
      <button
        ref={setActivatorNodeRef}
        type="button"
        {...attributes}
        {...listeners}
        aria-label={`Reorder ${status.name}`}
        className="flex size-10 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-fg-subtle hover:bg-surface-2 hover:text-fg-muted active:cursor-grabbing md:size-8"
      >
        <GripVertical aria-hidden className="size-4" />
      </button>
      <ColorButton
        value={status.color}
        onChange={onColor}
        label={`Color of “${status.name}”`}
        preview={(color) => <StatusIcon status={{ ...status, color }} label={null} />}
      />
      <div className="min-w-0 flex-1">
        <InlineEdit
          value={status.name}
          onSave={onRename}
          aria-label={`Name of status “${status.name}”`}
          maxLength={LIMITS.statusNameMax}
          className="text-sm font-medium text-fg"
        />
      </div>
      {/* Second line on phones: category, count and the step buttons. */}
      {/* No indent on phones: at 360px it left ~35px for the count ("4 ta…"). */}
      <div className="order-last flex w-full min-w-0 items-center gap-1 lg:order-none lg:w-auto lg:gap-2">
        {/* The kit Select is full width; this wrapper sets its size. */}
        <div className="w-36 shrink-0">
          <Select
            size="sm"
            aria-label={`Category of “${status.name}”`}
            value={status.category}
            onChange={(e) => onCategory(e.target.value as StatusCategory)}
            options={CATEGORY_OPTIONS}
          />
        </div>
        <span className="min-w-0 flex-1 truncate px-1 text-xs tabular-nums text-fg-muted lg:w-16 lg:flex-none lg:text-right">
          {pluralize(status.taskCount, 'task')}
        </span>
        <IconButton aria-label={`Move “${status.name}” up`} icon={<ArrowUp />} size="sm" disabled={index === 0} onClick={() => onStep(-1)} />
        <IconButton
          aria-label={`Move “${status.name}” down`}
          icon={<ArrowDown />}
          size="sm"
          disabled={index === groupSize - 1}
          onClick={() => onStep(1)}
        />
      </div>
      <IconButton
        aria-label={`Delete “${status.name}”`}
        tooltip={isOnly ? 'At least one status is required' : `Delete “${status.name}”`}
        icon={<Trash2 />}
        size="sm"
        disabled={isOnly}
        onClick={onDelete}
        className="text-fg-muted hover:text-danger"
      />
    </li>
  );
}

interface GroupCardProps {
  group: StatusGroup;
  total: number;
  onAdd: (category: StatusCategory) => void;
  actions: ReturnType<typeof useStatusActions>;
  statuses: readonly StatusDTO[];
  onDelete: (status: StatusDTO) => void;
}

function GroupCard({ group, total, onAdd, actions, statuses, onDelete }: GroupCardProps) {
  const meta = STATUS_CATEGORY_META[group.category];
  const ids = useMemo(() => group.statuses.map((s) => s.id), [group.statuses]);
  const headingId = `status-group-${group.category}`;
  return (
    <section aria-labelledby={headingId} className="min-w-0 rounded-lg border border-border bg-surface shadow-card">
      <div className="flex items-center gap-2.5 border-b border-border px-4 py-2.5">
        <StatusIcon status={{ name: meta.label, category: group.category, color: 'var(--fg-muted)' }} label={null} />
        <div className="min-w-0 flex-1">
          <h3 id={headingId} className="text-sm font-semibold text-fg">
            {meta.label}
          </h3>
          <p className="truncate text-xs text-fg-muted">
            {meta.description}
            {isClosedCategory(group.category) && ' · counts as closed'}
          </p>
        </div>
        <IconButton aria-label={`Add a ${meta.label} status`} icon={<Plus />} size="sm" onClick={() => onAdd(group.category)} />
      </div>
      {group.statuses.length === 0 ? (
        <p className="px-4 py-3 text-[13px] text-fg-subtle">No statuses in this category.</p>
      ) : (
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          <ul className="flex flex-col divide-y divide-border" aria-label={`${meta.label} statuses`}>
            {group.statuses.map((s, i) => (
              <StatusItem
                key={s.id}
                status={s}
                index={i}
                groupSize={group.statuses.length}
                isOnly={total <= 1}
                onRename={(name) => void actions.patch(s, { name })}
                onColor={(color) => void actions.patch(s, { color })}
                onCategory={(category) => void actions.changeCategory(s, category)}
                onStep={(delta) => {
                  const order = orderAfterStep(statuses, s.id, delta);
                  if (order) void actions.applyOrder(order);
                }}
                onDelete={() => onDelete(s)}
              />
            ))}
          </ul>
        </SortableContext>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Create dialog
// ---------------------------------------------------------------------------

function CreateStatusDialog({ category, onClose }: { category: StatusCategory | null; onClose: () => void }) {
  const create = useCreateStatus();
  const { statuses } = useLookups();
  const [name, setName] = useState('');
  const [cat, setCat] = useState<StatusCategory>(category ?? 'unstarted');
  const [color, setColor] = useState<string>(DEFAULT_STATUS_COLOR);
  const [errors, setErrors] = useState<FieldErrors>({});
  const open = category !== null;

  // Reset the form each time the dialog opens (for the category it was opened from).
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setName('');
      setCat(category);
      const used = new Set(statuses.map((s) => s.color));
      setColor(COLOR_PALETTE.find((c) => !used.has(c)) ?? DEFAULT_STATUS_COLOR);
      setErrors({});
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = statusCreateInput.safeParse({ name, category: cat, color });
    if (!parsed.success) return setErrors(zodFieldErrors(parsed.error));
    create.mutate(parsed.data, {
      onSuccess: (s) => {
        toast.success(`Status “${s.name}” added`);
        onClose();
      },
      onError: (err) => {
        const fields = apiFieldErrors(err);
        if (err instanceof ApiError && err.status === 409) fields.name = err.message;
        setErrors(fields);
        if (!fields.name) toast.error(err);
      },
    });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add status"
      description="Statuses are shared by all projects."
      onSubmit={submit}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={create.isPending}>
            Add status
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Name" required error={errors.name}>
          <Input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (errors.name) setErrors((x) => ({ ...x, name: undefined }));
            }}
            maxLength={LIMITS.statusNameMax}
            placeholder="e.g. Blocked"
            autoComplete="off"
          />
        </Field>
        <Field label="Category" hint={STATUS_CATEGORY_META[cat].description + (isClosedCategory(cat) ? ' — tasks count as closed.' : '.')}>
          <Select value={cat} onChange={(e) => setCat(e.target.value as StatusCategory)} options={CATEGORY_OPTIONS} />
        </Field>
        <Field label="Color">
          <ColorPicker value={color} onChange={setColor} />
        </Field>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Delete with reassignment
// ---------------------------------------------------------------------------

function ReassignDialog({ status, onClose }: { status: StatusDTO | null; onClose: () => void }) {
  const { statuses } = useLookups();
  const qc = useQueryClient();
  const remove = useDeleteStatus();
  const [targetId, setTargetId] = useState<number | null>(null);
  // Keep showing the last status while the dialog animates closed; reset on every open.
  const [shown, setShown] = useState<StatusDTO | null>(null);
  const open = status !== null;
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (status) {
      setShown(status);
      setTargetId(suggestedReassignTarget(statuses, status.id)?.id ?? null);
    }
  }
  const others = groupStatuses(statuses.filter((s) => s.id !== shown?.id)).filter((g) => g.statuses.length > 0);
  const target = statuses.find((s) => s.id === targetId);
  const flip = shown && target ? closedFlip(shown.category, target.category) : null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const status = shown;
    if (!status || !target) return;
    remove.mutate(
      { id: status.id, reassignTo: target.id },
      {
        onSuccess: () => {
          toast.success(`Deleted “${status.name}” and moved ${pluralize(status.taskCount, 'task')} to “${target.name}”`);
          onClose();
        },
        onError: (err) => {
          toast.error(err);
          void qc.invalidateQueries({ queryKey: qk.bootstrap });
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={shown ? `Delete “${shown.name}”` : 'Delete status'}
      onSubmit={submit}
      size="sm"
      mobileLayout="sheet"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="danger" loading={remove.isPending} disabled={!target}>
            Move tasks and delete
          </Button>
        </>
      }
    >
      {shown && (
        <div className="flex flex-col gap-4 text-sm">
          <p className="text-fg-muted">
            {pluralize(shown.taskCount, 'task')} (archived ones included) {shown.taskCount === 1 ? 'uses' : 'use'} this status. Choose
            where to move {shown.taskCount === 1 ? 'it' : 'them'} before it is deleted.
          </p>
          <Field
            label="Move tasks to"
            hint={
              flip === 'close'
                ? 'These tasks will count as closed.'
                : flip === 'reopen'
                  ? 'These tasks will be reopened.'
                  : 'Board filters and columns that use this status will use the new one.'
            }
          >
            <Select value={targetId === null ? '' : String(targetId)} onChange={(e) => setTargetId(Number(e.target.value))}>
              {others.map((g) => (
                <optgroup key={g.category} label={STATUS_CATEGORY_META[g.category].label}>
                  {g.statuses.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </Select>
          </Field>
        </div>
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/** Statuses only move vertically. */
const restrictToVerticalAxis: Modifier = ({ transform }) => ({ ...transform, x: 0 });

export default function StatusSettings() {
  const { statuses } = useLookups();
  const actions = useStatusActions();
  const remove = useDeleteStatus();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [createFor, setCreateFor] = useState<StatusCategory | null>(null);
  const [reassign, setReassign] = useState<StatusDTO | null>(null);
  const groups = useMemo(() => groupStatuses(statuses), [statuses]);
  const byId = useMemo(() => new Map(statuses.map((s) => [s.id, s])), [statuses]);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 120, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Drops only land inside the dragged status's own category.
  const collisionDetection: CollisionDetection = (args) =>
    closestCenter({
      ...args,
      droppableContainers: args.droppableContainers.filter(
        (c) => c.data.current?.category === args.active.data.current?.category,
      ),
    });

  const describe = (id: UniqueIdentifier) => {
    const s = byId.get(Number(id));
    if (!s) return { name: 'status', position: 0, size: 0, category: '' };
    const group = groups.find((g) => g.category === s.category)!;
    return {
      name: s.name,
      position: group.statuses.findIndex((x) => x.id === s.id) + 1,
      size: group.statuses.length,
      category: STATUS_CATEGORY_META[s.category].label,
    };
  };
  const announcements: Announcements = {
    onDragStart: ({ active }) => {
      const a = describe(active.id);
      return `Picked up ${a.name}, position ${a.position} of ${a.size} in ${a.category}.`;
    },
    onDragOver: ({ active, over }) =>
      over ? `${describe(active.id).name} is over position ${describe(over.id).position}.` : `${describe(active.id).name} is not over a position.`,
    onDragEnd: ({ active, over }) =>
      over ? `${describe(active.id).name} was dropped at position ${describe(over.id).position}.` : `${describe(active.id).name} was dropped.`,
    onDragCancel: ({ active }) => `Reordering cancelled. ${describe(active.id).name} was not moved.`,
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over) return;
    const order = orderAfterMove(statuses, Number(active.id), Number(over.id));
    if (order) void actions.applyOrder(order);
  };

  const requestDelete = async (status: StatusDTO) => {
    if (status.taskCount > 0) return setReassign(status);
    const ok = await confirm({
      title: `Delete “${status.name}”?`,
      body: 'No tasks use this status. Boards that filter by it will show it as deleted.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    remove.mutate(
      { id: status.id },
      {
        onSuccess: () => toast.success(`Deleted “${status.name}”`),
        onError: (err) => {
          toast.error(err);
          // Counts may be stale (e.g. a task moved to it meanwhile): refresh them.
          void qc.invalidateQueries({ queryKey: qk.bootstrap });
        },
      },
    );
  };

  return (
    <SettingsPage
      title="Statuses"
      description="Every task has one status. The category decides whether a task counts as open or closed; the order here is the column order on boards."
      actions={
        <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setCreateFor('unstarted')}>
          Add status
        </Button>
      }
    >
      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        modifiers={[restrictToVerticalAxis]}
        onDragEnd={onDragEnd}
        accessibility={{
          announcements,
          screenReaderInstructions: {
            draggable:
              'To reorder, press Space or Enter on the handle, use the arrow keys to move within the category, then press Space or Enter to drop, or Escape to cancel.',
          },
        }}
      >
        <div className="flex flex-col gap-4">
          {groups.map((g) => (
            <GroupCard
              key={g.category}
              group={g}
              total={statuses.length}
              statuses={statuses}
              actions={actions}
              onAdd={setCreateFor}
              onDelete={(s) => void requestDelete(s)}
            />
          ))}
        </div>
      </DndContext>
      <CreateStatusDialog category={createFor} onClose={() => setCreateFor(null)} />
      <ReassignDialog status={reassign} onClose={() => setReassign(null)} />
    </SettingsPage>
  );
}
