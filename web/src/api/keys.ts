// React Query keys + shared invalidation helpers.
//
// Every key of a space's data starts with ['space', spaceId] (design §12.4): the same ids exist in
// every space, so a request or mutation still in flight from one space can never write into what
// another space reads, and switching back to a recent space shows its data at once. The helpers
// below take the space id the caller captured when it started (useSpaceId()), not the current one.
//
// Cache layout:
//   ['auth','status']                         AuthStatusDTO (the account, its spaces and preferences)
//   ['auth','link',kind,token]                what a link's token opens (SignupPreviewDTO, PasswordResetPreviewDTO,
//                                             InvitationPreviewDTO); in memory only, dropped once the link is used
//   ['account','sessions']                    SessionDTO[]
//   ['account','passkeys']                    PasskeyDTO[]
//   ['account','security-events']             SecurityEventDTO[] (infinite)
//   ['account','invitations']                 PendingInvitationDTO[] (to the account's verified address)
//   ['spaces','list'] · ['spaces','deleted']  SpaceSummaryDTO[] · DeletedSpaceDTO[]
//   ['spaces',id,'detail'|'members'|'invitations']   SpaceDetailDTO · MemberDTO[] · InvitationDTO[]
//   ['admin','overview']                      AdminOverviewDTO
//   ['admin','users','list',q,orphaned] · ['admin','users',id]   Page<AdminUserDTO> (infinite) · AdminUserDetailDTO
//   ['admin','invitations'] · ['admin','spaces',q]      InvitationDTO[] · Page<AdminSpaceDTO> (infinite)
//   ['space',id,'bootstrap']                  BootstrapDTO — user, space, people, settings, statuses,
//                                             tags, projects (+stats), milestones (+stats), epics
//                                             (+stats), boards. Small; refetched after any change to
//                                             those entities or to tasks (stats depend on tasks).
//   ['space',id,'tasks','query',input]        TaskQueryResult for POST /tasks/query
//   ['space',id,'tasks','detail',taskId]      TaskDTO
//   ['space',id,'tasks','ref',ref]            TaskDTO
//   ['space',id,'tasks','timeline',taskId]    TaskTimelineDTO
//   ['space',id,'activity',params]            ActivityPage (infinite)
//   ['space',id,'worklogs',params]            WorklogReportDTO
//   ['space',id,'dashboard',today,weekStart]  DashboardDTO
//   ['space',id,'search',q]                   SearchResultDTO

import type { Query, QueryClient } from '@tanstack/react-query';
import type { TaskQueryInput, WorklogReportQuery } from '@shared/schemas';

export const qk = {
  // ---- The directory: the account, its spaces, the instance --------------------------------------
  authStatus: ['auth', 'status'] as const,
  linkPreviews: ['auth', 'link'] as const,
  linkPreview: (kind: 'signup' | 'reset' | 'invitation', token: string) => ['auth', 'link', kind, token] as const,
  sessions: ['account', 'sessions'] as const,
  passkeys: ['account', 'passkeys'] as const,
  securityEvents: ['account', 'security-events'] as const,
  pendingInvitations: ['account', 'invitations'] as const,
  spacesAll: ['spaces'] as const,
  spaces: ['spaces', 'list'] as const,
  deletedSpaces: ['spaces', 'deleted'] as const,
  spaceDetail: (spaceId: string) => ['spaces', spaceId, 'detail'] as const,
  members: (spaceId: string) => ['spaces', spaceId, 'members'] as const,
  invitations: (spaceId: string) => ['spaces', spaceId, 'invitations'] as const,
  adminAll: ['admin'] as const,
  adminOverview: ['admin', 'overview'] as const,
  adminUsers: (q: string, orphaned: boolean) => ['admin', 'users', 'list', q, orphaned] as const,
  adminUser: (userId: number) => ['admin', 'users', userId] as const,
  adminInvitations: ['admin', 'invitations'] as const,
  adminSpaces: (q: string) => ['admin', 'spaces', q] as const,

  // ---- One space's data ---------------------------------------------------------------------------
  space: (spaceId: string) => ['space', spaceId] as const,
  bootstrap: (spaceId: string) => ['space', spaceId, 'bootstrap'] as const,
  tasksAll: (spaceId: string) => ['space', spaceId, 'tasks'] as const,
  taskQueries: (spaceId: string) => ['space', spaceId, 'tasks', 'query'] as const,
  taskQuery: (spaceId: string, input: TaskQueryInput) => ['space', spaceId, 'tasks', 'query', input] as const,
  taskDetails: (spaceId: string) => ['space', spaceId, 'tasks', 'detail'] as const,
  task: (spaceId: string, id: number) => ['space', spaceId, 'tasks', 'detail', id] as const,
  taskByRef: (spaceId: string, ref: string) => ['space', spaceId, 'tasks', 'ref', ref.toUpperCase()] as const,
  timeline: (spaceId: string, taskId: number) => ['space', spaceId, 'tasks', 'timeline', taskId] as const,
  activityAll: (spaceId: string) => ['space', spaceId, 'activity'] as const,
  activity: (spaceId: string, params: { projectId?: number; taskId?: number; limit?: number }) =>
    ['space', spaceId, 'activity', params] as const,
  worklogsAll: (spaceId: string) => ['space', spaceId, 'worklogs'] as const,
  worklogs: (spaceId: string, params: WorklogReportQuery) => ['space', spaceId, 'worklogs', params] as const,
  dashboardAll: (spaceId: string) => ['space', spaceId, 'dashboard'] as const,
  dashboard: (spaceId: string, today: string, weekStartsOn: number) => ['space', spaceId, 'dashboard', today, weekStartsOn] as const,
  searchAll: (spaceId: string) => ['space', spaceId, 'search'] as const,
  search: (spaceId: string, q: string) => ['space', spaceId, 'search', q] as const,
};

