// The DirectoryService (design §2.3): what space hosts ask the directory (authorizeSpace, spaceSync, the
// import calls) and the directory's own upkeep (maintenance, the setup code). On Node the clients call
// it in-process; on Cloudflare DirectoryDO exposes these methods over RPC, so arguments and results
// stay plain JSON-safe data. The HTTP half of DirectoryClient (serve) is the directory app.

import type { DirectoryClient, SpaceAuthResult, SpaceIdentity, SpaceSyncPayload } from '../core/ports';
import { orphanedPasskeysWarning } from './admin';
import type { DirectoryContext } from './context';
import { purgeExpiredDevices } from './devices';
import { importCandidates, importCommitted, refundImport, reserveImport } from './imports';
import { purgeOldEvents } from './security';
import { findSession, purgeExpiredSessions, sessionEnd, touchSession } from './sessions';
import { findSpace, purgeDueSpaces } from './spaces';

export interface MaintenanceResult {
  sessions: number;
  deviceTokens: number;
  challenges: number;
  emailTokens: number;
  throttleRows: number;
  securityEvents: number;
  invitations: number;
  spacesPurged: number;
}

export interface DirectoryService extends Omit<DirectoryClient, 'serve'> {
  /**
   * The hourly upkeep (§9.8): expired sessions, device tokens, challenges and email tokens, buffered
   * throttle counts written and old rows purged, security events older than 90 days, invitations
   * closed more than 30 days ago, the purge of deleted and stale spaces (§5.8.16), and the password
   * parameter sets in use (§5.5). Each task runs in its own try/catch, so one failure stops neither the
   * others nor the schedule.
   */
  maintenance(): Promise<MaintenanceResult>;
  /**
   * While no account exists: the setup code, generated now when none is set (Node: in memory;
   * `generated` says so, and the caller prints it). null once an account exists. Requests that
   * generate a code announce it themselves (DirectoryDeps.onSetupCode).
   */
  ensureSetupCode(): { code: string; generated: boolean } | null;
  /**
   * Warnings for the startup log: the configuration's, the SIGNUP_POLICY one only when it was seeded now, and on
   * Node §5.6's domain-move warning.
   */
  readonly startupWarnings: readonly string[];
  /**
   * §5.6's domain-move warning (admin.ts orphanedPasskeysWarning), counted now, or null: Cloudflare's hourly
   * alarm logs it (it reads every passkey, too much for each start of the directory object).
   */
  passkeyWarning(): string | null;
  /** Write buffered throttle counts (before the process exits). */
  flush(): void;
}

const DAY_MS = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

