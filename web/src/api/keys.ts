// React Query keys + shared invalidation helpers.
//
// Cache layout:
//   ['auth','status']            AuthStatusDTO
//   ['auth','sessions']          SessionDTO[]
//   ['bootstrap']                BootstrapDTO — user, settings, statuses, tags, projects (+stats),
//                                milestones (+stats), epics (+stats), boards. Small; refetched after
//                                any change to those entities or to tasks (stats depend on tasks).
//   ['tasks', 'query', input]    TaskQueryResult for POST /tasks/query
//   ['tasks', 'detail', id]      TaskDTO
//   ['tasks', 'ref', ref]        TaskDTO
//   ['tasks', 'timeline', id]    TaskTimelineDTO
//   ['activity', params]         ActivityPage (infinite)
//   ['worklogs', params]         WorklogReportDTO
//   ['dashboard', today]         DashboardDTO
//   ['search', q]                SearchResultDTO

import type { Query, QueryClient } from '@tanstack/react-query';
import type { TaskQueryInput, WorklogReportQuery } from '@shared/schemas';

export const qk = {
  authStatus: ['auth', 'status'] as const,
  sessions: ['auth', 'sessions'] as const,
  bootstrap: ['bootstrap'] as const,
  tasksAll: ['tasks'] as const,
  taskQuery: (input: TaskQueryInput) => ['tasks', 'query', input] as const,
  task: (id: number) => ['tasks', 'detail', id] as const,
  taskByRef: (ref: string) => ['tasks', 'ref', ref.toUpperCase()] as const,
  timeline: (taskId: number) => ['tasks', 'timeline', taskId] as const,
  activityAll: ['activity'] as const,
  activity: (params: { projectId?: number; taskId?: number; limit?: number }) => ['activity', params] as const,
  worklogsAll: ['worklogs'] as const,
  worklogs: (params: WorklogReportQuery) => ['worklogs', params] as const,
  dashboardAll: ['dashboard'] as const,
  dashboard: (today: string) => ['dashboard', today] as const,
  searchAll: ['search'] as const,
  search: (q: string) => ['search', q] as const,
};

/**
 * After any task create/update/delete/move. `except` leaves matching ['tasks', …] queries
 * alone (a deleted task's own detail/timeline must not be refetched into a 404).
 */
export function invalidateTasks(qc: QueryClient, except?: (query: Query) => boolean): Promise<unknown> {
  return Promise.all([
    qc.invalidateQueries({ queryKey: qk.tasksAll, ...(except && { predicate: (q: Query) => !except(q) }) }),
    qc.invalidateQueries({ queryKey: qk.bootstrap }),
    qc.invalidateQueries({ queryKey: qk.dashboardAll }),
    qc.invalidateQueries({ queryKey: qk.activityAll }),
    qc.invalidateQueries({ queryKey: qk.searchAll }),
    qc.invalidateQueries({ queryKey: qk.worklogsAll }),
  ]);
}

/** After project/milestone/epic/tag/status/board/settings changes. */
export function invalidateStructure(qc: QueryClient, opts: { tasks?: boolean } = {}): Promise<unknown> {
  const jobs: Promise<unknown>[] = [
    qc.invalidateQueries({ queryKey: qk.bootstrap }),
    qc.invalidateQueries({ queryKey: qk.activityAll }),
    qc.invalidateQueries({ queryKey: qk.searchAll }),
  ];
  if (opts.tasks) {
    jobs.push(
      qc.invalidateQueries({ queryKey: qk.tasksAll }),
      qc.invalidateQueries({ queryKey: qk.dashboardAll }),
      qc.invalidateQueries({ queryKey: qk.worklogsAll }),
    );
  }
  return Promise.all(jobs);
}

/** After comment / work-log changes on one task. */
export function invalidateTimeline(qc: QueryClient, taskId: number): Promise<unknown> {
  return Promise.all([
    qc.invalidateQueries({ queryKey: qk.timeline(taskId) }),
    // commentCount / worklogMinutes live on TaskDTO
    qc.invalidateQueries({ queryKey: qk.tasksAll }),
    qc.invalidateQueries({ queryKey: qk.activityAll }),
    qc.invalidateQueries({ queryKey: qk.worklogsAll }),
    qc.invalidateQueries({ queryKey: qk.dashboardAll }),
  ]);
}
