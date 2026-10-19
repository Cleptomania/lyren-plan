// Signing in and out: the auth status (the account, its spaces and preferences, the instance), setup,
// login and logout, and the public flows of the sign-in pages (design §5.8.5, §5.8.6, §5.8.9, §5.8.19):
// sign-up, a forgotten password and its reset, the email confirmation link and the operator's recovery.
// The account's own settings are api/account.ts, invitations api/invitations.ts, and everything done with a
// passkey (signing in, and the passkey variants of these flows) api/passkeys.ts.

import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { ForgotPasswordInput, LoginInput, RecoverInput, ResetPasswordInput, SetupInput, SignupCompleteInput, SignupInput } from '@shared/schemas';
import type { AuthStatusDTO, EmailConfirmedDTO, PasswordResetPreviewDTO, RecoveryLinkDTO, SignupPreviewDTO, UserDTO } from '@shared/types';
import { forgetLinkToken } from '../lib/linkToken';
import { claimDrafts, forgetDrafts } from '../lib/spaceStorage';
import { ApiError, forgetEtags, http } from './client';
import { qk } from './keys';

export function useAuthStatus() {
  return useQuery({
    queryKey: qk.authStatus,
    queryFn: () => http.get<AuthStatusDTO>('/auth/status'),
    staleTime: 60_000,
    retry: 1,
  });
}

/**
 * The signed-in account (AuthStatusDTO.user). Only call inside the authenticated app (AuthedApp),
 * which renders once the auth status has a user, so this never throws there.
 */
export function useAccount(): UserDTO {
  const user = useAuthStatus().data?.user;
  if (!user) throw new Error('useAccount() used before the auth status loaded');
  return user;
}

/**
 * Drop everything cached for the previous user (their spaces' data, their session list, the
 * conditional-read memory); keep only the auth status.
 */
export function forgetUserData(qc: QueryClient): void {
  qc.removeQueries({ predicate: (q) => !(q.queryKey[0] === qk.authStatus[0] && q.queryKey[1] === qk.authStatus[1]) });
  forgetEtags();
}

/**
 * After the session ended (sign-out, account deleted): signed-out status first, so the auth gate
 * redirects to /login (unmounting every page) before the previous user's data is dropped, the tab's
 * unsent drafts included.
 */
export function signedOut(qc: QueryClient): void {
  qc.setQueryData<AuthStatusDTO>(qk.authStatus, (old) => (old ? { ...old, user: null, spaces: [], preferences: null } : old));
  forgetUserData(qc);
  forgetDrafts();
  void qc.invalidateQueries({ queryKey: qk.authStatus });
}

/**
 * After a sign-in, setup or a new account (sign-up, an invitation): the tab's drafts are the account's,
 * or are dropped (lib/spaceStorage.ts).
 */
export async function signedIn(qc: QueryClient, user: UserDTO): Promise<void> {
  claimDrafts(user.id, { signedIn: true });
  forgetUserData(qc);
  await qc.invalidateQueries({ queryKey: qk.authStatus });
}

export function useSetup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SetupInput) => http.post<{ user: UserDTO }>('/auth/setup', input),
    onSuccess: (res) => signedIn(qc, res.user),
  });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: LoginInput) => http.post<{ user: UserDTO }>('/auth/login', input),
    onSuccess: (res) => signedIn(qc, res.user),
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
    onSuccess: () => signedOut(qc),
  };
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation(logoutOptions(qc));
}

// ---- Links with a token (lib/linkToken.ts) -------------------------------------------------------

/**
 * A link's preview (POST …/inspect) is read once: not again on focus or by retries, since every refused
 * token counts on the client's tk limit (§5.7). The token is part of the key, in memory only. A page
 * passes a null token once the link is used, which keeps the last preview on screen (`placeholderData`)
 * instead of asking again with a token that no longer works (signing in drops every query, previews too).
 */
export const LINK_PREVIEW_OPTIONS = {
  retry: false,
  staleTime: Infinity,
  refetchOnWindowFocus: false,
  placeholderData: <T>(previous: T | undefined) => previous,
} as const;

/** The link was used: its token and the previews made with it go. */
export function forgetLink(qc: QueryClient): void {
  forgetLinkToken();
  qc.removeQueries({ queryKey: qk.linkPreviews });
}

/** Open sign-up (policy open): 202 whatever the address; the link (or a "sign in instead") arrives by mail. */
export function useSignup() {
  return useMutation({ mutationFn: (input: SignupInput) => http.post<{ ok: true }>('/auth/signup', input) });
}

/** The address a sign-up link was sent to. */
export function useSignupPreview(token: string | null) {
  return useQuery({
    queryKey: qk.linkPreview('signup', token ?? ''),
    queryFn: () => http.post<SignupPreviewDTO>('/auth/signup/inspect', { token }),
    enabled: token !== null,
    ...LINK_PREVIEW_OPTIONS,
  });
}

/** Creates the account of a sign-up link (its address verified) and signs it in. */
export function useCompleteSignup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SignupCompleteInput) => http.post<{ user: UserDTO }>('/auth/signup/complete', input),
    onSuccess: async (res) => {
      forgetLink(qc);
      await signedIn(qc, res.user);
    },
  });
}

/** 202 whatever the address: with mail, an active account with it gets a reset link (30 minutes). */
export function useForgotPassword() {
  return useMutation({ mutationFn: (input: ForgotPasswordInput) => http.post<{ ok: true }>('/auth/password/forgot', input) });
}

/** Whose password a reset link resets. */
export function useResetPreview(token: string | null) {
  return useQuery({
    queryKey: qk.linkPreview('reset', token ?? ''),
    queryFn: () => http.post<PasswordResetPreviewDTO>('/auth/password/reset/inspect', { token }),
    enabled: token !== null,
    ...LINK_PREVIEW_OPTIONS,
  });
}

/**
 * After a reset link was used (a new password, or a passkey instead, §5.8.9): the account is signed out
 * everywhere, this browser included when it was signed in to it (the answer expires its cookie); nobody is
 * signed in afterwards.
 */
export async function resetDone(qc: QueryClient): Promise<void> {
  forgetLink(qc);
  const before = qc.getQueryData<AuthStatusDTO>(qk.authStatus)?.user ?? null;
  await qc.invalidateQueries({ queryKey: qk.authStatus });
  // This browser's session was the account's: it ended with the reset.
  if (before !== null && !qc.getQueryData<AuthStatusDTO>(qk.authStatus)?.user) signedOut(qc);
}

/** Sets the password of a reset link (resetDone). */
export function useResetPassword() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ResetPasswordInput) => http.post<{ ok: true }>('/auth/password/reset', input),
    onSuccess: () => resetDone(qc),
  });
}

/**
 * Follows an email confirmation link: a verification or an email change, either only in a session of the
 * link's account (401 signed out, 403 for another account; §5.8.10, Appendix D 56). The token is not
 * consumed by a refusal, so it can be sent again after signing in.
 */
export function useConfirmEmail() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (token: string) => http.post<EmailConfirmedDTO>('/auth/email/confirm', { token }),
    onSuccess: async () => {
      forgetLink(qc);
      await qc.invalidateQueries({ queryKey: qk.authStatus });
    },
  });
}

/** The operator's recovery (RECOVERY_TOKEN set, else 404): a reset link for the account, 24 hours. */
export function useRecover() {
  return useMutation({ mutationFn: (input: RecoverInput) => http.post<RecoveryLinkDTO>('/auth/recover', input) });
}
