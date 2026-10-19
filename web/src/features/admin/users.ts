// What Administration → Users shows of an account and offers to do with it (design §5.8.11, §5.8.17,
// §5.8.18): its labels, the actions the server allows (never on one's own account; no reset link for an
// administrator, whose reset goes through the command line or the recovery token) and the texts of a reset
// link. Pure, so they are unit-tested (users.test.ts).

import type { BadgeVariant } from '../../components/ui';
import type { AdminUserDTO, ResetLinkDTO } from '@shared/types';
import { formatDateTime, pluralize } from '../../lib/format';

export interface UserBadge {
  label: string;
  variant: BadgeVariant;
}

type BadgeFields = 'id' | 'isInstanceAdmin' | 'status' | 'email' | 'emailVerified' | 'hasPassword' | 'passkeys' | 'usablePasskeys';

/**
 * An active account that can only sign in with passkeys that do not work on this address (§5.6): the accounts
 * the overview's warning counts (GET /api/admin/users?orphaned=1 lists them). It needs a reset link.
 */
export function cannotSignInHere(user: Pick<AdminUserDTO, 'status' | 'hasPassword' | 'passkeys' | 'usablePasskeys'>): boolean {
  return user.status === 'active' && !user.hasPassword && user.passkeys > 0 && user.usablePasskeys === 0;
}

/** What the list says when it shows only the accounts of cannotSignInHere (`?orphaned=1`). */
export const ORPHANED_FILTER_TEXT =
  'These accounts have no password, and none of their passkeys works on this address. Open one to create a reset link for it: with the link, they set a password or a passkey here.';

/** The account's labels in the list and its page. `mail`: the instance delivers mail (so verification means something). */
export function userBadges(user: Pick<AdminUserDTO, BadgeFields>, o: { meId: number; mail: boolean }): UserBadge[] {
  const badges: UserBadge[] = [];
  if (user.id === o.meId) badges.push({ label: 'You', variant: 'accent' });
  if (user.isInstanceAdmin) badges.push({ label: 'Administrator', variant: 'outline' });
  if (user.status === 'disabled') badges.push({ label: 'Disabled', variant: 'danger' });
  if (cannotSignInHere(user)) badges.push({ label: 'Can’t sign in here', variant: 'warning' });
  if (o.mail && user.email !== null && !user.emailVerified) badges.push({ label: 'Unverified', variant: 'warning' });
  return badges;
}

/** The address, or the sign-in name of an account from before email addresses. */
export function userIdentifier(user: Pick<AdminUserDTO, 'email' | 'username'>): string {
  return user.email ?? (user.username !== null ? `Username ${user.username}` : 'No email address');
}

/**
 * How the account signs in: its password and its passkeys (AdminUserDTO.passkeys counts every one, §5.6), and
 * how many of them do not work on this address.
 */
export function signInMethodsText(user: Pick<AdminUserDTO, 'hasPassword' | 'passkeys' | 'usablePasskeys'>): string {
  const elsewhere = user.passkeys - user.usablePasskeys;
  const notHere = (n: number) => `${n === 1 ? 'doesn’t' : 'don’t'} work on this address`;
  let passkeys: string | null = null;
  if (user.passkeys > 0) {
    passkeys = pluralize(user.passkeys, 'passkey');
    if (elsewhere === user.passkeys) passkeys += ` that ${notHere(elsewhere)}`;
    else if (elsewhere > 0) passkeys += ` (${elsewhere} ${notHere(elsewhere)})`;
  }
  if (user.hasPassword) return passkeys ? `A password and ${passkeys}` : 'A password';
  return passkeys ? `${passkeys}, no password` : 'No password';
}

/** What the account's typed confirmation of a deletion is: its address, or its username. */
export function deleteConfirmation(user: Pick<AdminUserDTO, 'email' | 'username' | 'displayName'>): string {
  return user.email ?? user.username ?? user.displayName;
}

export interface UserActions {
  /** Disable or enable; null for one's own account. */
  status: 'disable' | 'enable' | null;
  /** Promote or demote; null for one's own account. */
  admin: 'promote' | 'demote' | null;
  /** A reset link (§5.8.11): not for an administrator's account, one's own included. */
  resetLink: boolean;
  delete: boolean;
}

/** The changes the server accepts for this account from this admin (§5.8.18: never one's own). */
export function userActions(user: Pick<AdminUserDTO, 'id' | 'isInstanceAdmin' | 'status'>, meId: number): UserActions {
  const self = user.id === meId;
  return {
    status: self ? null : user.status === 'active' ? 'disable' : 'enable',
    admin: self ? null : user.isInstanceAdmin ? 'demote' : 'promote',
    resetLink: !user.isInstanceAdmin,
    delete: !self,
  };
}

/** Why a reset link is not offered, when it is not. */
export function resetLinkNote(user: Pick<AdminUserDTO, 'isInstanceAdmin'>): string | null {
  return user.isInstanceAdmin
    ? 'Administrators reset their password through their email, the command line (reset-password) or the recovery token, so that no administrator can take over another.'
    : null;
}

/** What the admin is told after creating a reset link. */
export function resetLinkResult(result: ResetLinkDTO, user: Pick<AdminUserDTO, 'displayName' | 'email'>): string {
  if (result.sent) return `A link to choose a new password was sent to ${user.email ?? user.displayName}. You don’t get a copy of it.`;
  return `This link lets ${user.displayName} choose a new password once, until ${formatDateTime(result.expiresAt)}. Give it to them yourself, over a channel you trust: whoever has it can sign in as them.`;
}
