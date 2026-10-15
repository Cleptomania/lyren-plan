// The shared non-drag way to change a task (SPEC §8.3, §9.1): useTaskActions() builds the
// MenuItem[]; TaskActionsMenu is the "⋯" button + menu used on cards, rows and the drawer.

import type { Placement } from '@floating-ui/react';
import { useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { MoreHorizontal } from 'lucide-react';
import { forwardRef, useCallback, useMemo, useState, type ButtonHTMLAttributes, type ReactElement } from 'react';
import { localToday } from '@shared/dates';
import type { BootstrapDTO, TaskDTO } from '@shared/types';
import { getLookups, useLookups } from '../../api/bootstrap';
import { qk } from '../../api/keys';
import { IconButton, Menu, type MenuItem } from '../ui';
import { taskActions } from './taskActions';
import { buildTaskActionItems, type ExtraMenuItems, type TaskActionItemsOptions } from './taskActionItems';
import { useSharedToday } from './useSharedToday';

export type TaskActionsOptions = Pick<TaskActionItemsOptions, 'onOpen' | 'onDeleted'>;

/**
 * The task menu as MenuItem[] (for your own <Menu> or a PageHeader `menu`):
 * Open, Status ▸, Priority ▸, Due date ▸, Tags…, Move to epic ▸, Move to project ▸,
 * `extra`, Duplicate, Archive/Unarchive, Delete…
 * Requires <TaskActionsHost /> (mounted by AppShell).
 */
export function useTaskActions(task: TaskDTO, extra?: ExtraMenuItems, options: TaskActionsOptions = {}): MenuItem[] {
  const lookups = useLookups();
  const today = useSharedToday();
  const { onOpen, onDeleted } = options;
  return useMemo(
    () => buildTaskActionItems(task, { lookups, today }, taskActions, { onOpen, onDeleted, extra }),
    [task, lookups, today, extra, onOpen, onDeleted],
  );
}

const EMPTY: MenuItem[] = [];

export interface TaskActionsMenuProps extends TaskActionsOptions {
  task: TaskDTO;
  /** Extra entries (e.g. a board's "Move to column ▸"); a function is only called when the menu opens. */
  extraItems?: ExtraMenuItems;
  /** Custom trigger element (default: a "⋯" icon button). */
  trigger?: ReactElement;
  /** Look of the default trigger: 'icon' (IconButton) or 'compact' (small, for cards and rows). */
  triggerVariant?: 'icon' | 'compact';
  /** Classes for the default trigger. */
  triggerClassName?: string;
  placement?: Placement;
  /** Controlled open state (optional). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/**
 * "⋯" button with the task menu. Cheap to render on every card: the items are only built
 * while the menu is open (from the cached lookups), and actions run in TaskActionsHost.
 */
export function TaskActionsMenu({
  task,
  extraItems,
  onOpen,
  onDeleted,
  trigger,
  triggerVariant = 'icon',
  triggerClassName,
  placement,
  open: openProp,
  onOpenChange,
}: TaskActionsMenuProps) {
  const qc = useQueryClient();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  // Once opened, keep building items so the panel keeps its content during the exit transition.
  const [activated, setActivated] = useState(false);
  const open = openProp ?? uncontrolledOpen;
  const setOpen = useCallback(
    (next: boolean) => {
      if (openProp === undefined) setUncontrolledOpen(next);
      if (next) setActivated(true);
      onOpenChange?.(next);
    },
    [openProp, onOpenChange],
  );

  const items = useMemo(() => {
    if (!open && !activated) return EMPTY;
    const boot = qc.getQueryData<BootstrapDTO>(qk.bootstrap);
    if (!boot) return EMPTY;
    return buildTaskActionItems(task, { lookups: getLookups(boot), today: localToday() }, taskActions, {
      onOpen,
      onDeleted,
      extra: extraItems,
    });
  }, [open, activated, qc, task, onOpen, onDeleted, extraItems]);

  const label = `Actions for ${task.ref}`;
  const triggerEl =
    trigger ??
    (triggerVariant === 'compact' ? (
      <TaskMenuButton aria-label={label} className={triggerClassName} />
    ) : (
      <IconButton aria-label={label} tooltip="More actions" icon={<MoreHorizontal />} className={triggerClassName} />
    ));

  return <Menu trigger={triggerEl} items={items} label={label} placement={placement} open={open} onOpenChange={setOpen} />;
}

export type TaskMenuButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & { 'aria-label': string };

/**
 * A small (28px) "⋯" button whose invisible hit area is 40px, for card corners and rows
 * where a full-size IconButton would crowd the content.
 */
export const TaskMenuButton = forwardRef<HTMLButtonElement, TaskMenuButtonProps>(function TaskMenuButton(
  { className, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      className={clsx(
        'relative inline-flex size-7 shrink-0 items-center justify-center rounded-md text-fg-muted transition-[color,background-color,opacity]',
        "hover:bg-surface-3 hover:text-fg aria-expanded:bg-surface-3 aria-expanded:text-fg before:absolute before:-inset-1.5 before:content-['']",
        'focus-visible:outline-2 focus-visible:outline-offset-0',
        className,
      )}
      {...rest}
    >
      <MoreHorizontal aria-hidden className="size-4" />
    </button>
  );
});
