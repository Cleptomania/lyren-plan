// The account's spaces and their members (design §7.2, /api/spaces…): the list, creating, renaming,
// deleting and restoring spaces, the members list, role changes, removing, leaving and transferring.
// Invitations are api/invitations.ts. The auth status lists the account's spaces too
// (AuthStatusDTO.spaces, which SpaceLayout reads), so every change here refreshes it.

import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { MemberRoleInput, SpaceCreateInput, SpaceDeleteInput, SpaceUpdateInput, TransferInput } from '@shared/schemas';
import type { DeletedSpaceDTO, MemberDTO, SpaceDetailDTO, SpaceSummaryDTO } from '@shared/types';
import { forgetEtags, http, request, retainEtags } from './client';
import { qk, spaceOfKey } from './keys';

/**
 * Forget a space the account left or lost (removed, deleted, gone from the auth status): its
 * queries, the directory's about it (detail, members) and its conditional-read memory.
 */
export function forgetSpace(qc: QueryClient, spaceId: string): void {
  qc.removeQueries({ queryKey: qk.space(spaceId) });
  qc.removeQueries({ queryKey: ['spaces', spaceId] });
  forgetEtags(spaceId);
}

/**
 * Forget every cached space that is not among `spaceIds` (the account's spaces now), and the
 * conditional-read memory of any other, also of one whose queries the cache dropped long ago.
 */
export function forgetLostSpaces(qc: QueryClient, spaceIds: readonly string[]): void {
  const keep = new Set(spaceIds);
  const cached = new Set(qc.getQueryCache().getAll().map((q) => spaceOfKey(q.queryKey)));
  for (const id of cached) if (id !== null && !keep.has(id)) forgetSpace(qc, id);
  retainEtags(spaceIds);
}

/** After a change to the account's spaces: the auth status lists them, and the pages below. */
export function refreshSpaces(qc: QueryClient): Promise<unknown> {
  return Promise.all([qc.invalidateQueries({ queryKey: qk.authStatus }), qc.invalidateQueries({ queryKey: qk.spacesAll })]);
}

export function useSpaces() {
  return useQuery({ queryKey: qk.spaces, queryFn: () => http.get<SpaceSummaryDTO[]>('/spaces') });
}

/** Deleted spaces the account can still restore (owners). */
export function useDeletedSpaces() {
  return useQuery({ queryKey: qk.deletedSpaces, queryFn: () => http.get<DeletedSpaceDTO[]>('/spaces/deleted') });
}

export function useSpaceDetail(spaceId: string) {
  return useQuery({ queryKey: qk.spaceDetail(spaceId), queryFn: () => http.get<SpaceDetailDTO>(`/spaces/${spaceId}`) });
}

export function useCreateSpace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SpaceCreateInput) => http.post<SpaceSummaryDTO>('/spaces', input),
    // Awaited: SpaceLayout opens a space once the auth status lists it.
    onSuccess: () => refreshSpaces(qc),
  });
}

/** Owners. */
export function useRenameSpace(spaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SpaceUpdateInput) => http.patch<SpaceSummaryDTO>(`/spaces/${spaceId}`, input),
    onSuccess: () => Promise.all([refreshSpaces(qc), qc.invalidateQueries({ queryKey: qk.bootstrap(spaceId) })]),
  });
}

/** Owners, re-auth; `confirmName` is the space's name. Restorable until `purgeAfter`. */
export function useDeleteSpace(spaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SpaceDeleteInput) => request<{ ok: true; purgeAfter: string }>('DELETE', `/spaces/${spaceId}`, input),
    onSuccess: () => {
      forgetSpace(qc, spaceId);
      return refreshSpaces(qc);
    },
  });
}

export function useRestoreSpace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (spaceId: string) => http.post<SpaceSummaryDTO>(`/spaces/${spaceId}/restore`),
    onSuccess: () => refreshSpaces(qc),
  });
}

export function useMembers(spaceId: string) {
  return useQuery({ queryKey: qk.members(spaceId), queryFn: () => http.get<MemberDTO[]>(`/spaces/${spaceId}/members`) });
}

/** Who may set which role: roles.ts canChangeRole (and roleChangeNeedsReauth for the re-auth window). */
export function useChangeMemberRole(spaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, ...input }: MemberRoleInput & { userId: number }) =>
      http.patch<MemberDTO>(`/spaces/${spaceId}/members/${userId}`, input),
    onSuccess: () => Promise.all([refreshSpaces(qc), qc.invalidateQueries({ queryKey: qk.bootstrap(spaceId) })]),
  });
}

export function useRemoveMember(spaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: number) => http.del<{ ok: true }>(`/spaces/${spaceId}/members/${userId}`),
    onSuccess: () => Promise.all([refreshSpaces(qc), qc.invalidateQueries({ queryKey: qk.bootstrap(spaceId) })]),
  });
}

/** Leave the space (not its last owner); its data is forgotten here. The caller navigates away first. */
export function useLeaveSpace(spaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => http.post<{ ok: true }>(`/spaces/${spaceId}/leave`),
    onSuccess: () => {
      forgetSpace(qc, spaceId);
      return refreshSpaces(qc);
    },
  });
}

/** Owners, re-auth: `userId` becomes an owner; `demoteSelfTo` then gives the caller that role. */
export function useTransferSpace(spaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: TransferInput) => http.post<{ ok: true }>(`/spaces/${spaceId}/transfer`, input),
    onSuccess: () => Promise.all([refreshSpaces(qc), qc.invalidateQueries({ queryKey: qk.bootstrap(spaceId) })]),
  });
}
