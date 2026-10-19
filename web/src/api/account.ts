// The signed-in account (design §7.2, /api/account…): profile, its email address (changing and verifying
// it), preferences, password, the re-auth window, sessions, the security log and notices, deletion. The
// account itself is useAccount() (api/auth.ts), from the auth status.

import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type {
  AccountDeleteInput,
  ChangePasswordInput,
  EmailChangeInput,
  PreferencesUpdateInput,
  ReauthPasswordInput,
  UpdateAccountInput,
  UserPreferences,
} from '@shared/schemas';
import type { AuthStatusDTO, EmailChangeDTO, SecurityEventDTO, SessionDTO, UserDTO } from '@shared/types';
import { signedOut } from './auth';
import { http, qs, request } from './client';
import { qk } from './keys';

/** The display name shows in every space (bootstrap's user and people). */
export function useUpdateAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateAccountInput) => http.patch<UserDTO>('/account', input),
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: qk.authStatus }),
        qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === 'space' && q.queryKey[2] === 'bootstrap' }),
      ]),
  });
}

/**
 * Change the email address (re-auth), which is also how an account from before email addresses adds one
 * (§5.8.10). With mail the new address gets a confirmation link (1 hour; `pending`), to be opened in a
 * session of this account; without mail the address changes at once, unverified.
 */
export function useChangeEmail() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: EmailChangeInput) => http.post<EmailChangeDTO>('/account/email', input),
    onSuccess: (res) =>
      Promise.all([
        qc.invalidateQueries({ queryKey: qk.securityEvents }),
        // Changed at once: the address shows in every space's members list.
        ...(res.pending ? [] : [qc.invalidateQueries({ queryKey: qk.authStatus }), qc.invalidateQueries({ queryKey: qk.spacesAll })]),
      ]),
  });
}

/** A new verification link to the account's unverified address (24 hours; the older one stops working). */
export function useSendVerification() {
  return useMutation({ mutationFn: () => http.post<{ ok: true }>('/account/email/verify') });
}

/** The parts of a preferences patch it names (undefined ones left out). */
export function definedPreferences(patch: PreferencesUpdateInput): Partial<UserPreferences> {
  return {
    ...(patch.weekStartsOn !== undefined && { weekStartsOn: patch.weekStartsOn }),
    ...(patch.homePage !== undefined && { homePage: patch.homePage }),
  };
}

/** Optimistic: the auth status (where the preferences live) changes at once and rolls back on failure. */
export function useUpdatePreferences() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: PreferencesUpdateInput) => http.patch<UserPreferences>('/account/preferences', patch),
    onMutate: async (patch) => {
      await qc.cancelQueries({ queryKey: qk.authStatus });
      const previous = qc.getQueryData<AuthStatusDTO>(qk.authStatus);
      if (previous?.preferences) {
        qc.setQueryData<AuthStatusDTO>(qk.authStatus, { ...previous, preferences: { ...previous.preferences, ...definedPreferences(patch) } });
      }
      return { previous };
    },
    onError: (_err, _patch, ctx) => {
      if (ctx?.previous) qc.setQueryData(qk.authStatus, ctx.previous);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: qk.authStatus }),
  });
}

export function useChangePassword() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ChangePasswordInput) => http.post<{ ok: true }>('/account/password', input),
    // A correct current password also opens the re-auth window (§5.4.4).
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: qk.sessions }),
        qc.invalidateQueries({ queryKey: qk.securityEvents }),
        qc.invalidateQueries({ queryKey: qk.authStatus }),
      ]),
  });
}

/**
 * Mutation options of useReauthPassword (exported for tests). The password is the mutation's variables:
 * `gcTime: 0` drops a mutation from the cache as soon as no observer holds it, so the dialog's reset()
 * after each attempt leaves the password nowhere.
 */
export function reauthPasswordOptions(qc: QueryClient) {
  return {
    mutationFn: (input: ReauthPasswordInput) =>
      http.post<{ ok: true; reauthUntil: string | null }>('/account/reauth/password', input),
    gcTime: 0,
    onSuccess: (res: { reauthUntil: string | null }) => {
      qc.setQueryData<AuthStatusDTO>(qk.authStatus, (old) => (old ? { ...old, reauthUntil: res.reauthUntil } : old));
    },
  };
}

/** Prove the password again: opens the re-auth window (design §5.4.4) that sensitive actions need. */
export function useReauthPassword() {
  const qc = useQueryClient();
  return useMutation(reauthPasswordOptions(qc));
}

export function useSessions() {
  return useQuery({ queryKey: qk.sessions, queryFn: () => http.get<SessionDTO[]>('/account/sessions') });
}

export function useRevokeSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => http.del<{ ok: true }>(`/account/sessions/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.sessions }),
  });
}

export function useRevokeOtherSessions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => http.post<{ ok: true; revoked: number }>('/account/sessions/revoke-others'),
    onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: qk.sessions }), qc.invalidateQueries({ queryKey: qk.securityEvents })]),
  });
}

/** The server's page size of GET /api/account/security-events. */
const SECURITY_EVENTS_PAGE = 50;

/** The account's security log, newest first, 50 per page (`before`: the oldest id shown). */
export function useSecurityEvents() {
  return useInfiniteQuery({
    queryKey: qk.securityEvents,
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) => http.get<SecurityEventDTO[]>(`/account/security-events${qs({ before: pageParam })}`),
    getNextPageParam: (last) => (last.length < SECURITY_EVENTS_PAGE ? undefined : last[last.length - 1]!.id),
  });
}

/** The security notices of the auth status (§5.8.11) were shown: the server stops sending them. */
export function useMarkNoticesSeen() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => http.post<{ ok: true }>('/account/notices/seen'),
    onSuccess: () => {
      qc.setQueryData<AuthStatusDTO>(qk.authStatus, (old) => (old ? { ...old, notices: [] } : old));
    },
  });
}

/** Deletes the account (re-auth; `confirm` is its email or username); signed out afterwards. */
export function useDeleteAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: AccountDeleteInput) => request<{ ok: true }>('DELETE', '/account', input),
    onSuccess: () => signedOut(qc),
  });
}
