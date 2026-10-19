// The instance administration (design §7.2, /api/admin…, instance admins only): the overview, the instance
// settings, accounts (with their reset links), instance invitations, spaces, the backup download and the
// mail test. Every write needs the re-auth window: the pages ask for it first (ensureReauth()), and a
// reauth_required answer is still handled by the client's handler. Keys start with ['admin'], so any change
// here refreshes the lists and the overview's recent actions together. The pages await mutateAsync() for
// their toasts: a row that a change removes from its list unmounts before mutate()'s callbacks would run.

import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query';
import type { AdminSettingsInput, AdminUserUpdateInput } from '@shared/schemas';
import type {
  AdminOverviewDTO,
  AdminSpaceDTO,
  AdminUserDetailDTO,
  AdminUserDTO,
  InstanceInfoDTO,
  InvitationCreatedDTO,
  InvitationDTO,
  MailTestDTO,
  Page,
  ResetLinkDTO,
} from '@shared/types';
import { http, qs } from './client';
import { qk } from './keys';

/** The instance backup (a plain GET link the browser downloads with the session cookie): a .tar of the directory and every space. */
export const BACKUP_URL = '/api/admin/backup';

/**
 * After any administrative change: every admin list, the overview's recent actions, and the auth status (the
 * instance's facts, the admin's own spaces). `except`: a query not to fetch again (a deleted account's page,
 * which its caller leaves).
 */
function refreshAdmin(qc: QueryClient, except?: QueryKey): Promise<unknown> {
  const skip = except ? JSON.stringify(except) : null;
  return Promise.all([
    qc.invalidateQueries({ queryKey: qk.adminAll, predicate: (q) => JSON.stringify(q.queryKey) !== skip }),
    qc.invalidateQueries({ queryKey: qk.authStatus }),
  ]);
}

export function useAdminOverview() {
  return useQuery({ queryKey: qk.adminOverview, queryFn: () => http.get<AdminOverviewDTO>('/admin/overview') });
}

/** A test message to the admin's own address, sent at once: { ok, messageId? }, or 502 with the transport's error. */
export function useSendTestMail() {
  return useMutation({ mutationFn: () => http.post<MailTestDTO>('/admin/mail/test') });
}

/** The signup policy and the password minimum (re-auth); `open` needs mail (409 mail_not_configured). */
export function useUpdateInstanceSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: AdminSettingsInput) => http.patch<InstanceInfoDTO>('/admin/settings', input),
    onSuccess: () => refreshAdmin(qc),
  });
}

// ---- Accounts -------------------------------------------------------------------------------------

/**
 * Accounts, newest first, a page at a time; `q` searches the address, the username and the name; `orphaned`:
 * only those that can only sign in with passkeys that do not work on this address (§5.6).
 */
export function useAdminUsers(q: string, orphaned = false) {
  return useInfiniteQuery({
    queryKey: qk.adminUsers(q, orphaned),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => http.get<Page<AdminUserDTO>>(`/admin/users${qs({ q, orphaned: orphaned ? 1 : undefined, cursor: pageParam })}`),
    getNextPageParam: (last) => last.nextCursor,
  });
}

export function useAdminUser(userId: number) {
  return useQuery({ queryKey: qk.adminUser(userId), queryFn: () => http.get<AdminUserDetailDTO>(`/admin/users/${userId}`) });
}

/** Disable or enable, promote or demote (re-auth; never one's own account). */
export function useUpdateAdminUser(userId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: AdminUserUpdateInput) => http.patch<AdminUserDTO>(`/admin/users/${userId}`, input),
    onSuccess: () => refreshAdmin(qc),
  });
}

/**
 * Delete the account as its owner would (re-auth); its spaces of its own go with it. Its page is not fetched
 * again (it would answer 404): the caller leaves it, then forgets it (forgetAdminUser).
 */
export function useDeleteAdminUser(userId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => http.del<{ ok: true }>(`/admin/users/${userId}`),
    onSuccess: () => refreshAdmin(qc, qk.adminUser(userId)),
  });
}

/** Drop a deleted account's page from the cache, once nothing shows it. */
export function forgetAdminUser(qc: QueryClient, userId: number): void {
  qc.removeQueries({ queryKey: qk.adminUser(userId), exact: true });
}

/** A password reset link (re-auth; not for an administrator): mailed to a verified address, else handed to the admin. */
export function useCreateResetLink(userId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => http.post<ResetLinkDTO>(`/admin/users/${userId}/reset-link`),
    onSuccess: () => refreshAdmin(qc),
  });
}

// ---- Instance invitations ---------------------------------------------------------------------------

export function useAdminInvitations() {
  return useQuery({ queryKey: qk.adminInvitations, queryFn: () => http.get<InvitationDTO[]>('/admin/invitations') });
}

/** Invite an address to an account of its own (re-auth): mailed, or a link to pass on when mail is off. */
export function useCreateAdminInvitation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (email: string) => http.post<InvitationCreatedDTO>('/admin/invitations', { email }),
    onSuccess: () => refreshAdmin(qc),
  });
}

export function useRevokeAdminInvitation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (invitationId: number) => http.del<{ ok: true }>(`/admin/invitations/${invitationId}`),
    onSuccess: () => refreshAdmin(qc),
  });
}

// ---- Spaces -------------------------------------------------------------------------------------------

/** Every space, newest first, a page at a time; `q` searches the name (or matches a space id). */
export function useAdminSpaces(q: string) {
  return useInfiniteQuery({
    queryKey: qk.adminSpaces(q),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => http.get<Page<AdminSpaceDTO>>(`/admin/spaces${qs({ q, cursor: pageParam })}`),
    getNextPageParam: (last) => last.nextCursor,
  });
}

/** Delete a space as its owner would (re-auth): restorable until purgeAfter. */
export function useDeleteAdminSpace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (spaceId: string) => http.del<{ ok: true; purgeAfter: string }>(`/admin/spaces/${spaceId}`),
    onSuccess: () => Promise.all([refreshAdmin(qc), qc.invalidateQueries({ queryKey: qk.spacesAll })]),
  });
}

export function useRestoreAdminSpace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (spaceId: string) => http.post<AdminSpaceDTO>(`/admin/spaces/${spaceId}/restore`),
    onSuccess: () => Promise.all([refreshAdmin(qc), qc.invalidateQueries({ queryKey: qk.spacesAll })]),
  });
}
