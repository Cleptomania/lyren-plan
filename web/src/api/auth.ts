import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { ChangePasswordInput, LoginInput, SetupInput, UpdateMeInput } from '@shared/schemas';
import type { AuthStatusDTO, SessionDTO, UserDTO } from '@shared/types';
import { ApiError, http } from './client';
import { qk } from './keys';

export function useAuthStatus() {
  return useQuery({
    queryKey: qk.authStatus,
    queryFn: () => http.get<AuthStatusDTO>('/auth/status'),
    staleTime: 60_000,
    retry: 1,
  });
}

/** Drop everything cached for the previous user (their session list too); keep only the auth status. */
function forgetUserData(qc: QueryClient): void {
  qc.removeQueries({ predicate: (q) => !(q.queryKey[0] === qk.authStatus[0] && q.queryKey[1] === qk.authStatus[1]) });
}

export function useSetup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SetupInput) => http.post<{ user: UserDTO }>('/auth/setup', input),
    onSuccess: async () => {
      forgetUserData(qc);
      await qc.invalidateQueries({ queryKey: qk.authStatus });
    },
  });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: LoginInput) => http.post<{ user: UserDTO }>('/auth/login', input),
    onSuccess: async () => {
      forgetUserData(qc);
      await qc.invalidateQueries({ queryKey: qk.authStatus });
    },
  });
}

/**
 * Mutation options of useLogout (exported for tests). The cache is cleared only once the
 * server has ended the session: a failed request (offline, server restarting) leaves the app
 * as it was, and the caller shows the error. A 401 means the session was already gone, which
 * is a successful sign-out too.
 */
export function logoutOptions(qc: QueryClient) {
  return {
    mutationFn: async (): Promise<void> => {
      try {
        await http.post<{ ok: true }>('/auth/logout');
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 401)) throw err;
      }
    },
    onSuccess: () => {
      // Signed-out status first, so the auth gate redirects to /login (unmounting every page)
      // before the previous user's data — bootstrap included — is dropped from the cache.
      qc.setQueryData<AuthStatusDTO>(qk.authStatus, (old) => (old ? { ...old, user: null } : old));
      forgetUserData(qc);
      void qc.invalidateQueries({ queryKey: qk.authStatus });
    },
  };
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation(logoutOptions(qc));
}

export function useUpdateMe() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateMeInput) => http.patch<UserDTO>('/auth/me', input),
    onSuccess: () =>
      Promise.all([qc.invalidateQueries({ queryKey: qk.authStatus }), qc.invalidateQueries({ queryKey: qk.bootstrap })]),
  });
}

export function useChangePassword() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ChangePasswordInput) => http.post<{ ok: true }>('/auth/password', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.sessions }),
  });
}

export function useSessions() {
  return useQuery({ queryKey: qk.sessions, queryFn: () => http.get<SessionDTO[]>('/auth/sessions') });
}

export function useRevokeSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => http.del<{ ok: true }>(`/auth/sessions/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.sessions }),
  });
}

export function useRevokeOtherSessions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => http.post<{ ok: true; revoked: number }>('/auth/sessions/revoke-others'),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.sessions }),
  });
}
