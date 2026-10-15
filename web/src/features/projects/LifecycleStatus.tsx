// Lifecycle statuses of projects, milestones and epics: badge + inline picker.
// Shape and text carry the meaning (icons differ per status), color only reinforces it.

import { clsx } from 'clsx';
import {
  Archive,
  ChevronDown,
  Circle,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CirclePause,
  CirclePlay,
  CircleX,
  type LucideIcon,
} from 'lucide-react';
import {
  EPIC_STATUSES,
  EPIC_STATUS_LABELS,
  MILESTONE_STATUSES,
  MILESTONE_STATUS_LABELS,
  PROJECT_STATUSES,
  PROJECT_STATUS_LABELS,
  type EpicStatus,
  type MilestoneStatus,
  type ProjectStatus,
} from '@shared/constants';
import { Badge, Picker, type BadgeVariant, type PickerOption } from '../../components/ui';

interface StatusMeta {
  label: string;
  icon: LucideIcon;
  variant: BadgeVariant;
  /** Text color class for the icon in lists and menus. */
  tone: string;
}

export interface LifecycleStatuses {
  project: ProjectStatus;
  milestone: MilestoneStatus;
  epic: EpicStatus;
}
export type LifecycleKind = keyof LifecycleStatuses;

const TONE: Record<BadgeVariant, string> = {
  neutral: 'text-fg-muted',
  accent: 'text-accent',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
  outline: 'text-fg-muted',
};

function meta(label: string, icon: LucideIcon, variant: BadgeVariant): StatusMeta {
  return { label, icon, variant, tone: TONE[variant] };
}

export const LIFECYCLE_META: { [K in LifecycleKind]: Record<LifecycleStatuses[K], StatusMeta> } = {
  project: {
    active: meta(PROJECT_STATUS_LABELS.active, CirclePlay, 'accent'),
    on_hold: meta(PROJECT_STATUS_LABELS.on_hold, CirclePause, 'warning'),
    completed: meta(PROJECT_STATUS_LABELS.completed, CircleCheck, 'success'),
    archived: meta(PROJECT_STATUS_LABELS.archived, Archive, 'neutral'),
  },
  milestone: {
    planned: meta(MILESTONE_STATUS_LABELS.planned, CircleDashed, 'neutral'),
    active: meta(MILESTONE_STATUS_LABELS.active, CircleDot, 'accent'),
    completed: meta(MILESTONE_STATUS_LABELS.completed, CircleCheck, 'success'),
    cancelled: meta(MILESTONE_STATUS_LABELS.cancelled, CircleX, 'neutral'),
  },
  epic: {
    open: meta(EPIC_STATUS_LABELS.open, Circle, 'neutral'),
    in_progress: meta(EPIC_STATUS_LABELS.in_progress, CircleDot, 'accent'),
    done: meta(EPIC_STATUS_LABELS.done, CircleCheck, 'success'),
    cancelled: meta(EPIC_STATUS_LABELS.cancelled, CircleX, 'neutral'),
  },
};

const ORDER: { [K in LifecycleKind]: readonly LifecycleStatuses[K][] } = {
  project: PROJECT_STATUSES,
  milestone: MILESTONE_STATUSES,
  epic: EPIC_STATUSES,
};

export function lifecycleMeta<K extends LifecycleKind>(kind: K, status: LifecycleStatuses[K]): StatusMeta {
  return (LIFECYCLE_META[kind] as Record<string, StatusMeta>)[status]!;
}

export function lifecycleStatuses<K extends LifecycleKind>(kind: K): readonly LifecycleStatuses[K][] {
  return ORDER[kind];
}

const KIND_LABEL: Record<LifecycleKind, string> = { project: 'Project', milestone: 'Milestone', epic: 'Epic' };

export interface LifecycleBadgeProps<K extends LifecycleKind> {
  kind: K;
  status: LifecycleStatuses[K];
  size?: 'sm' | 'md';
  className?: string;
}

/** Icon + label chip for a project / milestone / epic status. */
export function LifecycleBadge<K extends LifecycleKind>({ kind, status, size = 'sm', className }: LifecycleBadgeProps<K>) {
  const m = lifecycleMeta(kind, status);
  const Icon = m.icon;
  return (
    <Badge variant={m.variant} size={size} icon={<Icon aria-hidden />} className={className}>
      {m.label}
    </Badge>
  );
}

export interface LifecyclePickerProps<K extends LifecycleKind> {
  kind: K;
  value: LifecycleStatuses[K];
  onChange: (status: LifecycleStatuses[K]) => void;
  /** Accessible name prefix, e.g. the entity name ("Status of MVP launch"). */
  subject?: string;
  size?: 'sm' | 'md';
  disabled?: boolean;
  className?: string;
}

/** Inline status changer: a badge-styled button opening the status list (sheet on phones). */
export function LifecyclePicker<K extends LifecycleKind>({
  kind,
  value,
  onChange,
  subject,
  size = 'sm',
  disabled,
  className,
}: LifecyclePickerProps<K>) {
  const current = lifecycleMeta(kind, value);
  const CurrentIcon = current.icon;
  const options: PickerOption<string>[] = lifecycleStatuses(kind).map((status) => {
    const m = lifecycleMeta(kind, status);
    const Icon = m.icon;
    return { value: status, label: m.label, icon: <Icon aria-hidden className={clsx('size-4', m.tone)} /> };
  });
  const label = `${KIND_LABEL[kind]} status`;
  return (
    <Picker<string>
      label={label}
      options={options}
      value={value}
      onChange={(next) => {
        if (next !== value) onChange(next as LifecycleStatuses[K]);
      }}
      className="w-48"
      trigger={
        <button
          type="button"
          disabled={disabled}
          aria-label={`${subject ? `${subject} — ` : ''}${label}: ${current.label}. Change`}
          className={clsx(
            // 24–28px visually, 40px touch target via the ::before hit area
            'relative inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md font-medium leading-none transition-colors',
            "before:absolute before:-inset-x-1 before:-inset-y-2 before:content-[''] md:before:-inset-y-1",
            'hover:brightness-95 disabled:pointer-events-none disabled:opacity-60 dark:hover:brightness-125',
            size === 'sm' ? 'h-6 px-1.5 text-[11px] [&_svg]:size-3' : 'h-7 px-2 text-xs [&_svg]:size-3.5',
            BADGE_BG[current.variant],
            className,
          )}
        >
          <CurrentIcon aria-hidden />
          <span>{current.label}</span>
          <ChevronDown aria-hidden className="opacity-60" />
        </button>
      }
    />
  );
}

/** Same surface classes as the kit Badge variants (kept in sync visually). */
const BADGE_BG: Record<BadgeVariant, string> = {
  neutral: 'bg-surface-2 text-fg-muted',
  accent: 'bg-accent-soft text-accent',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
  outline: 'border border-border text-fg-muted',
};
