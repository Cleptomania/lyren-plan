// Builds the shared task menu (SPEC §9.1): Open, Status ▸, Priority ▸, Due date ▸, Tags…,
// Move to epic ▸, Move to project ▸, [caller's extra items], Duplicate, Archive, Delete.
// Pure apart from the React elements used as icons; actions go through `taskActions`.

import {
  Archive,
  ArchiveRestore,
  CalendarDays,
  CircleDashed,
  CopyPlus,
  FolderInput,
  Layers,
  PanelRightOpen,
  Tag,
  Trash2,
  X,
} from 'lucide-react';
import { PRIORITY_META } from '@shared/constants';
import type { ISODate, WeekStart } from '@shared/dates';
import type { TaskUpdateInput } from '@shared/schemas';
import type { EpicDTO, ProjectDTO, StatusDTO, TaskDTO } from '@shared/types';
import { formatDate, formatDueDate } from '../../lib/format';
import { ColorDot, type MenuItem, type MenuItemInput } from '../ui';
import { quickDates } from './dueDates';
import { EpicDot } from './EntityBadges';
import { epicGroupLabel, groupEpicsByMilestone, statusFraction, type StructureLookups } from './entityGroups';
import { PRIORITY_ORDER } from './options';
import { PriorityIcon } from './PriorityIcon';
import { StatusIcon } from './StatusIcon';
import type { TaskActions } from './taskActions';

export interface TaskActionLookups extends StructureLookups {
  statuses: readonly StatusDTO[];
  statusById: ReadonlyMap<number, StatusDTO>;
  epicById: ReadonlyMap<number, EpicDTO>;
  settings: { weekStartsOn: WeekStart };
}

/** Extra menu entries: a list, or a function evaluated only when the menu opens. */
export type ExtraMenuItems = readonly MenuItemInput[] | ((task: TaskDTO) => readonly MenuItemInput[]);

export interface TaskActionItemsOptions {
  /** "Open" handler (default: the task drawer); false hides the item (e.g. inside the drawer). */
  onOpen?: ((task: TaskDTO) => void) | false;
  /** See TaskDeleteOptions.onDeleted. */
  onDeleted?: (task: TaskDTO) => void;
  /** Inserted after the editing items, before Duplicate / Archive / Delete. */
  extra?: ExtraMenuItems;
}

function isItem(item: MenuItemInput): item is MenuItem {
  return !!item;
}

export function resolveExtraItems(extra: ExtraMenuItems | undefined, task: TaskDTO): MenuItem[] {
  if (!extra) return [];
  return (typeof extra === 'function' ? extra(task) : extra).filter(isItem);
}

export function buildTaskActionItems(
  task: TaskDTO,
  ctx: { lookups: TaskActionLookups; today: ISODate },
  actions: TaskActions,
  options: TaskActionItemsOptions = {},
): MenuItem[] {
  const { lookups, today } = ctx;
  const update = (patch: TaskUpdateInput) => actions.update(task, patch);
  const items: MenuItem[] = [];

  if (options.onOpen !== false) {
    const onOpen = options.onOpen;
    items.push({ label: 'Open', icon: <PanelRightOpen />, onSelect: () => (onOpen ? onOpen(task) : actions.open(task)) }, { separator: true });
  }

  items.push(statusItem(task, lookups.statuses, lookups.statusById.get(task.statusId), update));
  items.push({
    label: 'Priority',
    icon: <PriorityIcon priority={task.priority} label={null} />,
    hint: PRIORITY_META[task.priority].label,
    items: PRIORITY_ORDER.map((p) => ({
      label: PRIORITY_META[p].label,
      icon: <PriorityIcon priority={p} label={null} />,
      checked: p === task.priority,
      onSelect: () => {
        if (p !== task.priority) update({ priority: p });
      },
    })),
  });
  items.push(dueItem(task, today, lookups.settings.weekStartsOn, update, actions));
  items.push({
    label: 'Tags…',
    icon: <Tag />,
    hint: task.tags.length > 0 ? String(task.tags.length) : undefined,
    onSelect: () => actions.editTags(task),
  });

  items.push({ separator: true }, epicItem(task, lookups, update), projectItem(task, lookups.projects, actions));

  const extra = resolveExtraItems(options.extra, task);
  if (extra.length > 0) items.push({ separator: true }, ...extra);

  const archived = task.archivedAt !== null;
  items.push(
    { separator: true },
    { label: 'Duplicate', icon: <CopyPlus />, onSelect: () => actions.duplicate(task) },
    {
      label: archived ? 'Unarchive' : 'Archive',
      icon: archived ? <ArchiveRestore /> : <Archive />,
      onSelect: () => actions.setArchived(task, !archived),
    },
    {
      label: 'Delete…',
      icon: <Trash2 />,
      danger: true,
      onSelect: () => actions.delete(task, { onDeleted: options.onDeleted }),
    },
  );
  return items;
}