export function createDirectoryService(ctx: DirectoryContext, startupWarnings: readonly string[]): DirectoryService {
  const { db } = ctx;

  async function authorizeSpace(input: { tokenHash: string; spaceId: string; cookie: 'host' | 'plain'; secure: boolean }): Promise<SpaceAuthResult> {
    const nowMs = ctx.now();
    const found = findSession(db, input.tokenHash, nowMs);
    if (!found) return { ok: false, reason: 'unauthenticated' };
    const { session, user } = found;
    // The unprefixed cookie name on HTTPS counts only for a session from before the upgrade (§5.4.1).
    if (input.secure && input.cookie === 'plain' && session.auth_method !== 'legacy') return { ok: false, reason: 'unauthenticated' };
    touchSession(db, session, ctx.config, nowMs);
    const space = db.get<{ public_id: string; name: string; status: 'importing' | 'active'; sync_version: number; role: SpaceIdentity['role'] }>(
      `SELECT s.public_id, s.name, s.status, s.sync_version, m.role
       FROM spaces s JOIN memberships m ON m.space_id = s.id AND m.user_id = :userId
       WHERE s.public_id = :spaceId AND s.deleted_at IS NULL AND s.status <> 'provisioning'`,
      { spaceId: input.spaceId, userId: user.id },
    );
    if (!space) return { ok: false, reason: 'not_found' };
    return {
      ok: true,
      identity: {
        userId: user.id,
        displayName: user.display_name,
        email: user.email,
        role: space.role,
        instanceAdmin: user.is_instance_admin === 1,
        sessionId: session.id,
        reauthAt: session.reauth_at,
        space: { id: space.public_id, name: space.name, status: space.status, syncVersion: space.sync_version },
      },
      cacheUntil: sessionEnd(session),
    };
  }

  async function spaceSync(input: { spaceId: string; mirrorUserIds: number[] }): Promise<SpaceSyncPayload | null> {
    const space = findSpace(db, input.spaceId);
    if (!space || space.deleted_at !== null || space.status === 'provisioning') return null;
    const members = db.all<{ id: number; display_name: string; email: string | null }>(
      `SELECT u.id, u.display_name, u.email FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.space_id = :spaceId ORDER BY u.id`,
      { spaceId: space.id },
    );
    const memberIds = new Set(members.map((m) => m.id));
    const asked = [...new Set(input.mirrorUserIds)].filter((id) => Number.isSafeInteger(id) && id > 0 && !memberIds.has(id));
    const known = new Map(
      db
        .all<{ id: number; display_name: string }>(
          'SELECT id, display_name FROM users WHERE id IN (SELECT value FROM json_each(:ids))',
          { ids: JSON.stringify(asked) },
        )
        .map((u) => [u.id, u.display_name]),
    );
    return {
      name: space.name,
      status: space.status,
      syncVersion: space.sync_version,
      members: members.map((m) => ({ userId: m.id, displayName: m.display_name, email: m.email })),
      others: asked.map((userId) => {
        const displayName = known.get(userId);
        return displayName === undefined ? { userId, deleted: true as const } : { userId, displayName };
      }),
    };
  }

  async function maintenance(): Promise<MaintenanceResult> {
    const nowMs = ctx.now();
    const now = iso(nowMs);
    const result: MaintenanceResult = {
      sessions: 0,
      deviceTokens: 0,
      challenges: 0,
      emailTokens: 0,
      throttleRows: 0,
      securityEvents: 0,
      invitations: 0,
      spacesPurged: 0,
    };
    const task = async (name: string, fn: () => number | Promise<number>, into: keyof MaintenanceResult | null) => {
      try {
        const n = await fn();
        if (into) result[into] = n;
      } catch (err) {
        console.error(`[lyren] Maintenance task "${name}" failed:`, err);
      }
    };
    await task('sessions', () => purgeExpiredSessions(db, nowMs), 'sessions');
    await task('device tokens', () => purgeExpiredDevices(db, nowMs), 'deviceTokens');
    await task('challenges', () => db.run('DELETE FROM webauthn_challenges WHERE expires_at <= :now', { now }).changes, 'challenges');
    await task(
      'email tokens',
      () => db.run('DELETE FROM email_tokens WHERE expires_at <= :cutoff', { cutoff: iso(nowMs - DAY_MS) }).changes,
      'emailTokens',
    );
    await task('throttle', () => (ctx.throttle.flush(), ctx.throttle.purge(nowMs)), 'throttleRows');
    await task('security events', () => purgeOldEvents(db, nowMs), 'securityEvents');
    await task(
      'invitations',
      () =>
        db.run(
          `DELETE FROM invitations WHERE (accepted_at IS NOT NULL AND accepted_at <= :cutoff)
             OR (revoked_at IS NOT NULL AND revoked_at <= :cutoff) OR (expires_at <= :cutoff)`,
          { cutoff: iso(nowMs - 30 * DAY_MS) },
        ).changes,
      'invitations',
    );
    await task('space purge', () => purgeDueSpaces(ctx, nowMs), 'spacesPurged');
    await task('password parameters', async () => (await ctx.passwords.refresh(db), 0), null);
    return result;
  }

  return {
    authorizeSpace,
    spaceSync,
    importCandidates: async (input) => importCandidates(ctx, input),
    reserveImport: async (input) => reserveImport(ctx, input),
    refundImport: async (input) => refundImport(ctx, input),
    importCommitted: async (input) => importCommitted(ctx, input),
    maintenance,
    ensureSetupCode: () => (db.get('SELECT 1 AS present FROM users LIMIT 1') ? null : ctx.setupCode.ensure()),
    startupWarnings,
    passkeyWarning: () => orphanedPasskeysWarning(ctx),
    flush: () => {
      ctx.throttle.flush();
    },
  };
}
