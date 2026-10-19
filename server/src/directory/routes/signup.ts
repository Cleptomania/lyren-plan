// /api/auth/signup (design §5.8.5): open sign-up with email verification. No account exists before the
// owner of the address follows the emailed link (24 hours).
// - POST /signup answers 202 whatever the address. Whether it has an account is looked up after the
//   answer (afterResponse), so neither the answer nor its time tells: an address with an account gets
//   signup_existing (sign in, or reset the password), a new one the sign-up link. Without a transport that
//   delivers mail (and without MAIL_LOG_BODIES) no token is minted at all.
// - POST /signup/inspect shows the address; POST /signup/complete consumes the link and creates the
//   account (its address verified), its default space and a session.
// - With a passkey instead of a password: POST /signup/passkey/options (the link inspected, not used up; a
//   ceremony bound to it, with the user handle of the account to be) and POST /signup/passkey/complete
//   (the ceremony used up and the registration verified, then the link consumed and the account created
//   with the passkey and no password).
// Under any policy but open every request answers 403 signup_disabled, the same for every address.

import { Hono } from 'hono';
import { signupCompleteInput, signupInput, signupPasskeyCompleteInput, signupPasskeyOptionsInput, tokenInput } from '@shared/schemas';
import type { CeremonyDTO, SignupPreviewDTO, UserDTO } from '@shared/types';
import { randomToken } from '../../core/crypto';
import { conflict, HttpError, passkeyError } from '../../http/errors';
import { findByCredentialId } from '../../passkeys/credentials';
import { parseInput, readBody, readJson } from '../../http/validate';
import type { DirectoryEnv } from '../app';
import { afterResponse, type DirectoryContext } from '../context';
import { readDeviceToken } from '../devices';
import { findEmailToken, issueEmailToken, redeemEmailToken } from '../emailTokens';
import { currentMeta } from '../middleware';
import { beginRegistration, finishRegistration, PASSKEY_REGISTERED_ALREADY, requireRelyingParty } from '../passkeys';
import { getInstanceSettings } from '../settings';
import { createAccount, findUserByEmailKey, toUserDTO } from '../users';
import { assertLinkAttempts, checkPasswordLength, invalidLink, signIn, spendMailRequest } from './auth';

export const SIGNUP_TAKEN = 'An account with this email already exists. Sign in instead.';

/** 403 signup_disabled unless the policy is open (§5.3). */
export function assertSignupOpen(ctx: DirectoryContext): void {
  const policy = getInstanceSettings(ctx.db, ctx.config).signupPolicy;
  if (policy === 'open') return;
  throw new HttpError(403, 'signup_disabled', policy === 'closed' ? 'Sign-up is closed.' : 'Sign-up is by invitation only.');
}

