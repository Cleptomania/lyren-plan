// /api/auth/password/{forgot,reset} (design §5.8.9) and /api/auth/recover (§5.8.19). Public.
// - forgot answers 202 whatever the address. After the answer (afterResponse) an active account with that
//   address gets a reset link (30 minutes) by mail, when links can be mailed: with MAIL_TRANSPORT=log (and
//   no MAIL_LOG_BODIES) no token is minted at all, so no request can put a live link into a log. Any other
//   address counts on the mail budgets as that message would (§13.6: a full budget must not tell).
// - reset consumes the link (from forgot, an admin, or recovery), sets the password, bumps auth_epoch (every
//   other link of the account dies) and signs the account out everywhere: its sessions and device tokens go,
//   its lock-outs are cleared, and its spaces are told before the answer. No automatic sign-in (OWASP); the
//   password_changed notice lists what the account granted lately.
// - reset/passkey/options and reset/passkey use the link to set up a passkey instead (§5.8.9 step 4: a
//   passkey-only account's recovery, or anyone's choice): the registration is verified, then the link is
//   consumed, the passkey added, the password removed (unless the account would then have no way back in,
//   §5.8.12; Appendix D 59) and the account signed out everywhere as for a new password; the passkey_added
//   notice goes by mail.
// - recover is the operator's break-glass: with RECOVERY_TOKEN (compared as the setup code), a reset link
//   for any account, which also becomes an instance admin when none is left. 404 while the token is unset.

import { Hono } from 'hono';
import { forgotPasswordInput, recoverInput, resetPasskeyInput, resetPasswordInput, tokenInput } from '@shared/schemas';
import type { CeremonyDTO, PasskeyResetDTO, PasswordResetPreviewDTO, RecoveryLinkDTO } from '@shared/types';
import { expiredSessionCookies } from '../../core/cookies';
import { safeEqual } from '../../core/crypto';
import { forbidden, HttpError, notFound, passkeyError, quotaExceeded } from '../../http/errors';
import { defaultPasskeyName, findByCredentialId, insertPasskey, passkeyCount, PASSKEYS_PER_USER, usablePasskeys } from '../../passkeys/credentials';
import { relyingParty } from '../../passkeys/webauthn';
import { parseInput, readBody, readJson } from '../../http/validate';
import type { DirectoryEnv } from '../app';
import { afterResponse, type DirectoryContext } from '../context';
import { revokeDevices } from '../devices';
import { findEmailToken, issueEmailToken, redeemEmailToken } from '../emailTokens';
import { appendCookies, currentMeta } from '../middleware';
import {
  accountIdentity,
  beginRegistration,
  credentialRef,
  finishRegistration,
  PASSKEY_QUOTA,
  PASSKEY_REGISTERED_ALREADY,
  recordPasskeyAdded,
  requireRelyingParty,
  wayBackInRefusal,
} from '../passkeys';
import { recoverAccount } from '../recovery';
import { recordEvent } from '../security';
import { memberSpaceIds, pushInvalidate } from '../spaces';
import { POLICIES, type ThrottlePolicy } from '../throttle';
import { findUser, findUserByEmailKey, resolveIdentifier } from '../users';
import { assertLinkAttempts, assertNotThrottled, checkPasswordLength, clientKeys, invalidLink, spendMailRequest } from './auth';

