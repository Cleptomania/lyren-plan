// When the client offers passkeys (design §5.6, §14.7), what a failed ceremony comes to, and when the
// sign-in field's autofill asks again (§5.8.3).
import { describe, expect, it } from 'vitest';
import type { InstanceInfoDTO } from '@shared/types';
import { ApiError } from '../api/errors';
import {
  AUTOFILL_TIMEOUT_MIN_MS,
  autofillAgain,
  failureText,
  isUnknownCredential,
  NO_PASSKEY_USED_TEXT,
  PASSKEY_EXISTS_TEXT,
  PASSKEY_UNSUPPORTED_TEXT,
  PASSKEY_WRONG_ADDRESS_TEXT,
  passkeysAvailable,
  UNKNOWN_PASSKEY_TEXT,
  webauthnFailure,
  type PasskeyEnvironment,
} from './passkeys';

const ORIGIN = 'https://plan.example.com';
const on = (origin = ORIGIN): Pick<InstanceInfoDTO, 'passkeys'> => ({ passkeys: { enabled: true, origin, rpId: new URL(origin).hostname } });
const off: Pick<InstanceInfoDTO, 'passkeys'> = { passkeys: { enabled: false, origin: null, rpId: null } };
const env = (o: Partial<PasskeyEnvironment> = {}): PasskeyEnvironment => ({ secureContext: true, origin: ORIGIN, webauthn: true, ...o });

/** A rejection of @simplewebauthn/browser (WebAuthnError) or the browser's DOMException, by its shape. */
const browserError = (name: string, code?: string, message = 'The operation failed') => Object.assign(new Error(message), { name, ...(code && { code }) });

describe('passkeysAvailable', () => {
  it('needs passkeys on, a secure context at the instance’s own origin, and WebAuthn', () => {
    expect(passkeysAvailable(on(), env())).toBe(true);
    expect(passkeysAvailable(on(), env({ secureContext: false }))).toBe(false);
    expect(passkeysAvailable(on(), env({ webauthn: false }))).toBe(false);
    // The auth status has not loaded yet.
    expect(passkeysAvailable(undefined, env())).toBe(false);
    expect(passkeysAvailable(null, env())).toBe(false);
  });

  it('shows nothing in the desktop app or on an instance whose PUBLIC_URL allows none (an IP address, plain http)', () => {
    // The desktop app: no PUBLIC_URL, served on 127.0.0.1.
    expect(passkeysAvailable(off, env({ origin: 'http://127.0.0.1:43771' }))).toBe(false);
    // PUBLIC_URL=https://192.0.2.10: the server turns passkeys off; the page is a secure context all the same.
    expect(passkeysAvailable(off, env({ origin: 'https://192.0.2.10' }))).toBe(false);
    // enabled with no origin never happens, but would show nothing.
    expect(passkeysAvailable({ passkeys: { enabled: true, origin: null, rpId: null } }, env())).toBe(false);
  });

  it('shows nothing on another origin of the same instance (its IP address, another name, another port or scheme)', () => {
    const local = on('http://localhost:19610');
    expect(passkeysAvailable(local, env({ origin: 'http://localhost:19610' }))).toBe(true);
    expect(passkeysAvailable(local, env({ origin: 'http://127.0.0.1:19610' }))).toBe(false);
    expect(passkeysAvailable(local, env({ origin: 'http://localhost:19611' }))).toBe(false);
    expect(passkeysAvailable(on(), env({ origin: 'https://192.0.2.10' }))).toBe(false);
    expect(passkeysAvailable(on(), env({ origin: 'https://www.plan.example.com' }))).toBe(false);
    expect(passkeysAvailable(on(), env({ origin: 'http://plan.example.com' }))).toBe(false);
  });
});

describe('isUnknownCredential', () => {
  it('is the sign-in refusal naming the credential (§5.6), nothing else', () => {
    const unknown = new ApiError(400, 'passkey_error', 'This passkey could not be used to sign in.', [{ path: 'credential', message: 'unknown' }]);
    expect(isUnknownCredential(unknown)).toBe(true);
    expect(isUnknownCredential(new ApiError(400, 'passkey_error', 'This passkey could not be used to sign in.'))).toBe(false);
    expect(isUnknownCredential(new ApiError(400, 'validation_error', 'x', [{ path: 'credential', message: 'unknown' }]))).toBe(false);
    expect(isUnknownCredential(browserError('NotAllowedError'))).toBe(false);
  });
});

