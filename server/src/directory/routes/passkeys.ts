// Passkey routes (design §5.6, §5.8.3, §5.8.13, §5.8.14, §7.2). Every options call answers a CeremonyDTO
// (`{ ceremonyId, options }`, the options for @simplewebauthn/browser), and its verifying call sends the
// ceremony back with the browser's answer.
// - /api/auth (public): POST /passkey/login/options and /passkey/login, signing in with a discoverable
//   credential, modal or in the sign-in field's autofill. The options call stores nothing (a signed
//   ceremony); limits co on the options, pk on failures, and none of a password's (lg, lid, lda).
// - /api/account (signed in): GET /passkeys; POST /passkeys/options (re-auth window, fewer than 20) and POST
//   /passkeys to add one (passkey_added, and the notice by mail); PATCH /passkeys/:passkeyId to rename;
//   DELETE /passkeys/:passkeyId (re-auth window; the last usable credential stays), whose answer names the
//   passkeys the account keeps here for the WebAuthn signal API; POST /reauth/passkey/options and
//   /reauth/passkey, which open the re-auth window with one of the account's passkeys.
// Sign-up, invitation acceptance and the password reset with a passkey are routes/signup.ts', invitations.ts'
// and reset.ts'; removing the password is routes/account.ts'.

import { Hono } from 'hono';
import { ceremonyResponseInput, passkeyLoginOptionsInput, passkeyRegisterInput, passkeyRenameInput } from '@shared/schemas';
import type { CeremonyDTO, PasskeyDTO, PasskeyRemovedDTO, ReauthDTO, UserDTO } from '@shared/types';
import { randomToken } from '../../core/crypto';
import { accountDisabled, lastCredential, notFound, passkeyError, quotaExceeded } from '../../http/errors';
import { readBody, readId, readJson } from '../../http/validate';
import {
  CEREMONY_TTL_MS,
  CONDITIONAL_CEREMONY_TTL_MS,
  ceremonyMatches,
  consumeCeremony,
  consumeLoginCeremony,
  openLoginCeremony,
  signLoginCeremony,
  storeCeremony,
} from '../../passkeys/ceremonies';
import {
  defaultPasskeyName,
  deletePasskey,
  findByCredentialId,
  findPasskey,
  insertPasskey,
  listPasskeys,
  passkeyCount,
  PASSKEYS_PER_USER,
  recordPasskeyUse,
  renamePasskey,
  toPasskeyDTO,
  usablePasskeys,
} from '../../passkeys/credentials';
import { authenticationOptions, userHandleOf } from '../../passkeys/webauthn';
import type { DirectoryEnv } from '../app';
import type { DirectoryContext } from '../context';
import { issueDevice, readDeviceToken } from '../devices';
import { currentMeta, currentUser, freshSession, requireRecent } from '../middleware';
import {
  accountIdentity,
  assertAssertionAttempts,
  assertionFailed,
  beginRegistration,
  credentialRef,
  currentRpId,
  finishRegistration,
  NO_USABLE_PASSKEY,
  PASSKEY_QUOTA,
  PASSKEY_REAUTH_FAILED,
  PASSKEY_REGISTERED_ALREADY,
  PASSKEY_SIGN_IN_FAILED,
  passkeyRemovalRefusal,
  recordPasskeyAdded,
  requireRelyingParty,
  spendOptionsRequest,
  verifyPasskeyUse,
} from '../passkeys';
import { recordEvent } from '../security';
import { createSession, markReauthenticated, reauthUntil } from '../sessions';
import { getCeremonyKey } from '../settings';
import { findUser, findUserByWebauthnId, toUserDTO } from '../users';
import { signIn } from './auth';

