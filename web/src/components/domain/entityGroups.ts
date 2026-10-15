// Pure grouping helpers over the bootstrap lookups (epics by milestone, project scopes,
// started-status fractions). Shared by pickers and the task actions menu.

import type { EpicDTO, MilestoneDTO, ProjectDTO, StatusDTO } from '@shared/types';

/** The lookups subset these helpers need (structurally compatible with api/bootstrap Lookups). */
export interface StructureLookups {
  projects: readonly ProjectDTO[];
  projectById: ReadonlyMap<number, ProjectDTO>;
  milestonesByProject: ReadonlyMap<number, readonly MilestoneDTO[]>;
  epicsByProject: ReadonlyMap<number, readonly EpicDTO[]>;
}

/** One project, several projects, or (null/undefined) every non-archived project. */
export type ProjectScope = number | readonly number[] | null | undefined;

/** Project ids in project position order for a scope; unknown ids are dropped. */
export function scopeProjectIds(lookups: Pick<StructureLookups, 'projects'>, scope: ProjectScope): number[] {
  if (scope === null || scope === undefined) {
    return lookups.projects.filter((p) => p.status !== 'archived').map((p) => p.id);
  }
  const wanted = new Set(typeof scope === 'number' ? [scope] : scope);
  return lookups.projects.filter((p) => wanted.has(p.id)).map((p) => p.id);
}

export interface EpicGroup {
  /** Stable key: `m<milestoneId>` or `p<projectId>:none`. */
  key: string;
  project: ProjectDTO | undefined;
  /** null = epics without a milestone (listed after the project's milestones). */
  milestone: MilestoneDTO | null;
  epics: EpicDTO[];
}

/**
 * Epics of the given projects grouped by milestone: per project (in scope order) one group
 * per milestone in milestone order, then the epics without a milestone. Empty groups are
 * omitted; epics keep their position order.
 */
export function groupEpicsByMilestone(lookups: StructureLookups, projectIds: readonly number[]): EpicGroup[] {
  const groups: EpicGroup[] = [];
  for (const projectId of projectIds) {
    const epics = lookups.epicsByProject.get(projectId) ?? [];
    if (epics.length === 0) continue;
    const project = lookups.projectById.get(projectId);
    const milestones = lookups.milestonesByProject.get(projectId) ?? [];
    const known = new Set(milestones.map((m) => m.id));
    for (const milestone of milestones) {
      const inMilestone = epics.filter((e) => e.milestoneId === milestone.id);
      if (inMilestone.length > 0) groups.push({ key: `m${milestone.id}`, project, milestone, epics: inMilestone });
    }
    const loose = epics.filter((e) => e.milestoneId === null || !known.has(e.milestoneId));
    if (loose.length > 0) groups.push({ key: `p${projectId}:none`, project, milestone: null, epics: loose });
  }
  return groups;
}

/** Heading for an epic group; includes the project key when several projects are listed. */
export function epicGroupLabel(group: EpicGroup, multiProject: boolean): string {
  const name = group.milestone?.name ?? 'No milestone';
  return multiProject && group.project ? `${group.project.key} · ${name}` : name;
}

const fractionCache = new WeakMap<readonly StatusDTO[], Map<number, number>>();

/**
 * Pie fill of a 'started' status icon: started statuses (by position) split the range
 * evenly, so with "In Progress" and "In Review" the second looks further along. Other
 * categories return 0. Cached per statuses array (stable per bootstrap payload).
 */
export function statusFraction(status: Pick<StatusDTO, 'id' | 'category'>, statuses: readonly StatusDTO[]): number {
  if (status.category !== 'started') return 0;
  let map = fractionCache.get(statuses);
  if (!map) {
    const started = statuses.filter((s) => s.category === 'started').sort((a, b) => a.position - b.position || a.id - b.id);
    map = new Map(started.map((s, i) => [s.id, (i + 1) / (started.length + 1)]));
    fractionCache.set(statuses, map);
  }
  return map.get(status.id) ?? 0.5;
}
