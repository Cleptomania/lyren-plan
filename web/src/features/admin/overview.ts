// What Administration → Overview says about the instance (design §5.8.18, §12.2, §12.12): the facts of
// GET /api/admin/overview as rows of the configuration summary, and the recent administrative actions as
// sentences. Pure, so the texts are unit-tested (overview.test.ts).

import type { AdminEventDTO, AdminOverviewDTO, InstanceInfoDTO, MailTestDTO } from '@shared/types';
import { pluralize } from '../../lib/format';

export const POLICY_TEXT: Readonly<Record<InstanceInfoDTO['signupPolicy'], string>> = {
  open: 'Anyone can create an account',
  invite_only: 'Accounts by invitation only',
  closed: 'No new accounts',
};

/** A limit for the configuration summary: null means none. */
export function limitText(value: number | null, noun: string): string {
  return value === null ? 'No limit' : `${value.toLocaleString('en-US')} ${noun}`;
}

/** The origins links for other devices are built from (PUBLIC_URL, or the desktop app's LAN addresses). */
export function addressText(shareOrigins: readonly string[]): string {
  return shareOrigins.length > 0 ? shareOrigins.join(', ') : 'Not set (PUBLIC_URL)';
}

type OverviewConfig = AdminOverviewDTO['config'];

const TRANSPORT_NAMES: Readonly<Record<OverviewConfig['mailTransport'], string>> = {
  log: 'Not sent',
  smtp: 'SMTP',
  resend: 'Resend',
  cloudflare: 'Cloudflare Email Service',
};

/** How the instance sends mail, and from which address. */
export function mailText(config: Pick<OverviewConfig, 'mailTransport' | 'mailFrom'>): string {
  if (config.mailTransport === 'log') return 'Not sent: written to the server log (MAIL_TRANSPORT=log)';
  const name = TRANSPORT_NAMES[config.mailTransport];
  return config.mailFrom ? `${name}, from ${config.mailFrom}` : name;
}

export interface ConfigRow {
  label: string;
  value: string;
  /** The variables that set it (Appendix B). */
  variables: string;
}

/** The read-only configuration summary (no secret is ever part of it). */
export function configRows(config: OverviewConfig): ConfigRow[] {
  const days = (n: number) => pluralize(n, 'day');
  return [
    { label: 'Public address', value: config.publicUrl ?? 'Not set', variables: 'PUBLIC_URL' },
    { label: 'Mail', value: mailText(config), variables: 'MAIL_TRANSPORT, MAIL_FROM' },
    {
      label: 'Sign-in sessions',
      value: `End ${days(config.sessionTtlDays)} after their last use${config.sessionMaxDays > 0 ? `, and after ${days(config.sessionMaxDays)} at the latest` : ''}`,
      variables: 'SESSION_TTL_DAYS, SESSION_MAX_DAYS',
    },
    {
      label: 'Password confirmation',
      value: `Sensitive actions ask again after ${pluralize(config.reauthMinutes, 'minute')}`,
      variables: 'REAUTH_MINUTES',
    },
    { label: 'Invitations', value: `Valid for ${days(config.invitationTtlDays)}`, variables: 'INVITATION_TTL_DAYS' },
    {
      label: 'Deleted spaces',
      value: config.spaceDeleteGraceDays === 0 ? 'Removed at once' : `Can be restored for ${days(config.spaceDeleteGraceDays)}`,
      variables: 'SPACE_DELETE_GRACE_DAYS',
    },
    { label: 'Password hashing', value: config.passwordKdf, variables: 'PASSWORD_KDF' },
  ];
}

/** The overview's counts, for one line. */
export function countsText(counts: AdminOverviewDTO['counts']): string {
  return [pluralize(counts.users, 'account'), pluralize(counts.spaces, 'space'), pluralize(counts.sessions, 'signed-in session')].join(' · ');
}

/** Who acted: the admin, or the command line or the recovery token, which have no account. */
function actorText(event: Pick<AdminEventDTO, 'type' | 'data' | 'actor'>): string {
  if (event.actor) return event.actor.displayName;
  if (event.data.via === 'cli') return 'The command line';
  return 'A deleted account';
}

function targetText(event: Pick<AdminEventDTO, 'target'>): string {
  const target = event.target;
  if (!target) return 'something';
  return target.kind === 'email' ? target.email : target.name;
}

const POLICY_WORDS: Readonly<Record<string, string>> = { open: 'open', invite_only: 'by invitation', closed: 'closed' };

/** The changes of admin_settings_changed: "sign-up by invitation → closed; minimum password length 8 → 12". */
function settingsChangeText(data: Record<string, unknown>): string {
  const parts: string[] = [];
  const change = (key: string) => {
    const value = data[key] as { from?: unknown; to?: unknown } | undefined;
    return value && typeof value === 'object' ? value : null;
  };
  const policy = change('signupPolicy');
  if (policy) parts.push(`sign-up ${POLICY_WORDS[String(policy.from)] ?? String(policy.from)} → ${POLICY_WORDS[String(policy.to)] ?? String(policy.to)}`);
  const min = change('passwordMinLength');
  if (min) parts.push(`minimum password length ${String(min.from)} → ${String(min.to)}`);
  return parts.join('; ');
}

/** An administrative event as a sentence: "Ann disabled Bob". */
export function adminEventText(event: Pick<AdminEventDTO, 'type' | 'data' | 'actor' | 'target'>): string {
  const actor = actorText(event);
  const target = targetText(event);
  switch (event.type) {
    case 'admin_user_disabled':
      return `${actor} disabled ${target}`;
    case 'admin_user_enabled':
      return `${actor} enabled ${target} again`;
    case 'admin_granted':
      return `${actor} made ${target} an administrator`;
    case 'admin_revoked':
      return `${actor} took the administrator rights of ${target}`;
    case 'admin_reset_link':
      return `${actor} created a password reset link for ${target}${event.data.delivery === 'mail' ? ' (sent to them by mail)' : ''}`;
    case 'admin_user_deleted':
      return `${actor} deleted the account of ${target}`;
    case 'admin_space_deleted':
      return `${actor} deleted the space ${target}`;
    case 'admin_space_restored':
      return `${actor} restored the space ${target}`;
    case 'admin_settings_changed': {
      const changes = settingsChangeText(event.data);
      return changes ? `${actor} changed the settings: ${changes}` : `${actor} changed the settings`;
    }
    case 'admin_backup_downloaded':
      return `${actor} downloaded a backup of the instance`;
    case 'admin_invitation_created':
      return `${actor} invited ${target} to the instance`;
    case 'admin_invitation_revoked':
      return `${actor} revoked the invitation of ${target}`;
    case 'recovery_used':
      return `The recovery token gave ${target} a password reset link${event.data.madeAdmin === true ? ' and made them an administrator' : ''}`;
    default:
      return `${actor}: ${event.type.replace(/_/g, ' ')}`;
  }
}

/** What the "Send test email" button reports when the transport took the message. */
export function testMailText(result: MailTestDTO, to: string, transport: OverviewConfig['mailTransport']): string {
  if (transport === 'log') return `This instance sends no mail (MAIL_TRANSPORT=log): the server log notes a test message for ${to} instead.`;
  return `The test message to ${to} was handed to the mail server${result.messageId ? ` (${result.messageId})` : ''}. Check that inbox, and its spam folder.`;
}
