// /api/account: the signed-in user's own account (design §7.2): name and preferences, the password (set,
// change, remove), the re-auth window, sessions, the security log, and deleting the account (§5.8.12,
// §5.8.14, §5.8.15, §5.8.17). The passkeys and re-authentication with one are routes/passkeys.ts'. Every
// path here needs a session (the auth gate). Each write reads the session and the account after its body
// and after every hash (freshSession, §5), so a session revoked meanwhile changes nothing.

import { Hono, type Context } from 'hono';
import { z } from 'zod';
import {
  accountDeleteInput,
  changePasswordInput,
  idParamSchema,
  preferencesUpdateInput,
  reauthPasswordInput,
  updateAccountInput,
  type UserPreferences,
} from '@shared/schemas';
import type { SecurityEventDTO, SessionDTO, UserDTO } from '@shared/types';
import { expiredSessionCookies } from '../../core/cookies';
import { badRequest, conflict, lastCredential, notFound } from '../../http/errors';
import { readBody, readId, readJson, readQuery } from '../../http/validate';
import type { DirectoryEnv } from '../app';
import type { DirectoryContext } from '../context';
import { expiredDeviceCookies, findDevice, readDeviceToken, revokeDevices } from '../devices';
import { appendCookies, currentMeta, currentSession, currentUser, freshSession, requireRecent } from '../middleware';
import { NO_PASSWORD, passwordRemovalRefusal } from '../passkeys';
import { listEvents, recordEvent } from '../security';
import { listSessions, markReauthenticated, reauthUntil, revokeOtherSessions, revokeSession } from '../sessions';
import { memberSpaceIds, pushInvalidate, purgeSpace } from '../spaces';
import { POLICIES, type ThrottlePolicy } from '../throttle';
import {
  assertDeletable,
  confirmationName,
  confirmsAccount,
  deleteAccount,
  findUser,
  readPreferences,
  renameUser,
  toUserDTO,
  writePreferences,
  type UserRow,
} from '../users';
import { assertNotThrottled, checkPasswordLength, clientKeys } from './auth';

const securityEventsQuery = z.object({ before: idParamSchema.optional() });

