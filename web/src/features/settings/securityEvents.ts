// The account's security log as Account settings → Security lists it (design §5.11,
// GET /api/account/security-events). Pure, so the texts are unit-tested (securityEvents.test.ts).
// A type without a text of its own reads as its name.
// The administrative ones are the account's own: what an administrator did to it, or, in an
// administrator's log, what it did to the instance (the Overview lists those of every admin).

import type { SecurityEventDTO } from '@shared/types';
import { pluralize } from '../../lib/format';

const ROLE_WORDS: Readonly<Record<string, string>> = { owner: 'an owner', admin: 'an admin', member: 'a member', viewer: 'a viewer' };

/** "member_role_changed" → "Member role changed". */
function fromType(type: string): string {
  const words = type.replace(/_/g, ' ').trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : 'Security event';
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** Events the log marks as warnings: someone may be trying to get in. */
export function isWarningEvent(type: string): boolean {
  return type === 'login_failed' || type === 'passkey_counter_regression';
}

/** `spaceNames`: the account's spaces by id, to name the space of a role change. */
export function securityEventText(event: Pick<SecurityEventDTO, 'type' | 'data'>, spaceNames: ReadonlyMap<string, string> = new Map()): string {
  const { data } = event;
  switch (event.type) {
    case 'account_created':
      return 'Account created';
    case 'login':
      return 'Signed in';
    case 'login_failed': {
      const failures = num(data.failures);
      return failures !== null && failures > 1 ? `Failed sign-in attempts (${failures})` : 'Failed sign-in attempt';
    }
    case 'password_changed':
      return 'Password changed';
    case 'password_reset':
      return data.issuedBy !== undefined ? 'Password reset with a link from an administrator' : 'Password reset with a link';
    case 'password_removed':
      return data.via === 'reset'
        ? 'Password removed with a reset link: the account signs in with passkeys'
        : 'Password removed: the account signs in with passkeys';
    case 'passkey_login': {
      const name = str(data.name);
      return name ? `Signed in with the passkey “${name}”` : 'Signed in with a passkey';
    }
    case 'passkey_added': {
      const name = str(data.name);
      const passkey = name ? `Passkey “${name}”` : 'Passkey';
      if (data.via === 'reset') return `${passkey} set up with a reset link${data.issuedBy !== undefined ? ' from an administrator' : ''}`;
      if (data.via === 'signup' || data.via === 'invite') return `${passkey} set up with the new account`;
      return `${passkey} added`;
    }
    case 'passkey_removed': {
      const name = str(data.name);
      return name ? `Passkey “${name}” removed` : 'Passkey removed';
    }
    case 'passkey_counter_regression': {
      const name = str(data.name);
      // `purpose` (Appendix D 59): a sign-in or a re-authentication; events from before name neither.
      const use = data.purpose === 'login' ? 'A sign-in with' : data.purpose === 'reauth' ? 'A confirmation with' : 'A use of';
      return `${use} ${name ? `the passkey “${name}”` : 'a passkey'} was refused: its counter went backwards, which can mean that the passkey was copied`;
    }
    case 'email_change_requested': {
      const email = str(data.email);
      return email ? `Asked to change the email address to ${email}` : 'Asked to change the email address';
    }
    case 'email_changed': {
      const email = str(data.email);
      const from = str(data.from);
      if (!email) return 'Email address changed';
      return from ? `Email address changed from ${from} to ${email}` : `Email address set to ${email}`;
    }
    case 'email_verified': {
      const email = str(data.email);
      return email ? `Email address ${email} verified` : 'Email address verified';
    }
    case 'invitation_accepted': {
      const space = str(data.space) ? spaceNames.get(data.space as string) : undefined;
      const role = str(data.role) ? ROLE_WORDS[data.role as string] : undefined;
      if (!str(data.space)) return 'Accepted an invitation to this instance';
      return `Accepted an invitation to ${space ?? 'a space'}${role ? ` as ${role}` : ''}`;
    }
    case 'member_added': {
      const role = str(data.role) ? ROLE_WORDS[data.role as string] : undefined;
      const space = str(data.space) ? spaceNames.get(data.space as string) : undefined;
      return `Someone you invited joined ${space ?? 'a space'}${role ? ` as ${role}` : ''}`;
    }
    case 'mail_failed':
      return data.reason === 'cap' ? 'An email to you was not sent: the daily limit was reached' : 'An email to you could not be sent';
    case 'sessions_revoked': {
      const revoked = num(data.revoked);
      return revoked !== null ? `Signed out ${pluralize(revoked, 'other device')}` : 'Signed out other devices';
    }
    case 'member_role_changed': {
      const role = typeof data.role === 'string' ? ROLE_WORDS[data.role] : undefined;
      const space = typeof data.space === 'string' ? spaceNames.get(data.space) : undefined;
      if (!role) return 'Changed a member’s role';
      return `Made someone ${role} of ${space ?? 'a space'}`;
    }
    case 'admin_backup_downloaded':
      return 'Downloaded a backup of the instance';
    case 'admin_user_disabled':
      return 'An administrator disabled the account';
    case 'admin_user_enabled':
      return 'An administrator enabled the account again';
    case 'admin_granted':
      return 'Made an administrator of the instance';
    case 'admin_revoked':
      return 'No longer an administrator of the instance';
    case 'admin_reset_link':
      return 'An administrator created a password reset link';
    case 'recovery_used':
      return 'The recovery token was used for this account';
    case 'admin_settings_changed':
      return 'Changed the instance settings';
    case 'admin_space_deleted':
    case 'admin_space_restored': {
      const space = typeof data.name === 'string' && data.name !== '' ? `the space ${data.name}` : 'a space';
      return `${event.type === 'admin_space_deleted' ? 'Deleted' : 'Restored'} ${space} (administration)`;
    }
    case 'admin_invitation_created':
      return 'Invited someone to the instance';
    case 'admin_invitation_revoked':
      return 'Revoked an invitation to the instance';
    default:
      return fromType(event.type);
  }
}