/** The space a query key belongs to (['space', id, …]), or null for the directory's keys. */
export function spaceOfKey(queryKey: readonly unknown[]): string | null {
  return queryKey[0] === 'space' && typeof queryKey[1] === 'string' ? queryKey[1] : null;
}

/**
 * After any task create/update/delete/move in `spaceId`. `except` leaves matching tasks queries
 * alone (a deleted task's own detail/timeline must not be refetched into a 404).
 */
export function invalidateTasks(qc: QueryClient, spaceId: string, except?: (query: Query) => boolean): Promise<unknown> {
  return Promise.all([
    qc.invalidateQueries({ queryKey: qk.tasksAll(spaceId), ...(except && { predicate: (q: Query) => !except(q) }) }),
    qc.invalidateQueries({ queryKey: qk.bootstrap(spaceId) }),
    qc.invalidateQueries({ queryKey: qk.dashboardAll(spaceId) }),
    qc.invalidateQueries({ queryKey: qk.activityAll(spaceId) }),
    qc.invalidateQueries({ queryKey: qk.searchAll(spaceId) }),
    qc.invalidateQueries({ queryKey: qk.worklogsAll(spaceId) }),
  ]);
}

/** After project/milestone/epic/tag/status/board/settings changes in `spaceId`. */
export function invalidateStructure(qc: QueryClient, spaceId: string, opts: { tasks?: boolean } = {}): Promise<unknown> {
  const jobs: Promise<unknown>[] = [
    qc.invalidateQueries({ queryKey: qk.bootstrap(spaceId) }),
    qc.invalidateQueries({ queryKey: qk.activityAll(spaceId) }),
    qc.invalidateQueries({ queryKey: qk.searchAll(spaceId) }),
  ];
  if (opts.tasks) {
    jobs.push(
      qc.invalidateQueries({ queryKey: qk.tasksAll(spaceId) }),
      qc.invalidateQueries({ queryKey: qk.dashboardAll(spaceId) }),
      qc.invalidateQueries({ queryKey: qk.worklogsAll(spaceId) }),
    );
  }
  return Promise.all(jobs);
}

/** After comment / work-log changes on one task of `spaceId`. */
export function invalidateTimeline(qc: QueryClient, spaceId: string, taskId: number): Promise<unknown> {
  return Promise.all([
    qc.invalidateQueries({ queryKey: qk.timeline(spaceId, taskId) }),
    // commentCount / worklogMinutes live on TaskDTO
    qc.invalidateQueries({ queryKey: qk.tasksAll(spaceId) }),
    qc.invalidateQueries({ queryKey: qk.activityAll(spaceId) }),
    qc.invalidateQueries({ queryKey: qk.worklogsAll(spaceId) }),
    qc.invalidateQueries({ queryKey: qk.dashboardAll(spaceId) }),
  ]);
}
