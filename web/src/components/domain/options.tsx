// PickerOption builders for every task property. The domain pickers use them; feature code
// can feed them to the UI kit <Picker multiple> for filters (statuses, priorities, epics …).

import { CircleDashed } from 'lucide-react';
import { useMemo } from 'react';
import {
  EPIC_STATUS_LABELS,
  MILESTONE_STATUS_LABELS,
  PRIORITY_META,
  PROJECT_STATUS_LABELS,
  STATUS_CATEGORY_META,
  type Priority,
} from '@shared/constants';
import type { MilestoneDTO, ProjectDTO, StatusDTO, TagDTO } from '@shared/types';
import { useLookups } from '../../api/bootstrap';
import { ColorDot, type PickerOption } from '../ui';
import { EpicDot } from './EntityBadges';
import { epicGroupLabel, groupEpicsByMilestone, scopeProjectIds, statusFraction, type ProjectScope, type StructureLookups } from './entityGroups';
import { PriorityIcon } from './PriorityIcon';
import { StatusIcon } from './StatusIcon';

/** Board / menu order: urgent first, "No priority" last. */
export const PRIORITY_ORDER: readonly Priority[] = [4, 3, 2, 1, 0];

const noneIcon = <CircleDashed className="text-fg-subtle" />;

export function statusOptions(statuses: readonly StatusDTO[]): PickerOption<number>[] {
  return statuses.map((s) => ({
    value: s.id,
    label: s.name,
    icon: <StatusIcon status={s} fraction={statusFraction(s, statuses)} label={null} />,
    keywords: STATUS_CATEGORY_META[s.category].label,
  }));
}

export function priorityOptions(): PickerOption<Priority>[] {
  return PRIORITY_ORDER.map((p) => ({
    value: p,
    label: PRIORITY_META[p].label,
    icon: <PriorityIcon priority={p} label={null} />,
    keywords: PRIORITY_META[p].key,
  }));
}

export interface ProjectOptionsConfig {
  /** List archived projects under an "Archived" heading (default false: hidden). */
  includeArchived?: boolean;
}

/** Non-archived projects in position order (key as hint), then archived ones if requested. */
export function projectOptions(projects: readonly ProjectDTO[], { includeArchived = false }: ProjectOptionsConfig = {}): PickerOption<number>[] {
  const option = (p: ProjectDTO, group?: string): PickerOption<number> => ({
    value: p.id,
    label: p.name,
    hint: p.key,
    icon: <ColorDot color={p.color} square />,
    keywords: `${p.key} ${PROJECT_STATUS_LABELS[p.status]}`,
    group,
  });
  const active = projects.filter((p) => p.status !== 'archived').map((p) => option(p));
  if (!includeArchived) return active;
  return [...active, ...projects.filter((p) => p.status === 'archived').map((p) => option(p, 'Archived'))];
}

export interface ScopedOptionsConfig {
  /** One project, several, or every non-archived project (default). */
  projectId?: ProjectScope;
  /** Leading "No milestone" / "No epic" option with value null (default true). */
  includeNone?: boolean;
  noneLabel?: string;
}

function closedMilestone(m: MilestoneDTO): boolean {
  return m.status === 'completed' || m.status === 'cancelled';
}

/** Milestones of the scope (grouped by project when several), after an optional "No milestone". */
export function milestoneOptions(
  lookups: StructureLookups,
  { projectId, includeNone = true, noneLabel = 'No milestone' }: ScopedOptionsConfig = {},
): PickerOption<number | null>[] {
  const ids = scopeProjectIds(lookups, projectId);
  const multi = ids.length > 1;
  const out: PickerOption<number | null>[] = includeNone ? [{ value: null, label: noneLabel, icon: noneIcon }] : [];
  for (const pid of ids) {
    const project = lookups.projectById.get(pid);
    for (const m of lookups.milestonesByProject.get(pid) ?? []) {
      out.push({
        value: m.id,
        label: m.name,
        hint: closedMilestone(m) ? MILESTONE_STATUS_LABELS[m.status] : undefined,
        keywords: project ? `${project.key} ${project.name}` : undefined,
        group: multi ? project?.name : undefined,
      });
    }
  }
  return out;
}

/**
 * Epics of the scope grouped by milestone (milestone order, then "No milestone"), after an
 * optional "No epic". Headings are omitted when a single project has no milestones.
 */
export function epicOptions(
  lookups: StructureLookups,
  { projectId, includeNone = true, noneLabel = 'No epic' }: ScopedOptionsConfig = {},
): PickerOption<number | null>[] {
  const ids = scopeProjectIds(lookups, projectId);
  const multi = ids.length > 1;
  const groups = groupEpicsByMilestone(lookups, ids);
  const showHeadings = multi || groups.some((g) => g.milestone !== null);
  const out: PickerOption<number | null>[] = includeNone ? [{ value: null, label: noneLabel, icon: noneIcon }] : [];
  for (const group of groups) {
    const heading = showHeadings ? epicGroupLabel(group, multi) : undefined;
    for (const e of group.epics) {
      out.push({
        value: e.id,
        label: e.name,
        icon: <EpicDot color={e.color} />,
        hint: e.status === 'done' || e.status === 'cancelled' ? EPIC_STATUS_LABELS[e.status] : undefined,
        keywords: group.milestone?.name,
        group: heading,
      });
    }
  }
  return out;
}

export function tagOptions(tags: readonly TagDTO[]): PickerOption<number>[] {
  return tags.map((t) => ({ value: t.id, label: t.name, icon: <ColorDot color={t.color} /> }));
}

// ---- Hooks (memoized per bootstrap payload) ----------------------------------------------

export function useStatusOptions(): PickerOption<number>[] {
  const { statuses } = useLookups();
  return useMemo(() => statusOptions(statuses), [statuses]);
}

export function usePriorityOptions(): PickerOption<Priority>[] {
  return useMemo(() => priorityOptions(), []);
}

export function useProjectOptions(config: ProjectOptionsConfig = {}): PickerOption<number>[] {
  const { projects } = useLookups();
  const { includeArchived } = config;
  return useMemo(() => projectOptions(projects, { includeArchived }), [projects, includeArchived]);
}

function scopeKey(scope: ProjectScope): string {
  return scope === null || scope === undefined ? '*' : typeof scope === 'number' ? String(scope) : scope.join(',');
}

export function useMilestoneOptions(config: ScopedOptionsConfig = {}): PickerOption<number | null>[] {
  const lookups = useLookups();
  const key = scopeKey(config.projectId);
  const { includeNone, noneLabel } = config;
  // `key` stands in for the projectId array, which callers often pass inline.
  return useMemo(() => milestoneOptions(lookups, config), [lookups, key, includeNone, noneLabel]);
}

export function useEpicOptions(config: ScopedOptionsConfig = {}): PickerOption<number | null>[] {
  const lookups = useLookups();
  const key = scopeKey(config.projectId);
  const { includeNone, noneLabel } = config;
  return useMemo(() => epicOptions(lookups, config), [lookups, key, includeNone, noneLabel]);
}

export function useTagOptions(): PickerOption<number>[] {
  const { tags } = useLookups();
  return useMemo(() => tagOptions(tags), [tags]);
}
