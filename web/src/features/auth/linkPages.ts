// What the public pages show (design §12.2, §12.7): which ways back in the sign-in page offers, what the
// sign-up page says under each policy, what a link with a token (sign-up, reset, email confirmation,
// invitation) comes to when the server refuses it, and what a reset with a passkey does to the password.
// Pure, so the states are unit-tested (linkPages.test.ts).

import type { AuthStatusDTO, InstanceInfoDTO, PasskeyResetDTO } from '@shared/types';
import { ApiError, DAILY_LIMIT_TEXT, errorMessage } from '../../api/errors';
import { unreachableText } from '../../api/networkError';

// ---- The sign-in page ---------------------------------------------------------------------------

export interface SignInHelp {
  /** "Forgot password?": the instance mails reset links (§5.8.9; InstanceInfoDTO.mailLinks). */
  forgot: boolean;
  /** Without mail: "Ask an administrator of this instance for a reset link" (§5.8.11). Not in the desktop app, whose user runs it. */
  askAdmin: boolean;
  /** The reset-password command of a server one runs oneself (PasswordResetHint); there is no command line on Cloudflare. */
  command: boolean;
  /** "Create an account": the signup policy is open (§5.3) and the instance mails the sign-up links. */
  signup: boolean;
}

export function signInHelp(status: Pick<AuthStatusDTO, 'instance' | 'desktop'>): SignInHelp {
  const { instance } = status;
  return {
    forgot: instance.mailLinks,
    askAdmin: !instance.mailLinks && status.desktop === undefined,
    command: instance.runtime === 'node',
    // An open policy set while mail worked does nothing without it (the server answers 202 and sends nothing).
    signup: instance.signupPolicy === 'open' && instance.mailLinks,
  };
}

export const ASK_ADMIN_TEXT = 'Forgot your password? Ask an administrator of this instance for a reset link.';

// ---- Sign-up ------------------------------------------------------------------------------------

/** Why /signup offers no form (any policy but open, or open on an instance that sends no mail now), or null. */
export function signupClosedText(instance: Pick<InstanceInfoDTO, 'signupPolicy' | 'mailLinks'>): { title: string; body: string } | null {
  switch (instance.signupPolicy) {
    case 'open':
      if (instance.mailLinks) return null;
      return {
        title: 'Sign-up is not available at the moment',
        body: 'This instance sends no email at the moment, and a new account needs it to confirm its address. Ask someone who uses this instance to invite you.',
      };
    case 'invite_only':
      return {
        title: 'Sign-up is by invitation only',
        body: 'Ask someone who uses this instance to invite you to their space. The invitation brings a link to create your account.',
      };
    case 'closed':
      return { title: 'Sign-up is closed', body: 'This instance creates no new accounts at the moment, except by an invitation from an administrator.' };
  }
}

// ---- Too many requests --------------------------------------------------------------------------

/**
 * A 429 on the sign-in, setup and link pages: the server's own throttle (or the zone's rule) lasts minutes,
 * but Cloudflare's daily request limit (error 1027, api/errors.ts) lasts until 00:00 UTC, and says so.
 */
export function tooManyText(err: ApiError): string {
  return err.message === DAILY_LIMIT_TEXT ? DAILY_LIMIT_TEXT : 'Too many attempts. Wait a few minutes before trying again.';
}

// ---- Links with a token -------------------------------------------------------------------------

/** The one answer for every link token the server will not take (§5.7). */
export const INVALID_LINK_TEXT = 'This link is invalid or has expired.';

/** What a refusal of a link (or of the request made with it) comes to. */
export type LinkFailure =
  /** The link cannot be used: unknown, used, expired, revoked or replaced by a newer one (the server tells none apart). */
  | { kind: 'invalid'; message: string }
  /** The same link may work in a while: too many attempts, the network, the server. */
  | { kind: 'retry'; message: string }
  /** Another refusal (the policy, an address taken, …), in the server's words. */
  | { kind: 'refused'; code: string; message: string };