describe('webauthnFailure', () => {
  it('says nothing when the page ended the request or the person closed the browser’s dialog (or it timed out)', () => {
    expect(webauthnFailure(browserError('AbortError', 'ERROR_CEREMONY_ABORTED'), 'sign_in')).toEqual({ kind: 'aborted' });
    expect(webauthnFailure(browserError('AbortError'), 'confirm')).toEqual({ kind: 'aborted' });
    expect(webauthnFailure(browserError('NotAllowedError', 'ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY'), 'create')).toEqual({ kind: 'cancelled' });
    expect(webauthnFailure(browserError('NotAllowedError'), 'sign_in')).toEqual({ kind: 'cancelled' });
  });

  it('gives the server’s refusal in its words, an unknown passkey of a sign-in with what to do', () => {
    const unknown = new ApiError(400, 'passkey_error', 'This passkey could not be used to sign in.', [{ path: 'credential', message: 'unknown' }]);
    expect(webauthnFailure(unknown, 'sign_in')).toEqual({ kind: 'message', message: UNKNOWN_PASSKEY_TEXT });
    expect(webauthnFailure(new ApiError(400, 'passkey_error', 'This passkey could not be set up. Try again.'), 'create')).toEqual({
      kind: 'message',
      message: 'This passkey could not be set up. Try again.',
    });
    expect(webauthnFailure(new ApiError(409, 'quota_exceeded', 'An account can have at most 20 passkeys. Remove one first.'), 'create')).toMatchObject({
      message: 'An account can have at most 20 passkeys. Remove one first.',
    });
    expect(webauthnFailure(new ApiError(0, 'network_error', 'offline'), 'sign_in').kind).toBe('message');
  });

  it('explains the browser’s refusals: a passkey there already, a device that cannot make one, the wrong address', () => {
    expect(webauthnFailure(browserError('InvalidStateError', 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED'), 'create')).toEqual({ kind: 'message', message: PASSKEY_EXISTS_TEXT });
    for (const code of [
      'ERROR_AUTHENTICATOR_MISSING_DISCOVERABLE_CREDENTIAL_SUPPORT',
      'ERROR_AUTHENTICATOR_MISSING_USER_VERIFICATION_SUPPORT',
      'ERROR_AUTHENTICATOR_NO_SUPPORTED_PUBKEYCREDPARAMS_ALG',
    ]) {
      expect(webauthnFailure(browserError('ConstraintError', code), 'create')).toEqual({ kind: 'message', message: PASSKEY_UNSUPPORTED_TEXT });
    }
    expect(webauthnFailure(browserError('SecurityError', 'ERROR_INVALID_RP_ID'), 'sign_in')).toEqual({ kind: 'message', message: PASSKEY_WRONG_ADDRESS_TEXT });
  });

  it('names what failed for anything else, with the browser’s own words', () => {
    expect(webauthnFailure(browserError('UnknownError', 'ERROR_AUTHENTICATOR_GENERAL_ERROR', 'The authenticator broke.'), 'create')).toEqual({
      kind: 'message',
      message: 'The passkey could not be set up: The authenticator broke.',
    });
    expect(webauthnFailure(new Error('WebAuthn is not supported in this browser'), 'sign_in')).toEqual({
      kind: 'message',
      message: 'Signing in with a passkey failed: WebAuthn is not supported in this browser.',
    });
    expect(webauthnFailure(undefined, 'confirm')).toEqual({ kind: 'message', message: 'Confirming with a passkey failed.' });
  });
});

describe('autofillAgain', () => {
  const cancelled = { kind: 'cancelled' } as const;
  const message = { kind: 'message', message: 'x' } as const;

  it('asks again after a picked passkey failed, or after the browser timed the request out', () => {
    expect(autofillAgain({ failure: message, picked: true, elapsedMs: 1_000 })).toBe(true);
    expect(autofillAgain({ failure: cancelled, picked: true, elapsedMs: 1_000 })).toBe(true);
    expect(autofillAgain({ failure: cancelled, picked: false, elapsedMs: AUTOFILL_TIMEOUT_MIN_MS })).toBe(true);
  });

  it('stops after the page ended it, or a refusal at once (no loop of options calls)', () => {
    expect(autofillAgain({ failure: { kind: 'aborted' }, picked: true, elapsedMs: 600_000 })).toBe(false);
    expect(autofillAgain({ failure: cancelled, picked: false, elapsedMs: 50 })).toBe(false);
    // The options call refused (429, passkeys off): never picked.
    expect(autofillAgain({ failure: message, picked: false, elapsedMs: 600_000 })).toBe(false);
  });

  it('stops after a picked passkey was refused for what no other passkey changes; passkey_error asks again', () => {
    const refused = (err: ApiError) => autofillAgain({ failure: webauthnFailure(err, 'sign_in'), picked: true, elapsedMs: 1_000, err });
    expect(refused(new ApiError(403, 'account_disabled', 'This account is disabled'))).toBe(false);
    expect(refused(new ApiError(429, 'rate_limited', 'Too many attempts, try again later'))).toBe(false);
    expect(refused(new ApiError(409, 'conflict', 'Passkeys are not available on this instance (off).'))).toBe(false);
    expect(refused(new ApiError(0, 'network_error', 'offline'))).toBe(false);
    expect(refused(new ApiError(400, 'passkey_error', 'This passkey could not be used to sign in.'))).toBe(true);
  });
});

describe('failureText', () => {
  it('a button’s ceremony says the message, a hint when the browser ended it, nothing when the page did', () => {
    expect(failureText({ kind: 'message', message: 'x' }, 'sign_in')).toBe('x');
    expect(failureText(webauthnFailure(browserError('NotAllowedError'), 'sign_in'), 'sign_in')).toBe(NO_PASSKEY_USED_TEXT.sign_in);
    expect(failureText({ kind: 'cancelled' }, 'create')).toBe('No passkey was set up. Try again, or use another device or password manager.');
    expect(failureText({ kind: 'cancelled' }, 'confirm')).toBe('No passkey was used. Try again.');
    expect(failureText({ kind: 'aborted' }, 'sign_in')).toBeNull();
  });
});
