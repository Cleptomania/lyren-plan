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
import { http, qs } from './client';
import { invalidateStructure } from './keys';

// ---- Projects --------------------------------------------------------------

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ProjectCreateInput) => http.post<ProjectDTO>('/projects', input),
    onSuccess: () => invalidateStructure(qc),
  });
}

export function useUpdateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: ProjectUpdateInput & { id: number }) => http.patch<ProjectDTO>(`/projects/${id}`, input),
    // key changes alter task refs; status 'archived' hides tasks from default filters
    onSuccess: () => invalidateStructure(qc, { tasks: true }),
  });
}

/** Deletes the project and EVERYTHING in it (milestones, epics, tasks, comments, logs). */
export function useDeleteProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => http.del<{ ok: true }>(`/projects/${id}`),
    onSuccess: () => invalidateStructure(qc, { tasks: true }),
  });
}

export function useReorderProjects() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: number[]) => http.post<{ ok: true }>('/projects/reorder', { ids }),
    onSuccess: () => invalidateStructure(qc),
  });
}

// ---- Milestones ------------------------------------------------------------

export function useCreateMilestone() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: MilestoneCreateInput) => http.post<MilestoneDTO>('/milestones', input),
    onSuccess: () => invalidateStructure(qc),
  });
}

export function useUpdateMilestone() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: MilestoneUpdateInput & { id: number }) =>
      http.patch<MilestoneDTO>(`/milestones/${id}`, input),
    onSuccess: () => invalidateStructure(qc),
  });
}

/** epics: 'detach' (default) keeps the epics without a milestone; 'delete' deletes them (their tasks are detached). */
export function useDeleteMilestone() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, epics = 'detach' }: { id: number; epics?: 'detach' | 'delete' }) =>
      http.del<{ ok: true }>(`/milestones/${id}${qs({ epics })}`),
    onSuccess: () => invalidateStructure(qc, { tasks: true }),
  });
}

/** ids: every milestone of ONE project, in the desired order. */
export function useReorderMilestones() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: number[]) => http.post<{ ok: true }>('/milestones/reorder', { ids }),
    onSuccess: () => invalidateStructure(qc),
  });
}

// ---- Epics -----------------------------------------------------------------

export function useCreateEpic() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: EpicCreateInput) => http.post<EpicDTO>('/epics', input),
    onSuccess: () => invalidateStructure(qc),
  });
}

export function useUpdateEpic() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: EpicUpdateInput & { id: number }) => http.patch<EpicDTO>(`/epics/${id}`, input),
    // moving an epic between milestones changes its tasks' derived milestoneId
    onSuccess: () => invalidateStructure(qc, { tasks: true }),
  });
}

/** tasks: 'detach' (default) keeps tasks without an epic; 'delete' deletes the epic's tasks too. */
export function useDeleteEpic() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, tasks = 'detach' }: { id: number; tasks?: 'detach' | 'delete' }) =>
      http.del<{ ok: true }>(`/epics/${id}${qs({ tasks })}`),
    onSuccess: () => invalidateStructure(qc, { tasks: true }),
  });
}

/** ids: every epic of ONE project, in the desired order. */
export function useReorderEpics() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: number[]) => http.post<{ ok: true }>('/epics/reorder', { ids }),
    onSuccess: () => invalidateStructure(qc),
  });
}
