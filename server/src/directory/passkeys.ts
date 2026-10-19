// Passkeys in the directory (design §5.6, §5.8.3, §5.8.12-§5.8.14): what the passkey routes share. The
// relying party (409 while passkeys are off), the limits of the options calls (co:<ip>, co:<net>, every
// call) and of failed assertions (pk:<ip>, pk:<net>, each failure; buffered, so a one-off anonymous request
// writes no row), the steps of a registration and of an assertion, the rules that keep an account a way to
// sign in (only usable passkeys count: passkeys are on and the passkey was registered for this RP ID), and
// the passkey_added record. The warning about accounts a domain move left without one is admin.ts's.
//
// Every options call makes its challenge first and signs (sign-in) or stores (everything else) it before
// it awaits the library's options, so the rows it checked cannot change in between; every verifying call
// uses its ceremony up before it verifies, and re-reads what it acts on afterwards (§5).

import type { Context } from 'hono';
import type { CeremonyDTO } from '@shared/types';
import { randomToken } from '../core/crypto';
import type { TrustedMeta } from '../core/ports';
import { conflict, passkeyError, type HttpError } from '../http/errors';
import { ceremonyMatches, consumeCeremony, storeCeremony, type CeremonyBinding, type CeremonyRow } from '../passkeys/ceremonies';
import { PASSKEYS_PER_USER, storedCredential, usablePasskeys, type PasskeyRow } from '../passkeys/credentials';
import {
  counterRegressed,
  registrationOptions,
  relyingParty,
  verifyAssertion,
  verifyRegistration,
  type CredentialRef,
  type RegisteredCredential,
  type RelyingParty,
} from '../passkeys/webauthn';
import type { DirectoryEnv } from './app';
import type { DirectoryContext } from './context';
import { resetLinkRefusal } from './admin';
import { assertNotThrottled, clientKeys } from './routes/auth';
import { recordEvent } from './security';
import { POLICIES, type ThrottlePolicy } from './throttle';
import { otherActiveAdmins, type UserRow } from './users';

type C = Context<DirectoryEnv>;

export const PASSKEY_SIGN_IN_FAILED = 'This passkey could not be used to sign in.';
export const PASSKEY_REAUTH_FAILED = 'This passkey could not be used to confirm it is you.';
export const PASSKEY_SETUP_FAILED = 'This passkey could not be set up. Try again.';
export const PASSKEY_REGISTERED_ALREADY = 'This passkey is registered already.';
export const NO_USABLE_PASSKEY = 'This account has no passkey that works on this address.';
export const PASSKEY_QUOTA = `An account can have at most ${PASSKEYS_PER_USER} passkeys. Remove one first.`;
export const LAST_PASSKEY = 'This passkey is the only way left to sign in to your account. Set a password or add another passkey first.';
export const NO_PASSWORD = 'This account has no password.';
/** DELETE /api/account/password's refusals (§5.8.12, 409 last_credential). */
export const PASSWORD_NEEDS_PASSKEY = 'Add a passkey that works on this address before you remove your password.';
export const PASSWORD_NEEDS_VERIFIED_EMAIL =
  'Your account needs a verified email address first: a reset link by mail is how you would get back in if you lost your passkeys.';
export const ONLY_ADMIN_WITHOUT_MAIL = 'You are the only administrator and this instance cannot send mail: keep your password';
export const ADMIN_WITHOUT_MAIL = 'This instance cannot send mail, and administrators cannot create reset links for each other: keep your password';
export const NO_RESET_LINK_WITHOUT_MAIL = 'This instance cannot send mail, and no administrator can create a reset link for your account: keep your password';

/** The relying party; 409 while passkeys are off (no PUBLIC_URL that allows them, §5.6). */
export function requireRelyingParty(ctx: DirectoryContext): RelyingParty {
  const rp = relyingParty(ctx.config.passkeys);
  if (rp === null) throw conflict(`Passkeys are not available on this instance (${ctx.config.passkeys.disabledReason ?? 'off'}).`);
  return rp;
}

/** The RP ID passkeys must have been registered for to work here; null while passkeys are off. */
export function currentRpId(ctx: DirectoryContext): string | null {
  return relyingParty(ctx.config.passkeys)?.rpId ?? null;
}

/** A passkey as the options name it. */
export function credentialRef(row: PasskeyRow): CredentialRef {
  const { credentialId, transports } = storedCredential(row);
  return { credentialId, transports };
}

