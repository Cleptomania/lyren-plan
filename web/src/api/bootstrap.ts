// The bootstrap payload holds all small, frequently-needed lists. Components read
// it through useLookups(), which adds id->entity maps and sorted views.

import { useQuery } from '@tanstack/react-query';
import { localToday } from '@shared/dates';
import type { Settings } from '@shared/schemas';
import type {
  BoardDTO,
  BootstrapDTO,
  EpicDTO,
  MilestoneDTO,
  ProjectDTO,
  StatusDTO,
  TagDTO,
  UserDTO,
} from '@shared/types';
import { http } from './client';
import { qk } from './keys';

export function useBootstrap(enabled = true) {
  return useQuery({
    queryKey: qk.bootstrap,
    queryFn: () => http.get<BootstrapDTO>(`/bootstrap?today=${localToday()}`),
    staleTime: 30_000,
    enabled,
  });
}

export interface Lookups {
  user: UserDTO;
  settings: Settings;
  version: string;
  /** Ordered by position. */
  statuses: StatusDTO[];
  /** Ordered by name. */
  tags: TagDTO[];
  /** Ordered by position (includes archived; filter with p.status !== 'archived'). */
  projects: ProjectDTO[];
  /** Ordered by project position, then milestone position. */
  milestones: MilestoneDTO[];
  /** Ordered by project position, then epic position. */
  epics: EpicDTO[];
  /** Ordered by position. */
  boards: BoardDTO[];
  statusById: Map<number, StatusDTO>;
  tagById: Map<number, TagDTO>;
  projectById: Map<number, ProjectDTO>;
  milestoneById: Map<number, MilestoneDTO>;
  epicById: Map<number, EpicDTO>;
  boardById: Map<number, BoardDTO>;
  milestonesByProject: Map<number, MilestoneDTO[]>;
  epicsByProject: Map<number, EpicDTO[]>;
  epicsByMilestone: Map<number, EpicDTO[]>;
  /** Status used for new tasks when none is chosen (first 'unstarted', else first). */
  defaultStatus: StatusDTO | undefined;
}

function groupBy<T, K>(items: T[], key: (t: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const it of items) {
    const k = key(it);
    const arr = m.get(k);
    if (arr) arr.push(it);
    else m.set(k, [it]);
  }
  return m;
}

export function buildLookups(b: BootstrapDTO): Lookups {
  const statuses = [...b.statuses].sort((x, y) => x.position - y.position || x.id - y.id);
  const projects = [...b.projects].sort((x, y) => x.position - y.position || x.id - y.id);
  const projectOrder = new Map(projects.map((p, i) => [p.id, i]));
  const milestones = [...b.milestones].sort(
    (x, y) =>
      (projectOrder.get(x.projectId) ?? 0) - (projectOrder.get(y.projectId) ?? 0) ||
      x.position - y.position ||
      x.id - y.id,
  );
  const epics = [...b.epics].sort(
    (x, y) =>
      (projectOrder.get(x.projectId) ?? 0) - (projectOrder.get(y.projectId) ?? 0) ||
      x.position - y.position ||
      x.id - y.id,
  );
  const tags = [...b.tags].sort((x, y) => x.name.localeCompare(y.name, undefined, { sensitivity: 'base' }));
  const boards = [...b.boards].sort((x, y) => x.position - y.position || x.id - y.id);
  const epicsByMilestone = new Map<number, EpicDTO[]>();
  for (const e of epics) {
    if (e.milestoneId === null) continue;
    const arr = epicsByMilestone.get(e.milestoneId);
    if (arr) arr.push(e);
    else epicsByMilestone.set(e.milestoneId, [e]);
  }
  return {
    user: b.user,
    settings: b.settings,
    version: b.version,
    statuses,
    tags,
    projects,
    milestones,
    epics,
    boards,
    statusById: new Map(statuses.map((s) => [s.id, s])),
    tagById: new Map(tags.map((t) => [t.id, t])),
    projectById: new Map(projects.map((p) => [p.id, p])),
    milestoneById: new Map(milestones.map((m) => [m.id, m])),
    epicById: new Map(epics.map((e) => [e.id, e])),
    boardById: new Map(boards.map((x) => [x.id, x])),
    milestonesByProject: groupBy(milestones, (m) => m.projectId),
    epicsByProject: groupBy(epics, (e) => e.projectId),
    epicsByMilestone,
    defaultStatus: statuses.find((s) => s.category === 'unstarted') ?? statuses[0],
  };
}

const lookupsCache = new WeakMap<BootstrapDTO, Lookups>();

/** Memoized per bootstrap payload: every component shares one Lookups object. */
export function getLookups(b: BootstrapDTO): Lookups {
  let l = lookupsCache.get(b);
  if (!l) {
    l = buildLookups(b);
    lookupsCache.set(b, l);
  }
  return l;
}

/**
 * Lookups from the bootstrap cache. Only call inside the authenticated app shell,
 * which renders children after bootstrap has loaded — so this never returns undefined there.
 */
export function useLookups(): Lookups {
  const { data } = useBootstrap();
  if (!data) throw new Error('useLookups() used before bootstrap data loaded');
  return getLookups(data);
}
