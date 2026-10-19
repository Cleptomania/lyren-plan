// /api/admin: instance administration (design §5.8.18, §7.2), for instance admins only. Every write needs
// the re-auth window (§5.4.4) and is a security event with the admin as actor_id, which every admin sees in
// the overview. Writes check the admin before their body, then read the body, the fresh session and the
// admin again (Appendix D 21), and refuse what they refuse anyway before they ask for the window (Appendix
// D 11). The rules are directory/admin.ts's.
// - GET /overview: warnings, the instance, its configuration (no secrets), counts, the last 20 admin events.
// - PATCH /settings: the signup policy (`open` needs mail: 409 mail_not_configured) and the password minimum.
// - GET /users, GET/PATCH/DELETE /users/:userId: a searchable list; disable or enable, promote or demote
//   (never one's own account; the last active admin stays one); delete as §5.8.17 does, the admin acting.
// - POST /users/:userId/reset-link (§5.8.11, ar:<adminId>): a password reset link for an account that is no
//   instance admin, nor was one lately (admin.ts#resetLinkRefusal): mailed to its verified address (the
//   admin gets no link), else handed to the admin (24 hours). One admin cannot take over another, not even
//   by demoting it first (the CLI or the recovery token can).
// - GET/POST /invitations, DELETE /invitations/:invitationId: instance invitations (an account, no space).
// - GET /spaces, DELETE /spaces/:spaceId, POST /spaces/:spaceId/restore: every space, without content.
// - GET /backup (§9.5): a backup set of the directory and every space, written by the Node stack
//   (DirectoryDeps.backup) and streamed as application/x-tar. HEAD answers with the headers only and
//   writes nothing. Each download is a security event that every admin sees, since a set holds every
//   space and password hash.
// - POST /mail/test (§5.10.5): a test message to the admin's own address, sent at once, so mail can be
//   tried from the UI: { ok, messageId? }, or 502 unavailable with the transport's error (never a secret).

import { Hono } from 'hono';
import { adminInvitationInput, adminSettingsInput, adminSpacesQuery, adminUsersQuery, adminUserUpdateInput } from '@shared/schemas';
import type {
  AdminOverviewDTO,
  AdminSpaceDTO,
  AdminUserDetailDTO,
  AdminUserDTO,
  InstanceInfoDTO,
  InvitationCreatedDTO,
  InvitationDTO,
  MailTestDTO,
  Page,
  ResetLinkDTO,
} from '@shared/types';
import { conflict, forbidden, HttpError, notFound, rateLimited, unavailable } from '../../http/errors';
import { readBody, readId, readJson, readQuery } from '../../http/validate';
import {
  adminDeleteSpace,
  adminOverview,
  adminRestoreSpace,
  adminSpace,
  adminUserDetail,
  assertAdminDeletable,
  assertAdminRestorable,
  assertKeepsAnAdmin,
  assertNotSelf,
  changeUser,
  listAdminSpaces,
  listAdminUsers,
  requireAnySpace,
  resetLinkRefusal,
} from '../admin';
import type { DirectoryEnv } from '../app';
import type { DirectoryContext } from '../context';
import { createInvitation, findOpenInvitation, listInvitations, revokeInvitation } from '../invitations';
import { currentMeta, freshSession, requireInstanceAdmin, requireRecent } from '../middleware';
import { createResetLink } from '../recovery';
import { recordEvent } from '../security';
import { assertPolicyPossible, getInstanceSettings, setPasswordMinLength, setSignupPolicy } from '../settings';
import { purgeSpace, pushInvalidate } from '../spaces';
import { POLICIES } from '../throttle';
import { assertDeletable, deleteAccount, findUser } from '../users';
import { instanceInfo } from './auth';

