// Passkeys in the web client (design §5.6, §5.8.3, §12.7, §12.8): when the client offers them at all, what a
// failed WebAuthn ceremony comes to, and when the sign-in field's autofill asks again. Pure, so the
// decisions are unit-tested (passkeys.test.ts); api/passkeys.ts runs the ceremonies with
// @simplewebauthn/browser, whose errors (WebAuthnError: `name` and `code`) are read here by shape.

import type { InstanceInfoDTO } from '@shared/types';
import { ApiError, errorMessage } from '../api/errors';
import { unreachableText } from '../api/networkError';

/** What the page knows about where it runs. */
export interface PasskeyEnvironment {
  /** window.isSecureContext: https, or http on localhost. */
  secureContext: boolean;
  /** location.origin. */
  origin: string;
  /** @simplewebauthn/browser's browserSupportsWebAuthn(). */
  webauthn: boolean;
}

/**
 * Whether any passkey UI shows (§5.6): passkeys are on for this instance, the page is a secure context at the
 * instance's own origin (its PUBLIC_URL), and the browser has WebAuthn. So the desktop app (no PUBLIC_URL),
 * a LAN address or an IP origin of an instance whose PUBLIC_URL is a name, and old browsers offer none of it.
 */
export function passkeysAvailable(instance: Pick<InstanceInfoDTO, 'passkeys'> | null | undefined, env: PasskeyEnvironment): boolean {
  const passkeys = instance?.passkeys;
  return Boolean(passkeys?.enabled && passkeys.origin !== null && env.secureContext && env.origin === passkeys.origin && env.webauthn);
}

/** What the person was doing when a ceremony failed (the texts differ). */
export type PasskeyPurpose = 'sign_in' | 'confirm' | 'create';

export type PasskeyFailure =
  /** The request was ended by the page (a newer request, leaving the page): nothing to say. */
  | { kind: 'aborted' }
  /**
   * NotAllowedError: the person closed the browser's dialog, it timed out, or the device had nothing it could
   * use (no passkey here, no user verification; Chromium tells none of these apart). The autofill says nothing;
   * a button's ceremony a quiet hint (failureText).
   */
  | { kind: 'cancelled' }
  | { kind: 'message'; message: string };

/**
 * The server answered a sign-in with a passkey it does not know that was this instance's (§5.6 details
 * `credential: unknown`; the server names only those, Appendix D 59), so the browser may forget it.
 */
export function isUnknownCredential(err: unknown): boolean {
  return err instanceof ApiError && err.code === 'passkey_error' && err.fieldError('credential') === 'unknown';
}

export const UNKNOWN_PASSKEY_TEXT = 'This passkey no longer works here: it was removed, or made for another address. Choose another one, or sign in with your password.';
export const PASSKEY_EXISTS_TEXT = 'This device or password manager already has a passkey for this account. Add the next one on another device.';
export const PASSKEY_UNSUPPORTED_TEXT =
  'This device cannot make a passkey that works here: it has to keep the passkey itself and confirm it is you, with a PIN, a fingerprint or your face.';
export const PASSKEY_WRONG_ADDRESS_TEXT = 'Passkeys do not work on this address. Open Lyren Plan at its usual address.';

const FAILED_PREFIX: Readonly<Record<PasskeyPurpose, string>> = {
  sign_in: 'Signing in with a passkey failed',
  confirm: 'Confirming with a passkey failed',
  create: 'The passkey could not be set up',
};

/** What a button's ceremony says when the browser ended it with NotAllowedError (`cancelled`). */
export const NO_PASSKEY_USED_TEXT: Readonly<Record<PasskeyPurpose, string>> = {
  sign_in: 'No passkey was used. Try again, or sign in with your password.',
  confirm: 'No passkey was used. Try again.',
  create: 'No passkey was set up. Try again, or use another device or password manager.',
};

/** WebAuthnError codes (@simplewebauthn/browser) of a device that cannot make the passkey the server asks for. */
const UNSUPPORTED_CODES: ReadonlySet<string> = new Set([
  'ERROR_AUTHENTICATOR_MISSING_DISCOVERABLE_CREDENTIAL_SUPPORT',
  'ERROR_AUTHENTICATOR_MISSING_USER_VERIFICATION_SUPPORT',
  'ERROR_AUTHENTICATOR_NO_SUPPORTED_PUBKEYCREDPARAMS_ALG',
]);