function statusItem(
  task: TaskDTO,
  statuses: readonly StatusDTO[],
  current: StatusDTO | undefined,
  update: (patch: TaskUpdateInput) => void,
): MenuItem {
  const icon = (s: StatusDTO) => <StatusIcon status={s} fraction={statusFraction(s, statuses)} label={null} />;
  return {
    label: 'Status',
    icon: current ? icon(current) : <CircleDashed />,
    hint: current?.name,
    items: statuses.map((s) => ({
      label: s.name,
      icon: icon(s),
      checked: s.id === task.statusId,
      onSelect: () => {
        if (s.id !== task.statusId) update({ statusId: s.id });
      },
    })),
  };
}

function dueItem(
  task: TaskDTO,
  today: ISODate,
  weekStartsOn: WeekStart,
  update: (patch: TaskUpdateInput) => void,
  actions: TaskActions,
): MenuItem {
  return {
    label: 'Due date',
    icon: <CalendarDays />,
    hint: task.dueDate ? formatDueDate(task.dueDate, today) : undefined,
    items: [
      ...quickDates(today, weekStartsOn).map((q) => ({
        label: q.label,
        hint: formatDate(q.date, today),
        checked: task.dueDate === q.date,
        onSelect: () => {
          if (task.dueDate !== q.date) update({ dueDate: q.date });
        },
      })),
      { separator: true },
      { label: 'Pick a date…', icon: <CalendarDays />, onSelect: () => actions.pickDueDate(task) },
      { label: 'Clear', icon: <X />, disabled: task.dueDate === null, onSelect: () => update({ dueDate: null }) },
    ],
  };
}

function epicItem(task: TaskDTO, lookups: TaskActionLookups, update: (patch: TaskUpdateInput) => void): MenuItem {
  const groups = groupEpicsByMilestone(lookups, [task.projectId]);
  const current = task.epicId !== null ? lookups.epicById.get(task.epicId) : undefined;
  const showHeadings = groups.some((g) => g.milestone !== null);
  const sub: MenuItem[] = [
    {
      label: 'No epic',
      icon: <CircleDashed />,
      checked: task.epicId === null,
      onSelect: () => {
        if (task.epicId !== null) update({ epicId: null });
      },
    },
  ];
  for (const group of groups) {
    if (showHeadings) sub.push({ heading: epicGroupLabel(group, false) });
    for (const epic of group.epics) {
      sub.push({
        label: epic.name,
        icon: <EpicDot color={epic.color} />,
        checked: epic.id === task.epicId,
        onSelect: () => {
          if (epic.id !== task.epicId) update({ epicId: epic.id });
        },
      });
    }
  }
  if (groups.length === 0) sub.push({ label: 'This project has no epics', disabled: true });
  return { label: 'Move to epic', icon: <Layers />, hint: current?.name, items: sub };
}

function projectItem(task: TaskDTO, projects: readonly ProjectDTO[], actions: TaskActions): MenuItem {
  const choices = projects.filter((p) => p.status !== 'archived' || p.id === task.projectId);
  return {
    label: 'Move to project',
    icon: <FolderInput />,
    disabled: choices.length < 2,
    items: choices.map((p) => ({
      label: p.name,
      icon: <ColorDot color={p.color} square />,
      hint: p.key,
      checked: p.id === task.projectId,
      onSelect: () => {
        if (p.id === task.projectId) return;
        actions.update(task, { projectId: p.id }, { success: (saved) => `Moved to ${p.name} as ${saved.ref}` });
      },
    })),
  };
}
