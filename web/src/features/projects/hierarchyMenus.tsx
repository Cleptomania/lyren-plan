// "⋯" menu items for milestones and epics (overview cards, rows and their pages).
// Move up / Move down are the non-drag way to reorder (touch, keyboard, screen readers).

import { ArrowDown, ArrowUp, ExternalLink, Milestone as MilestoneIcon, Pencil, Plus, Trash2 } from 'lucide-react';
import type { EpicStatus, MilestoneStatus } from '@shared/constants';
import type { EpicDTO, MilestoneDTO } from '@shared/types';
import type { MenuItem, MenuItemInput } from '../../components/ui';
import { lifecycleMeta, lifecycleStatuses, type LifecycleKind, type LifecycleStatuses } from './LifecycleStatus';

export interface MoveActions {
  /** null = already first (rendered disabled). */
  up: (() => void) | null;
  down: (() => void) | null;
}

function statusSubmenu<K extends LifecycleKind>(kind: K, current: LifecycleStatuses[K], onSelect: (s: LifecycleStatuses[K]) => void): MenuItem {
  const CurrentIcon = lifecycleMeta(kind, current).icon;
  return {
    label: 'Status',
    icon: <CurrentIcon />,
    hint: lifecycleMeta(kind, current).label,
    items: lifecycleStatuses(kind).map((status) => {
      const Icon = lifecycleMeta(kind, status).icon;
      return {
        label: lifecycleMeta(kind, status).label,
        icon: <Icon />,
        checked: status === current,
        onSelect: () => {
          if (status !== current) onSelect(status);
        },
      };
    }),
  };
}

function moveItems(move: MoveActions | undefined): MenuItemInput[] {
  if (!move) return [];
  return [
    { separator: true },
    { label: 'Move up', icon: <ArrowUp />, disabled: !move.up, onSelect: move.up ?? undefined },
    { label: 'Move down', icon: <ArrowDown />, disabled: !move.down, onSelect: move.down ?? undefined },
  ];
}

export function milestoneMenuItems(
  milestone: MilestoneDTO,
  actions: {
    open?: () => void;
    edit: () => void;
    setStatus: (status: MilestoneStatus) => void;
    addEpic: () => void;
    move?: MoveActions;
    remove: () => void;
  },
): MenuItemInput[] {
  return [
    actions.open && { label: 'Open milestone', icon: <ExternalLink />, onSelect: actions.open },
    { label: 'Edit…', icon: <Pencil />, onSelect: actions.edit },
    statusSubmenu('milestone', milestone.status, actions.setStatus),
    { label: 'Add epic…', icon: <Plus />, onSelect: actions.addEpic },
    ...moveItems(actions.move),
    { separator: true },
    { label: 'Delete milestone…', icon: <Trash2 />, danger: true, onSelect: actions.remove },
  ];
}

export function epicMenuItems(
  epic: EpicDTO,
  actions: {
    open?: () => void;
    edit: () => void;
    setStatus: (status: EpicStatus) => void;
    /** The project's milestones, for "Milestone ▸". */
    milestones: readonly MilestoneDTO[];
    setMilestone: (milestoneId: number | null) => void;
    move?: MoveActions;
    remove: () => void;
  },
): MenuItemInput[] {
  const current = actions.milestones.find((m) => m.id === epic.milestoneId);
  return [
    actions.open && { label: 'Open epic', icon: <ExternalLink />, onSelect: actions.open },
    { label: 'Edit…', icon: <Pencil />, onSelect: actions.edit },
    statusSubmenu('epic', epic.status, actions.setStatus),
    {
      label: 'Milestone',
      icon: <MilestoneIcon />,
      hint: current?.name ?? 'None',
      items: [
        { label: 'No milestone', checked: epic.milestoneId === null, onSelect: () => epic.milestoneId !== null && actions.setMilestone(null) },
        ...(actions.milestones.length > 0 ? [{ separator: true } as const] : []),
        ...actions.milestones.map((m) => ({
          label: m.name,
          checked: m.id === epic.milestoneId,
          hint: m.status === 'completed' || m.status === 'cancelled' ? lifecycleMeta('milestone', m.status).label : undefined,
          onSelect: () => m.id !== epic.milestoneId && actions.setMilestone(m.id),
        })),
      ],
    },
    ...moveItems(actions.move),
    { separator: true },
    { label: 'Delete epic…', icon: <Trash2 />, danger: true, onSelect: actions.remove },
  ];
}
