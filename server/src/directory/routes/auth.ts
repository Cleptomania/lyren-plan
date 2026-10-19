// /api/auth: status, first-run setup, password login and logout (design §5.8.1, §5.8.2, §5.8.15), and the
// helpers the other public flows share (client keys, limits, link tokens, signing in). Public: these work
// without a session, and each checks what it needs itself. Sign-up is routes/signup.ts, the password reset
// and recovery routes/reset.ts, the email confirmation routes/email.ts.

import { Hono, type Context } from 'hono';
import { loginInput, setupInput } from '@shared/schemas';
import type { AuthStatusDTO, InstanceInfoDTO, UserDTO } from '@shared/types';
import { expiredSessionCookies } from '../../core/cookies';
import { safeEqual } from '../../core/crypto';
import { limiterKey, netKey } from '../../core/net';
import { APP_VERSION } from '../../core/version';
import { accountDisabled, badRequest, conflict, forbidden, HttpError, invalidToken, rateLimited, unauthorized } from '../../http/errors';
import { readJson } from '../../http/validate';
import type { DirectoryEnv } from '../app';
import type { DirectoryContext } from '../context';
import { deviceCookie, findDevice, issueDevice, readDeviceToken } from '../devices';
import { sendVerification } from '../emailTokens';
import { appendCookies, currentMeta, setSessionCookie } from '../middleware';
import { listNotices, recordEvent, recordLoginFailure } from '../security';
import { createSession, deleteSession, reauthUntil, type SessionRow } from '../sessions';
import { getInstanceSettings, getLegacySpaceId } from '../settings';
import { listSpaces } from '../spaces';
import { POLICIES, type ThrottlePolicy } from '../throttle';
import { createAccount, findUser, readPreferences, resolveIdentifier, toUserDTO, userCount } from '../users';

type C = Context<DirectoryEnv>;

/** 0 = no limit → null (InstanceInfoDTO.limits). */
const orNull = (n: number) => (n > 0 ? n : null);

/** InstanceInfoDTO: public facts about the instance (AuthStatusDTO.instance). */
export function instanceInfo(ctx: DirectoryContext): InstanceInfoDTO {
  const { config, deps } = ctx;
  const settings = getInstanceSettings(ctx.db, config);
  return {
    name: config.instanceName,
    runtime: deps.runtime.kind,
    signupPolicy: settings.signupPolicy,
    mail: deps.mail.deliversMail,
    mailLinks: ctx.mailer.sendsTokens,
    passkeys: { enabled: config.passkeys.enabled, origin: config.passkeys.origin, rpId: config.passkeys.rpId },
    passwordMinLength: settings.passwordMinLength,
    features: {
      backupDownload: deps.runtime.capabilities.backupDownload && deps.backup !== undefined,
      recovery: config.recoveryToken !== null,
    },
    shareOrigins: deps.shareOrigins(),
    limits: {
      importMaxBytes: config.quotas.importMaxBytes,
      importMaxRowWrites: orNull(config.quotas.importMaxRowWrites),
      importDailyRowWrites: orNull(config.quotas.importDailyRowWrites),
      maxSpacesPerUser: orNull(config.quotas.maxSpacesPerUser),
      maxMembersPerSpace: orNull(config.quotas.maxMembersPerSpace),
    },
  };
}

/** 400 validation_error unless `password` is at least the instance's minimum length (§5.5). */
export function checkPasswordLength(ctx: DirectoryContext, password: string, path: string): void {
  const min = getInstanceSettings(ctx.db, ctx.config).passwordMinLength;
  if (password.length < min) throw badRequest(`${path}: At least ${min} characters`, [{ path, message: `At least ${min} characters` }]);
}

/** The ip and coarse network keys of the request (§5.9); an unknown address is '-'. */
export function clientKeys(c: C): { ip: string; net: string } {
  const ip = currentMeta(c).clientIp || '-';
  return { ip: limiterKey(ip), net: netKey(ip) };
}

/** 429 when any of the keys is blocked (the longest Retry-After of them). */
export function assertNotThrottled(ctx: DirectoryContext, checks: ReadonlyArray<[string, ThrottlePolicy]>): void {
  let retryAfterMs = 0;
  for (const [key, policy] of checks) {
    const state = ctx.throttle.check(key, policy);
    if (state.blocked) retryAfterMs = Math.max(retryAfterMs, state.retryAfterMs);
  }
  if (retryAfterMs > 0) throw rateLimited(undefined, retryAfterMs / 1000);
}

