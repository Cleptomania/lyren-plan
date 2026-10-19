// Password reset links that are handed to someone rather than requested by mail: an admin's for another
// account (design §5.8.11, recovery without mail) and the operator's recovery token (§5.8.19, the
// break-glass way in when no administrator can sign in). Both make a reset_password token; the user then
// chooses a password through /reset like any other reset (routes/reset.ts), and is told at the next
// sign-in (AuthStatusDTO.notices: admin_reset_link, recovery_used).

import type { RecoveryLinkDTO, ResetLinkDTO } from '@shared/types';
import type { TrustedMeta } from '../core/ports';
import type { DirectoryContext } from './context';
import { HANDED_RESET_TTL_MS, issueEmailToken } from './emailTokens';
import { recordEvent } from './security';
import { findUser, type UserRow } from './users';

/**
 * email_tokens needs an address; an account from before email addresses has none, and its link goes to
 * nobody (it is handed over), so its token records the empty address.
 */
const addressOf = (user: UserRow) => ({ address: user.email ?? '', key: user.email_key ?? '' });

/**
 * POST /api/admin/users/:userId/reset-link (§5.8.11). The caller has checked that `target` is no
 * instance admin, nor was one lately (admin.ts#resetLinkRefusal), the re-auth window and ar:<adminId>. With mail and a verified address the link goes to
 * the user (30 minutes) and the admin gets none, so an admin can help but cannot sign in as them;
 * otherwise the admin gets a link that works for 24 hours. Either way the event admin_reset_link (the
 * user's notice at the next sign-in) and, with mail, the password_reset_by_admin notice.
 */
export function createResetLink(ctx: DirectoryContext, o: { admin: UserRow; target: UserRow; meta: TrustedMeta }): ResetLinkDTO {
  const { db, mailer } = ctx;
  const nowMs = ctx.now();
  const mailed = mailer.deliversMail && o.target.email !== null && o.target.email_verified_at !== null;
  const { token, expiresAt } = db.tx(() => {
    const issued = issueEmailToken(db, {
      purpose: 'reset_password',
      user: o.target,
      email: addressOf(o.target),
      ttlMs: mailed ? undefined : HANDED_RESET_TTL_MS,
      issuedBy: o.admin.id,
      meta: o.meta,
      nowMs,
    });
    recordEvent(db, {
      type: 'admin_reset_link',
      userId: o.target.id,
      actorId: o.admin.id,
      meta: o.meta,
      data: { delivery: mailed ? 'mail' : 'link', displayName: o.target.display_name },
      nowMs,
    });
    return issued;
  });
  // No meta for the messages: their mail_failed would put the admin's address in the user's own log.
  if (mailed) mailer.passwordReset({ user: o.target, token, anonymous: false, byAdmin: true, meta: null });
  if (mailer.deliversMail) mailer.passwordResetByAdmin({ user: o.target, adminName: o.admin.display_name, meta: null });
  return mailed ? { sent: true } : { sent: false, link: mailer.link(`/reset#t=${token}`), expiresAt };
}

/**
 * POST /api/auth/recover with the right RECOVERY_TOKEN (§5.8.19): a reset link for the account (24 hours,
 * issued by nobody), and, when no active instance admin is left, the account becomes one (and active, so
 * it can sign in with the link). The event recovery_used is the account's notice and every admin sees it;
 * a mail notice follows when mail works.
 */
export function recoverAccount(ctx: DirectoryContext, o: { user: UserRow; meta: TrustedMeta }): RecoveryLinkDTO {
  const { db, mailer } = ctx;
  const nowMs = ctx.now();
  const done = db.tx(() => {
    const admins = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE is_instance_admin = 1 AND status = 'active'")!.n;
    const madeAdmin = admins === 0;
    if (madeAdmin) {
      db.run("UPDATE users SET is_instance_admin = 1, status = 'active', updated_at = :now WHERE id = :id", {
        id: o.user.id,
        now: new Date(nowMs).toISOString(),
      });
    }
    const user = findUser(db, o.user.id)!;
    const issued = issueEmailToken(db, {
      purpose: 'reset_password',
      user,
      email: addressOf(user),
      ttlMs: HANDED_RESET_TTL_MS,
      issuedBy: null,
      meta: o.meta,
      nowMs,
    });
    recordEvent(db, { type: 'recovery_used', userId: user.id, meta: o.meta, data: { madeAdmin, displayName: user.display_name }, nowMs });
    return { ...issued, user, madeAdmin };
  });
  // As above: the operator's address stays out of the account's own log.
  mailer.recoveryUsed({ user: done.user, madeAdmin: done.madeAdmin, meta: null });
  return { link: mailer.link(`/reset#t=${done.token}`), expiresAt: done.expiresAt, madeAdmin: done.madeAdmin };
}
