// Security events (design §5.11): the account's security log (GET /api/account/security-events), the
// notices it is shown once (AuthStatusDTO.notices, §5.8.11) and the admins' audit trail (ADMIN_EVENT_TYPES,
// Administration → Overview, directory/admin.ts). Each records the client's address and user agent from
// TrustedMeta. Kept 90 days (maintenance).

import type { NoticeDTO, SecurityEventDTO } from '@shared/types';
import type { Db } from '../core/db';
import type { TrustedMeta } from '../core/ports';

/** The event types of §5.11 (the admin_invitation_* ones are Appendix D 54's). */
export type SecurityEventType =
  | 'account_created'
  | 'login'
  | 'login_failed'
  | 'passkey_login'
  | 'password_changed'
  | 'password_reset'
  | 'password_removed'
  | 'passkey_added'
  | 'passkey_removed'
  | 'passkey_counter_regression'
  | 'email_change_requested'
  | 'email_changed'
  | 'email_verified'
  | 'sessions_revoked'
  | 'account_deleted'
  | 'invitation_accepted'
  | 'member_added'
  | 'member_role_changed'
  | 'recovery_used'
  | 'mail_failed'
  | 'admin_user_disabled'
  | 'admin_user_enabled'
  | 'admin_granted'
  | 'admin_revoked'
  | 'admin_reset_link'
  | 'admin_user_deleted'
  | 'admin_space_deleted'
  | 'admin_space_restored'
  | 'admin_settings_changed'
  | 'admin_backup_downloaded'
  | 'admin_invitation_created'
  | 'admin_invitation_revoked';

/**
 * The administrative actions every admin sees (§5.8.18): the admin API's (with actor_id), the command
 * line's `promote-admin` and `policy` (no actor; data.via 'cli') and the recovery token's.
 */
export const ADMIN_EVENT_TYPES: ReadonlyArray<SecurityEventType> = [
  'admin_user_disabled',
  'admin_user_enabled',
  'admin_granted',
  'admin_revoked',
  'admin_reset_link',
  'admin_user_deleted',
  'admin_space_deleted',
  'admin_space_restored',
  'admin_settings_changed',
  'admin_backup_downloaded',
  'admin_invitation_created',
  'admin_invitation_revoked',
  'recovery_used',
];

const NOTICE_TYPES: ReadonlyArray<NoticeDTO['type']> = ['admin_reset_link', 'recovery_used'];
export const SECURITY_EVENTS_PAGE = 50;
const KEEP_DAYS = 90;
const LOGIN_FAILED_EVERY_MS = 60 * 60 * 1000;

export interface EventRow {
  id: number;
  type: string;
  ip: string | null;
  user_agent: string | null;
  data: string;
  created_at: string;
}

const iso = (ms: number) => new Date(ms).toISOString();

export function recordEvent(
  db: Db,
  e: {
    type: SecurityEventType;
    userId: number | null;
    actorId?: number | null;
    meta: TrustedMeta | null;
    data?: Record<string, unknown>;
    nowMs: number;
  },
): void {
  db.run(
    `INSERT INTO security_events (user_id, actor_id, type, ip, user_agent, data, created_at)
     VALUES (:userId, :actorId, :type, :ip, :ua, :data, :now)`,
    {
      userId: e.userId,
      actorId: e.actorId ?? null,
      type: e.type,
      ip: e.meta?.clientIp ? e.meta.clientIp.slice(0, 100) : null,
      ua: e.meta?.userAgent ?? null,
      data: JSON.stringify(e.data ?? {}),
      now: iso(e.nowMs),
    },
  );
}

/**
 * login_failed, at most once per account per hour, so a password flood writes few rows. `data` holds
 * the account's count of failed sign-ins in the current window (`failures`) when it is known.
 */
export function recordLoginFailure(db: Db, userId: number, meta: TrustedMeta, data: { failures?: number }, nowMs: number): void {
  const last = db.get<{ created_at: string }>(
    "SELECT created_at FROM security_events WHERE user_id = :userId AND type = 'login_failed' ORDER BY id DESC LIMIT 1",
    { userId },
  );
  if (last && Date.parse(last.created_at) > nowMs - LOGIN_FAILED_EVERY_MS) return;
  recordEvent(db, { type: 'login_failed', userId, meta, data, nowMs });
}

export function toEventDTO(row: EventRow): SecurityEventDTO {
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.data);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
  } catch {
    // a damaged row shows no data
  }
  return { id: row.id, type: row.type, ip: row.ip, userAgent: row.user_agent, createdAt: row.created_at, data };
}

/** Events about an account that someone else's request wrote with no actor: the recovery token's operator. */
const OPERATOR_EVENTS: ReadonlySet<string> = new Set(['recovery_used']);

/**
 * The user's events, newest first, 50 at a time; `before` is the last id of the previous page. In the
 * account's own log (`view: 'own'`) the events another account acted in (an admin's, with actor_id) and
 * the operator's show no address or user agent: those are the admin's, whose views keep them.
 */
export function listEvents(db: Db, userId: number, before: number | null, view: 'own' | 'admin'): SecurityEventDTO[] {
  const rows = db.all<EventRow & { actor_id: number | null }>(
    `SELECT id, type, ip, user_agent, data, created_at, actor_id FROM security_events
     WHERE user_id = :userId AND (:before IS NULL OR id < :before)
     ORDER BY id DESC LIMIT ${SECURITY_EVENTS_PAGE}`,
    { userId, before },
  );
  return rows.map((row) => {
    const event = toEventDTO(row);
    const others = (row.actor_id !== null && row.actor_id !== userId) || OPERATOR_EVENTS.has(row.type);
    return view === 'own' && others ? { ...event, ip: null, userAgent: null } : event;
  });
}

/** AuthStatusDTO.notices: the account's notice events newer than users.notices_seen_at. */
export function listNotices(db: Db, userId: number, seenAt: string | null): NoticeDTO[] {
  const rows = db.all<{ id: number; type: NoticeDTO['type']; actor_name: string | null; created_at: string }>(
    `SELECT e.id, e.type, a.display_name AS actor_name, e.created_at
     FROM security_events e LEFT JOIN users a ON a.id = e.actor_id
     WHERE e.user_id = :userId AND e.type IN (SELECT value FROM json_each(:types))
       AND (:seenAt IS NULL OR e.created_at > :seenAt)
     ORDER BY e.id`,
    { userId, types: JSON.stringify(NOTICE_TYPES), seenAt },
  );
  return rows.map((r) => ({ id: r.id, type: r.type, actorName: r.actor_name, createdAt: r.created_at }));
}

/** Maintenance: delete events older than 90 days. */
export function purgeOldEvents(db: Db, nowMs: number): number {
  return db.run('DELETE FROM security_events WHERE created_at < :cutoff', { cutoff: iso(nowMs - KEEP_DAYS * 86_400_000) }).changes;
}