/** Mounted at /api/auth: signing in with a passkey (§5.8.3). */
export function passkeyAuthRoutes(ctx: DirectoryContext) {
  const { db, config } = ctx;
  const r = new Hono<DirectoryEnv>();

  r.post('/passkey/login/options', async (c) => {
    const input = await readJson(c, passkeyLoginOptionsInput);
    const rp = requireRelyingParty(ctx);
    spendOptionsRequest(ctx, c);
    // Signed, not stored: an anonymous options call writes nothing (§5.6).
    const challenge = randomToken();
    const exp = ctx.now() + (input.conditional ? CONDITIONAL_CEREMONY_TTL_MS : CEREMONY_TTL_MS);
    const ceremonyId = signLoginCeremony(getCeremonyKey(db), { challenge, exp });
    const options = await authenticationOptions(rp, { challenge, allow: [], conditional: input.conditional });
    return c.json<CeremonyDTO>({ ceremonyId, options: options as unknown as Record<string, unknown> });
  });

  r.post('/passkey/login', async (c) => {
    const input = await readJson(c, ceremonyResponseInput);
    const meta = currentMeta(c);
    const rp = requireRelyingParty(ctx);
    assertAssertionAttempts(ctx, c);
    const ceremony = openLoginCeremony(getCeremonyKey(db), input.ceremonyId, ctx.now());
    if (ceremony === null) throw assertionFailed(ctx, c, PASSKEY_SIGN_IN_FAILED);
    // Only a passkey that works here signs in (an unknown one leaves the ceremony unused: nothing is written).
    // An unknown one is named, so that the browser forgets it, only when it was this instance's: its user
    // handle is an account's here (a passkey removed since, or one of another address of this instance). The
    // RP ID is not this instance's alone (WEBAUTHN_RP_ID may be a parent domain, other instances may share the
    // host), and the browser deletes what it is told is unknown (Appendix D 59).
    const passkey = findByCredentialId(db, input.response.id);
    if (passkey === null || passkey.rp_id !== rp.rpId) {
      const handle = userHandleOf(input.response);
      const ours = handle !== null && findUserByWebauthnId(db, handle) !== null;
      throw assertionFailed(ctx, c, PASSKEY_SIGN_IN_FAILED, ours ? [{ path: 'credential', message: 'unknown' }] : undefined);
    }
    const owner = findUser(db, passkey.user_id);
    if (owner === null || userHandleOf(input.response) !== owner.webauthn_user_id) throw assertionFailed(ctx, c, PASSKEY_SIGN_IN_FAILED);
    // Used up before the answer is verified: single use for every attempt that gets this far.
    if (!consumeLoginCeremony(db, input.ceremonyId, ceremony, ctx.now())) throw assertionFailed(ctx, c, PASSKEY_SIGN_IN_FAILED);
    const used = await verifyPasskeyUse(ctx, c, rp, {
      passkey,
      response: input.response,
      challenge: ceremony.challenge,
      purpose: 'login',
      message: PASSKEY_SIGN_IN_FAILED,
      meta,
    });
    // Re-read: the account may have been deleted or disabled while the answer was verified.
    const user = findUser(db, passkey.user_id);
    if (user === null) throw assertionFailed(ctx, c, PASSKEY_SIGN_IN_FAILED);
    // Only ever after a good passkey, as after a correct password.
    if (user.status === 'disabled') throw accountDisabled();
    const presented = readDeviceToken(c.req.header('cookie'), meta.secure);
    const done = ctx.now();
    const { token, session, device } = db.tx(() => {
      recordPasskeyUse(db, passkey.id, { ...used, nowMs: done });
      db.run('UPDATE users SET last_login_at = :now WHERE id = :id', { id: user.id, now: new Date(done).toISOString() });
      const created = createSession(db, { userId: user.id, authMethod: 'passkey', meta, config, nowMs: done });
      const device = issueDevice(db, user.id, presented, done);
      recordEvent(db, { type: 'passkey_login', userId: user.id, meta, data: { passkeyId: passkey.id, name: passkey.name }, nowMs: done });
      return { ...created, device };
    });
    signIn(c, ctx, token, session, device);
    return c.json<{ user: UserDTO }>({ user: toUserDTO(db, findUser(db, user.id) ?? user) });
  });

  return r;
}

