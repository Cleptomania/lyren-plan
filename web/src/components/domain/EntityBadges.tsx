// Compact labels for statuses, priorities, projects, epics and milestones. They take the
// entity objects (from useLookups()) and render nothing for a missing entity, so stale ids
// (deleted elsewhere) never crash a list.

import { clsx } from 'clsx';
import { Milestone } from 'lucide-react';
import { MILESTONE_STATUS_LABELS, PRIORITY_META, type Priority } from '@shared/constants';
import type { EpicDTO, MilestoneDTO, ProjectDTO, StatusDTO } from '@shared/types';
import { useLookups } from '../../api/bootstrap';
import { ColorDot } from '../ui';
import { statusFraction } from './entityGroups';
import { Pill, type PillSize } from './Pill';
import { PriorityIcon } from './PriorityIcon';
import { StatusIcon } from './StatusIcon';

interface BadgeBaseProps {
  size?: PillSize;
  /** Borderless (icon + text). */
  plain?: boolean;
  className?: string;
}

// ---- Status ------------------------------------------------------------------------

export interface StatusBadgeProps extends BadgeBaseProps {
  status: StatusDTO | undefined;
  /** Pie fill for 'started' statuses; computed from the configured statuses when omitted. */
  fraction?: number;
}

/** Status icon + name. */
export function StatusBadge({ status, fraction, ...rest }: StatusBadgeProps) {
  if (!status) return null;
  if (fraction === undefined && status.category === 'started') return <ConnectedStatusBadge status={status} {...rest} />;
  return <StatusBadgeView status={status} fraction={fraction ?? 0} {...rest} />;
}

function ConnectedStatusBadge({ status, ...rest }: BadgeBaseProps & { status: StatusDTO }) {
  const { statuses } = useLookups();
  return <StatusBadgeView status={status} fraction={statusFraction(status, statuses)} {...rest} />;
}

function StatusBadgeView({ status, fraction, size = 'sm', plain, className }: BadgeBaseProps & { status: StatusDTO; fraction: number }) {
  return (
    <Pill
      size={size}
      plain={plain}
      tone="default"
      className={className}
      icon={<StatusIcon status={status} fraction={fraction} label={null} size={size === 'sm' ? 12 : 14} />}
    >
      {status.name}
    </Pill>
  );
}

// ---- Priority ----------------------------------------------------------------------

export interface PriorityBadgeProps extends BadgeBaseProps {
  priority: Priority;
  /** Render nothing for "No priority" (default false). */
  hideNone?: boolean;
}

/** Priority icon + label ("Urgent", "High" …). */
export function PriorityBadge({ priority, hideNone, size = 'sm', plain, className }: PriorityBadgeProps) {
  if (hideNone && priority === 0) return null;
  return (
    <Pill
      size={size}
      plain={plain}
      className={className}
      icon={<PriorityIcon priority={priority} label={null} size={size === 'sm' ? 12 : 14} />}
    >
      {PRIORITY_META[priority].label}
    </Pill>
  );
}

// ---- Project -----------------------------------------------------------------------

export interface ProjectDotProps {
  project: Pick<ProjectDTO, 'name' | 'color'> | undefined;
  size?: 'xs' | 'sm' | 'md';
  className?: string;
}

/** The project's color as a small rounded square, labelled with the project name. */
export function ProjectDot({ project, size = 'sm', className }: ProjectDotProps) {
  if (!project) return null;
  return <ColorDot color={project.color} size={size} square label={project.name} className={className} />;
}

export interface ProjectBadgeProps extends BadgeBaseProps {
  project: Pick<ProjectDTO, 'key' | 'name' | 'color'> | undefined;
  /** 'key' (default, "WEB"), 'name' or 'both' ("WEB · Website"). */
  show?: 'key' | 'name' | 'both';
}

/** Color square + project key and/or name. The full name is always in the accessible name. */
export function ProjectBadge({ project, show = 'key', size = 'sm', plain, className }: ProjectBadgeProps) {
  if (!project) return null;
  const text = show === 'key' ? project.key : show === 'name' ? project.name : `${project.key} · ${project.name}`;
  return (
    <Pill
      size={size}
      plain={plain}
      className={className}
      title={project.name}
      icon={<ColorDot color={project.color} size={size === 'sm' ? 'sm' : 'md'} square />}
    >
      {show === 'key' ? (
        <>
          <span aria-hidden>{text}</span>
          <span className="sr-only">Project {project.name}</span>
        </>
      ) : (
        text
      )}
    </Pill>
  );
}

// ---- Epic / milestone --------------------------------------------------------------

/** Decorative epic marker: a small diamond in the epic's color (projects are squares, tags dots). */
export function EpicDot({ color, className }: { color: string; className?: string }) {
  return <span aria-hidden className={clsx('inline-block size-2 shrink-0 rotate-45 rounded-[2px]', className)} style={{ backgroundColor: color }} />;
}

export interface EpicBadgeProps extends BadgeBaseProps {
  epic: Pick<EpicDTO, 'name' | 'color'> | undefined;
}

/** Epic name with its color (diamond), e.g. on cards and rows. */
export function EpicBadge({ epic, size = 'sm', plain, className }: EpicBadgeProps) {
  if (!epic) return null;
  return (
    <Pill
      size={size}
      plain={plain}
      className={className}
      textClassName="max-w-[11rem]"
      title={`Epic: ${epic.name}`}
      icon={<EpicDot color={epic.color} />}
    >
      <span className="sr-only">Epic </span>
      {epic.name}
    </Pill>
  );
}

export interface MilestoneBadgeProps extends BadgeBaseProps {
  milestone: Pick<MilestoneDTO, 'name' | 'status'> | undefined;
}

/** Milestone flag + name; closed milestones are muted. */
export function MilestoneBadge({ milestone, size = 'sm', plain, className }: MilestoneBadgeProps) {
  if (!milestone) return null;
  const closed = milestone.status === 'completed' || milestone.status === 'cancelled';
  return (
    <Pill
      size={size}
      plain={plain}
      tone={closed ? 'subtle' : undefined}
      className={className}
      textClassName="max-w-[11rem]"
      title={`Milestone: ${milestone.name}${closed ? ` (${MILESTONE_STATUS_LABELS[milestone.status]})` : ''}`}
      icon={<Milestone aria-hidden />}
    >
      <span className="sr-only">Milestone </span>
      {milestone.name}
    </Pill>
  );
}

// ---- Task reference ----------------------------------------------------------------

export interface TaskRefProps {
  /** The task reference, e.g. 'LYR-42'. */
  value: string;
  className?: string;
}

/** Muted, tabular task reference ("LYR-42"). */
export function TaskRef({ value, className }: TaskRefProps) {
  return <span className={clsx('shrink-0 whitespace-nowrap text-[11px] font-medium tabular-nums text-fg-subtle', className)}>{value}</span>;
}
