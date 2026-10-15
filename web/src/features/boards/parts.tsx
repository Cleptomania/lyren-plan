// Small presentational pieces shared by the board layouts and the config panel.

import { clsx } from 'clsx';
import { CalendarDays, CalendarOff, CircleCheck, CircleDashed, CircleHelp, LayoutGrid, Milestone, TriangleAlert } from 'lucide-react';
import { NONE_GROUP_KEY, OTHER_GROUP_KEY } from '@shared/board';
import type { Priority } from '@shared/constants';
import type { ReactNode } from 'react';
import { useLookups } from '../../api/bootstrap';
import { EpicDot, PriorityIcon, StatusIcon, statusFraction } from '../../components/domain';
import { ColorDot } from '../../components/ui';
import type { GroupField, GroupInfo, WipState } from './grouping';

/** Decorative icon for a group (the label carries the meaning). */
export function GroupIcon({ field, group, className }: { field: GroupField; group: Pick<GroupInfo, 'key' | 'color'>; className?: string }) {
  const lookups = useLookups();
  const box = clsx('inline-flex size-4 shrink-0 items-center justify-center [&_svg]:size-4', className);
  const muted = <CircleDashed aria-hidden className="text-fg-subtle" />;
  let icon: ReactNode = null;
  switch (field) {
    case 'status': {
      const s = lookups.statusById.get(Number(group.key));
      icon = s ? <StatusIcon status={s} fraction={statusFraction(s, lookups.statuses)} label={null} /> : <CircleHelp aria-hidden className="text-fg-subtle" />;
      break;
    }
    case 'statusCategory': {
      const s = lookups.statuses.find((x) => x.category === group.key);
      icon = s ? <StatusIcon status={s} fraction={statusFraction(s, lookups.statuses)} label={null} /> : muted;
      break;
    }
    case 'priority':
      icon = <PriorityIcon priority={Number(group.key) as Priority} label={null} />;
      break;
    case 'project':
      icon = group.color ? <ColorDot color={group.color} square /> : muted;
      break;
    case 'epic':
      icon = group.key === NONE_GROUP_KEY || !group.color ? muted : <EpicDot color={group.color} />;
      break;
    case 'milestone':
      icon = group.key === NONE_GROUP_KEY ? muted : <Milestone aria-hidden className="text-fg-muted" />;
      break;
    case 'tag':
      icon = group.key === NONE_GROUP_KEY || !group.color ? muted : <ColorDot color={group.color} />;
      break;
    case 'due':
      icon =
        group.key === 'overdue' ? (
          <TriangleAlert aria-hidden className="text-danger" />
        ) : group.key === 'no_date' ? (
          <CalendarOff aria-hidden className="text-fg-subtle" />
        ) : group.key === 'past' ? (
          <CircleCheck aria-hidden className="text-fg-subtle" />
        ) : (
          <CalendarDays aria-hidden className={group.key === 'today' ? 'text-warning' : 'text-fg-muted'} />
        );
      break;
    case 'custom':
      icon =
        group.key === OTHER_GROUP_KEY ? muted : group.color ? <ColorDot color={group.color} /> : <LayoutGrid aria-hidden className="text-fg-subtle" />;
      break;
    case 'none':
      icon = null;
      break;
  }
  return icon ? (
    <span aria-hidden className={box}>
      {icon}
    </span>
  ) : null;
}

/** Task count, or "7 / 5" with a WIP limit (warning icon + screen-reader text when exceeded). */
export function GroupCount({ count, wip, className }: { count: number; wip?: WipState; className?: string }) {
  if (!wip) {
    return (
      <span className={clsx('shrink-0 text-xs tabular-nums text-fg-muted', className)}>
        {count}
        <span className="sr-only"> {count === 1 ? 'task' : 'tasks'}</span>
      </span>
    );
  }
  return (
    <span
      className={clsx(
        'inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 text-xs tabular-nums',
        wip.over ? 'bg-danger-soft font-medium text-danger' : 'text-fg-muted',
        className,
      )}
      title={wip.over ? `Over the WIP limit of ${wip.limit}` : `WIP limit ${wip.limit}`}
    >
      {wip.over && <TriangleAlert aria-hidden className="size-3.5" />}
      {wip.count} / {wip.limit}
      <span className="sr-only">{wip.over ? ' tasks, over WIP limit' : ' tasks, WIP limit'}</span>
    </span>
  );
}

/** Where a dragged card will land (manual sort). Takes no layout space in a `gap-2` column. */
export function InsertionLine() {
  return (
    <div aria-hidden className="pointer-events-none relative -mb-2 h-0">
      <div className="absolute inset-x-0.5 -top-[5px] h-[3px] rounded-full bg-accent" />
    </div>
  );
}

/** Group label with an optional hint (project key) — truncates. */
export function GroupLabel({ group, className }: { group: Pick<GroupInfo, 'label' | 'hint'>; className?: string }) {
  return (
    <span className={clsx('flex min-w-0 items-baseline gap-1.5', className)}>
      <span className="truncate font-medium text-fg">{group.label}</span>
      {group.hint && <span className="shrink-0 text-[11px] text-fg-subtle">{group.hint}</span>}
    </span>
  );
}
