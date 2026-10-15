// Comments, work logs and activity.

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { localToday } from '@shared/dates';
import type {
  CommentCreateInput,
  CommentUpdateInput,
  WorklogCreateInput,
  WorklogReportQuery,
  WorklogUpdateInput,
} from '@shared/schemas';
import type { ActivityPage, CommentDTO, TaskTimelineDTO, WorklogDTO, WorklogReportDTO } from '@shared/types';
import { http, qs } from './client';
import { invalidateTimeline, qk } from './keys';

export function useTaskTimeline(taskId: number | null | undefined) {
  return useQuery({
    queryKey: qk.timeline(taskId ?? 0),
    queryFn: () => http.get<TaskTimelineDTO>(`/tasks/${taskId}/timeline`),
    enabled: typeof taskId === 'number' && taskId > 0,
  });
}

export function useAddComment(taskId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CommentCreateInput) => http.post<CommentDTO>(`/tasks/${taskId}/comments`, input),
    onSuccess: () => invalidateTimeline(qc, taskId),
  });
}

export function useUpdateComment(taskId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: CommentUpdateInput & { id: number }) => http.patch<CommentDTO>(`/comments/${id}`, input),
    onSuccess: () => invalidateTimeline(qc, taskId),
  });
}

export function useDeleteComment(taskId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => http.del<{ ok: true }>(`/comments/${id}`),
    onSuccess: () => invalidateTimeline(qc, taskId),
  });
}

export function useAddWorklog(taskId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: WorklogCreateInput) => http.post<WorklogDTO>(`/tasks/${taskId}/worklogs`, input),
    onSuccess: () => invalidateTimeline(qc, taskId),
  });
}

export function useUpdateWorklog(taskId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: WorklogUpdateInput & { id: number }) => http.patch<WorklogDTO>(`/worklogs/${id}`, input),
    onSuccess: () => invalidateTimeline(qc, taskId),
  });
}

export function useDeleteWorklog(taskId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => http.del<{ ok: true }>(`/worklogs/${id}`),
    onSuccess: () => invalidateTimeline(qc, taskId),
  });
}

/** Activity feed (newest first), paged with a `before` cursor. */
export function useActivityFeed(params: { projectId?: number; taskId?: number; limit?: number } = {}) {
  return useInfiniteQuery({
    queryKey: qk.activity(params),
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) =>
      http.get<ActivityPage>(
        `/activity${qs({ projectId: params.projectId, taskId: params.taskId, limit: params.limit ?? 50, before: pageParam as number | undefined })}`,
      ),
    getNextPageParam: (last) => last.nextBefore ?? undefined,
  });
}

/** Work-log entries across tasks for a date range (inclusive). */
export function useWorklogReport(params: WorklogReportQuery) {
  return useQuery({
    queryKey: qk.worklogs(params),
    queryFn: () =>
      http.get<WorklogReportDTO>(`/worklogs${qs({ from: params.from, to: params.to, projectId: params.projectId, today: params.today ?? localToday() })}`),
  });
}
