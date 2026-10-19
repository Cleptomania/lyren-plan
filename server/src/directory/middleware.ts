// The directory app's middleware (design §2.2, §5.4): the request's TrustedMeta (from the caller, never
// from a header), the session cookie, the auth gate and the body limits. The gateway in front has
// already checked the path, the CSRF header and Content-Length.
//
// Session cookie (§5.4.1, core/cookies.ts): an insecure request carries lyren_session; a secure one
// __Host-lyren_session, and on Node also lyren_session for a session from before the multi-user
// upgrade (auth_method 'legacy'), which is re-issued at once under the __Host- name. A touched session
// (at most hourly) gets its cookie again with the new Max-Age.

import type { Context, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { AUTH_BODY_LIMIT, isPublicDirectoryPath } from '../core/config';
import { readSessionToken, sessionCookies, sessionMaxAge } from '../core/cookies';
import { sha256Hex } from '../core/crypto';
import type { TrustedMeta } from '../core/ports';
import { forbidden, reauthRequired, unauthorized } from '../http/errors';
import type { DirectoryEnv } from './app';
import type { DirectoryContext } from './context';
import { findSession, isRecent, touchSession, type SessionRow } from './sessions';
import type { UserRow } from './users';

type C = Context<DirectoryEnv>;

/** The facts the gateway established about this request. */
export function currentMeta(c: C): TrustedMeta {
  const meta = c.env?.meta;
  if (!meta) throw new Error('The directory app needs the TrustedMeta: app.fetch(request, { meta })');
  return meta;
}

/** The signed-in user (behind requireAuth). */
export function currentUser(c: C): UserRow {
  const user = c.get('user');
  if (!user) throw unauthorized();
  return user;
}

export function currentSession(c: C): SessionRow {
  const session = c.get('session');
  if (!session) throw unauthorized();
  return session;
}

/**
 * The request's session and user read again, for a handler that is about to act (§5): other requests
 * run while a body arrives or a hash is computed, and one of them may have revoked the session or
 * disabled the account. A handler calls it after its last await and before what it checks and writes,
 * with no await in between. 401 once the session is gone; c.var.user and c.var.session are updated.
 */
export function freshSession(c: C, ctx: DirectoryContext): { user: UserRow; session: SessionRow } {
  const found = findSession(ctx.db, currentSession(c).token_hash, ctx.now());
  c.set('user', found?.user ?? null);
  c.set('session', found?.session ?? null);
  if (!found) throw unauthorized();
  return found;
}

/** Add Set-Cookie headers (several cookies, so never one header replacing another). */
export function appendCookies(c: Context, cookies: readonly string[]): void {
  for (const cookie of cookies) c.header('Set-Cookie', cookie, { append: true });
}

/** Set the session cookie for `session` under the request's naming rule. */
export function setSessionCookie(c: C, ctx: DirectoryContext, token: string, session: SessionRow): void {
  const maxAge = sessionMaxAge(ctx.config.sessionTtlDays, ctx.now(), session.absolute_expires_at);
  appendCookies(c, sessionCookies(token, { secure: currentMeta(c).secure, maxAge }));
}

/** Attach the user and session of the request's session cookie, when it has a valid one. */
export function sessionMiddleware(ctx: DirectoryContext): MiddlewareHandler<DirectoryEnv> {
  return async (c, next) => {
    c.set('user', null);
    c.set('session', null);
    const meta = currentMeta(c);
    const cookie = readSessionToken(c.req.header('cookie'), meta.secure, ctx.deps.runtime.kind);
    if (cookie) {
      const nowMs = ctx.now();
      const found = findSession(ctx.db, sha256Hex(cookie.token), nowMs);
      // On HTTPS the unprefixed name only counts for a session from before the upgrade, so a cookie
      // planted under it cannot sign this browser into someone else's session.
      const legacyName = meta.secure && cookie.source === 'plain';
      if (found && (!legacyName || found.session.auth_method === 'legacy')) {
        // Set before next(), so a later expiry (logout, revocation) comes after it and wins.
        if (touchSession(ctx.db, found.session, ctx.config, nowMs) || legacyName) {
          setSessionCookie(c, ctx, cookie.token, found.session);
        }
        c.set('user', found.user);
        c.set('session', found.session);
      }
    }
    await next();
  };
}

/** Refuse requests without a session (401). */
export const requireAuth: MiddlewareHandler<DirectoryEnv> = async (c, next) => {
  if (!c.get('user')) throw unauthorized();
  await next();
};

/** Paths that need no session: the sign-in endpoints and the invitation page's (each route checks what it needs). */
export function isPublicPath(path: string): boolean {
  return isPublicDirectoryPath(path);
}

/** The auth gate: every path but the public ones needs a session. */
export const authGate: MiddlewareHandler<DirectoryEnv> = (c, next) =>
  isPublicPath(c.req.path) ? next() : requireAuth(c, next);

/**
 * Body limits (§7.1): the public endpoints take a few short strings and are reachable by anyone, so
 * 64 KiB; everything else BODY_LIMIT. The gateway refuses a larger Content-Length first.
 */
export function bodyLimits(ctx: DirectoryContext): MiddlewareHandler<DirectoryEnv> {
  const publicLimit = bodyLimit({ maxSize: Math.min(ctx.config.bodyLimit, AUTH_BODY_LIMIT) });
  const defaultLimit = bodyLimit({ maxSize: ctx.config.bodyLimit });
  return (c, next) => (isPublicPath(c.req.path) ? publicLimit(c, next) : defaultLimit(c, next));
}

/** The re-auth window (§5.4.4) is open, else 403 reauth_required. */
export function requireRecent(c: C, ctx: DirectoryContext): void {
  if (!isRecent(currentSession(c), ctx.config, ctx.now())) throw reauthRequired();
}

export function requireInstanceAdmin(c: C): UserRow {
  const user = currentUser(c);
  if (user.is_instance_admin !== 1) throw forbidden('Only an administrator of this instance can do this');
  return user;
}
