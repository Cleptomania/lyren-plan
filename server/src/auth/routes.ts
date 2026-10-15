// /api/auth — first-run setup, login/logout, account and session management.

import { Hono, type Context } from 'hono';
import { createHash, timingSafeEqual } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { deleteCookie, getCookie } from 'hono/cookie';
import { SESSION_COOKIE } from '@shared/constants';
import { changePasswordInput, loginInput, setupInput, updateMeInput } from '@shared/schemas';
import type { AuthStatusDTO, SessionDTO, UserDTO } from '@shared/types';
import { APP_VERSION } from '../config';
import { createSampleData, ensureDefaults } from '../db/seed';
import type { AppEnv, Deps } from '../env';
import { badRequest, conflict, forbidden, notFound, rateLimited, unauthorized } from '../http/errors';
import { readId, readJson } from '../http/validate';
import { desktopApp } from '../routes/desktop';
import { currentSession, currentUser } from './context';
import { clientIp, requireAuth, setSessionCookie } from './middleware';
import { getDummyHash, hashPassword, verifyPassword } from './passwords';
import { FailureLimiter, GuessThrottle, limiterKey } from './rateLimit';
import { createSession, deleteSessionByToken, type SessionRow, type UserRow } from './sessions';
import { toUserDTO } from './users';