/** 429 while the client is over tk:<ip> (invalid link tokens, §5.7); every endpoint that takes a token asks first. */
export function assertLinkAttempts(ctx: DirectoryContext, c: C): void {
  assertNotThrottled(ctx, [[`tk:${clientKeys(c).ip}`, POLICIES.tk]]);
}

/** The one answer for an unknown, used, expired or stale link token (400 invalid_token), counted on tk:<ip>. */
export function invalidLink(ctx: DirectoryContext, c: C): HttpError {
  ctx.throttle.hit(`tk:${clientKeys(c).ip}`, POLICIES.tk);
  return invalidToken();
}

/**
 * The limits of a request that mails a link to an address (§5.9): mh and md on its email_key and, for the
 * anonymous ones (sign-up, forgot password), mi:<ip>. Checked, then counted, the same whether or not the
 * address has an account.
 */
export function spendMailRequest(ctx: DirectoryContext, c: C, emailKey: string, o: { anonymous: boolean }): void {
  const keys: Array<[string, ThrottlePolicy]> = [
    [`mh:${emailKey}`, POLICIES.mh],
    [`md:${emailKey}`, POLICIES.md],
  ];
  if (o.anonymous) keys.push([`mi:${clientKeys(c).ip}`, POLICIES.mi]);
  assertNotThrottled(ctx, keys);
  for (const [key, policy] of keys) ctx.throttle.hit(key, policy);
}

/**
 * Give the request's browser its new session: the request's previous session (if any) is deleted, and
 * the session cookie and a new device cookie are set.
 */
export function signIn(c: C, ctx: DirectoryContext, token: string, session: SessionRow, device: string | null) {
  const previous = c.get('session');
  if (previous) deleteSession(ctx.db, previous.id);
  setSessionCookie(c, ctx, token, session);
  if (device !== null) appendCookies(c, [deviceCookie(device, currentMeta(c).secure)]);
}

