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
import { useSpaceId } from '../app/space';
import { qs, spaceApi } from './client';
import { invalidateTimeline, qk } from './keys';

export function useTaskTimeline(taskId: number | null | undefined) {
  const sid = useSpaceId();
  return useQuery({
    queryKey: qk.timeline(sid, taskId ?? 0),
    queryFn: () => spaceApi(sid).get<TaskTimelineDTO>(`/tasks/${taskId}/timeline`),
    enabled: typeof taskId === 'number' && taskId > 0,
  });
}

export function useAddComment(taskId: number) {
  const sid = useSpaceId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CommentCreateInput) => spaceApi(sid).post<CommentDTO>(`/tasks/${taskId}/comments`, input),
    onSuccess: () => invalidateTimeline(qc, sid, taskId),
  });
}

export function useUpdateComment(taskId: number) {
  const sid = useSpaceId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: CommentUpdateInput & { id: number }) => spaceApi(sid).patch<CommentDTO>(`/comments/${id}`, input),
    onSuccess: () => invalidateTimeline(qc, sid, taskId),
  });
}

export function useDeleteComment(taskId: number) {
  const sid = useSpaceId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => spaceApi(sid).del<{ ok: true }>(`/comments/${id}`),
    onSuccess: () => invalidateTimeline(qc, sid, taskId),
  });
}

export function useAddWorklog(taskId: number) {
  const sid = useSpaceId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: WorklogCreateInput) => spaceApi(sid).post<WorklogDTO>(`/tasks/${taskId}/worklogs`, input),
    onSuccess: () => invalidateTimeline(qc, sid, taskId),
  });
}

export function useUpdateWorklog(taskId: number) {
  const sid = useSpaceId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: WorklogUpdateInput & { id: number }) => spaceApi(sid).patch<WorklogDTO>(`/worklogs/${id}`, input),
    onSuccess: () => invalidateTimeline(qc, sid, taskId),
  });
}

export function useDeleteWorklog(taskId: number) {
  const sid = useSpaceId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => spaceApi(sid).del<{ ok: true }>(`/worklogs/${id}`),
    onSuccess: () => invalidateTimeline(qc, sid, taskId),
  });
}

/** Activity feed (newest first), paged with a `before` cursor. */
export function useActivityFeed(params: { projectId?: number; taskId?: number; limit?: number } = {}) {
  const sid = useSpaceId();
  return useInfiniteQuery({
    queryKey: qk.activity(sid, params),
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) => {
      const query = qs({ projectId: params.projectId, taskId: params.taskId, limit: params.limit ?? 50, before: pageParam as number | undefined });
      return spaceApi(sid).get<ActivityPage>(`/activity${query}`);
    },
    getNextPageParam: (last) => last.nextBefore ?? undefined,
  });
}

/** Work-log entries across tasks for a date range (inclusive). */
export function useWorklogReport(params: WorklogReportQuery) {
  const sid = useSpaceId();
  return useQuery({
    queryKey: qk.worklogs(sid, params),
    queryFn: () =>
      spaceApi(sid).get<WorklogReportDTO>(`/worklogs${qs({ from: params.from, to: params.to, projectId: params.projectId, today: params.today ?? localToday() })}`),
  });
}