export function signupRoutes(ctx: DirectoryContext) {
  const { db, mailer } = ctx;
  const r = new Hono<DirectoryEnv>();

  r.post('/signup', async (c) => {
    const body = await readBody(c);
    // The policy first: the same refusal for every address, valid or not.
    assertSignupOpen(ctx);
    const { email } = parseInput(signupInput, body);
    const meta = currentMeta(c);
    // Without mail (an open policy kept from a configuration with mail) nothing happens, and nothing is counted.
    if (!mailer.sendsTokens) return c.json({ ok: true }, 202);
    spendMailRequest(ctx, c, email.key, { anonymous: true });
    afterResponse(ctx, () => {
      const user = findUserByEmailKey(db, email.key);
      if (user) {
        mailer.signupExisting({ user, meta });
        return;
      }
      const { token } = issueEmailToken(db, { purpose: 'signup', user: null, email, meta, nowMs: ctx.now() });
      mailer.signupVerify({ to: email.address, token, meta });
    });
    return c.json({ ok: true }, 202);
  });

  r.post('/signup/inspect', async (c) => {
    const { token } = await readJson(c, tokenInput);
    assertLinkAttempts(ctx, c);
    const row = findEmailToken(db, token, ['signup'], ctx.now());
    if (!row) throw invalidLink(ctx, c);
    return c.json<SignupPreviewDTO>({ email: row.email });
  });

  r.post('/signup/complete', async (c) => {
    const input = await readJson(c, signupCompleteInput);
    const meta = currentMeta(c);
    assertLinkAttempts(ctx, c);
    // Cheapest checks first: no hash for a request that cannot succeed.
    const found = findEmailToken(db, input.token, ['signup'], ctx.now());
    if (!found) throw invalidLink(ctx, c);
    assertSignupOpen(ctx);
    if (findUserByEmailKey(db, found.email_key)) throw conflict(SIGNUP_TAKEN);
    checkPasswordLength(ctx, input.password, 'password');
    const passwordHash = await ctx.passwords.hash(input.password);
    // Other requests ran during the hash: the link is consumed now (once), then the rules are asked again.
    const row = redeemEmailToken(db, input.token, 'signup', ctx.now());
    if (!row) throw invalidLink(ctx, c);
    assertSignupOpen(ctx);
    if (findUserByEmailKey(db, row.email_key)) throw conflict(SIGNUP_TAKEN);
    const created = await createAccount(ctx, {
      email: { address: row.email, key: row.email_key },
      emailVerified: true,
      displayName: input.displayName,
      passwordHash,
      isInstanceAdmin: false,
      authMethod: 'signup',
      sampleData: null,
      meta,
      deviceToken: readDeviceToken(c.req.header('cookie'), meta.secure),
      takenMessage: SIGNUP_TAKEN,
    });
    signIn(c, ctx, created.session.token, created.session.row, created.deviceToken);
    return c.json<{ user: UserDTO }>({ user: toUserDTO(db, created.user) }, 201);
  });

  r.post('/signup/passkey/options', async (c) => {
    const input = await readJson(c, signupPasskeyOptionsInput);
    const rp = requireRelyingParty(ctx);
    assertLinkAttempts(ctx, c);
    const found = findEmailToken(db, input.token, ['signup'], ctx.now());
    if (!found) throw invalidLink(ctx, c);
    assertSignupOpen(ctx);
    if (findUserByEmailKey(db, found.email_key)) throw conflict(SIGNUP_TAKEN);
    // The account's WebAuthn user handle, made now: the passkey is registered with it.
    const handle = randomToken(32);
    const ceremony = await beginRegistration(ctx, c, rp, {
      binding: { purpose: 'signup', emailTokenId: found.id },
      user: { handle, name: found.email, displayName: input.displayName },
      exclude: [],
      pendingUserHandle: handle,
    });
    return c.json<CeremonyDTO>(ceremony);
  });

  r.post('/signup/passkey/complete', async (c) => {
    const input = await readJson(c, signupPasskeyCompleteInput);
    const meta = currentMeta(c);
    const rp = requireRelyingParty(ctx);
    assertLinkAttempts(ctx, c);
    // Cheapest checks first: no verification for a request that cannot succeed.
    const found = findEmailToken(db, input.token, ['signup'], ctx.now());
    if (!found) throw invalidLink(ctx, c);
    assertSignupOpen(ctx);
    if (findUserByEmailKey(db, found.email_key)) throw conflict(SIGNUP_TAKEN);
    const { credential, ceremony } = await finishRegistration(ctx, rp, {
      ceremonyId: input.ceremonyId,
      binding: { purpose: 'signup', emailTokenId: found.id },
      response: input.response,
    });
    // Other requests ran during the verification: the link is consumed now (once), then the rules are asked again.
    if (findByCredentialId(db, credential.credentialId)) throw passkeyError(PASSKEY_REGISTERED_ALREADY);
    const row = redeemEmailToken(db, input.token, 'signup', ctx.now());
    if (!row) throw invalidLink(ctx, c);
    assertSignupOpen(ctx);
    if (findUserByEmailKey(db, row.email_key)) throw conflict(SIGNUP_TAKEN);
    const created = await createAccount(ctx, {
      email: { address: row.email, key: row.email_key },
      emailVerified: true,
      displayName: input.displayName,
      passwordHash: null,
      passkey: { credential, rpId: rp.rpId, name: input.passkeyName ?? 'Passkey 1' },
      userHandle: ceremony.pending_user_handle!,
      isInstanceAdmin: false,
      authMethod: 'signup',
      sampleData: null,
      meta,
      deviceToken: readDeviceToken(c.req.header('cookie'), meta.secure),
      takenMessage: SIGNUP_TAKEN,
    });
    signIn(c, ctx, created.session.token, created.session.row, created.deviceToken);
    return c.json<{ user: UserDTO }>({ user: toUserDTO(db, created.user) }, 201);
  });

  return r;
}
