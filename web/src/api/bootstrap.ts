// The bootstrap payload of a space holds all its small, frequently-needed lists. Components read
// it through useLookups(), which adds id->entity maps and sorted views, and merges the
// account's preferences (AuthStatusDTO.preferences) into the space's settings.

import { useQuery } from '@tanstack/react-query';
import { localToday } from '@shared/dates';
import { spacePermissions, type SpacePermissions } from '@shared/roles';
import { DEFAULT_PREFERENCES, type Settings, type UserPreferences } from '@shared/schemas';
import type {
  BoardDTO,
  BootstrapDTO,
  EpicDTO,
  MilestoneDTO,
  PersonDTO,
  ProjectDTO,
  SpaceInfoDTO,
  StatusDTO,
  TagDTO,
  UserRef,
} from '@shared/types';
import { useSpaceId } from '../app/space';
import { useAuthStatus } from './auth';
import { spaceApi } from './client';
import { qk } from './keys';

/** The query options of a space's bootstrap (SpaceLayout loads it; useLookups reads it). */
export function bootstrapQuery(spaceId: string) {
  return {
    queryKey: qk.bootstrap(spaceId),
    queryFn: () => spaceApi(spaceId).get<BootstrapDTO>(`/bootstrap?today=${localToday()}`),
    staleTime: 30_000,
  };
}

export function useBootstrap(spaceId: string, enabled = true) {
  return useQuery({ ...bootstrapQuery(spaceId), enabled });
}

export interface Lookups {
  /** The viewer (the account itself: useAccount). */
  user: UserRef;
  /** The space as its bootstrap names it, with the viewer's role. */
  space: SpaceInfoDTO;
  /** What the viewer's role may do here (the space context's, as of this bootstrap). */
  permissions: SpacePermissions;
  /** Everyone the space's content can name: members, former members, placeholders (by display name). */
  people: PersonDTO[];
  personById: Map<number, PersonDTO>;
  /** The space's settings and the account's preferences. */
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

export function buildLookups(b: BootstrapDTO, preferences: UserPreferences | null = null): Lookups {
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
    space: b.space,
    permissions: spacePermissions(b.space.role),
    people: b.people,
    personById: new Map(b.people.map((p) => [p.id, p])),
    settings: { ...DEFAULT_PREFERENCES, ...b.settings, ...preferences },
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

const lookupsCache = new WeakMap<BootstrapDTO, { preferences: UserPreferences | null; lookups: Lookups }>();

/** Memoized per bootstrap payload and preferences: every component shares one Lookups object. */
export function getLookups(b: BootstrapDTO, preferences: UserPreferences | null = null): Lookups {
  let entry = lookupsCache.get(b);
  if (!entry || entry.preferences !== preferences) {
    entry = { preferences, lookups: buildLookups(b, preferences) };
    lookupsCache.set(b, entry);
  }
  return entry.lookups;
}

/**
 * Lookups from the space's bootstrap cache. Only call inside a space (SpaceLayout), which renders
 * its pages once their bootstrap has loaded — so this never throws there.
 */
export function useLookups(): Lookups {
  const { data } = useBootstrap(useSpaceId());
  const preferences = useAuthStatus().data?.preferences ?? null;
  if (!data) throw new Error('useLookups() used before bootstrap data loaded');
  return getLookups(data, preferences);
}
