// The account's email address (design §5.8.6, §5.8.10): POST /api/account/email (changing it, which is
// also how an account from before email addresses adds one; re-auth), POST /api/account/email/verify, and
// POST /api/auth/email/confirm, the link of both (public; the purpose of the token decides).
// - With links that can be mailed (mailer.sendsTokens), a change answers 202 whatever the address: after
//   the answer the new address gets the confirmation link (1 hour), or, when another account has it,
//   email_change_taken. The change happens when the link is followed, and only in a session of the account
//   that asked: nobody can attach someone else's address to their own account by getting its owner to open
//   the link (and then collect the address's pending invitations).
// - Without mail an address that is taken is said so (409, §13.6's accepted residual of mail-less
//   instances), and a free one is the account's at once, unverified.
// - A verification link confirms the account's current address only, and, like a change, only in a session
//   of that account: an address attached without proof (a change while the instance had no mail, a link
//   invitation accepted by its inviter) must not become verified when its real owner follows the link.
//   Signed out the answer names the account (401), and nothing is consumed until it signs in.

import { Hono } from 'hono';
import { emailChangeInput, tokenInput } from '@shared/schemas';
import type { EmailChangeDTO, EmailConfirmedDTO } from '@shared/types';
import { badRequest, conflict, forbidden, HttpError } from '../../http/errors';
import { readBody, readJson } from '../../http/validate';
import type { DirectoryEnv } from '../app';
import { afterResponse, type DirectoryContext } from '../context';
import { findEmailToken, issueEmailToken, redeemEmailToken, sendVerification } from '../emailTokens';
import { currentMeta, freshSession, requireRecent } from '../middleware';
import { recordEvent } from '../security';
import { pushInvalidate } from '../spaces';
import { changeEmail, findUser, findUserByEmailKey } from '../users';
import { assertLinkAttempts, invalidLink, spendMailRequest } from './auth';

export const EMAIL_TAKEN = 'That email address is used by another account';

export function emailRoutes(ctx: DirectoryContext) {
  const { db, mailer } = ctx;
  const r = new Hono<DirectoryEnv>();

  r.post('/account/email', async (c) => {
    const { email } = await readJson(c, emailChangeInput);
    const meta = currentMeta(c);
    const { user } = freshSession(c, ctx);
    requireRecent(c, ctx);
    if (email.key === user.email_key) {
      throw badRequest('This is your email address already', [{ path: 'email', message: 'This is your email address already' }]);
    }
    const nowMs = ctx.now();
    if (mailer.sendsTokens) {
      spendMailRequest(ctx, c, email.key, { anonymous: false });
      recordEvent(db, { type: 'email_change_requested', userId: user.id, meta, data: { email: email.address }, nowMs });
      // Whether another account has the address is looked up after the answer (the same answer either way).
      afterResponse(ctx, () => {
        const account = findUser(db, user.id);
        if (!account) return;
        if (findUserByEmailKey(db, email.key)) {
          mailer.emailChangeTaken({ user: account, to: email.address, meta });
          return;
        }
        const { token } = issueEmailToken(db, { purpose: 'change_email', user: account, email, meta, nowMs: ctx.now() });
        mailer.emailChangeConfirm({ user: account, to: email.address, token, meta });
      });
      return c.json<EmailChangeDTO>({ ok: true, pending: true }, 202);
    }
    if (findUserByEmailKey(db, email.key)) throw conflict(EMAIL_TAKEN);
    const spaces = db.tx(() => {
      const spaces = changeEmail(db, { userId: user.id, email, verified: false, nowMs });
      recordEvent(db, { type: 'email_changed', userId: user.id, meta, data: user.email ? { email: email.address, from: user.email } : { email: email.address }, nowMs });
      return spaces;
    });
    await pushInvalidate(ctx, spaces, 'defer');
    return c.json<EmailChangeDTO>({ ok: true, pending: false, email: email.address });
  });

  r.post('/account/email/verify', async (c) => {
    // No input, but the body is read before acting (Appendix D 21).
    await readBody(c);
    const meta = currentMeta(c);
    const { user } = freshSession(c, ctx);
    if (user.email === null || user.email_key === null) throw conflict('Your account has no email address. Add one first.');
    if (user.email_verified_at !== null) throw conflict('Your email address is verified already');
    if (!mailer.sendsTokens) throw new HttpError(409, 'mail_not_configured', 'Verifying an email address needs a mail transport (MAIL_TRANSPORT)');
    spendMailRequest(ctx, c, user.email_key, { anonymous: false });
    sendVerification(ctx, user, meta);
    return c.json({ ok: true }, 202);
  });

  r.post('/auth/email/confirm', async (c) => {
    const { token } = await readJson(c, tokenInput);
    const meta = currentMeta(c);
    assertLinkAttempts(ctx, c);
    const found = findEmailToken(db, token, ['verify_email', 'change_email'], ctx.now());
    const owner = found?.user_id ? findUser(db, found.user_id) : null;
    if (!found || !owner) throw invalidLink(ctx, c);
    const nowMs = ctx.now();

    // Both purposes: only in a session of the token's account; nothing is consumed otherwise.
    if (!c.get('session')) {
      throw new HttpError(401, 'unauthorized', `Sign in as ${owner.display_name} to confirm this address`, [
        { path: 'displayName', message: owner.display_name },
      ]);
    }
    const { user } = freshSession(c, ctx);
    if (user.id !== owner.id) throw forbidden('This link belongs to another account');

    if (found.purpose === 'verify_email') {
      const email = db.tx(() => {
        const row = redeemEmailToken(db, token, 'verify_email', nowMs);
        const account = row?.user_id === user.id ? findUser(db, user.id) : null;
        // The link confirms the address it was sent to, while that is still the account's.
        if (!row || !account || account.email === null || account.email_key !== row.email_key) return null;
        if (account.email_verified_at === null) {
          db.run('UPDATE users SET email_verified_at = :now, updated_at = :now WHERE id = :id', { id: account.id, now: new Date(nowMs).toISOString() });
          recordEvent(db, { type: 'email_verified', userId: account.id, meta, data: { email: account.email }, nowMs });
        }
        return account.email;
      });
      if (email === null) throw invalidLink(ctx, c);
      return c.json<EmailConfirmedDTO>({ ok: true, email, purpose: 'verify_email' });
    }

    const done = db.tx(() => {
      const row = redeemEmailToken(db, token, 'change_email', nowMs);
      if (!row || row.user_id !== user.id) return null;
      const holder = findUserByEmailKey(db, row.email_key);
      // Rolls the redemption back: the link stays as it was.
      if (holder && holder.id !== user.id) throw conflict(EMAIL_TAKEN);
      const before = findUser(db, user.id)!;
      const spaces = changeEmail(db, { userId: user.id, email: { address: row.email, key: row.email_key }, verified: true, nowMs });
      recordEvent(db, {
        type: 'email_changed',
        userId: user.id,
        meta,
        data: before.email ? { email: row.email, from: before.email } : { email: row.email },
        nowMs,
      });
      return { before, spaces, email: row.email };
    });
    if (done === null) throw invalidLink(ctx, c);
    // To the old address (the account as it was: the notice goes to a verified address only).
    if (done.before.email !== null) mailer.emailChangedNotice({ user: done.before, meta });
    await pushInvalidate(ctx, done.spaces, 'defer');
    return c.json<EmailConfirmedDTO>({ ok: true, email: done.email, purpose: 'change_email' });
  });

  return r;
}
