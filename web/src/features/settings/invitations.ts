// What a space's Settings → Invitations shows and offers (design §5.8.8, §12.9): the roles the viewer may
// invite with, who may resend and revoke which invitation, a row's details, and how a refused invitation
// reads (an address, a quota, a daily limit, a mail that could not be sent). Pure, so it is unit-tested
// (invitations.test.ts).

import { canInviteRole, INVITABLE_ROLES, type InvitableRole, type SpaceRole } from '@shared/roles';
import type { InvitationDTO, PendingInvitationDTO } from '@shared/types';
import { ApiError, errorMessage } from '../../api/errors';
import { formatRelativeTime, pluralize } from '../../lib/format';
import { invitationStatusText } from '../admin/invitations';
import { roleWord } from '../invitations/inviteView';

/** The roles `actor` may invite with (admins: members and viewers; owners: admins too), highest first. */
export function inviteRoles(actor: SpaceRole): InvitableRole[] {
  return INVITABLE_ROLES.filter((role) => canInviteRole(actor, role));
}

/** Whether `actor` may resend and revoke the invitation (an admin invitation is an owner's). */
export function managesInvitation(actor: SpaceRole, invitation: Pick<InvitationDTO, 'role'>): boolean {
  return invitation.role !== null && canInviteRole(actor, invitation.role);
}

/** A row's details: who sent it, when, how often, and until when it works. */
export function invitationDetails(invitation: InvitationDTO, now: number = Date.now()): string {
  const sent = `sent ${formatRelativeTime(invitation.lastSentAt, now)}${invitation.sendCount > 1 ? ` (${pluralize(invitation.sendCount, 'time')})` : ''}`;
  return [invitation.invitedBy ? `From ${invitation.invitedBy.displayName}` : null, sent, invitationStatusText(invitation, now)]
    .filter(Boolean)
    .join(' · ');
}

export interface InvitationRefusal {
  /** Said at the address field (the address itself is the problem). */
  field?: string;
  /** Said above the form, which keeps what was typed for another try. */
  message?: string;
  /** What to do about it. */
  hint?: string;
  /** The inviter's own address must be verified first (with mail, §5.8.8 step 2). */
  verify?: boolean;
}

/** How a refused create reads (POST …/invitations). */
export function invitationRefusal(err: unknown): InvitationRefusal {
  if (!(err instanceof ApiError)) return { message: errorMessage(err) };
  const field = err.fieldError('email');
  if (field) return { field };
  // "<address> is already a member", "An invitation to this address is pending" (Resend is in the list).
  if (err.code === 'conflict') return { field: err.message };
  if (err.code === 'quota_exceeded') {
    return { message: err.message, hint: 'To make room, revoke invitations that are no longer needed, or remove members who have left.' };
  }
  if (err.status === 429) return { message: err.message, hint: 'Daily limits keep invitations from being used for spam. Try again tomorrow.' };
  if (err.code === 'forbidden' && /verify your email/i.test(err.message)) return { message: err.message, verify: true };
  return { message: errorMessage(err) };
}

/** The account's own invitation on /spaces: "Alice invited you to Team as a member." */
export function pendingInvitationText(invitation: Pick<PendingInvitationDTO, 'inviterName' | 'spaceName' | 'role'>): string {
  return `${invitation.inviterName ?? 'Someone'} invited you to ${invitation.spaceName} as ${roleWord(invitation.role)}.`;
}