export function authRoutes(deps: Deps) {
  const { db, config } = deps;
  const r = new Hono<AppEnv>();
  // Per client network (limiterKey: IPv6 grouped by /64): 10 failures per 15 minutes, then 429.
  const limiter = new FailureLimiter(10, 15 * 60 * 1000);
  // Account-wide: past 20 failures per 15 minutes, sign-in attempts are spaced out progressively
  // whatever address they come from (see GuessThrottle).
  const throttle = new GuessThrottle();
  const limitKey = (c: Context<AppEnv>) => limiterKey(clientIp(c, config.trustProxy));

  const userCount = () => Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')!.n);

  function startSession(c: Context<AppEnv>, user: UserRow) {
    const { token } = createSession(
      db,
      user.id,
      { userAgent: c.req.header('user-agent') ?? null, ip: clientIp(c, config.trustProxy) },
      config.sessionTtlDays,
    );
    setSessionCookie(c, token, config);
  }

  function setupCodeMatches(given: string | undefined): boolean {
    if (config.setupToken === null) return true;
    const a = createHash('sha256').update(given?.trim() ?? '').digest();
    const b = createHash('sha256').update(config.setupToken).digest();
    return timingSafeEqual(a, b);
  }

  r.get('/status', (c) => {
    const user = c.get('user');
    const setupRequired = userCount() === 0;
    const body: AuthStatusDTO = {
      setupRequired,
      setupCodeRequired: setupRequired && config.setupToken !== null,
      user: user ? toUserDTO(user) : null,
      version: APP_VERSION,
      // Only the desktop app adds this; the Node build's and Docker's answer stays as it was.
      ...(deps.desktop ? { desktop: desktopApp(deps.desktop) } : {}),
    };
    return c.json(body);
  });

  r.post('/setup', async (c) => {
    const input = await readJson(c, setupInput);
    // Cheap checks first: no scrypt work for requests that cannot succeed.
    if (userCount() > 0) throw conflict('Setup has already been completed');
    const key = limitKey(c);
    if (limiter.isBlocked(key)) throw rateLimited();
    if (!setupCodeMatches(input.setupCode)) {
      limiter.recordFailure(key);
      throw forbidden('Invalid setup code');
    }
    const passwordHash = await hashPassword(input.password);
    const user = db.tx(() => {
      if (userCount() > 0) throw conflict('Setup has already been completed');
      const now = new Date().toISOString();
      const { lastInsertRowid } = db.run(
        `INSERT INTO users (username, display_name, password_hash, created_at, updated_at)
         VALUES (:username, :displayName, :hash, :now, :now)`,
        { username: input.username, displayName: input.displayName, hash: passwordHash, now },
      );
      ensureDefaults(db);
      return db.get<UserRow>('SELECT * FROM users WHERE id = :id', { id: lastInsertRowid })!;
    });
    if (input.createSampleData) {
      try {
        db.tx(() => createSampleData(db, user.id, input.today));
      } catch (err) {
        console.error('[lyren] Failed to create sample data:', err);
      }
    }
    startSession(c, user);
    return c.json<{ user: UserDTO }>({ user: toUserDTO(user) }, 201);
  });

  r.post('/login', async (c) => {
    const input = await readJson(c, loginInput);
    const key = limitKey(c);
    if (limiter.isBlocked(key)) throw rateLimited();
    const wait = throttle.reserve();
    if (wait === null) throw rateLimited();
    // Count the attempt before any await so parallel requests can't exceed the limits.
    limiter.recordFailure(key);
    throttle.recordFailure();
    if (wait > 0) await sleep(wait);
    const user = db.get<UserRow>('SELECT * FROM users WHERE username = :username', { username: input.username });
    // Always run one scrypt verification so response timing does not reveal valid usernames.
    const ok = await verifyPassword(input.password, user?.password_hash ?? (await getDummyHash()));
    if (!user || !ok) throw unauthorized('Incorrect username or password');
    limiter.reset(key);
    throttle.forgive();
    startSession(c, user);
    return c.json<{ user: UserDTO }>({ user: toUserDTO(user) });
  });

  r.post('/logout', (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) deleteSessionByToken(db, token);
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  r.get('/me', requireAuth, (c) => c.json<UserDTO>(toUserDTO(currentUser(c))));

  r.patch('/me', requireAuth, async (c) => {
    const user = currentUser(c);
    const input = await readJson(c, updateMeInput);
    db.run('UPDATE users SET display_name = :displayName, updated_at = :now WHERE id = :id', {
      id: user.id,
      displayName: input.displayName,
      now: new Date().toISOString(),
    });
    const row = db.get<UserRow>('SELECT * FROM users WHERE id = :id', { id: user.id })!;
    return c.json<UserDTO>(toUserDTO(row));
  });

  r.post('/password', requireAuth, async (c) => {
    const user = currentUser(c);
    const session = currentSession(c);
    const input = await readJson(c, changePasswordInput);
    const key = limitKey(c);
    if (limiter.isBlocked(key)) throw rateLimited();
    limiter.recordFailure(key);
    if (!(await verifyPassword(input.currentPassword, user.password_hash))) {
      throw badRequest('Current password is incorrect', [{ path: 'currentPassword', message: 'Incorrect password' }]);
    }
    limiter.reset(key);
    const hash = await hashPassword(input.newPassword);
    db.tx(() => {
      db.run('UPDATE users SET password_hash = :hash, updated_at = :now WHERE id = :id', {
        id: user.id,
        hash,
        now: new Date().toISOString(),
      });
      // Sign out every other device.
      db.run('DELETE FROM sessions WHERE user_id = :userId AND id <> :sessionId', { userId: user.id, sessionId: session.id });
    });
    return c.json({ ok: true });
  });

  r.get('/sessions', requireAuth, (c) => {
    const user = currentUser(c);
    const current = currentSession(c);
    const rows = db.all<SessionRow>(
      'SELECT * FROM sessions WHERE user_id = :userId AND expires_at > :now ORDER BY last_seen_at DESC',
      { userId: user.id, now: new Date().toISOString() },
    );
    const body: SessionDTO[] = rows.map((s) => ({
      id: s.id,
      createdAt: s.created_at,
      lastSeenAt: s.last_seen_at,
      expiresAt: s.expires_at,
      userAgent: s.user_agent,
      ip: s.ip,
      current: s.id === current.id,
    }));
    return c.json(body);
  });

  r.delete('/sessions/:id', requireAuth, (c) => {
    const user = currentUser(c);
    const id = readId(c);
    const { changes } = db.run('DELETE FROM sessions WHERE id = :id AND user_id = :userId', { id, userId: user.id });
    if (changes === 0) throw notFound('Session');
    if (id === currentSession(c).id) deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  r.post('/sessions/revoke-others', requireAuth, (c) => {
    const user = currentUser(c);
    const session = currentSession(c);
    const { changes } = db.run('DELETE FROM sessions WHERE user_id = :userId AND id <> :id', {
      userId: user.id,
      id: session.id,
    });
    return c.json({ ok: true, revoked: changes });
  });

  return r;
}