export function linkFailure(err: unknown): LinkFailure {
  if (!(err instanceof ApiError)) return { kind: 'retry', message: errorMessage(err) };
  if (err.code === 'invalid_token') return { kind: 'invalid', message: err.message || INVALID_LINK_TEXT };
  // A token the schema refuses (cut short when it was copied) is no link either.
  if (err.code === 'validation_error' && err.fieldError('token') !== undefined) return { kind: 'invalid', message: INVALID_LINK_TEXT };
  if (err.code === 'network_error') return { kind: 'retry', message: unreachableText().message };
  if (err.status === 429) return { kind: 'retry', message: tooManyText(err) };
  if (err.status >= 500) return { kind: 'retry', message: errorMessage(err) };
  return { kind: 'refused', code: err.code, message: errorMessage(err) };
}

export type LinkKind = 'signup' | 'reset' | 'email' | 'invitation';

/** What to do about a link that cannot be used, per kind of link: how long such links work, and where a new one comes from. */
export const LINK_HELP: Readonly<Record<LinkKind, string>> = {
  signup: 'A sign-up link works once, for 24 hours. Sign up again to get a new one.',
  reset: 'A reset link works once, for 30 minutes (24 hours when an administrator made it), and a newer link replaces it. Ask for a new one.',
  email:
    'A verification link works for 24 hours, the link of an email change for 1 hour, and a newer link replaces an older one. ' +
    'Ask for a new one in Account settings.',
  invitation: 'An invitation works once, until it expires or is revoked, and sending it again replaces its link. Ask whoever invited you for a new one.',
};

/** The page was opened without its link's token (typed in, a bookmark, or reloaded once the token left the address bar). */
export const MISSING_LINK_TEXT = 'This page opens from a link in an email or a link someone gave you. Open that link again.';

// ---- Email confirmation (§5.8.6, §5.8.10) --------------------------------------------------------

export type EmailConfirmFailure =
  /** Signed out: only a session of the link's account may confirm it (a verification and an email change alike). */
  | { kind: 'sign_in'; displayName: string | null; message: string }
  /** Signed in as another account. */
  | { kind: 'other_account'; message: string }
  | LinkFailure;

export function emailConfirmFailure(err: unknown): EmailConfirmFailure {
  if (err instanceof ApiError && err.status === 401) {
    return { kind: 'sign_in', displayName: err.fieldError('displayName') ?? null, message: err.message };
  }
  if (err instanceof ApiError && err.status === 403 && err.code === 'forbidden') return { kind: 'other_account', message: err.message };
  return linkFailure(err);
}

// ---- A reset link with a passkey (§5.8.9 step 4, Appendix D 59) ------------------------------------

/** A sentence of the server's (its last_credential reasons do not all end in a full stop). */
const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);

/**
 * What the reset page says, before the passkey is set up, of what it does to the account's password
 * (PasswordResetPreviewDTO): the passkey replaces it, unless the account would then have no way back in.
 */
export function passkeyResetText(preview: { hasPassword: boolean; passkeyKeepsPassword: string | null }): string {
  if (!preview.hasPassword) return 'This signs the account out on every device. You then sign in with the passkey.';
  if (preview.passkeyKeepsPassword === null) {
    return 'The passkey replaces the password, which stops working, and the account is signed out on every device. You then sign in with the passkey.';
  }
  return `This signs the account out on every device. You then sign in with the passkey; the password keeps working too. ${sentence(preview.passkeyKeepsPassword)}`;
}

export const PASSKEY_SET_UP_TEXT = 'Passkey set up. Sign in with it.';

/** What the sign-in page says after a reset with a passkey (PasskeyResetDTO). */
export function passkeyResetNotice(result: Pick<PasskeyResetDTO, 'passwordRemoved' | 'passwordKept'>): string {
  if (result.passwordRemoved) return 'Passkey set up, and your password removed. Sign in with the passkey.';
  if (result.passwordKept !== null) return `${PASSKEY_SET_UP_TEXT} Your password still works too. ${sentence(result.passwordKept)}`;
  return PASSKEY_SET_UP_TEXT;
}
