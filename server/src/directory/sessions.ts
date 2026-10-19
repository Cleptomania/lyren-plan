// Sessions (design §5.4): a random 256-bit token in an HttpOnly cookie (core/cookies.ts), only its
// sha256 in the directory. expires_at slides by SESSION_TTL_DAYS, touched at most hourly (by the
// directory's session middleware and by authorizeSpace), and never past absolute_expires_at
// (SESSION_MAX_DAYS, when > 0). reauth_at is the last credential proof: the re-auth window of
// REAUTH_MINUTES (§5.4.4) is measured from it.

import type { AuthMethod } from '@shared/constants';
import type { SessionDTO } from '@shared/types';
import type { DirectoryConfig } from '../core/config';
import { randomToken, sha256Hex } from '../core/crypto';
import type { Db } from '../core/db';
import type { TrustedMeta } from '../core/ports';
import type { UserRow } from './users';

export interface SessionRow {
  id: number;
  token_hash: string;
  user_id: number;
  auth_method: AuthMethod;
  reauth_at: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  absolute_expires_at: string | null;
  user_agent: string | null;
  ip: string | null;
}

const DAY_MS = 86_400_000;
/** last_seen_at and the sliding expiry are written at most this often. */
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

type SessionConfig = Pick<DirectoryConfig, 'sessionTtlDays' | 'sessionMaxDays' | 'reauthMinutes'>;

const iso = (ms: number) => new Date(ms).toISOString();

/** The sliding expiry from `nowMs`, capped by the absolute one. */
function slidingExpiry(nowMs: number, ttlDays: number, absoluteExpiresAt: string | null): string {
  const sliding = nowMs + ttlDays * DAY_MS;
  return iso(absoluteExpiresAt === null ? sliding : Math.min(sliding, Date.parse(absoluteExpiresAt)));
}

/** A new session for `userId`; the raw token exists only in the returned value (for the cookie). */
export function createSession(
  db: Db,
  o: { userId: number; authMethod: Exclude<AuthMethod, 'legacy'>; meta: TrustedMeta; config: SessionConfig; nowMs: number },
): { token: string; session: SessionRow } {
  const token = randomToken();
  const now = iso(o.nowMs);
  const absolute = o.config.sessionMaxDays > 0 ? iso(o.nowMs + o.config.sessionMaxDays * DAY_MS) : null;
  const session = db.get<SessionRow>(
    `INSERT INTO sessions (token_hash, user_id, auth_method, reauth_at, created_at, last_seen_at, expires_at,
       absolute_expires_at, user_agent, ip)
     VALUES (:hash, :userId, :method, :now, :now, :now, :expires, :absolute, :ua, :ip)
     RETURNING *`,
    {
      hash: sha256Hex(token),
      userId: o.userId,
      method: o.authMethod,
      now,
      expires: slidingExpiry(o.nowMs, o.config.sessionTtlDays, absolute),
      absolute,
      ua: o.meta.userAgent?.slice(0, 300) ?? null,
      ip: o.meta.clientIp ? o.meta.clientIp.slice(0, 100) : null,
    },
  )!;
  return { token, session };
}

const isExpired = (session: SessionRow, nowIso: string) =>
  session.expires_at <= nowIso || (session.absolute_expires_at !== null && session.absolute_expires_at <= nowIso);

/**
 * The unexpired session with this token hash and its active user, or null. An expired session is
 * deleted on the way; a disabled account has no session (its sessions are deleted when it is disabled).
 */
export function findSession(db: Db, tokenHash: string, nowMs: number): { session: SessionRow; user: UserRow } | null {
  if (!/^[0-9a-f]{64}$/.test(tokenHash)) return null;
  const session = db.get<SessionRow>('SELECT * FROM sessions WHERE token_hash = :hash', { hash: tokenHash });
  if (!session) return null;
  if (isExpired(session, iso(nowMs))) {
    db.run('DELETE FROM sessions WHERE id = :id', { id: session.id });
    return null;
  }
  const user = db.get<UserRow>("SELECT * FROM users WHERE id = :id AND status = 'active'", { id: session.user_id });
  return user ? { session, user } : null;
}

