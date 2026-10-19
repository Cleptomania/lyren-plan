// Invitations (design §5.8.8, §7.2): a space's (its admins and owners invite, resend and revoke), the
// invitation page's (/invite: what a link offers, accepting it as a new account, with a password or a
// passkey, or as the signed-in one) and the account's own pending ones (instances with mail, a verified
// address). Accepting changes the account's spaces, which the auth status lists, so it is refreshed before
// the caller opens the space.

import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { InvitationAcceptInput, InvitationCreateInput, InvitationPasskeyAcceptInput } from '@shared/schemas';
import type { InvitationAcceptedDTO, InvitationCreatedDTO, InvitationDTO, InvitationPreviewDTO, PendingInvitationDTO } from '@shared/types';
import { forgetLink, LINK_PREVIEW_OPTIONS, signedIn } from './auth';
import { http } from './client';
import { qk } from './keys';
import { registerPasskey, type WithAnswer } from './passkeys';

// ---- A space's invitations (admins and owners) ------------------------------------------------------

export function useSpaceInvitations(spaceId: string) {
  return useQuery({ queryKey: qk.invitations(spaceId), queryFn: () => http.get<InvitationDTO[]>(`/spaces/${spaceId}/invitations`) });
}

/**
 * Invite an address with a role (an admin invitation needs an owner and the re-auth window). With mail it
 * is sent at once (503 when it could not be: nothing is kept, so the form can try again); without, the
 * answer holds the link to pass on, shown once.
 */
export function useCreateInvitation(spaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: InvitationCreateInput) => http.post<InvitationCreatedDTO>(`/spaces/${spaceId}/invitations`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.invitations(spaceId) }),
  });
}

/** Send again with a new link (at most once in 10 minutes, 5 times in all); the earlier link stops working. */
export function useResendInvitation(spaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (invitationId: number) => http.post<InvitationCreatedDTO>(`/spaces/${spaceId}/invitations/${invitationId}/resend`),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.invitations(spaceId) }),
  });
}

export function useRevokeInvitation(spaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (invitationId: number) => http.del<{ ok: true }>(`/spaces/${spaceId}/invitations/${invitationId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.invitations(spaceId) }),
  });
}

// ---- The invitation page (/invite) ---------------------------------------------------------------------

/** What an invitation link offers; asked again whenever the browser signs in or out (the key's cache goes then). */
export function useInvitationPreview(token: string | null) {
  return useQuery({
    queryKey: qk.linkPreview('invitation', token ?? ''),
    queryFn: () => http.post<InvitationPreviewDTO>('/invitations/inspect', { token }),
    enabled: token !== null,
    ...LINK_PREVIEW_OPTIONS,
  });
}

/** After an invitation was accepted: the account's spaces (the auth status lists them) and its pending list. */
function joined(qc: QueryClient): Promise<unknown> {
  return Promise.all([
    qc.invalidateQueries({ queryKey: qk.authStatus }),
    qc.invalidateQueries({ queryKey: qk.spacesAll }),
    qc.invalidateQueries({ queryKey: qk.pendingInvitations }),
  ]);
}

/**
 * Accept an invitation link: signed out with a name and a password, as a new account (signed in
 * afterwards); signed in with the token alone, as this account. `spaceId` is the space joined (null for
 * an instance invitation).
 */
export function useAcceptInvitation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: InvitationAcceptInput) => http.post<InvitationAcceptedDTO>('/invitations/accept', input),
    onSuccess: async (res) => {
      forgetLink(qc);
      if ('user' in res) await signedIn(qc, res.user);
      else await joined(qc);
    },
  });
}

/** Accept an invitation link as a new account with a passkey and no password (§5.8.8), signed in afterwards. */
export function useAcceptInvitationWithPasskey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ token, displayName, passkeyName }: { token: string; displayName: string; passkeyName: string | null }) =>
      registerPasskey('/invitations/accept/passkey/options', { token, displayName }, (answer) => {
        const input: WithAnswer<InvitationPasskeyAcceptInput> = { token, displayName, ...answer, ...(passkeyName !== null && { passkeyName }) };
        return http.post<InvitationAcceptedDTO>('/invitations/accept/passkey', input);
      }),
    onSuccess: async (res) => {
      forgetLink(qc);
      if ('user' in res) await signedIn(qc, res.user);
    },
  });
}

// ---- The account's own (/spaces) -------------------------------------------------------------------------

/** Open invitations to the account's address: always none without mail or for an unverified address. */
export function usePendingInvitations(enabled: boolean) {
  return useQuery({ queryKey: qk.pendingInvitations, queryFn: () => http.get<PendingInvitationDTO[]>('/invitations'), enabled });
}

export function useAcceptPendingInvitation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (invitationId: number) => http.post<{ ok: true; spaceId: string }>(`/invitations/${invitationId}/accept`),
    onSuccess: () => joined(qc),
  });
}

/** Decline: the inviter would have to invite the address again. */
export function useDeclineInvitation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (invitationId: number) => http.post<{ ok: true }>(`/invitations/${invitationId}/decline`),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.pendingInvitations }),
  });
}
