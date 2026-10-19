// Optimistic wrappers around the project / milestone / epic mutations in api/projects.ts.
// The API hooks invalidate bootstrap after success; these wrappers additionally write the
// expected result into the bootstrap cache first (so pickers, names and order change
// immediately), roll back on failure and show toast.error. They never reject: they resolve
// to the server DTO, or undefined when the request failed (the toast already explained it).

import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import type { EpicUpdateInput, MilestoneUpdateInput, ProjectUpdateInput } from '@shared/schemas';
import type { BootstrapDTO, EpicDTO, MilestoneDTO, ProjectDTO } from '@shared/types';
import {
  useReorderEpics,
  useReorderMilestones,
  useReorderProjects,
  useUpdateEpic,
  useUpdateMilestone,
  useUpdateProject,
} from '../../api/projects';
import { qk } from '../../api/keys';
import { useSpaceId } from '../../app/space';
import { toast } from '../../components/ui';

type EntityKind = 'projects' | 'milestones' | 'epics';
interface EntityOf {
  projects: ProjectDTO;
  milestones: MilestoneDTO;
  epics: EpicDTO;
}

function stripUndefined<T extends object>(patch: T): Partial<T> {
  return Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Apply `patch` to one entity in the bootstrap cache. Returns a rollback that restores the previous entity. */
async function patchCachedEntity<K extends EntityKind>(
  qc: QueryClient,
  spaceId: string,
  kind: K,
  id: number,
  patch: Partial<EntityOf[K]>,
): Promise<() => void> {
  await qc.cancelQueries({ queryKey: qk.bootstrap(spaceId), exact: true });
  const list = qc.getQueryData<BootstrapDTO>(qk.bootstrap(spaceId))?.[kind] as EntityOf[K][] | undefined;
  const previous = list?.find((e) => e.id === id);
  if (!previous) return () => {};
  const replace = (value: EntityOf[K]) =>
    qc.setQueryData<BootstrapDTO>(qk.bootstrap(spaceId), (old) =>
      old ? { ...old, [kind]: (old[kind] as EntityOf[K][]).map((e) => (e.id === id ? value : e)) } : old,
    );
  replace({ ...previous, ...patch });
  return () => replace(previous);
}

/** Write new positions (index in `ids`) into the bootstrap cache. Returns a rollback. */
async function reorderCached(qc: QueryClient, spaceId: string, kind: EntityKind, ids: readonly number[]): Promise<() => void> {
  await qc.cancelQueries({ queryKey: qk.bootstrap(spaceId), exact: true });
  const list = qc.getQueryData<BootstrapDTO>(qk.bootstrap(spaceId))?.[kind];
  if (!list) return () => {};
  const before = new Map(list.map((e) => [e.id, e.position]));
  const index = new Map(ids.map((id, i) => [id, i]));
  const write = (position: (id: number, current: number) => number) =>
    qc.setQueryData<BootstrapDTO>(qk.bootstrap(spaceId), (old) =>
      old
        ? { ...old, [kind]: (old[kind] as Array<{ id: number; position: number }>).map((e) => ({ ...e, position: position(e.id, e.position) })) }
        : old,
    );
  write((id, current) => index.get(id) ?? current);
  return () => write((id, current) => before.get(id) ?? current);
}

async function run<T>(rollback: () => void, request: Promise<T>, success?: string): Promise<T | undefined> {
  try {
    const result = await request;
    if (success) toast.success(success);
    return result;
  } catch (err) {
    rollback();
    toast.error(err);
    return undefined;
  }
}

export function useSaveProject() {
  const sid = useSpaceId();
  const qc = useQueryClient();
  const { mutateAsync } = useUpdateProject();
  return useCallback(
    async (project: Pick<ProjectDTO, 'id'>, patch: ProjectUpdateInput, success?: string) => {
      const rollback = await patchCachedEntity(qc, sid, 'projects', project.id, stripUndefined(patch));
      return run(rollback, mutateAsync({ id: project.id, ...patch }), success);
    },
    [qc, sid, mutateAsync],
  );
}

export function useSaveMilestone() {
  const sid = useSpaceId();
  const qc = useQueryClient();
  const { mutateAsync } = useUpdateMilestone();
  return useCallback(
    async (milestone: Pick<MilestoneDTO, 'id'>, patch: MilestoneUpdateInput, success?: string) => {
      const rollback = await patchCachedEntity(qc, sid, 'milestones', milestone.id, stripUndefined(patch));
      return run(rollback, mutateAsync({ id: milestone.id, ...patch }), success);
    },
    [qc, sid, mutateAsync],
  );
}

export function useSaveEpic() {
  const sid = useSpaceId();
  const qc = useQueryClient();
  const { mutateAsync } = useUpdateEpic();
  return useCallback(
    async (epic: Pick<EpicDTO, 'id'>, patch: EpicUpdateInput, success?: string) => {
      const rollback = await patchCachedEntity(qc, sid, 'epics', epic.id, stripUndefined(patch));
      return run(rollback, mutateAsync({ id: epic.id, ...patch }), success);
    },
    [qc, sid, mutateAsync],
  );
}

/** Reorder a whole scope (all projects, or all milestones / epics of one project). */
export function useReorder(kind: EntityKind) {
  const sid = useSpaceId();
  const qc = useQueryClient();
  const projects = useReorderProjects();
  const milestones = useReorderMilestones();
  const epics = useReorderEpics();
  const mutateAsync = { projects, milestones, epics }[kind].mutateAsync;
  return useCallback(
    async (ids: number[]) => {
      const rollback = await reorderCached(qc, sid, kind, ids);
      return run(rollback, mutateAsync(ids));
    },
    [qc, sid, kind, mutateAsync],
  );
}
