// Cookie sessions: random 256-bit token in an HttpOnly cookie, sha256(token) in the DB.

import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../db';

export interface SessionRow {
  id: number;
  token_hash: string;
  user_id: number;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  user_agent: string | null;
  ip: string | null;
}

export interface UserRow {
  id: number;
  username: string;
  display_name: string;
  password_hash: string;
  created_at: string;
  updated_at: string;
}

const TOUCH_INTERVAL_MS = 60 * 60 * 1000; // refresh last_seen/expiry at most hourly

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createSession(
  db: Db,
  userId: number,
  meta: { userAgent?: string | null; ip?: string | null },
  ttlDays: number,
): { token: string; session: SessionRow } {
  const token = randomBytes(32).toString('base64url');
  const now = new Date();
  const expires = new Date(now.getTime() + ttlDays * 86_400_000);
  const { lastInsertRowid } = db.run(
    `INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at, user_agent, ip)
     VALUES (:hash, :userId, :now, :now, :expires, :ua, :ip)`,
    {
      hash: hashToken(token),
      userId,
      now: now.toISOString(),
      expires: expires.toISOString(),
      ua: meta.userAgent?.slice(0, 300) ?? null,
      ip: meta.ip?.slice(0, 100) ?? null,
    },
  );
  const session = db.get<SessionRow>('SELECT * FROM sessions WHERE id = :id', { id: lastInsertRowid })!;
  return { token, session };
}

/** Resolve a session token to its (unexpired) session and user. */
export function findSession(db: Db, token: string): { session: SessionRow; user: UserRow } | null {
  if (!token || token.length > 200) return null;
  const session = db.get<SessionRow>('SELECT * FROM sessions WHERE token_hash = :hash', { hash: hashToken(token) });
  if (!session) return null;
  if (session.expires_at <= new Date().toISOString()) {
    db.run('DELETE FROM sessions WHERE id = :id', { id: session.id });
    return null;
  }
  const user = db.get<UserRow>('SELECT * FROM users WHERE id = :id', { id: session.user_id });
  if (!user) return null;
  return { session, user };
}

/** Sliding expiry: extend the session when it has not been touched for a while. */
export function touchSession(db: Db, session: SessionRow, ttlDays: number): boolean {
  const now = Date.now();
  if (now - Date.parse(session.last_seen_at) < TOUCH_INTERVAL_MS) return false;
  db.run('UPDATE sessions SET last_seen_at = :now, expires_at = :expires WHERE id = :id', {
    id: session.id,
    now: new Date(now).toISOString(),
    expires: new Date(now + ttlDays * 86_400_000).toISOString(),
  });
  return true;
}

export function deleteSessionByToken(db: Db, token: string): void {
  db.run('DELETE FROM sessions WHERE token_hash = :hash', { hash: hashToken(token) });
}

export function purgeExpiredSessions(db: Db): number {
  return db.run('DELETE FROM sessions WHERE expires_at <= :now', { now: new Date().toISOString() }).changes;
}
