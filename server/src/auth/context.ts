// Helpers for reading the authenticated user inside route handlers.

import type { Context } from 'hono';
import type { AppEnv } from '../env';
import { unauthorized } from '../http/errors';
import type { SessionRow, UserRow } from './sessions';

/** The signed-in user. Every /api route except auth/health is behind requireAuth, so this never throws there. */
export function currentUser(c: Context<AppEnv>): UserRow {
  const user = c.get('user');
  if (!user) throw unauthorized();
  return user;
}

export function currentSession(c: Context<AppEnv>): SessionRow {
  const session = c.get('session');
  if (!session) throw unauthorized();
  return session;
}