export function accountRoutes(ctx: DirectoryContext) {
  const { db, config, throttle, passwords } = ctx;
  const r = new Hono<DirectoryEnv>();

  const fresh = (user: UserRow) => findUser(db, user.id) ?? user;

  /**
   * Check the account's password for a re-auth or a password change: limits li, ln and lid, on which a
   * failure counts (before the check, as for login); a success opens the re-auth window, and rehashes
   * when the stored parameters differ from the target. Wrong → 400 with `path`.
   */
  async function provePassword(c: Context<DirectoryEnv>, password: string, path: string): Promise<void> {
    const user = currentUser(c);
    const { ip, net } = clientKeys(c);
    const keys: Array<[string, ThrottlePolicy]> = [
      [`li:${ip}`, POLICIES.li],
      [`ln:${net}`, POLICIES.ln],
      [`lid:a:${user.id}`, POLICIES.lid],
    ];
    assertNotThrottled(ctx, keys);
    // A full hash queue refuses before anything is counted (a refused check is no failed password).
    passwords.assertCapacity();
    for (const [key, policy] of keys) throttle.hit(key, policy);
    const { ok, rehash } = await passwords.verify(password, user.password_hash);
    if (!ok) throw badRequest('Incorrect password', [{ path, message: 'Incorrect password' }]);
    for (const [key, policy] of keys) {
      if (policy === POLICIES.lid) throttle.clear(key);
      else throttle.forgive(key, policy);
    }
    const { session } = freshSession(c, ctx);
    db.tx(() => {
      if (rehash !== null) {
        db.run('UPDATE users SET password_hash = :hash WHERE id = :id AND password_hash = :old', {
          id: user.id,
          hash: rehash,
          old: user.password_hash,
        });
      }
      markReauthenticated(db, session, ctx.now());
    });
  }

  r.get('/', (c) => c.json<UserDTO>(toUserDTO(db, currentUser(c))));

  r.patch('/', async (c) => {
    const input = await readJson(c, updateAccountInput);
    const { user } = freshSession(c, ctx);
    if (input.displayName !== user.display_name) {
      const spaces = renameUser(db, user.id, input.displayName, ctx.now());
      await pushInvalidate(ctx, spaces, 'defer');
    }
    return c.json<UserDTO>(toUserDTO(db, fresh(user)));
  });

  r.patch('/preferences', async (c) => {
    const input = await readJson(c, preferencesUpdateInput);
    const { user } = freshSession(c, ctx);
    const preferences: UserPreferences = { ...readPreferences(user), ...input };
    writePreferences(db, user.id, preferences, ctx.now());
    return c.json<UserPreferences>(preferences);
  });

  r.post('/password', async (c) => {
    const meta = currentMeta(c);
    const input = await readJson(c, changePasswordInput);
    const { user } = freshSession(c, ctx);
    if (user.password_hash !== null) {
      if (input.currentPassword === undefined) {
        throw badRequest('Enter your current password', [{ path: 'currentPassword', message: 'Required' }]);
      }
      await provePassword(c, input.currentPassword, 'currentPassword');
    } else {
      // Setting a first password (a passkey-only account) needs the re-auth window instead.
      requireRecent(c, ctx);
    }
    checkPasswordLength(ctx, input.newPassword, 'newPassword');
    const hash = await passwords.hash(input.newPassword);
    const { session } = freshSession(c, ctx);
    const nowMs = ctx.now();
    const now = new Date(nowMs).toISOString();
    const keepDevice = findDevice(db, user.id, readDeviceToken(c.req.header('cookie'), meta.secure), nowMs);
    const spaces = db.tx(() => {
      db.run(
        `UPDATE users SET password_hash = :hash, password_changed_at = :now, updated_at = :now, auth_epoch = auth_epoch + 1
         WHERE id = :id`,
        { id: user.id, hash, now },
      );
      // Sign out every other device; only this browser keeps its device token (a stolen laptop loses it).
      revokeOtherSessions(db, user.id, session.id);
      revokeDevices(db, user.id, keepDevice);
      recordEvent(db, { type: 'password_changed', userId: user.id, meta, nowMs });
      return memberSpaceIds(db, user.id);
    });
    ctx.mailer.passwordChanged({ user, via: 'change', meta });
    await pushInvalidate(ctx, spaces, 'await');
    return c.json({ ok: true });
  });

  r.delete('/password', async (c) => {
    await readBody(c);
    const meta = currentMeta(c);
    const { user } = freshSession(c, ctx);
    if (user.password_hash === null) throw conflict(NO_PASSWORD);
    // A usable passkey and a way back in (§5.8.12), before the re-auth window.
    const refusal = passwordRemovalRefusal(ctx, user);
    if (refusal !== null) throw lastCredential(refusal);
    requireRecent(c, ctx);
    const nowMs = ctx.now();
    const now = new Date(nowMs).toISOString();
    db.tx(() => {
      // auth_epoch + 1: the account's outstanding links die, and a sign-in checked against the old password fails.
      db.run(
        `UPDATE users SET password_hash = NULL, password_changed_at = NULL, updated_at = :now, auth_epoch = auth_epoch + 1
         WHERE id = :id`,
        { id: user.id, now },
      );
      recordEvent(db, { type: 'password_removed', userId: user.id, meta, nowMs });
    });
    return c.json({ ok: true });
  });

  r.post('/reauth/password', async (c) => {
    const input = await readJson(c, reauthPasswordInput);
    const { user } = freshSession(c, ctx);
    if (user.password_hash === null) {
      throw badRequest('This account has no password', [{ path: 'password', message: 'This account has no password' }]);
    }
    await provePassword(c, input.password, 'password');
    return c.json({ ok: true, reauthUntil: reauthUntil(currentSession(c), config, ctx.now()) });
  });

  r.get('/sessions', (c) => {
    const body: SessionDTO[] = listSessions(db, currentUser(c).id, currentSession(c).id, ctx.now());
    return c.json(body);
  });

  r.delete('/sessions/:sessionId', (c) => {
    const { user, session } = freshSession(c, ctx);
    const id = readId(c, 'sessionId');
    if (!revokeSession(db, user.id, id)) throw notFound('Session');
    if (id === session.id) appendCookies(c, expiredSessionCookies(currentMeta(c).secure));
    return c.json({ ok: true });
  });

  r.post('/sessions/revoke-others', async (c) => {
    // No input, but the body is read before acting (Appendix D 21).
    await readBody(c);
    const { user, session } = freshSession(c, ctx);
    const meta = currentMeta(c);
    const { revoked, spaces } = db.tx(() => {
      const revoked = revokeOtherSessions(db, user.id, session.id);
      recordEvent(db, { type: 'sessions_revoked', userId: user.id, meta, data: { revoked }, nowMs: ctx.now() });
      return { revoked, spaces: memberSpaceIds(db, user.id) };
    });
    await pushInvalidate(ctx, spaces, 'await');
    return c.json({ ok: true, revoked });
  });

  r.get('/security-events', (c) => {
    const { before } = readQuery(c, securityEventsQuery);
    const body: SecurityEventDTO[] = listEvents(db, currentUser(c).id, before ?? null, 'own');
    return c.json(body);
  });

  r.post('/notices/seen', async (c) => {
    await readBody(c);
    db.run('UPDATE users SET notices_seen_at = :now WHERE id = :id', {
      id: freshSession(c, ctx).user.id,
      now: new Date(ctx.now()).toISOString(),
    });
    return c.json({ ok: true });
  });

  r.delete('/', async (c) => {
    const meta = currentMeta(c);
    const input = await readJson(c, accountDeleteInput);
    const { user } = freshSession(c, ctx);
    requireRecent(c, ctx);
    // The rules that keep the instance usable come first, so the confirmation is not asked in vain.
    assertDeletable(db, user);
    if (!confirmsAccount(user, input.confirm)) {
      const name = confirmationName(user);
      throw badRequest(`Type ${name} to confirm`, [{ path: 'confirm', message: `Type ${name} to confirm` }]);
    }
    const { pushed, deleted } = deleteAccount(db, {
      userId: user.id,
      actorId: null,
      graceDays: config.spaceDeleteGraceDays,
      meta,
      nowMs: ctx.now(),
    });
    await pushInvalidate(ctx, pushed, 'await');
    if (config.spaceDeleteGraceDays === 0) {
      for (const space of deleted) {
        await purgeSpace(ctx, space).catch((err) => console.error(`[lyren] Could not purge space ${space.public_id}:`, err));
      }
    }
    appendCookies(c, [...expiredSessionCookies(meta.secure), ...expiredDeviceCookies(meta.secure)]);
    return c.json({ ok: true });
  });

  return r;
}