/** Mounted at /api/account: the account's passkeys (§5.8.13) and re-authentication with one (§5.8.14). */
export function passkeyAccountRoutes(ctx: DirectoryContext) {
  const { db, config } = ctx;
  const r = new Hono<DirectoryEnv>();

  r.get('/passkeys', (c) => {
    const rpId = currentRpId(ctx);
    return c.json<PasskeyDTO[]>(listPasskeys(db, currentUser(c).id).map((row) => toPasskeyDTO(row, rpId)));
  });

  r.post('/passkeys/options', async (c) => {
    // No input, but the body is read before acting (Appendix D 21).
    await readBody(c);
    const { user, session } = freshSession(c, ctx);
    const rp = requireRelyingParty(ctx);
    // The rules that refuse anyway come before the re-auth window.
    if (passkeyCount(db, user.id) >= PASSKEYS_PER_USER) throw quotaExceeded(PASSKEY_QUOTA);
    requireRecent(c, ctx);
    const ceremony = await beginRegistration(ctx, c, rp, {
      binding: { purpose: 'register', userId: user.id, sessionId: session.id },
      user: accountIdentity(user),
      exclude: usablePasskeys(db, user.id, rp.rpId).map(credentialRef),
    });
    return c.json<CeremonyDTO>(ceremony);
  });

  r.post('/passkeys', async (c) => {
    const input = await readJson(c, passkeyRegisterInput);
    const meta = currentMeta(c);
    const { user, session } = freshSession(c, ctx);
    const rp = requireRelyingParty(ctx);
    if (passkeyCount(db, user.id) >= PASSKEYS_PER_USER) throw quotaExceeded(PASSKEY_QUOTA);
    const { credential } = await finishRegistration(ctx, rp, {
      ceremonyId: input.ceremonyId,
      binding: { purpose: 'register', userId: user.id, sessionId: session.id },
      response: input.response,
    });
    // Other requests ran during the verification: the session, the quota and the credential again.
    const fresh = freshSession(c, ctx);
    const nowMs = ctx.now();
    const passkey = db.tx(() => {
      if (passkeyCount(db, user.id) >= PASSKEYS_PER_USER) throw quotaExceeded(PASSKEY_QUOTA);
      if (findByCredentialId(db, credential.credentialId)) throw passkeyError(PASSKEY_REGISTERED_ALREADY);
      const row = insertPasskey(db, { userId: user.id, credential, rpId: rp.rpId, name: input.name ?? defaultPasskeyName(db, user.id), nowMs });
      recordPasskeyAdded(ctx, { userId: user.id, passkey: row, via: 'settings', meta });
      return row;
    });
    ctx.mailer.passkeyAdded({ user: fresh.user, passkeyName: passkey.name, via: 'settings', meta });
    return c.json<PasskeyDTO>(toPasskeyDTO(passkey, rp.rpId), 201);
  });

  r.patch('/passkeys/:passkeyId', async (c) => {
    const input = await readJson(c, passkeyRenameInput);
    const { user } = freshSession(c, ctx);
    const id = readId(c, 'passkeyId');
    if (!renamePasskey(db, user.id, id, input.name)) throw notFound('Passkey');
    return c.json<PasskeyDTO>(toPasskeyDTO(findPasskey(db, user.id, id)!, currentRpId(ctx)));
  });

  r.delete('/passkeys/:passkeyId', async (c) => {
    await readBody(c);
    const meta = currentMeta(c);
    const { user } = freshSession(c, ctx);
    const passkey = findPasskey(db, user.id, readId(c, 'passkeyId'));
    if (passkey === null) throw notFound('Passkey');
    // The last usable credential stays (§5.6), checked before the re-auth window.
    const refusal = passkeyRemovalRefusal(ctx, user, passkey);
    if (refusal !== null) throw lastCredential(refusal);
    requireRecent(c, ctx);
    db.tx(() => {
      deletePasskey(db, user.id, passkey.id);
      recordEvent(db, { type: 'passkey_removed', userId: user.id, meta, data: { passkeyId: passkey.id, name: passkey.name }, nowMs: ctx.now() });
    });
    // For PublicKeyCredential.signalAllAcceptedCredentials: what this RP ID still accepts for the account.
    const kept = usablePasskeys(db, user.id, currentRpId(ctx)).map((p) => p.credential_id);
    return c.json<PasskeyRemovedDTO>({ ok: true, acceptedCredentialIds: kept, userHandle: user.webauthn_user_id });
  });

  r.post('/reauth/passkey/options', async (c) => {
    await readBody(c);
    const { user, session } = freshSession(c, ctx);
    const rp = requireRelyingParty(ctx);
    const usable = usablePasskeys(db, user.id, rp.rpId);
    if (usable.length === 0) throw passkeyError(NO_USABLE_PASSKEY);
    spendOptionsRequest(ctx, c);
    const challenge = randomToken();
    const ceremonyId = storeCeremony(db, { binding: { purpose: 'reauth', userId: user.id, sessionId: session.id }, challenge, nowMs: ctx.now() });
    const options = await authenticationOptions(rp, { challenge, allow: usable.map(credentialRef) });
    return c.json<CeremonyDTO>({ ceremonyId, options: options as unknown as Record<string, unknown> });
  });

  r.post('/reauth/passkey', async (c) => {
    const input = await readJson(c, ceremonyResponseInput);
    const meta = currentMeta(c);
    const { user, session } = freshSession(c, ctx);
    const rp = requireRelyingParty(ctx);
    assertAssertionAttempts(ctx, c);
    // Used up first, whatever follows; then it must be this session's, and the passkey this account's.
    const ceremony = consumeCeremony(db, input.ceremonyId, 'reauth', ctx.now());
    if (ceremony === null || !ceremonyMatches(ceremony, { purpose: 'reauth', userId: user.id, sessionId: session.id })) {
      throw assertionFailed(ctx, c, PASSKEY_REAUTH_FAILED);
    }
    const passkey = findByCredentialId(db, input.response.id);
    if (passkey === null || passkey.user_id !== user.id || passkey.rp_id !== rp.rpId) throw assertionFailed(ctx, c, PASSKEY_REAUTH_FAILED);
    // A user handle is optional with allowCredentials, but when the authenticator sends one it must be this account's.
    const handle = userHandleOf(input.response);
    if (handle !== null && handle !== user.webauthn_user_id) throw assertionFailed(ctx, c, PASSKEY_REAUTH_FAILED);
    const used = await verifyPasskeyUse(ctx, c, rp, {
      passkey,
      response: input.response,
      challenge: ceremony.challenge,
      purpose: 'reauth',
      message: PASSKEY_REAUTH_FAILED,
      meta,
    });
    // The session may have been revoked while the answer was verified.
    const fresh = freshSession(c, ctx);
    const nowMs = ctx.now();
    db.tx(() => {
      recordPasskeyUse(db, passkey.id, { ...used, nowMs });
      markReauthenticated(db, fresh.session, nowMs);
    });
    return c.json<ReauthDTO>({ ok: true, reauthUntil: reauthUntil(fresh.session, config, ctx.now()) });
  });

  return r;
}
