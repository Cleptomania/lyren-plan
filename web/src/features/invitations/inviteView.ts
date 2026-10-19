// What the invitation page (/invite, design §5.8.8, §12.7) shows for a link's InvitationPreviewDTO: who
// invited the reader to what, and which way in it offers: join as the signed-in account (which may already
// be a member), "this invitation is for someone else", or, signed out, creating an account or signing in,
// or both when the server does not say whether the address has an account (a copied link); and what to do
// when accepting is refused for a reason the reader cannot fix. Pure, so the states are unit-tested
// (inviteView.test.ts).

import { ROLE_RANK, type InvitableRole, type SpaceRole } from '@shared/roles';
import type { InvitationPreviewDTO } from '@shared/types';

export type InviteView =
  /** Signed in as the invited address. `change`: what accepting changes (a member keeps the higher role). */
  | { kind: 'join'; change: 'join' | 'raise' | 'none' }
  /** An instance invitation (an account of one's own), signed in as its address: there is nothing to accept. */
  | { kind: 'has_account' }
  /** Signed in as another account. */
  | { kind: 'wrong_account' }
  /** Signed out, and the invited address has no account. */
  | { kind: 'create' }
  /** Signed out, and the invited address has an account. */
  | { kind: 'sign_in' }
  /** Signed out, and nobody tells whether the address has an account (a copied link, §5.8.8): both ways. */
  | { kind: 'choose' };

export function inviteView(preview: Pick<InvitationPreviewDTO, 'kind' | 'role' | 'account' | 'signedIn'>): InviteView {
  const { signedIn } = preview;
  if (signedIn !== null) {
    if (!signedIn.matches) return { kind: 'wrong_account' };
    if (preview.kind === 'instance') return { kind: 'has_account' };
    return { kind: 'join', change: joinChange(preview.role, signedIn.memberRole) };
  }
  if (preview.account === 'new') return { kind: 'create' };
  if (preview.account === 'exists') return { kind: 'sign_in' };
  return { kind: 'choose' };
}

/** What joining changes for an account that is `memberRole` in the space already (null: not a member). */
export function joinChange(role: InvitableRole | null, memberRole: SpaceRole | null): 'join' | 'raise' | 'none' {
  if (memberRole === null) return 'join';
  return role !== null && ROLE_RANK[role] > ROLE_RANK[memberRole] ? 'raise' : 'none';
}

const ROLE_WORDS: Readonly<Record<SpaceRole, string>> = { owner: 'an owner', admin: 'an admin', member: 'a member', viewer: 'a viewer' };

/** "an admin", "a member", … */
export function roleWord(role: SpaceRole): string {
  return ROLE_WORDS[role];
}

/** The invitation in one sentence: "Alice (alice@example.com) invited you to Team as a member." */
export function inviteSentence(
  preview: Pick<InvitationPreviewDTO, 'kind' | 'spaceName' | 'inviterName' | 'inviterEmail' | 'role'>,
  instanceName: string,
): string {
  const who = preview.inviterName ? `${preview.inviterName}${preview.inviterEmail ? ` (${preview.inviterEmail})` : ''}` : 'Someone';
  if (preview.kind === 'instance' || preview.spaceName === null || preview.role === null) {
    return `${who} invited you to an account of your own on ${instanceName}.`;
  }
  return `${who} invited you to ${preview.spaceName} as ${roleWord(preview.role)}.`;
}

/** What joining does, for the "Join" view. */
export function joinText(preview: Pick<InvitationPreviewDTO, 'spaceName' | 'role' | 'signedIn'>): string {
  const space = preview.spaceName ?? 'the space';
  const memberRole = preview.signedIn?.memberRole ?? null;
  switch (joinChange(preview.role, memberRole)) {
    case 'join':
      return `Join ${space} with this account.`;
    case 'raise':
      return `You are ${roleWord(memberRole!)} of ${space} already. Accepting makes you ${roleWord(preview.role!)}.`;
    case 'none':
      return `You are ${roleWord(memberRole!)} of ${space} already, so accepting changes nothing.`;
  }
}

/** The inviter as the help texts name them. */
const inviterOf = (preview: Pick<InvitationPreviewDTO, 'inviterName'>) => preview.inviterName ?? 'whoever invited you';

/**
 * Creating an account was refused by the policy (403 signup_disabled: sign-up is closed, and only an
 * administrator's invitation makes an account). The link is fine, and still works for an account the
 * reader has already, unless the server said the address has none.
 */
export function signupClosedHelp(preview: Pick<InvitationPreviewDTO, 'inviterName' | 'account'>): { title: string; text: string; signIn: boolean } {
  const ask = `ask an administrator of this instance to invite you (${inviterOf(preview)} can ask one for you)`;
  if (preview.account === 'new') {
    return {
      title: 'This instance creates no new accounts',
      text: `Only an administrator’s invitation creates an account here, so this invitation cannot make you one. To join, ${ask}.`,
      signIn: false,
    };
  }
  return {
    title: 'This instance creates no new accounts',
    text: `Only an administrator’s invitation creates an account here. This invitation still works for an account you have here already: sign in to accept it. Otherwise ${ask}.`,
    signIn: true,
  };
}

/** What to do about a refusal of accepting that is said above the form (null: its message is enough). */
export function acceptRefusalHint(code: string, preview: Pick<InvitationPreviewDTO, 'inviterName'>): string | null {
  // The space is full (MAX_MEMBERS_PER_SPACE): only its admins can make room.
  if (code === 'quota_exceeded') return `Ask ${inviterOf(preview)} to make room in the space, then accept again.`;
  return null;
}
