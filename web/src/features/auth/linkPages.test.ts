// The public pages' states (design §12.2, §12.7): the ways back in the sign-in page offers by mail, policy
// and runtime, the sign-up page under each policy, what a refused link comes to, and a reset with a passkey.
import { describe, expect, it } from 'vitest';
import type { InstanceInfoDTO } from '@shared/types';
import { ApiError, DAILY_LIMIT_TEXT, errorFromResponse } from '../../api/errors';
import {
  emailConfirmFailure,
  INVALID_LINK_TEXT,
  linkFailure,
  PASSKEY_SET_UP_TEXT,
  passkeyResetNotice,
  passkeyResetText,
  signInHelp,
  signupClosedText,
  tooManyText,
} from './linkPages';

function status(o: Partial<InstanceInfoDTO> = {}, desktop = false) {
  const instance = { mail: false, mailLinks: false, signupPolicy: 'invite_only', runtime: 'node', ...o } as InstanceInfoDTO;
  return desktop ? { instance, desktop: { exe: 'lyren-plan.exe', windows: true } } : { instance };
}

describe('signInHelp', () => {
  it('"Forgot password?" only when the instance mails links; otherwise "ask an administrator"', () => {
    expect(signInHelp(status({ mail: true, mailLinks: true }))).toMatchObject({ forgot: true, askAdmin: false });
    expect(signInHelp(status({ mail: false, mailLinks: false }))).toMatchObject({ forgot: false, askAdmin: true });
    // Development with MAIL_LOG_BODIES: the links are in the server's log.
    expect(signInHelp(status({ mail: false, mailLinks: true }))).toMatchObject({ forgot: true, askAdmin: false });
  });

  it('"Create an account" only under the open policy, and while the instance mails links (the sign-up link)', () => {
    expect(signInHelp(status({ mail: true, mailLinks: true, signupPolicy: 'open' })).signup).toBe(true);
    expect(signInHelp(status({ mail: true, mailLinks: true, signupPolicy: 'invite_only' })).signup).toBe(false);
    expect(signInHelp(status({ mail: true, mailLinks: true, signupPolicy: 'closed' })).signup).toBe(false);
    // The policy was set while mail worked; the server was started with MAIL_TRANSPORT=log since.
    expect(signInHelp(status({ mail: false, mailLinks: false, signupPolicy: 'open' })).signup).toBe(false);
    expect(signInHelp(status({ mail: false, mailLinks: true, signupPolicy: 'open' })).signup).toBe(true);
  });

  it('the reset-password command on Node only; the desktop app asks no administrator (its user runs it)', () => {
    expect(signInHelp(status({ runtime: 'node' })).command).toBe(true);
    expect(signInHelp(status({ runtime: 'cloudflare' }))).toMatchObject({ command: false, askAdmin: true });
    expect(signInHelp(status({ runtime: 'node' }, true))).toMatchObject({ command: true, askAdmin: false, forgot: false });
  });
});

describe('signupClosedText', () => {
  it('explains every policy but open, which shows the form while the instance mails links', () => {
    expect(signupClosedText({ signupPolicy: 'open', mailLinks: true })).toBeNull();
    expect(signupClosedText({ signupPolicy: 'invite_only', mailLinks: true })?.title).toBe('Sign-up is by invitation only');
    expect(signupClosedText({ signupPolicy: 'closed', mailLinks: true })?.title).toBe('Sign-up is closed');
    expect(signupClosedText({ signupPolicy: 'open', mailLinks: false })?.title).toBe('Sign-up is not available at the moment');
  });
});