/**
 * The keys of a passkey limit: <name>:<ip> and <name>:<net>, the latter left out when it is the same text
 * (an address the server could not read, '-', has no coarser network).
 */
function passkeyKeys(c: C, ip: ThrottlePolicy, net: ThrottlePolicy): Array<[string, ThrottlePolicy]> {
  const keys = clientKeys(c);
  const list: Array<[string, ThrottlePolicy]> = [[`${ip.name}:${keys.ip}`, ip]];
  if (keys.net !== keys.ip) list.push([`${net.name}:${keys.net}`, net]);
  return list;
}

/** Every WebAuthn options call counts on co:<ip> and co:<net> (§5.9; 429 once over). */
export function spendOptionsRequest(ctx: DirectoryContext, c: C): void {
  const keys = passkeyKeys(c, POLICIES.co, POLICIES.coNet);
  assertNotThrottled(ctx, keys);
  for (const [key, policy] of keys) ctx.throttle.hit(key, policy);
}

/** 429 while the client is over pk:<ip> or pk:<net> (failed assertions); the sign-in and re-auth ask first. */
export function assertAssertionAttempts(ctx: DirectoryContext, c: C): void {
  assertNotThrottled(ctx, passkeyKeys(c, POLICIES.pk, POLICIES.pkNet));
}

/** A failed assertion: one count on pk:<ip> and pk:<net>, and the 400 passkey_error to throw. */
export function assertionFailed(ctx: DirectoryContext, c: C, message: string, details?: Array<{ path: string; message: string }>): HttpError {
  for (const [key, policy] of passkeyKeys(c, POLICIES.pk, POLICIES.pkNet)) ctx.throttle.hit(key, policy);
  return passkeyError(message, details);
}

/** The name and display name an account's registration options give the authenticator. */
export function accountIdentity(user: Pick<UserRow, 'webauthn_user_id' | 'email' | 'username' | 'display_name'>) {
  return { handle: user.webauthn_user_id, name: user.email ?? user.username ?? user.display_name, displayName: user.display_name };
}

/**
 * Begin a registration (§5.6): counts on co, stores the ceremony for `binding` (with the handle of the
 * account to be created, for sign-up and invitations), then makes the options. The caller has checked
 * everything the request needs, with no await since.
 */
export async function beginRegistration(
  ctx: DirectoryContext,
  c: C,
  rp: RelyingParty,
  o: {
    binding: CeremonyBinding;
    user: { handle: string; name: string; displayName: string };
    exclude: readonly CredentialRef[];
    /** Sign-up and invitations: the user handle of the account the ceremony creates. */
    pendingUserHandle?: string;
  },
): Promise<CeremonyDTO> {
  spendOptionsRequest(ctx, c);
  const challenge = randomToken();
  const ceremonyId = storeCeremony(ctx.db, { binding: o.binding, challenge, pendingUserHandle: o.pendingUserHandle, nowMs: ctx.now() });
  const options = await registrationOptions(rp, {
    challenge,
    userHandle: o.user.handle,
    userName: o.user.name,
    displayName: o.user.displayName,
    exclude: o.exclude,
  });
  return { ceremonyId, options: options as unknown as Record<string, unknown> };
}

/**
 * Finish a registration: use up the ceremony (whatever follows), check that it was made for `binding`, and
 * verify the answer with its challenge. 400 passkey_error for any failure. The caller re-reads what it acts
 * on (this awaited) and checks that the credential is not registered already.
 */
export async function finishRegistration(
  ctx: DirectoryContext,
  rp: RelyingParty,
  o: { ceremonyId: string; binding: CeremonyBinding; response: unknown },
): Promise<{ credential: RegisteredCredential; ceremony: CeremonyRow }> {
  const ceremony = consumeCeremony(ctx.db, o.ceremonyId, o.binding.purpose, ctx.now());
  if (ceremony === null || !ceremonyMatches(ceremony, o.binding)) throw passkeyError(PASSKEY_SETUP_FAILED);
  const credential = await verifyRegistration(rp, o.response, ceremony.challenge);
  if (credential === null) throw passkeyError(PASSKEY_SETUP_FAILED);
  return { credential, ceremony };
}