export function authRoutes(ctx: DirectoryContext) {
  const { db, config, deps, throttle, passwords } = ctx;
  const r = new Hono<DirectoryEnv>();

  r.get('/status', (c) => {
    const user = c.get('user');
    const session = c.get('session');
    const setupRequired = userCount(db) === 0;
    // "No code yet" is not "no code required": while setup is required a code always exists (§5.8.1).
    if (setupRequired && !config.setupCodeDisabled) ctx.setupCode.ensureAnnounced();
    const legacySpaceId = getLegacySpaceId(db);
    const spaces = user ? listSpaces(db, user.id) : [];
    const body: AuthStatusDTO = {
      setupRequired,
      setupCodeRequired: !config.setupCodeDisabled,
      user: user ? toUserDTO(db, user) : null,
      version: APP_VERSION,
      instance: instanceInfo(ctx),
      spaces,
      preferences: user ? readPreferences(user) : null,
      reauthUntil: session ? reauthUntil(session, config, ctx.now()) : null,
      notices: user ? listNotices(db, user.id, user.notices_seen_at) : [],
      legacySpaceId: legacySpaceId !== null && spaces.some((s) => s.id === legacySpaceId) ? legacySpaceId : null,
      // Only the desktop app adds these; the Node build's and Docker's answer has neither key.
      ...(deps.desktop ? { desktop: deps.desktop.app } : {}),
      ...(deps.desktop && user?.is_instance_admin === 1 ? { desktopData: deps.desktop.data() } : {}),
    };
    return c.json(body);
  });

  r.post('/setup', async (c) => {
    const input = await readJson(c, setupInput);
    const meta = currentMeta(c);
    // Cheapest checks first: no hashing for requests that cannot succeed.
    if (userCount(db) > 0) throw conflict('Setup has already been completed');
    const { ip, net } = clientKeys(c);
    assertNotThrottled(ctx, [
      [`li:${ip}`, POLICIES.li],
      [`ln:${net}`, POLICIES.ln],
    ]);
    if (!config.setupCodeDisabled) {
      const code = ctx.setupCode.ensureAnnounced();
      if (!safeEqual(input.setupCode?.trim() ?? '', code)) {
        throttle.hit(`li:${ip}`, POLICIES.li);
        throttle.hit(`ln:${net}`, POLICIES.ln);
        ctx.setupCode.afterFailure();
        throw forbidden('Invalid setup code');
      }
    }
    checkPasswordLength(ctx, input.password, 'password');
    const passwordHash = await passwords.hash(input.password);
    const created = await createAccount(ctx, {
      email: input.email,
      emailVerified: false,
      displayName: input.displayName,
      passwordHash,
      isInstanceAdmin: true,
      authMethod: 'setup',
      firstAccount: true,
      sampleData: input.createSampleData ? (input.today ? { today: input.today } : {}) : null,
      meta,
      deviceToken: readDeviceToken(c.req.header('cookie'), meta.secure),
    });
    // A link to verify the address follows by mail (§5.8.1 step 5).
    if (ctx.mailer.sendsTokens) sendVerification(ctx, created.user, meta);
    signIn(c, ctx, created.session.token, created.session.row, created.deviceToken);
    return c.json<{ user: UserDTO }>({ user: toUserDTO(db, created.user) }, 201);
  });

  r.post('/login', async (c) => {
    const input = await readJson(c, loginInput);
    const meta = currentMeta(c);
    const nowMs = ctx.now();
    const { user: account, key: accountKey } = resolveIdentifier(db, input.identifier);
    const presented = readDeviceToken(c.req.header('cookie'), meta.secure);
    const trusted = account !== null && findDevice(db, account.id, presented, nowMs) !== null;
    const { ip, net } = clientKeys(c);
    // Keys in the order of §5.8.2; a browser with the account's device token skips lg, lid and lda.
    const keys: Array<[string, ThrottlePolicy]> = [];
    if (!trusted) keys.push(['lg', POLICIES.lg]);
    keys.push([`li:${ip}`, POLICIES.li], [`ln:${net}`, POLICIES.ln]);
    if (!trusted) keys.push([`lid:${accountKey}`, POLICIES.lid]);
    if (!trusted && account !== null) keys.push([`lda:${account.id}`, POLICIES.lda]);
    assertNotThrottled(ctx, keys);
    // A full hash queue refuses before anything is counted: a sign-in it turns away is no failure.
    passwords.assertCapacity();
    // Count the failure before the slow check, so parallel requests cannot slip past the limits.
    const counts = new Map(keys.map(([key, policy]) => [policy.name, throttle.hit(key, policy).count]));
    const startedAt = ctx.now();
    const checked = account?.password_hash ?? null;
    const { ok, rehash } = await passwords.verify(input.password, checked, db);
    // Re-read: other requests may have run during the hash (the account deleted or disabled meanwhile). A
    // credential change meanwhile bumps auth_epoch and fails this check like a wrong password, so no session
    // outlives a password change that signed the other browsers out; another sign-in's rehash keeps the epoch.
    const user = account && findUser(db, account.id);
    const current = user !== null && user.auth_epoch === account?.auth_epoch;
    if (!ok || !current) {
      if (user) {
        const failures = counts.get(POLICIES.lid.name);
        recordLoginFailure(db, user.id, meta, failures === undefined ? {} : { failures }, ctx.now());
        // This failure started the account's lda block (once in its 24 h window): a deferred notice (§5.8.2 step 5).
        if (counts.get(POLICIES.lda.name) === POLICIES.lda.limit) ctx.mailer.loginAttempts({ user, meta });
      }
      await passwords.padFailure(db, startedAt);
      throw unauthorized('Incorrect email or password');
    }
    // Only ever after a correct password.
    if (user.status === 'disabled') throw accountDisabled();
    for (const [key, policy] of keys) {
      if (policy === POLICIES.lid) throttle.clear(key);
      else throttle.forgive(key, policy);
    }
    const done = ctx.now();
    const { token, session, device } = db.tx(() => {
      // Only the hash that was checked is replaced (another sign-in's rehash meanwhile wins).
      if (rehash !== null) {
        db.run('UPDATE users SET password_hash = :hash WHERE id = :id AND password_hash = :old', {
          id: user.id,
          hash: rehash,
          old: checked,
        });
      }
      db.run('UPDATE users SET last_login_at = :now WHERE id = :id', { id: user.id, now: new Date(done).toISOString() });
      const created = createSession(db, { userId: user.id, authMethod: 'password', meta, config, nowMs: done });
      const device = issueDevice(db, user.id, presented, done);
      recordEvent(db, { type: 'login', userId: user.id, meta, data: { method: 'password' }, nowMs: done });
      return { ...created, device };
    });
    signIn(c, ctx, token, session, device);
    return c.json<{ user: UserDTO }>({ user: toUserDTO(db, findUser(db, user.id) ?? user) });
  });

  r.post('/logout', async (c) => {
    // The body (unused, the web client sends {}) is read before the answer: on Cloudflare an object that
    // answers first leaves the Worker's forwarding of it failing ("Can't read from request stream").
    await c.req.text().catch(() => '');
    const session = c.get('session');
    if (session) deleteSession(db, session.id);
    // The device cookie stays: it is not a session (§5.8.15).
    appendCookies(c, expiredSessionCookies(currentMeta(c).secure));
    return c.json({ ok: true });
  });

  return r;
}