export function adminRoutes(ctx: DirectoryContext) {
  const { db, deps, config } = ctx;
  const r = new Hono<DirectoryEnv>();

  /** A write's admin after its body: the session and account read again, and still an instance admin. */
  const actingAdmin = (c: Parameters<typeof freshSession>[0]) => {
    freshSession(c, ctx);
    return requireInstanceAdmin(c);
  };

  r.get('/overview', (c) => {
    requireInstanceAdmin(c);
    return c.json<AdminOverviewDTO>(adminOverview(ctx));
  });

  r.patch('/settings', async (c) => {
    requireInstanceAdmin(c);
    const input = await readJson(c, adminSettingsInput);
    const admin = actingAdmin(c);
    const before = getInstanceSettings(db, config);
    if (input.signupPolicy !== undefined && input.signupPolicy !== before.signupPolicy) assertPolicyPossible(input.signupPolicy, ctx.mailer.sendsTokens);
    requireRecent(c, ctx);
    const changed: Record<string, { from: unknown; to: unknown }> = {};
    db.tx(() => {
      if (input.signupPolicy !== undefined && input.signupPolicy !== before.signupPolicy) {
        setSignupPolicy(db, input.signupPolicy, ctx.mailer.sendsTokens);
        changed.signupPolicy = { from: before.signupPolicy, to: input.signupPolicy };
      }
      if (input.passwordMinLength !== undefined && input.passwordMinLength !== before.passwordMinLength) {
        setPasswordMinLength(db, input.passwordMinLength);
        changed.passwordMinLength = { from: before.passwordMinLength, to: input.passwordMinLength };
      }
      if (Object.keys(changed).length > 0) {
        recordEvent(db, { type: 'admin_settings_changed', userId: admin.id, actorId: admin.id, meta: currentMeta(c), data: changed, nowMs: ctx.now() });
      }
    });
    return c.json<InstanceInfoDTO>(instanceInfo(ctx));
  });

  // ---- Accounts ------------------------------------------------------------------------------------

  r.get('/users', (c) => {
    requireInstanceAdmin(c);
    const query = readQuery(c, adminUsersQuery);
    return c.json<Page<AdminUserDTO>>(listAdminUsers(ctx, { ...query, orphaned: query.orphaned === '1' }));
  });

  r.get('/users/:userId', (c) => {
    requireInstanceAdmin(c);
    return c.json<AdminUserDetailDTO>(adminUserDetail(ctx, readId(c, 'userId')));
  });

  r.patch('/users/:userId', async (c) => {
    requireInstanceAdmin(c);
    const input = await readJson(c, adminUserUpdateInput);
    const admin = actingAdmin(c);
    const targetId = readId(c, 'userId');
    assertNotSelf(admin, targetId, 'change');
    const target = findUser(db, targetId);
    if (!target) throw notFound('Account');
    assertKeepsAnAdmin(db, target, input);
    requireRecent(c, ctx);
    const { user, revoked, refreshed } = changeUser(ctx, { actor: admin, targetId, change: input, meta: currentMeta(c) });
    // A disabled account's sessions are gone: its spaces forget them before this answers (§5.8.18).
    await pushInvalidate(ctx, revoked, 'await');
    await pushInvalidate(ctx, refreshed, 'defer');
    return c.json<AdminUserDTO>(user);
  });

  r.delete('/users/:userId', async (c) => {
    requireInstanceAdmin(c);
    // No input, but the body is read before acting (Appendix D 21).
    await readBody(c);
    const admin = actingAdmin(c);
    const targetId = readId(c, 'userId');
    assertNotSelf(admin, targetId, 'delete');
    const target = findUser(db, targetId);
    if (!target) throw notFound('Account');
    // The rules that keep the instance usable come before the re-auth window (last_owner, last_admin).
    assertDeletable(db, target, { byAdmin: true });
    requireRecent(c, ctx);
    const { pushed, deleted } = deleteAccount(db, {
      userId: target.id,
      actorId: admin.id,
      byAdmin: true,
      graceDays: config.spaceDeleteGraceDays,
      meta: currentMeta(c),
      nowMs: ctx.now(),
    });
    await pushInvalidate(ctx, pushed, 'await');
    if (config.spaceDeleteGraceDays === 0) {
      for (const space of deleted) {
        await purgeSpace(ctx, space).catch((err) => console.error(`[lyren] Could not purge space ${space.public_id}:`, err));
      }
    }
    return c.json({ ok: true });
  });

  r.post('/users/:userId/reset-link', async (c) => {
    requireInstanceAdmin(c);
    await readBody(c);
    const admin = actingAdmin(c);
    const target = findUser(db, readId(c, 'userId'));
    if (!target) throw notFound('Account');
    // Permission before the re-auth window (Appendix D 11); the admin's own account is an admin's too.
    const refusal = resetLinkRefusal(db, target, ctx.now());
    if (refusal !== null) throw forbidden(refusal);
    requireRecent(c, ctx);
    const key = `ar:${admin.id}`;
    const state = ctx.throttle.check(key, POLICIES.ar);
    if (state.blocked) throw rateLimited('You have created as many reset links as you can today', state.retryAfterMs / 1000);
    ctx.throttle.hit(key, POLICIES.ar);
    return c.json<ResetLinkDTO>(createResetLink(ctx, { admin, target, meta: currentMeta(c) }));
  });

  // ---- Instance invitations (§5.8.8: an account, no space) -----------------------------------------

  r.get('/invitations', (c) => {
    requireInstanceAdmin(c);
    return c.json<InvitationDTO[]>(listInvitations(db, null, ctx.now()));
  });

  r.post('/invitations', async (c) => {
    requireInstanceAdmin(c);
    const input = await readJson(c, adminInvitationInput);
    const admin = actingAdmin(c);
    requireRecent(c, ctx);
    const meta = currentMeta(c);
    const created = await createInvitation(ctx, { inviter: admin, space: null, email: input.email, role: null, meta });
    const data = { invitationId: created.invitation.id, email: created.invitation.email };
    recordEvent(db, { type: 'admin_invitation_created', userId: admin.id, actorId: admin.id, meta, data, nowMs: ctx.now() });
    return c.json<InvitationCreatedDTO>(created, 201);
  });

  r.delete('/invitations/:invitationId', async (c) => {
    requireInstanceAdmin(c);
    await readBody(c);
    const admin = actingAdmin(c);
    const invitation = findOpenInvitation(db, null, readId(c, 'invitationId'));
    if (!invitation) throw notFound('Invitation');
    requireRecent(c, ctx);
    const nowMs = ctx.now();
    db.tx(() => {
      if (!revokeInvitation(db, { invitationId: invitation.id, byUserId: admin.id, nowMs })) throw notFound('Invitation');
      const data = { invitationId: invitation.id, email: invitation.email };
      recordEvent(db, { type: 'admin_invitation_revoked', userId: admin.id, actorId: admin.id, meta: currentMeta(c), data, nowMs });
    });
    return c.json({ ok: true });
  });

  // ---- Spaces (§13.11: no content, no membership) ---------------------------------------------------

  r.get('/spaces', (c) => {
    requireInstanceAdmin(c);
    const query = readQuery(c, adminSpacesQuery);
    return c.json<Page<AdminSpaceDTO>>(listAdminSpaces(ctx, query));
  });

  r.delete('/spaces/:spaceId', async (c) => {
    requireInstanceAdmin(c);
    await readBody(c);
    const admin = actingAdmin(c);
    const space = requireAnySpace(db, c.req.param('spaceId') ?? '');
    assertAdminDeletable(space);
    requireRecent(c, ctx);
    const meta = currentMeta(c);
    // A space created for an import that did not finish goes at once, as for its owner (§8.4).
    if (space.status === 'importing') {
      await purgeSpace(ctx, space).catch((err) => {
        console.error(`[lyren] Could not purge space ${space.public_id}:`, err);
        throw unavailable('The space could not be deleted. Try again later.');
      });
      const data = { space: space.public_id, name: space.name };
      recordEvent(db, { type: 'admin_space_deleted', userId: admin.id, actorId: admin.id, meta, data, nowMs: ctx.now() });
      return c.json({ ok: true, purgeAfter: new Date(ctx.now()).toISOString() });
    }
    const purgeAfter = adminDeleteSpace(ctx, { admin, space, meta });
    // Deleting ends everyone's access: the space forgets cached identities before this answers.
    await pushInvalidate(ctx, [space.public_id], 'await');
    if (config.spaceDeleteGraceDays === 0) {
      await purgeSpace(ctx, space).catch((err) => console.error(`[lyren] Could not purge space ${space.public_id}:`, err));
    }
    return c.json({ ok: true, purgeAfter });
  });

  r.post('/spaces/:spaceId/restore', async (c) => {
    requireInstanceAdmin(c);
    await readBody(c);
    const admin = actingAdmin(c);
    const space = requireAnySpace(db, c.req.param('spaceId') ?? '');
    assertAdminRestorable(db, space, ctx.now());
    requireRecent(c, ctx);
    adminRestoreSpace(ctx, { admin, space, meta: currentMeta(c) });
    await pushInvalidate(ctx, [space.public_id], 'defer');
    return c.json<AdminSpaceDTO>(adminSpace(ctx, space.id));
  });

  // ---- Backups and mail ----------------------------------------------------------------------------

  // app.get also answers HEAD (Hono drops the body).
  r.get('/backup', async (c) => {
    const backup = deps.runtime.capabilities.backupDownload ? deps.backup : undefined;
    if (!backup) throw new HttpError(404, 'not_found', 'Not found');
    const admin = requireInstanceAdmin(c);
    requireRecent(c, ctx);
    const day = new Date(ctx.now()).toISOString().slice(0, 10);
    c.header('Content-Type', 'application/x-tar');
    // Headers only: a set is written for a GET alone (a body-less response would never close its stream).
    if (c.req.method === 'HEAD') {
      return c.body(null, 200, { 'Content-Disposition': `attachment; filename="lyren-backup-${day}.tar"` });
    }
    const set = await backup.create();
    recordEvent(db, { type: 'admin_backup_downloaded', userId: admin.id, actorId: admin.id, meta: currentMeta(c), nowMs: ctx.now() });
    return c.body(set.body, 200, {
      'Content-Disposition': `attachment; filename="${set.filename}"`,
      'Content-Length': String(set.size),
    });
  });

  r.post('/mail/test', async (c) => {
    requireInstanceAdmin(c);
    // No input, but the body is read before acting (Appendix D 21; the web client sends {}).
    await c.req.arrayBuffer();
    const { user } = freshSession(c, ctx);
    requireInstanceAdmin(c);
    if (user.email === null) throw conflict('Your account has no email address to send the test message to. Add one first.');
    const result = await ctx.mailer.test({ user, meta: currentMeta(c) });
    if (!result.sent) throw new HttpError(502, 'unavailable', result.message);
    return c.json<MailTestDTO>(result.messageId === null ? { ok: true } : { ok: true, messageId: result.messageId });
  });

  return r;
}