/**
 * Verify an assertion by `passkey` (the answer's credential, the account's and usable here, checked by the
 * caller) for `challenge`. After the verification the passkey is read again: removed meanwhile, the
 * assertion fails; a signature counter that did not move forward (§5.6; one that stays 0 is fine) is
 * recorded as passkey_counter_regression (with `purpose`: a sign-in or a re-authentication) and fails.
 * Every failure counts on pk. Returns the new counter and backup state, which the caller stores with what
 * it does (recordPasskeyUse).
 */
export async function verifyPasskeyUse(
  ctx: DirectoryContext,
  c: C,
  rp: RelyingParty,
  o: { passkey: PasskeyRow; response: unknown; challenge: string; purpose: 'login' | 'reauth'; message: string; meta: TrustedMeta },
): Promise<{ counter: number; backedUp: boolean }> {
  const result = await verifyAssertion(rp, o.response, o.challenge, storedCredential(o.passkey));
  if (result === null) throw assertionFailed(ctx, c, o.message);
  const current = ctx.db.get<PasskeyRow>('SELECT * FROM passkeys WHERE id = :id', { id: o.passkey.id });
  if (!current) throw assertionFailed(ctx, c, o.message);
  if (counterRegressed(current.sign_count, result.counter)) {
    recordEvent(ctx.db, {
      type: 'passkey_counter_regression',
      userId: current.user_id,
      meta: o.meta,
      data: { passkeyId: current.id, name: current.name, stored: current.sign_count, received: result.counter, purpose: o.purpose },
      nowMs: ctx.now(),
    });
    throw assertionFailed(ctx, c, o.message);
  }
  return result;
}

/**
 * Why `passkey` cannot be removed (409 last_credential), or null. Only usable passkeys are a way to sign
 * in: removing one is refused when the account has no password and no other usable passkey (§5.6). A
 * passkey that does not work here can always go.
 */
export function passkeyRemovalRefusal(ctx: DirectoryContext, user: UserRow, passkey: PasskeyRow): string | null {
  const rpId = currentRpId(ctx);
  if (rpId === null || passkey.rp_id !== rpId || user.password_hash !== null) return null;
  return usablePasskeys(ctx.db, user.id, rpId).some((p) => p.id !== passkey.id) ? null : LAST_PASSKEY;
}

/**
 * Why the account cannot remove its password (§5.8.12; 409 last_credential), or null. It needs a usable
 * passkey, and a way back in should it lose every passkey (wayBackInRefusal).
 */
export function passwordRemovalRefusal(ctx: DirectoryContext, user: UserRow): string | null {
  if (usablePasskeys(ctx.db, user.id, currentRpId(ctx)).length === 0) return PASSWORD_NEEDS_PASSKEY;
  return wayBackInRefusal(ctx, user);
}

/**
 * Why an account without a password would have no way back in should it lose every passkey (§5.8.12's second
 * condition), or null: it has a verified address on an instance that delivers mail (forgot password); or an
 * administrator may create a reset link for it (another active admin, and the account is not an admin's, nor
 * demoted lately, §5.8.11); or it is the Node runtime (the reset-password command).
 */
export function wayBackInRefusal(ctx: DirectoryContext, user: UserRow): string | null {
  const { db } = ctx;
  const mail = ctx.mailer.deliversMail;
  if (mail && user.email !== null && user.email_verified_at !== null) return null;
  const others = otherActiveAdmins(db, user.id);
  if (others > 0 && resetLinkRefusal(db, user, ctx.now()) === null) return null;
  if (ctx.deps.runtime.kind === 'node') return null;
  if (mail) return PASSWORD_NEEDS_VERIFIED_EMAIL;
  if (user.is_instance_admin === 1) return others === 0 ? ONLY_ADMIN_WITHOUT_MAIL : ADMIN_WITHOUT_MAIL;
  return NO_RESET_LINK_WITHOUT_MAIL;
}

/**
 * passkey_added for the account (inside the caller's transaction): `via` says where the passkey came from
 * (Account settings, a reset link, the sign-up or invitation that created the account).
 */
export function recordPasskeyAdded(
  ctx: DirectoryContext,
  o: { userId: number; passkey: PasskeyRow; via: 'settings' | 'reset' | 'signup' | 'invite'; meta: TrustedMeta; data?: Record<string, unknown> },
): void {
  recordEvent(ctx.db, {
    type: 'passkey_added',
    userId: o.userId,
    meta: o.meta,
    data: { passkeyId: o.passkey.id, name: o.passkey.name, via: o.via, ...o.data },
    nowMs: ctx.now(),
  });
}
