// Administration → Settings (design §5.3, §5.5): the signup policy, each choice explained (what it allows,
// that `open` needs mail, that a change affects only accounts created from then on), and the minimum length
// of new passwords. Pure, so the texts and the checks are unit-tested (settings.test.ts).

import type { SignupPolicy } from '@shared/constants';
import type { AdminSettingsInput } from '@shared/schemas';

export interface PolicyChoice {
  value: SignupPolicy;
  label: string;
  description: string;
}

export const POLICY_CHOICES: readonly PolicyChoice[] = [
  {
    value: 'open',
    label: 'Anyone can sign up',
    description:
      'People create an account with their email address, which they confirm through a link Lyren Plan mails them. Invitations work as well.',
  },
  {
    value: 'invite_only',
    label: 'By invitation',
    description: 'New accounts are made by accepting an invitation: to a space, from one of its owners or admins, or to this instance, from an administrator.',
  },
  {
    value: 'closed',
    label: 'Closed',
    description:
      'No new accounts, except through an administrator: an instance invitation, or a space invitation an administrator sent. People with an account can still join spaces they are invited to.',
  },
];

/** Why a choice cannot be made now, or null. `open` needs a transport that delivers mail (§5.3). */
export function policyUnavailable(policy: SignupPolicy, mail: boolean): string | null {
  return policy === 'open' && !mail ? 'Needs mail: set MAIL_TRANSPORT on the server first, so sign-up links can be sent.' : null;
}

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 64;

/** The password minimum as typed, or the error to show. */
export function parsePasswordMinimum(text: string): { value: number } | { error: string } {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return { error: `Enter a number from ${PASSWORD_MIN} to ${PASSWORD_MAX}` };
  const value = Number(trimmed);
  if (value < PASSWORD_MIN || value > PASSWORD_MAX) return { error: `Enter a number from ${PASSWORD_MIN} to ${PASSWORD_MAX}` };
  return { value };
}

/** The PATCH body for what differs from the current settings; null when nothing does. */
export function settingsChange(
  current: { signupPolicy: SignupPolicy; passwordMinLength: number },
  wanted: { signupPolicy: SignupPolicy; passwordMinLength: number },
): AdminSettingsInput | null {
  const change: AdminSettingsInput = {
    ...(wanted.signupPolicy !== current.signupPolicy && { signupPolicy: wanted.signupPolicy }),
    ...(wanted.passwordMinLength !== current.passwordMinLength && { passwordMinLength: wanted.passwordMinLength }),
  };
  return Object.keys(change).length > 0 ? change : null;
}