/**
 * What a failed passkey ceremony comes to: the server's refusal in its words (the unknown passkey of a
 * sign-in with a hint), the network's or the limit's usual texts, or the browser's WebAuthn error
 * (startRegistration and startAuthentication reject with a WebAuthnError or the DOMException itself).
 */
export function webauthnFailure(err: unknown, purpose: PasskeyPurpose): PasskeyFailure {
  if (err instanceof ApiError) {
    if (purpose === 'sign_in' && isUnknownCredential(err)) return { kind: 'message', message: UNKNOWN_PASSKEY_TEXT };
    if (err.code === 'network_error') return { kind: 'message', message: unreachableText().message };
    return { kind: 'message', message: errorMessage(err) };
  }
  const e = (err ?? {}) as { name?: unknown; code?: unknown; message?: unknown };
  const name = typeof e.name === 'string' ? e.name : '';
  const code = typeof e.code === 'string' ? e.code : '';
  if (code === 'ERROR_CEREMONY_ABORTED' || name === 'AbortError') return { kind: 'aborted' };
  // NotAllowedError covers "cancelled", "timed out" and "no passkey chosen": the browser said so already.
  if (name === 'NotAllowedError') return { kind: 'cancelled' };
  if (code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED' || name === 'InvalidStateError') {
    return { kind: 'message', message: purpose === 'create' ? PASSKEY_EXISTS_TEXT : `${FAILED_PREFIX[purpose]}.` };
  }
  if (UNSUPPORTED_CODES.has(code) || name === 'NotSupportedError' || name === 'ConstraintError') return { kind: 'message', message: PASSKEY_UNSUPPORTED_TEXT };
  if (code === 'ERROR_INVALID_DOMAIN' || code === 'ERROR_INVALID_RP_ID' || name === 'SecurityError') return { kind: 'message', message: PASSKEY_WRONG_ADDRESS_TEXT };
  const detail = typeof e.message === 'string' ? e.message.trim().replace(/\.$/, '') : '';
  return { kind: 'message', message: detail ? `${FAILED_PREFIX[purpose]}: ${detail}.` : `${FAILED_PREFIX[purpose]}.` };
}

/**
 * What a ceremony a button started shows after `failure`: its message, or for `cancelled` the quiet hint of
 * NO_PASSKEY_USED_TEXT, so the button never just stops spinning (the browser may have shown nothing at all);
 * null when the page ended it.
 */
export function failureText(failure: PasskeyFailure, purpose: PasskeyPurpose): string | null {
  if (failure.kind === 'message') return failure.message;
  return failure.kind === 'cancelled' ? NO_PASSKEY_USED_TEXT[purpose] : null;
}

// ---- The sign-in field's autofill (conditional UI, §5.8.3) ----------------------------------------

/**
 * A sign-in ceremony for the autofill lives 10 minutes on the server (§5.6). One still waiting after 9 is
 * replaced by a new one, so that a passkey picked later is not refused as expired.
 */
export const AUTOFILL_RENEW_MS = 9 * 60_000;

/** A request the browser ended this long after it began timed out (rather than being refused at once). */
export const AUTOFILL_TIMEOUT_MIN_MS = 60_000;

/**
 * Whether the autofill asks again after its request ended (`err` what it failed with): yes after a picked
 * passkey failed (the person may pick another) or a timeout; no after the page ended it (a modal ceremony,
 * leaving the page), when the browser or the server refused it at once (no loop of options calls, each counted
 * on `co`, §5.9), or when the server refused the sign-in for something no other passkey changes (a disabled
 * account, a limit, passkeys off: any refusal but passkey_error).
 */
export function autofillAgain(o: { failure: PasskeyFailure; picked: boolean; elapsedMs: number; err?: unknown }): boolean {
  if (o.failure.kind === 'aborted') return false;
  if (o.err instanceof ApiError && o.err.code !== 'passkey_error') return false;
  if (o.picked) return true;
  return o.failure.kind === 'cancelled' && o.elapsedMs >= AUTOFILL_TIMEOUT_MIN_MS;
}