describe('linkFailure', () => {
  it('one state for every link the server will not take, in its words', () => {
    const invalid = new ApiError(400, 'invalid_token', 'This link is invalid or has expired.');
    expect(linkFailure(invalid)).toEqual({ kind: 'invalid', message: 'This link is invalid or has expired.' });
    // A token cut short when it was copied: refused by the schema, the same state.
    const short = new ApiError(400, 'validation_error', 'token: Invalid link', [{ path: 'token', message: 'Invalid link' }]);
    expect(linkFailure(short)).toEqual({ kind: 'invalid', message: INVALID_LINK_TEXT });
  });

  it('a link that may work in a while: the network, too many attempts, the server', () => {
    expect(linkFailure(new ApiError(0, 'network_error', 'x')).kind).toBe('retry');
    expect(linkFailure(new ApiError(429, 'rate_limited', 'Too many attempts, try again later'))).toEqual({
      kind: 'retry',
      message: 'Too many attempts. Wait a few minutes before trying again.',
    });
    expect(linkFailure(new ApiError(503, 'unavailable', 'Too many sign-ins at the moment.'))).toEqual({ kind: 'retry', message: 'Too many sign-ins at the moment.' });
  });

  it('Cloudflare’s daily request limit keeps its own words: it lasts until 00:00 UTC, not minutes', () => {
    const daily = errorFromResponse(429, '<html>Error 1027 · This website has been temporarily rate limited</html>');
    expect(linkFailure(daily)).toEqual({ kind: 'retry', message: DAILY_LIMIT_TEXT });
    expect(tooManyText(daily)).toBe(DAILY_LIMIT_TEXT);
    // The zone's rate-limiting rule (1015) and the server's own throttle: minutes.
    expect(tooManyText(errorFromResponse(429, '<html>error code: 1015</html>'))).toBe('Too many attempts. Wait a few minutes before trying again.');
    expect(tooManyText(new ApiError(429, 'rate_limited', 'Too many attempts, try again later'))).toBe('Too many attempts. Wait a few minutes before trying again.');
  });

  it('other refusals keep their code and the server’s message', () => {
    expect(linkFailure(new ApiError(403, 'signup_disabled', 'Sign-up is closed.'))).toEqual({ kind: 'refused', code: 'signup_disabled', message: 'Sign-up is closed.' });
    const taken = new ApiError(409, 'conflict', 'An account with this email already exists. Sign in instead.');
    expect(linkFailure(taken)).toMatchObject({ kind: 'refused', code: 'conflict' });
  });
});

describe('emailConfirmFailure', () => {
  it('an email change signed out: sign in as the account the server names; as another account: sign out first', () => {
    const signedOut = new ApiError(401, 'unauthorized', 'Sign in as Alice to confirm this address', [{ path: 'displayName', message: 'Alice' }]);
    expect(emailConfirmFailure(signedOut)).toEqual({ kind: 'sign_in', displayName: 'Alice', message: 'Sign in as Alice to confirm this address' });
    expect(emailConfirmFailure(new ApiError(401, 'unauthorized', 'Sign in'))).toMatchObject({ kind: 'sign_in', displayName: null });
    expect(emailConfirmFailure(new ApiError(403, 'forbidden', 'This link belongs to another account'))).toEqual({
      kind: 'other_account',
      message: 'This link belongs to another account',
    });
  });

  it('otherwise as any link', () => {
    expect(emailConfirmFailure(new ApiError(400, 'invalid_token', INVALID_LINK_TEXT)).kind).toBe('invalid');
    expect(emailConfirmFailure(new ApiError(409, 'conflict', 'That email address is used by another account'))).toMatchObject({ kind: 'refused', code: 'conflict' });
  });
});

describe('a reset with a passkey', () => {
  const kept = 'You are the only administrator and this instance cannot send mail: keep your password';

  it('says beforehand whether the passkey replaces the password', () => {
    expect(passkeyResetText({ hasPassword: true, passkeyKeepsPassword: null })).toMatch(/^The passkey replaces the password, which stops working/);
    expect(passkeyResetText({ hasPassword: true, passkeyKeepsPassword: kept })).toBe(
      'This signs the account out on every device. You then sign in with the passkey; the password keeps working too. ' +
        'You are the only administrator and this instance cannot send mail: keep your password.',
    );
    expect(passkeyResetText({ hasPassword: false, passkeyKeepsPassword: null })).toBe('This signs the account out on every device. You then sign in with the passkey.');
  });

  it('and afterwards what happened to it', () => {
    expect(passkeyResetNotice({ passwordRemoved: true, passwordKept: null })).toBe('Passkey set up, and your password removed. Sign in with the passkey.');
    expect(passkeyResetNotice({ passwordRemoved: false, passwordKept: kept })).toBe(`Passkey set up. Sign in with it. Your password still works too. ${kept}.`);
    expect(passkeyResetNotice({ passwordRemoved: false, passwordKept: null })).toBe(PASSKEY_SET_UP_TEXT);
  });
});
