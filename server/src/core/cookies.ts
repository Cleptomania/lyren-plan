// The session cookie (design §5.4.1): its name, attributes, and which value a request carries.
// On HTTPS it is __Host-lyren_session (Secure, Path=/, no Domain), so a sibling subdomain cannot plant
// or shadow it (session fixation). Over plain HTTP (the desktop app on 127.0.0.1, LAN installs,
// Docker without TLS, wrangler dev) it is lyren_session, and no __Host- cookie is ever emitted, not
// even an expired one: Hono's setCookie/deleteCookie throw "__Host- Cookie must have Secure
// attributes" without Secure. Attributes: HttpOnly; SameSite=Lax; Path=/; Secure when secure.

import { parse, serialize } from 'hono/utils/cookie';
import { SESSION_COOKIE, SESSION_COOKIE_SECURE } from '@shared/constants';
import type { RuntimeInfo } from './runtime';

/** Longer values are ignored (a session token is 43 characters). */
const MAX_TOKEN_LENGTH = 200;

export function sessionCookieName(secure: boolean): string {
  return secure ? SESSION_COOKIE_SECURE : SESSION_COOKIE;
}

/** Max-Age in seconds: the sliding lifetime, capped by the time left until absolute_expires_at. */
export function sessionMaxAge(ttlDays: number, nowMs: number, absoluteExpiresAt: string | null): number {
  const sliding = ttlDays * 86_400;
  if (absoluteExpiresAt === null) return sliding;
  return Math.max(0, Math.min(sliding, Math.floor((Date.parse(absoluteExpiresAt) - nowMs) / 1000)));
}

/** One Set-Cookie value with the session cookie's attributes (Max-Age=0 expires it). */
function setCookieValue(name: string, value: string, secure: boolean, maxAge: number): string {
  return serialize(name, value, { httpOnly: true, sameSite: 'Lax', secure, path: '/', maxAge });
}

/**
 * Set-Cookie values that set the session cookie. A secure request gets __Host-lyren_session and
 * expires lyren_session (an upgraded install's old cookie); an insecure one only lyren_session.
 */
export function sessionCookies(token: string, o: { secure: boolean; maxAge: number }): string[] {
  const cookie = setCookieValue(sessionCookieName(o.secure), token, o.secure, o.maxAge);
  return o.secure ? [cookie, setCookieValue(SESSION_COOKIE, '', true, 0)] : [cookie];
}

/** Set-Cookie values for logout: lyren_session always, __Host-lyren_session only on secure requests. */
export function expiredSessionCookies(secure: boolean): string[] {
  const plain = setCookieValue(SESSION_COOKIE, '', secure, 0);
  return secure ? [plain, setCookieValue(SESSION_COOKIE_SECURE, '', true, 0)] : [plain];
}

/**
 * The session token a request carries, and which cookie name carried it:
 *  - insecure request: lyren_session only;
 *  - secure request on Cloudflare: __Host-lyren_session only (no session there was ever issued under
 *    the other name);
 *  - secure request on Node: __Host-lyren_session, else lyren_session with source 'plain'. The caller
 *    accepts a 'plain' token on a secure request only for a session created before the upgrade
 *    (auth_method 'legacy'), and re-issues it under the __Host- name, so a cookie planted under the
 *    unprefixed name cannot sign a browser into someone else's session.
 * Empty values and values over 200 characters count as absent. Parsing is Hono's getCookie's (the
 * first value of a name wins).
 */
export function readSessionToken(
  cookieHeader: string | null | undefined,
  secure: boolean,
  runtime: RuntimeInfo['kind'] = 'node',
): { token: string; source: 'host' | 'plain' } | null {
  if (!cookieHeader) return null;
  const cookies = parse(cookieHeader);
  const usable = (value: string | undefined) =>
    value !== undefined && value !== '' && value.length <= MAX_TOKEN_LENGTH ? value : null;
  if (secure) {
    const host = usable(cookies[SESSION_COOKIE_SECURE]);
    if (host) return { token: host, source: 'host' };
    if (runtime === 'cloudflare') return null;
  }
  const plain = usable(cookies[SESSION_COOKIE]);
  return plain ? { token: plain, source: 'plain' } : null;
}
