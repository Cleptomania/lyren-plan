// What Account settings → Profile says about the account's email address (design §5.1, §5.8.6, §5.8.10):
// whether it is verified (which means something only on an instance that mails), what a change did (a
// confirmation link to the new address, or the change at once without mail), and the prompt for an
// account from before email addresses. Pure, so it is unit-tested (accountEmail.test.ts).

import type { EmailChangeDTO, UserDTO } from '@shared/types';

export type EmailState =
  /** An account from before email addresses: it signs in with its username. */
  | 'none'
  | 'verified'
  /** Unverified on an instance that mails: a verification link can be sent. */
  | 'unverified'
  /** The instance sends no mail, so no address is ever verified (§5.1). */
  | 'unverifiable';

export function emailState(user: Pick<UserDTO, 'email' | 'emailVerified'>, mail: boolean): EmailState {
  if (user.email === null) return 'none';
  if (user.emailVerified) return 'verified';
  return mail ? 'unverified' : 'unverifiable';
}

/** The card's description of the address. */
export function emailDescription(state: EmailState): string {
  switch (state) {
    case 'none':
      return (
        'Your account signs in with its username. Add an email address to sign in with it, to be invited to spaces by it ' +
        'and to reset a forgotten password.'
      );
    case 'verified':
      return 'You sign in with it, and invitations and password resets are mailed to it. Members of your spaces can see it.';
    case 'unverified':
      return 'You sign in with it. Verify it to get invitations and password resets by email. Members of your spaces can see it.';
    case 'unverifiable':
      return 'You sign in with it. Members of your spaces can see it. This instance sends no email, so addresses are not verified.';
  }
}

/** What a change of the address did, in a sentence. `before`: the address (or username) it had. */
export function emailChangeText(result: EmailChangeDTO, requested: string, before: { email: string | null; username: string | null }): string {
  if (!result.pending) return `Your email address is now ${result.email}.`;
  const until = before.email !== null ? `you keep signing in with ${before.email}` : 'you keep signing in with your username';
  return (
    `We sent a confirmation link to ${requested}. Open it within an hour, in a browser where you are signed in to this account. ` +
    `Until then ${until}.`
  );
}