/** Sliding expiry: when the session was not touched for an hour, extend it. Returns whether it did. */
export function touchSession(db: Db, session: SessionRow, config: SessionConfig, nowMs: number): boolean {
  if (nowMs - Date.parse(session.last_seen_at) < TOUCH_INTERVAL_MS) return false;
  const expires = slidingExpiry(nowMs, config.sessionTtlDays, session.absolute_expires_at);
  db.run('UPDATE sessions SET last_seen_at = :now, expires_at = :expires WHERE id = :id', {
    id: session.id,
    now: iso(nowMs),
    expires,
  });
  session.last_seen_at = iso(nowMs);
  session.expires_at = expires;
  return true;
}

/** ms epoch at which the session ends (the earlier of its sliding and absolute expiry). */
export function sessionEnd(session: SessionRow): number {
  const sliding = Date.parse(session.expires_at);
  return session.absolute_expires_at === null ? sliding : Math.min(sliding, Date.parse(session.absolute_expires_at));
}

/** The end of the session's re-auth window (ms epoch); in the past when it is closed. */
export function reauthEnd(session: SessionRow, config: SessionConfig): number {
  return Date.parse(session.reauth_at) + config.reauthMinutes * 60_000;
}

/** A credential was proven in the session within REAUTH_MINUTES (§5.4.4). */
export function isRecent(session: SessionRow, config: SessionConfig, nowMs: number): boolean {
  return reauthEnd(session, config) > nowMs;
}

/** AuthStatusDTO.reauthUntil: the window's end, or null when it is closed. */
export function reauthUntil(session: SessionRow, config: SessionConfig, nowMs: number): string | null {
  const end = reauthEnd(session, config);
  return end > nowMs ? iso(end) : null;
}

/** Open the re-auth window now (a password or passkey was just proven). */
export function markReauthenticated(db: Db, session: SessionRow, nowMs: number): void {
  session.reauth_at = iso(nowMs);
  db.run('UPDATE sessions SET reauth_at = :now WHERE id = :id', { id: session.id, now: session.reauth_at });
}

export function deleteSession(db: Db, sessionId: number): void {
  db.run('DELETE FROM sessions WHERE id = :id', { id: sessionId });
}

/** Delete the user's session `sessionId`; false when there is no such session of theirs. */
export function revokeSession(db: Db, userId: number, sessionId: number): boolean {
  return db.run('DELETE FROM sessions WHERE id = :id AND user_id = :userId', { id: sessionId, userId }).changes > 0;
}

/** Delete every session of the user but `keepSessionId`; returns how many. */
export function revokeOtherSessions(db: Db, userId: number, keepSessionId: number): number {
  return db.run('DELETE FROM sessions WHERE user_id = :userId AND id <> :keep', { userId, keep: keepSessionId }).changes;
}

/** GET /api/account/sessions: the user's unexpired sessions, most recently used first. */
export function listSessions(db: Db, userId: number, currentId: number, nowMs: number): SessionDTO[] {
  const now = iso(nowMs);
  const rows = db.all<SessionRow>(
    `SELECT * FROM sessions WHERE user_id = :userId AND expires_at > :now
       AND (absolute_expires_at IS NULL OR absolute_expires_at > :now)
     ORDER BY last_seen_at DESC, id DESC`,
    { userId, now },
  );
  return rows.map((s) => ({
    id: s.id,
    createdAt: s.created_at,
    lastSeenAt: s.last_seen_at,
    expiresAt: s.expires_at,
    userAgent: s.user_agent,
    ip: s.ip,
    current: s.id === currentId,
    authMethod: s.auth_method,
  }));
}

/** Maintenance: delete expired sessions; returns how many. */
export function purgeExpiredSessions(db: Db, nowMs: number): number {
  const now = iso(nowMs);
  return db.run(
    'DELETE FROM sessions WHERE expires_at <= :now OR (absolute_expires_at IS NOT NULL AND absolute_expires_at <= :now)',
    { now },
  ).changes;
}
