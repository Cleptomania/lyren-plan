// Projects, milestones and epics. Lists come from bootstrap (useLookups);
// these hooks cover mutations.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  EpicCreateInput,
  EpicUpdateInput,
  MilestoneCreateInput,
  MilestoneUpdateInput,
  ProjectCreateInput,
  ProjectUpdateInput,
} from '@shared/schemas';
import type { EpicDTO, MilestoneDTO, ProjectDTO } from '@shared/types';
import { useSpaceId } from '../app/space';
import { qs, spaceApi } from './client';
import { invalidateStructure } from './keys';

// ---- Projects --------------------------------------------------------------

export function useCreateProject() {
  const sid = useSpaceId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ProjectCreateInput) => spaceApi(sid).post<ProjectDTO>('/projects', input),
    onSuccess: () => invalidateStructure(qc, sid),
  });
}

export function useUpdateProject() {
  const sid = useSpaceId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: ProjectUpdateInput & { id: number }) => spaceApi(sid).patch<ProjectDTO>(`/projects/${id}`, input),
    // key changes alter task refs; status 'archived' hides tasks from default filters
    onSuccess: () => invalidateStructure(qc, sid, { tasks: true }),
  });
}

/** Deletes the project and EVERYTHING in it (milestones, epics, tasks, comments, logs). */
export function useDeleteProject() {
  const sid = useSpaceId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => spaceApi(sid).del<{ ok: true }>(`/projects/${id}`),
    onSuccess: () => invalidateStructure(qc, sid, { tasks: true }),
  });
}

export function useReorderProjects() {
  const sid = useSpaceId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: number[]) => spaceApi(sid).post<{ ok: true }>('/projects/reorder', { ids }),
    onSuccess: () => invalidateStructure(qc, sid),
  });
}

// ---- Milestones ------------------------------------------------------------

export function useCreateMilestone() {
  const sid = useSpaceId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: MilestoneCreateInput) => spaceApi(sid).post<MilestoneDTO>('/milestones', input),
    onSuccess: () => invalidateStructure(qc, sid),
  });
}

export function useUpdateMilestone() {
  const sid = useSpaceId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: MilestoneUpdateInput & { id: number }) =>
      spaceApi(sid).patch<MilestoneDTO>(`/milestones/${id}`, input),
    onSuccess: () => invalidateStructure(qc, sid),
  });
}

/** epics: 'detach' (default) keeps the epics without a milestone; 'delete' deletes them (their tasks are detached). */
export function useDeleteMilestone() {
  const sid = useSpaceId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, epics = 'detach' }: { id: number; epics?: 'detach' | 'delete' }) =>
      spaceApi(sid).del<{ ok: true }>(`/milestones/${id}${qs({ epics })}`),
    onSuccess: () => invalidateStructure(qc, sid, { tasks: true }),
  });
}

/** ids: every milestone of ONE project, in the desired order. */
export function useReorderMilestones() {
  const sid = useSpaceId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: number[]) => spaceApi(sid).post<{ ok: true }>('/milestones/reorder', { ids }),
    onSuccess: () => invalidateStructure(qc, sid),
  });
}

// ---- Epics -----------------------------------------------------------------

export function useCreateEpic() {
  const sid = useSpaceId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: EpicCreateInput) => spaceApi(sid).post<EpicDTO>('/epics', input),
    onSuccess: () => invalidateStructure(qc, sid),
  });
}

export function useUpdateEpic() {
  const sid = useSpaceId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: EpicUpdateInput & { id: number }) => spaceApi(sid).patch<EpicDTO>(`/epics/${id}`, input),
    // moving an epic between milestones changes its tasks' derived milestoneId
    onSuccess: () => invalidateStructure(qc, sid, { tasks: true }),
  });
}

/** tasks: 'detach' (default) keeps tasks without an epic; 'delete' deletes the epic's tasks too. */
export function useDeleteEpic() {
  const sid = useSpaceId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, tasks = 'detach' }: { id: number; tasks?: 'detach' | 'delete' }) =>
      spaceApi(sid).del<{ ok: true }>(`/epics/${id}${qs({ tasks })}`),
    onSuccess: () => invalidateStructure(qc, sid, { tasks: true }),
  });
}

/** ids: every epic of ONE project, in the desired order. */
export function useReorderEpics() {
  const sid = useSpaceId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: number[]) => spaceApi(sid).post<{ ok: true }>('/epics/reorder', { ids }),
    onSuccess: () => invalidateStructure(qc, sid),
  });
}
