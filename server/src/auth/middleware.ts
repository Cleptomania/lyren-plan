// Session resolution, auth guard and CSRF guard middleware.

import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { getConnInfo } from '@hono/node-server/conninfo';
import { CSRF_HEADER, SESSION_COOKIE } from '@shared/constants';
import type { Config } from '../config';
import type { AppEnv, Deps } from '../env';
import { forbidden, unauthorized } from '../http/errors';
import { findSession, touchSession } from './sessions';

/** Attach `user`/`session` to the context when a valid session cookie is present. */
export function sessionMiddleware({ db, config }: Deps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    c.set('user', null);
    c.set('session', null);
    const token = getCookie(c, SESSION_COOKIE);
    if (token) {
      const found = findSession(db, token);
      if (found) {
        // Sliding expiry: when the DB expiry is extended, re-issue the cookie too. Set before
        // next() so a later deleteCookie (logout/revoke) still wins.
        if (touchSession(db, found.session, config.sessionTtlDays)) setSessionCookie(c, token, config);
        c.set('user', found.user);
        c.set('session', found.session);
      }
    }
    await next();
  };
}

/** Reject unauthenticated requests with 401. */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.get('user')) throw unauthorized();
  await next();
};

/**
 * CSRF defence: every state-changing /api request must carry `X-Lyren-Request: 1`.
 * Browsers cannot attach custom headers to cross-site requests without a CORS
 * preflight, which this server never approves. Session cookies are also SameSite=Lax.
 */
export const requireCsrfHeader: MiddlewareHandler<AppEnv> = async (c, next) => {
  const method = c.req.method;
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    if (c.req.header(CSRF_HEADER) !== '1') throw forbidden(`Missing ${CSRF_HEADER} header`);
  }
  await next();
};

/**
 * Client address. With TRUST_PROXY the RIGHTMOST X-Forwarded-For entry is used: it is the
 * one appended by the (trusted) reverse proxy, while entries to its left are client-controlled.
 */
export function clientIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = c.req.header('x-forwarded-for');
    const last = xff
      ?.split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .at(-1);
    if (last) return last;
    const real = c.req.header('x-real-ip');
    if (real) return real.trim();
  }
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export function isSecureRequest(c: Context, cookieSecure: 'auto' | boolean, trustProxy: boolean): boolean {
  if (cookieSecure !== 'auto') return cookieSecure;
  if (trustProxy) {
    const proto = c.req.header('x-forwarded-proto');
    if (proto) return proto.split(',')[0]!.trim().toLowerCase() === 'https';
  }
  return new URL(c.req.url).protocol === 'https:';
}

export function sessionCookieOptions(c: Context, config: Config) {
  return {
    httpOnly: true,
    sameSite: 'Lax' as const,
    secure: isSecureRequest(c, config.cookieSecure, config.trustProxy),
    path: '/',
    maxAge: config.sessionTtlDays * 86_400,
  };
}

export function setSessionCookie(c: Context, token: string, config: Config): void {
  setCookie(c, SESSION_COOKIE, token, sessionCookieOptions(c, config));
}
