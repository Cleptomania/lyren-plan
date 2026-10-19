// A space's structure and people (its settings pages): tags, statuses, the space settings with the
// account's preferences, and the authorship of former members' and imported entries. The archive's export and
// import are api/importExport.ts.

import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type {
  PeopleReassignInput,
  PreferencesUpdateInput,
  SpaceSettings,
  SpaceSettingsUpdateInput,
  StatusCreateInput,
  StatusUpdateInput,
  TagCreateInput,
  TagUpdateInput,
  UserPreferences,
} from '@shared/schemas';
import type { AuthStatusDTO, BootstrapDTO, PeopleDisownedDTO, PeopleReassignedDTO, StatusDTO, TagDTO } from '@shared/types';
import { useSpaceId } from '../app/space';
import { definedPreferences } from './account';
import { http, qs, spaceApi } from './client';
import { invalidateStructure, qk } from './keys';

// ---- Tags ------------------------------------------------------------------

export function useCreateTag() {
  const sid = useSpaceId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: TagCreateInput) => spaceApi(sid).post<TagDTO>('/tags', input),
    onSuccess: () => invalidateStructure(qc, sid),
  });
}

export function useUpdateTag() {
  const sid = useSpaceId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: TagUpdateInput & { id: number }) => spaceApi(sid).patch<TagDTO>(`/tags/${id}`, input),
    onSuccess: () => invalidateStructure(qc, sid, { tasks: true }),
  });
}

export function useDeleteTag() {
  const sid = useSpaceId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => spaceApi(sid).del<{ ok: true }>(`/tags/${id}`),
    onSuccess: () => invalidateStructure(qc, sid, { tasks: true }),
  });
}

/** Re-tag every task tagged `id` with `targetId`, then delete `id`. */
export function useMergeTag() {
  const sid = useSpaceId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, targetId }: { id: number; targetId: number }) => spaceApi(sid).post<TagDTO>(`/tags/${id}/merge`, { targetId }),
    onSuccess: () => invalidateStructure(qc, sid, { tasks: true }),
  });
}

// ---- Statuses --------------------------------------------------------------

export function useCreateStatus() {
  const sid = useSpaceId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: StatusCreateInput) => spaceApi(sid).post<StatusDTO>('/statuses', input),
    onSuccess: () => invalidateStructure(qc, sid),
  });
}

export function useUpdateStatus() {
  const sid = useSpaceId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: StatusUpdateInput & { id: number }) => spaceApi(sid).patch<StatusDTO>(`/statuses/${id}`, input),
    onSuccess: () => invalidateStructure(qc, sid, { tasks: true }),
  });
}

/** reassignTo is required when tasks still use the status. */
export function useDeleteStatus() {
  const sid = useSpaceId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reassignTo }: { id: number; reassignTo?: number }) => spaceApi(sid).del<{ ok: true }>(`/statuses/${id}${qs({ reassignTo })}`),
    onSuccess: () => invalidateStructure(qc, sid, { tasks: true }),
  });
}

export function useReorderStatuses() {
  const sid = useSpaceId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: number[]) => spaceApi(sid).post<{ ok: true }>('/statuses/reorder', { ids }),
    onSuccess: () => invalidateStructure(qc, sid, { tasks: true }),
  });
}

// ---- Settings ----------------------------------------------------------------

/** A change to the merged settings: the space's (estimate unit, default board) and the account's preferences. */
export type SettingsPatch = SpaceSettingsUpdateInput & PreferencesUpdateInput;

/** The space's part and the account's part of a settings patch, each null when the patch names none of it. */
export function splitSettingsPatch(patch: SettingsPatch): { space: Partial<SpaceSettings> | null; preferences: Partial<UserPreferences> | null } {
  const space: Partial<SpaceSettings> = {
    ...(patch.estimateUnit !== undefined && { estimateUnit: patch.estimateUnit }),
    ...(patch.defaultBoardId !== undefined && { defaultBoardId: patch.defaultBoardId }),
  };
  const preferences = definedPreferences(patch);
  return {
    space: Object.keys(space).length > 0 ? space : null,
    preferences: Object.keys(preferences).length > 0 ? preferences : null,
  };
}

interface SettingsContext {
  boot: BootstrapDTO | undefined;
  status: AuthStatusDTO | undefined;
}

/**
 * Options of useUpdateSettings in `spaceId` (exported for tests): PATCH /api/s/:id/settings for the
 * space's part and PATCH /api/account/preferences for the account's, both applied at once to their
 * caches (the space's bootstrap, the auth status) and rolled back when the request fails.
 */
export function updateSettingsOptions(qc: QueryClient, spaceId: string) {
  return {
    mutationFn: async (patch: SettingsPatch): Promise<void> => {
      const { space, preferences } = splitSettingsPatch(patch);
      await Promise.all([
        space ? spaceApi(spaceId).patch<SpaceSettings>('/settings', space) : null,
        preferences ? http.patch<UserPreferences>('/account/preferences', preferences) : null,
      ]);
    },
    onMutate: async (patch: SettingsPatch): Promise<SettingsContext> => {
      const { space, preferences } = splitSettingsPatch(patch);
      await Promise.all([qc.cancelQueries({ queryKey: qk.bootstrap(spaceId) }), qc.cancelQueries({ queryKey: qk.authStatus })]);
      const boot = qc.getQueryData<BootstrapDTO>(qk.bootstrap(spaceId));
      const status = qc.getQueryData<AuthStatusDTO>(qk.authStatus);
      if (boot && space) qc.setQueryData<BootstrapDTO>(qk.bootstrap(spaceId), { ...boot, settings: { ...boot.settings, ...space } });
      if (status?.preferences && preferences) {
        qc.setQueryData<AuthStatusDTO>(qk.authStatus, { ...status, preferences: { ...status.preferences, ...preferences } });
      }
      return { boot, status };
    },
    onError: (_err: Error, patch: SettingsPatch, ctx: SettingsContext | undefined) => {
      const { space, preferences } = splitSettingsPatch(patch);
      if (space && ctx?.boot) qc.setQueryData(qk.bootstrap(spaceId), ctx.boot);
      if (preferences && ctx?.status) qc.setQueryData(qk.authStatus, ctx.status);
    },
    onSettled: () => Promise.all([invalidateStructure(qc, spaceId, { tasks: true }), qc.invalidateQueries({ queryKey: qk.authStatus })]),
  };
}

/** Saves the merged settings a patch names: the space's settings and the account's preferences. */
export function useUpdateSettings() {
  const sid = useSpaceId();
  const qc = useQueryClient();
  return useMutation(updateSettingsOptions(qc, sid));
}

// ---- People (design §8.6) ----------------------------------------------------------------------

/**
 * Move the tasks, comments, work logs and activity of a former member or a placeholder (`personId`, negative
 * for a placeholder) to a member (admins and owners). The space's lists name people, so all of it is read again.
 */
export function useReassignPerson() {
  const sid = useSpaceId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ personId, toUserId }: { personId: number; toUserId: number }) =>
      spaceApi(sid).post<PeopleReassignedDTO>(`/people/${personId}/reassign`, { toUserId } satisfies PeopleReassignInput),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.space(sid) }),
  });
}

/** Give up the imported comments, work logs and activity attributed to the viewer: they go to "Unknown (imported)". */
export function useDisownImported() {
  const sid = useSpaceId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => spaceApi(sid).post<PeopleDisownedDTO>('/people/me/disown'),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.space(sid) }),
  });
}
