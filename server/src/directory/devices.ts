// Device cookies (design §5.8.2; OWASP "device cookies" against targeted lock-out). After a successful
// sign-in the response sets __Host-lyren_device (secure requests) or lyren_device (insecure ones, where
// no __Host- cookie is ever emitted, as for the session cookie, core/cookies.ts) with a random token,
// stored as sha256 in device_tokens: at most 10 per account, the least recently used one replaced, each
// valid for 365 days. A valid device token of the account exempts its browser from the per-account
// login limits (lid, lda) and the instance-wide ceiling (lg). It is not a session and grants nothing
// else: a password is still required.

import { parse, serialize } from 'hono/utils/cookie';
import { randomToken, sha256Hex } from '../core/crypto';
import type { Db } from '../core/db';

export const DEVICE_COOKIE = 'lyren_device';
export const DEVICE_COOKIE_SECURE = '__Host-lyren_device';

const DEVICE_DAYS = 365;
const MAX_DEVICES_PER_USER = 10;
const MAX_TOKEN_LENGTH = 200;

const iso = (ms: number) => new Date(ms).toISOString();

const cookieValue = (name: string, value: string, secure: boolean, maxAge: number) =>
  serialize(name, value, { httpOnly: true, sameSite: 'Lax', secure, path: '/', maxAge });

/** Set-Cookie value for a device token. */
export function deviceCookie(token: string, secure: boolean): string {
  return cookieValue(secure ? DEVICE_COOKIE_SECURE : DEVICE_COOKIE, token, secure, DEVICE_DAYS * 86_400);
}

/** Set-Cookie values that expire the device cookie: lyren_device always, the __Host- one on secure requests. */
export function expiredDeviceCookies(secure: boolean): string[] {
  const plain = cookieValue(DEVICE_COOKIE, '', secure, 0);
  return secure ? [plain, cookieValue(DEVICE_COOKIE_SECURE, '', true, 0)] : [plain];
}

/** The device token a request carries (by the session cookie's naming rule), or null. */
export function readDeviceToken(cookieHeader: string | null | undefined, secure: boolean): string | null {
  if (!cookieHeader) return null;
  const value = parse(cookieHeader)[secure ? DEVICE_COOKIE_SECURE : DEVICE_COOKIE];
  return value && value.length <= MAX_TOKEN_LENGTH ? value : null;
}

/** The id of `userId`'s unexpired device token `token`, or null. */
export function findDevice(db: Db, userId: number, token: string | null, nowMs: number): number | null {
  if (token === null) return null;
  const row = db.get<{ id: number }>(
    'SELECT id FROM device_tokens WHERE token_hash = :hash AND user_id = :userId AND expires_at > :now',
    { hash: sha256Hex(token), userId, now: iso(nowMs) },
  );
  return row?.id ?? null;
}

/**
 * After a successful sign-in: refresh the browser's device token when it already has a valid one of
 * this account, else issue one (replacing the account's least recently used beyond 10). Returns the
 * token to set as a cookie, or null when the browser keeps its own.
 */
export function issueDevice(db: Db, userId: number, presented: string | null, nowMs: number): string | null {
  const now = iso(nowMs);
  const existing = findDevice(db, userId, presented, nowMs);
  if (existing !== null) {
    db.run('UPDATE device_tokens SET last_used_at = :now WHERE id = :id', { id: existing, now });
    return null;
  }
  const token = randomToken();
  db.tx(() => {
    db.run(
      `INSERT INTO device_tokens (user_id, token_hash, created_at, last_used_at, expires_at)
       VALUES (:userId, :hash, :now, :now, :expires)`,
      { userId, hash: sha256Hex(token), now, expires: iso(nowMs + DEVICE_DAYS * 86_400_000) },
    );
    db.run(
      `DELETE FROM device_tokens WHERE user_id = :userId AND id NOT IN (
         SELECT id FROM device_tokens WHERE user_id = :userId ORDER BY last_used_at DESC, id DESC LIMIT ${MAX_DEVICES_PER_USER})`,
      { userId },
    );
  });
  return token;
}

/** Delete the account's device tokens, except `keepId` (the current browser's, after a password change). */
export function revokeDevices(db: Db, userId: number, keepId: number | null = null): number {
  return db.run('DELETE FROM device_tokens WHERE user_id = :userId AND id IS NOT :keep', { userId, keep: keepId }).changes;
}

/** Maintenance: delete expired device tokens. */
export function purgeExpiredDevices(db: Db, nowMs: number): number {
  return db.run('DELETE FROM device_tokens WHERE expires_at <= :now', { now: iso(nowMs) }).changes;
}