export function resetRoutes(ctx: DirectoryContext) {
  const { db, config, mailer, throttle } = ctx;
  const r = new Hono<DirectoryEnv>();

  r.post('/password/forgot', async (c) => {
    const { email } = await readJson(c, forgotPasswordInput);
    const meta = currentMeta(c);
    // Without mail the request does nothing at all, so it counts nothing either (no rows, §13.10).
    if (!mailer.sendsTokens) return c.json({ ok: true }, 202);
    spendMailRequest(ctx, c, email.key, { anonymous: true });
    afterResponse(ctx, () => {
      const user = findUserByEmailKey(db, email.key);
      if (!user || user.status !== 'active' || user.email === null) {
        mailer.passwordResetToNobody({ to: email.address });
        return;
      }
      const { token } = issueEmailToken(db, {
        purpose: 'reset_password',
        user,
        email: { address: user.email, key: email.key },
        meta,
        nowMs: ctx.now(),
      });
      mailer.passwordReset({ user, token, anonymous: true, meta });
    });
    return c.json({ ok: true }, 202);
  });

  r.post('/password/reset/inspect', async (c) => {
    const { token } = await readJson(c, tokenInput);
    assertLinkAttempts(ctx, c);
    const row = findEmailToken(db, token, ['reset_password'], ctx.now());
    const user = row?.user_id ? findUser(db, row.user_id) : null;
    if (!user) throw invalidLink(ctx, c);
    // §5.8.9 step 4: a passkey instead of a password, while passkeys are on and the account has room.
    const canUsePasskey = relyingParty(config.passkeys) !== null && passkeyCount(db, user.id) < PASSKEYS_PER_USER;
    return c.json<PasswordResetPreviewDTO>({
      email: user.email,
      username: user.username,
      hasPassword: user.password_hash !== null,
      canUsePasskey,
      passkeyKeepsPassword: canUsePasskey && user.password_hash !== null ? wayBackInRefusal(ctx, user) : null,
    });
  });

  r.post('/password/reset', async (c) => {
    const input = await readJson(c, resetPasswordInput);
    const meta = currentMeta(c);
    assertLinkAttempts(ctx, c);
    if (!findEmailToken(db, input.token, ['reset_password'], ctx.now())) throw invalidLink(ctx, c);
    checkPasswordLength(ctx, input.password, 'password');
    const hash = await ctx.passwords.hash(input.password);
    // After the hash: the link is consumed (once) and its auth_epoch checked in the transaction that uses it.
    const nowMs = ctx.now();
    const now = new Date(nowMs).toISOString();
    const done = db.tx(() => {
      const row = redeemEmailToken(db, input.token, 'reset_password', nowMs);
      if (!row || row.user_id === null) return null;
      const userId = row.user_id;
      db.run(
        `UPDATE users SET password_hash = :hash, password_changed_at = :now, updated_at = :now, auth_epoch = auth_epoch + 1
         WHERE id = :id`,
        { id: userId, hash, now },
      );
      // Signed out everywhere, and no browser keeps its exemption from the lock-outs.
      db.run('DELETE FROM sessions WHERE user_id = :id', { id: userId });
      revokeDevices(db, userId);
      recordEvent(db, { type: 'password_reset', userId, meta, data: row.issued_by === null ? {} : { issuedBy: row.issued_by }, nowMs });
      return { user: findUser(db, userId)!, spaces: memberSpaceIds(db, userId) };
    });
    if (!done) throw invalidLink(ctx, c);
    throttle.clear(`lid:a:${done.user.id}`);
    throttle.clear(`lda:${done.user.id}`);
    // The browser that reset the password may have been signed in to the account: that session is gone too.
    if (c.get('session')?.user_id === done.user.id) appendCookies(c, expiredSessionCookies(meta.secure));
    mailer.passwordChanged({ user: done.user, via: 'reset', meta });
    await pushInvalidate(ctx, done.spaces, 'await');
    return c.json({ ok: true });
  });

  r.post('/password/reset/passkey/options', async (c) => {
    const { token } = await readJson(c, tokenInput);
    const rp = requireRelyingParty(ctx);
    assertLinkAttempts(ctx, c);
    const row = findEmailToken(db, token, ['reset_password'], ctx.now());
    const user = row?.user_id ? findUser(db, row.user_id) : null;
    if (!row || !user) throw invalidLink(ctx, c);
    if (passkeyCount(db, user.id) >= PASSKEYS_PER_USER) throw quotaExceeded(PASSKEY_QUOTA);
    const ceremony = await beginRegistration(ctx, c, rp, {
      binding: { purpose: 'reset', emailTokenId: row.id, userId: user.id },
      user: accountIdentity(user),
      exclude: usablePasskeys(db, user.id, rp.rpId).map(credentialRef),
    });
    return c.json<CeremonyDTO>(ceremony);
  });

  r.post('/password/reset/passkey', async (c) => {
    const input = await readJson(c, resetPasskeyInput);
    const meta = currentMeta(c);
    const rp = requireRelyingParty(ctx);
    assertLinkAttempts(ctx, c);
    const found = findEmailToken(db, input.token, ['reset_password'], ctx.now());
    if (!found || found.user_id === null) throw invalidLink(ctx, c);
    const userId = found.user_id;
    if (passkeyCount(db, userId) >= PASSKEYS_PER_USER) throw quotaExceeded(PASSKEY_QUOTA);
    const { credential } = await finishRegistration(ctx, rp, {
      ceremonyId: input.ceremonyId,
      binding: { purpose: 'reset', emailTokenId: found.id, userId },
      response: input.response,
    });
    // After the verification: the link is consumed (once) and its auth_epoch checked in the transaction that uses it.
    const nowMs = ctx.now();
    const now = new Date(nowMs).toISOString();
    const done = db.tx(() => {
      const row = redeemEmailToken(db, input.token, 'reset_password', nowMs);
      if (!row || row.user_id !== userId) return null;
      if (passkeyCount(db, userId) >= PASSKEYS_PER_USER) throw quotaExceeded(PASSKEY_QUOTA);
      if (findByCredentialId(db, credential.credentialId)) throw passkeyError(PASSKEY_REGISTERED_ALREADY);
      const passkey = insertPasskey(db, { userId, credential, rpId: rp.rpId, name: input.name ?? defaultPasskeyName(db, userId), nowMs });
      // The passkey replaces the password (Appendix D 59), as a new password would, unless the account would
      // then have no way back in (§5.8.12): it keeps it, and the answer says why.
      const before = findUser(db, userId)!;
      const passwordKept = before.password_hash === null ? null : wayBackInRefusal(ctx, before);
      const passwordRemoved = before.password_hash !== null && passwordKept === null;
      db.run('UPDATE users SET updated_at = :now, auth_epoch = auth_epoch + 1 WHERE id = :id', { id: userId, now });
      if (passwordRemoved) db.run('UPDATE users SET password_hash = NULL, password_changed_at = NULL WHERE id = :id', { id: userId });
      // Signed out everywhere, as after a new password, and no browser keeps its exemption from the lock-outs.
      db.run('DELETE FROM sessions WHERE user_id = :id', { id: userId });
      revokeDevices(db, userId);
      const issuedBy = row.issued_by === null ? {} : { issuedBy: row.issued_by };
      recordPasskeyAdded(ctx, { userId, passkey, via: 'reset', meta, data: issuedBy });
      if (passwordRemoved) recordEvent(db, { type: 'password_removed', userId, meta, data: { via: 'reset', ...issuedBy }, nowMs });
      return { user: findUser(db, userId)!, passkey, spaces: memberSpaceIds(db, userId), passwordRemoved, passwordKept };
    });
    if (!done) throw invalidLink(ctx, c);
    // The lock-outs guard the password: they go with it, and stay while it does.
    if (done.user.password_hash === null) {
      throttle.clear(`lid:a:${userId}`);
      throttle.clear(`lda:${userId}`);
    }
    if (c.get('session')?.user_id === userId) appendCookies(c, expiredSessionCookies(meta.secure));
    mailer.passkeyAdded({ user: done.user, passkeyName: done.passkey.name, via: 'reset', meta });
    await pushInvalidate(ctx, done.spaces, 'await');
    return c.json<PasskeyResetDTO>({ ok: true, passwordRemoved: done.passwordRemoved, passwordKept: done.passwordKept });
  });

  r.post('/recover', async (c) => {
    const body = await readBody(c);
    const expected = config.recoveryToken;
    // Unset: as if the endpoint did not exist.
    if (expected === null) throw new HttpError(404, 'not_found', 'Not found');
    const input = parseInput(recoverInput, body);
    const { ip, net } = clientKeys(c);
    const keys: Array<[string, ThrottlePolicy]> = [
      [`li:${ip}`, POLICIES.li],
      [`ln:${net}`, POLICIES.ln],
    ];
    assertNotThrottled(ctx, keys);
    if (!safeEqual(input.token, expected)) {
      for (const [key, policy] of keys) throttle.hit(key, policy);
      throw forbidden('Invalid recovery token');
    }
    const { user } = resolveIdentifier(db, input.identifier);
    if (!user) throw notFound('Account');
    return c.json<RecoveryLinkDTO>(recoverAccount(ctx, { user, meta: currentMeta(c) }));
  });

  return r;
}
