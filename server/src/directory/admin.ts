// Instance administration (design §5.8.18, §7.2, §13.11): what the /api/admin routes read and change.
// The routes check who acts (an instance admin, with the re-auth window for every write); this module keeps
// the rules of the changes themselves and reads the lists.
//
// - The overview: warnings, the configuration without its secrets, counts, and the last 20 administrative
//   events of every admin (ADMIN_EVENT_TYPES), so admins see each other's actions.
// - Accounts: a searchable list, newest first, and one account with its spaces and security log. Disabling
//   one ends its sessions and device tokens and revokes its open invitations; demoting an admin revokes the
//   instance invitations it sent. Nobody changes their own account here, and the last active admin stays
//   one (409 last_admin). Deleting is users.ts#deleteAccount with the admin as the actor.
// - Spaces: the list (name, owners, members, state, size; never content), delete and restore. Admins get no
//   membership; a restore needs the grace period to be running (Appendix D 20) and a member left to open it.
//
// The lists match `q` with instr() on ASCII-lowered columns, as SQLite's lower() folds on both runtimes
// (§3.7: never LIKE), and page with a cursor of the last row's sort key.

import type { SpaceRole } from '@shared/roles';
import type { AdminEventDTO, AdminEventTarget, AdminOverviewDTO, AdminSpaceDTO, AdminUserDetailDTO, AdminUserDTO, Page, UserRef } from '@shared/types';
import { SIGNUP_SEED_WARNING } from '../core/config';
import type { Db, SqlParams } from '../core/db';
import { isSpaceId } from '../core/ids';
import type { TrustedMeta } from '../core/ports';
import { badRequest, conflict, forbidden, lastAdmin, notFound } from '../http/errors';
import { ORPHANED_ACCOUNT_SQL, orphanedAccounts } from '../passkeys/credentials';
import { relyingParty } from '../passkeys/webauthn';
import { instanceInfo } from './routes/auth';
import type { DirectoryContext } from './context';
import { revokeDevices } from './devices';
import { revokeInvitationsSentBy } from './invitations';
import { ADMIN_EVENT_TYPES, listEvents, recordEvent, toEventDTO, type EventRow } from './security';
import { getInstanceSettings } from './settings';
import { isRestorable, memberSpaceIds, restoreSpace, softDeleteSpace, type SpaceRow } from './spaces';
import { findUser, otherActiveAdmins, type UserRow } from './users';

/** Page size of the admin lists when the request names none (§7.4). */
export const ADMIN_PAGE_DEFAULT = 50;
/** How many administrative events the overview lists. */
export const RECENT_ADMIN_EVENTS = 20;

export const RECOVERY_TOKEN_WARNING = {
  node: 'RECOVERY_TOKEN is set: whoever knows it can get a sign-in link for any account. Remove it from the server’s configuration once you no longer need it, then restart Lyren Plan.',
  cloudflare:
    'RECOVERY_TOKEN is set: whoever knows it can get a sign-in link for any account. Remove it once you no longer need it (npx wrangler secret delete RECOVERY_TOKEN).',
} as const;
export const OPEN_WITHOUT_MAIL_WARNING =
  'Sign-up is open, but this instance sends no mail (MAIL_TRANSPORT=log), so nobody can confirm an address to sign up. Configure mail, or choose another sign-up policy in Settings.';
export const NO_PUBLIC_URL_WARNING = 'PUBLIC_URL is not set: passkeys and email links are off';

const iso = (ms: number) => new Date(ms).toISOString();

/** ASCII lower case, as SQLite's lower() folds it: a search matches the same rows on both runtimes. */
export function asciiLower(s: string): string {
  return s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

/**
 * What an administrator should act on (§5.3, §5.8.19, §5.10.2, AdminOverviewDTO.warnings); `orphaned`: the
 * accounts of §5.6's domain-move warning (orphanedAccounts).
 */
export function adminWarnings(ctx: DirectoryContext, orphaned: number): string[] {
  const { config, deps } = ctx;
  const warnings: string[] = [];
  if (config.recoveryToken !== null) warnings.push(RECOVERY_TOKEN_WARNING[deps.runtime.kind]);
  // The configuration's own (MAIL_LOG_BODIES on a public origin). The SIGNUP_POLICY seed's only mattered
  // when the directory was created; the policy is the instance setting now, checked next.
  warnings.push(...config.warnings.filter((w) => w !== SIGNUP_SEED_WARNING));
  // The policy was set while mail worked, and the server was started without it since.
  if (getInstanceSettings(ctx.db, config).signupPolicy === 'open' && !ctx.mailer.sendsTokens) warnings.push(OPEN_WITHOUT_MAIL_WARNING);
  // The desktop app serves this computer (and its LAN addresses), which needs no PUBLIC_URL.
  if (config.publicUrl === null && !deps.desktop) warnings.push(NO_PUBLIC_URL_WARNING);
  const passkeys = orphanedPasskeysText(orphaned, deps.runtime.kind);
  if (passkeys !== null) warnings.push(passkeys);
  return warnings;
}

/** The RP ID passkeys must have been registered for to work here; null while passkeys are off. */
const rpIdOf = (ctx: Pick<DirectoryContext, 'config'>) => relyingParty(ctx.config.passkeys)?.rpId ?? null;

/**
 * The warning of §5.6 for `n` active accounts without a password none of whose passkeys works here (passkeys
 * are off, or the RP ID changed since they were registered: a domain move), or null for none. Besides a reset
 * link from an admin, it names what helps where admins cannot make one (an admin's account, the only admin):
 * the reset-password command on Node, the recovery token on Cloudflare (§5.8.19).
 */
export function orphanedPasskeysText(n: number, runtime: 'node' | 'cloudflare'): string | null {
  if (n === 0) return null;
  const one = n === 1;
  const accounts = one ? '1 account can only' : `${n} accounts can only`;
  const links = one ? 'Create a reset link for it (Admin → Users)' : 'Create reset links for them (Admin → Users)';
  const otherwise =
    runtime === 'node'
      ? `or run reset-password <email> on the server${one ? '' : ' for each'}`
      : `or, for ${one ? 'an administrator’s account' : 'administrators’ accounts'}, use the recovery token (RECOVERY_TOKEN)`;
  return `${accounts} sign in with passkeys that do not work on this address. ${links}, ${otherwise}.`;
}

/**
 * §5.6's warning (orphanedPasskeysText), counted now: in Node's startup log, Cloudflare's hourly alarm, and the
 * admin overview. It reads every passkey (orphanedAccounts).
 */
export function orphanedPasskeysWarning(ctx: Pick<DirectoryContext, 'db' | 'config' | 'deps'>): string | null {
  return orphanedPasskeysText(orphanedAccounts(ctx.db, rpIdOf(ctx)), ctx.deps.runtime.kind);
}

const count = (db: Db, sql: string, params: SqlParams = {}) => db.get<{ n: number }>(sql, params)!.n;

/** GET /api/admin/overview. */
export function adminOverview(ctx: DirectoryContext): AdminOverviewDTO {
  const { db, config } = ctx;
  const now = iso(ctx.now());
  const orphaned = orphanedAccounts(db, rpIdOf(ctx));
  return {
    instance: instanceInfo(ctx),
    counts: {
      users: count(db, 'SELECT COUNT(*) AS n FROM users'),
      spaces: count(db, "SELECT COUNT(*) AS n FROM spaces WHERE deleted_at IS NULL AND status <> 'provisioning'"),
      sessions: count(
        db,
        'SELECT COUNT(*) AS n FROM sessions WHERE expires_at > :now AND (absolute_expires_at IS NULL OR absolute_expires_at > :now)',
        { now },
      ),
    },
    // No secret: SMTP_PASS, RESEND_API_KEY, RECOVERY_TOKEN and SETUP_TOKEN are not in the list.
    config: {
      publicUrl: config.publicUrl,
      mailTransport: config.mail.transport,
      mailFrom: config.mail.from?.address ?? null,
      sessionTtlDays: config.sessionTtlDays,
      sessionMaxDays: config.sessionMaxDays,
      reauthMinutes: config.reauthMinutes,
      invitationTtlDays: config.invitationTtlDays,
      spaceDeleteGraceDays: config.spaceDeleteGraceDays,
      passwordKdf: config.passwordKdf,
    },
    warnings: adminWarnings(ctx, orphaned),
    orphanedPasskeyAccounts: orphaned,
    recentAdminEvents: recentAdminEvents(db),
  };
}

interface AdminEventRow extends EventRow {
  user_id: number | null;
  actor_id: number | null;
  actor_name: string | null;
  user_name: string | null;
}

/** The events about one account (user_id), which its own security log shows too. */
const ACCOUNT_EVENTS: ReadonlySet<string> = new Set([
  'admin_user_disabled',
  'admin_user_enabled',
  'admin_granted',
  'admin_revoked',
  'admin_reset_link',
  'recovery_used',
]);

const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** An account's name when the event's row no longer has one ("Ada disabled a deleted account"). */
const DELETED_ACCOUNT = 'a deleted account';

function eventTarget(row: AdminEventRow, data: Record<string, unknown>): AdminEventTarget | null {
  if (ACCOUNT_EVENTS.has(row.type)) {
    if (row.user_name !== null) return { kind: 'user', id: row.user_id, name: row.user_name };
    // Deleted since: the name the event was written with (data.displayName; none in events before it).
    return { kind: 'user', id: null, name: text(data.displayName) ?? DELETED_ACCOUNT };
  }
  switch (row.type) {
    case 'admin_user_deleted':
      return { kind: 'user', id: null, name: text(data.displayName) ?? DELETED_ACCOUNT };
    case 'admin_space_deleted':
    case 'admin_space_restored': {
      const id = text(data.space);
      return id === null ? null : { kind: 'space', id, name: text(data.name) ?? id };
    }
    case 'admin_invitation_created':
    case 'admin_invitation_revoked': {
      const email = text(data.email);
      return email === null ? null : { kind: 'email', email };
    }
    default:
      return null;
  }
}

/**
 * The last administrative events, newest first. The scan walks security_events backwards by id until it
 * has `limit` of them (no index on type: the table keeps 90 days, mostly sign-ins, which are rare with
 * 30-day sessions).
 */
export function recentAdminEvents(db: Db, limit = RECENT_ADMIN_EVENTS): AdminEventDTO[] {
  const rows = db.all<AdminEventRow>(
    `SELECT e.id, e.type, e.ip, e.user_agent, e.data, e.created_at, e.user_id, e.actor_id,
       a.display_name AS actor_name, u.display_name AS user_name
     FROM security_events e LEFT JOIN users a ON a.id = e.actor_id LEFT JOIN users u ON u.id = e.user_id
     WHERE e.type IN (SELECT value FROM json_each(:types))
     ORDER BY e.id DESC LIMIT ${limit}`,
    { types: JSON.stringify(ADMIN_EVENT_TYPES) },
  );
  return rows.map((row) => {
    const event = toEventDTO(row);
    const actor: UserRef | null = row.actor_id !== null && row.actor_name !== null ? { id: row.actor_id, displayName: row.actor_name } : null;
    return { ...event, actor, target: eventTarget(row, event.data) };
  });
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

interface AdminUserRow extends UserRow {
  passkey_count: number;
  usable_passkey_count: number;
  space_count: number;
}

/** The accounts as the admin lists show them; `:rpId` is the current RP ID (rpIdOf), for the usable passkeys. */
const ADMIN_USER_SELECT = `SELECT u.*,
    (SELECT COUNT(*) FROM passkeys p WHERE p.user_id = u.id) AS passkey_count,
    (SELECT COUNT(*) FROM passkeys p WHERE p.user_id = u.id AND p.rp_id IS :rpId) AS usable_passkey_count,
    (SELECT COUNT(*) FROM memberships m JOIN spaces s ON s.id = m.space_id
     WHERE m.user_id = u.id AND s.deleted_at IS NULL AND s.status <> 'provisioning') AS space_count
  FROM users u`;

const toAdminUserDTO = (r: AdminUserRow): AdminUserDTO => ({
  id: r.id,
  email: r.email,
  username: r.username,
  displayName: r.display_name,
  emailVerified: r.email_verified_at !== null,
  isInstanceAdmin: r.is_instance_admin === 1,
  status: r.status,
  hasPassword: r.password_hash !== null,
  passkeys: r.passkey_count,
  usablePasskeys: r.usable_passkey_count,
  spaces: r.space_count,
  createdAt: r.created_at,
  lastLoginAt: r.last_login_at,
});

/** One account as the admin list shows it; 404 when there is none. */
export function adminUser(ctx: Pick<DirectoryContext, 'db' | 'config'>, userId: number): AdminUserDTO {
  const row = ctx.db.get<AdminUserRow>(`${ADMIN_USER_SELECT} WHERE u.id = :id`, { id: userId, rpId: rpIdOf(ctx) });
  if (!row) throw notFound('Account');
  return toAdminUserDTO(row);
}

/**
 * GET /api/admin/users: newest first. `q` is a part of the address (its email_key), the legacy username
 * or the display name, compared in ASCII lower case; `orphaned`: only the accounts of §5.6's domain-move
 * warning (ORPHANED_ACCOUNT_SQL); `cursor` is the last id of the previous page.
 */
export function listAdminUsers(
  ctx: Pick<DirectoryContext, 'db' | 'config'>,
  o: { q?: string; orphaned?: boolean; cursor?: number; limit?: number },
): Page<AdminUserDTO> {
  const limit = o.limit ?? ADMIN_PAGE_DEFAULT;
  const q = o.q ? asciiLower(o.q) : null;
  const rows = ctx.db.all<AdminUserRow>(
    `${ADMIN_USER_SELECT}
     WHERE (:q IS NULL OR instr(u.email_key, :q) > 0 OR instr(lower(u.username), :q) > 0 OR instr(lower(u.display_name), :q) > 0)
       AND (NOT :orphaned OR (${ORPHANED_ACCOUNT_SQL}))
       AND (:cursor IS NULL OR u.id < :cursor)
     ORDER BY u.id DESC LIMIT :limit`,
    { q, orphaned: o.orphaned ?? false, rpId: rpIdOf(ctx), cursor: o.cursor ?? null, limit: limit + 1 },
  );
  const items = rows.slice(0, limit).map(toAdminUserDTO);
  return { items, nextCursor: rows.length > limit ? String(items[items.length - 1]!.id) : null };
}

/** GET /api/admin/users/:userId: the account, the spaces it is a member of, and its last 50 security events. */
export function adminUserDetail(ctx: Pick<DirectoryContext, 'db' | 'config'>, userId: number): AdminUserDetailDTO {
  const { db } = ctx;
  const user = adminUser(ctx, userId);
  const memberships = db.all<{ public_id: string; name: string; role: SpaceRole }>(
    `SELECT s.public_id, s.name, m.role FROM memberships m JOIN spaces s ON s.id = m.space_id
     WHERE m.user_id = :id AND s.deleted_at IS NULL AND s.status <> 'provisioning'
     ORDER BY lower(s.name), s.public_id`,
    { id: userId },
  );
  return {
    ...user,
    memberships: memberships.map((m) => ({ space: { id: m.public_id, name: m.name }, role: m.role })),
    events: listEvents(db, userId, null, 'admin'),
  };
}

export interface AdminUserChange {
  status?: 'active' | 'disabled';
  isInstanceAdmin?: boolean;
}

export const NOT_SELF = {
  change: 'You cannot disable or demote your own account. Ask another administrator.',
  delete: 'You cannot delete your own account here. Use Account settings → Danger zone.',
} as const;

/** The admin API never changes the admin's own account (§5.8.18): another admin, or the CLI, can. */
export function assertNotSelf(actor: Pick<UserRow, 'id'>, targetId: number, what: keyof typeof NOT_SELF): void {
  if (actor.id === targetId) throw forbidden(NOT_SELF[what]);
}

export const ADMIN_RESET_LINK_REFUSED = 'Reset links for administrators can only be created with the command line or the recovery token';
export const DEMOTED_RESET_LINK_REFUSED =
  'This account was an administrator until recently, so its reset links can only be created with the command line or the recovery token';
/** How long a demoted admin's account stays out of reach of the admins' reset links. */
export const DEMOTED_ADMIN_DAYS = 30;

/**
 * Why an admin may not create a reset link for `target` (§5.8.11: not for an administrator's account), or
 * null. An account that stopped being an admin less than 30 days ago, or has not signed in since, counts
 * as one: otherwise one admin could take over another in two steps, demoting it and then asking for a link.
 */
export function resetLinkRefusal(db: Db, target: UserRow, nowMs: number): string | null {
  if (target.is_instance_admin === 1) return ADMIN_RESET_LINK_REFUSED;
  const revoked = db.get<{ created_at: string }>(
    "SELECT created_at FROM security_events WHERE user_id = :id AND type = 'admin_revoked' ORDER BY id DESC LIMIT 1",
    { id: target.id },
  );
  if (!revoked) return null;
  const recent = Date.parse(revoked.created_at) > nowMs - DEMOTED_ADMIN_DAYS * 86_400_000;
  const signedInSince = target.last_login_at !== null && target.last_login_at > revoked.created_at;
  return recent || !signedInSince ? DEMOTED_RESET_LINK_REFUSED : null;
}

/** The last active instance admin stays one: neither disabled nor demoted (409 last_admin). */
export function assertKeepsAnAdmin(db: Db, target: UserRow, change: AdminUserChange): void {
  const leaves = (change.status === 'disabled' && target.status === 'active') || (change.isInstanceAdmin === false && target.is_instance_admin === 1);
  if (leaves && target.is_instance_admin === 1 && target.status === 'active' && otherActiveAdmins(db, target.id) === 0) {
    throw lastAdmin('This is the only active administrator. Make another account an administrator first');
  }
}

/**
 * PATCH /api/admin/users/:userId's change (the route has checked the rules and the re-auth window; they are
 * checked again in the transaction). Returns the account and the spaces to tell: a disabled account's, at
 * once (awaited), and a changed admin's, whose cached identities carry the flag (deferred).
 */
export function changeUser(
  ctx: DirectoryContext,
  o: { actor: UserRow; targetId: number; change: AdminUserChange; meta: TrustedMeta },
): { user: AdminUserDTO; revoked: string[]; refreshed: string[] } {
  const { db } = ctx;
  const nowMs = ctx.now();
  const now = iso(nowMs);
  return db.tx(() => {
    const target = findUser(db, o.targetId);
    if (!target) throw notFound('Account');
    assertNotSelf(o.actor, target.id, 'change');
    assertKeepsAnAdmin(db, target, o.change);
    // The name too: the overview names the account after it is deleted (eventTarget).
    const event = (type: 'admin_user_disabled' | 'admin_user_enabled' | 'admin_granted' | 'admin_revoked') =>
      recordEvent(db, { type, userId: target.id, actorId: o.actor.id, meta: o.meta, data: { displayName: target.display_name }, nowMs });
    let revoked: string[] = [];
    let refreshed: string[] = [];
    const admin = o.change.isInstanceAdmin;
    if (admin !== undefined && (admin ? 1 : 0) !== target.is_instance_admin) {
      db.run('UPDATE users SET is_instance_admin = :admin, updated_at = :now WHERE id = :id', { id: target.id, admin, now });
      // An instance invitation is only as good as its inviter's admin rights (§5.8.8).
      if (!admin) revokeInvitationsSentBy(db, target.id, nowMs, { instanceOnly: true });
      event(admin ? 'admin_granted' : 'admin_revoked');
      refreshed = memberSpaceIds(db, target.id);
    }
    if (o.change.status !== undefined && o.change.status !== target.status) {
      db.run('UPDATE users SET status = :status, updated_at = :now WHERE id = :id', { id: target.id, status: o.change.status, now });
      if (o.change.status === 'disabled') {
        // Signed out everywhere, no browser keeps its exemption from the lock-outs, no invitation of theirs works.
        db.run('DELETE FROM sessions WHERE user_id = :id', { id: target.id });
        revokeDevices(db, target.id);
        revokeInvitationsSentBy(db, target.id, nowMs);
        revoked = memberSpaceIds(db, target.id);
        refreshed = [];
      }
      event(o.change.status === 'disabled' ? 'admin_user_disabled' : 'admin_user_enabled');
    }
    return { user: adminUser(ctx, target.id), revoked, refreshed };
  });
}

// ---------------------------------------------------------------------------
// Spaces
// ---------------------------------------------------------------------------

interface AdminSpaceRow extends SpaceRow {
  member_count: number;
}

const ADMIN_SPACE_SELECT = `SELECT s.*, (SELECT COUNT(*) FROM memberships m WHERE m.space_id = s.id) AS member_count FROM spaces s`;

/** The cursor of the admin spaces list: the last space's created_at and id (the internal id stays internal). */
const SPACE_CURSOR = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)_([0-9a-z]{16})$/;

function toAdminSpaces(ctx: DirectoryContext, rows: AdminSpaceRow[]): AdminSpaceDTO[] {
  const owners = new Map<string, UserRef[]>();
  const ownerRows = ctx.db.all<{ public_id: string; id: number; display_name: string }>(
    `SELECT s.public_id, u.id, u.display_name FROM spaces s
       JOIN memberships m ON m.space_id = s.id AND m.role = 'owner' JOIN users u ON u.id = m.user_id
     WHERE s.public_id IN (SELECT value FROM json_each(:ids))
     ORDER BY m.created_at, u.id`,
    { ids: JSON.stringify(rows.map((r) => r.public_id)) },
  );
  for (const o of ownerRows) {
    const list = owners.get(o.public_id) ?? [];
    list.push({ id: o.id, displayName: o.display_name });
    owners.set(o.public_id, list);
  }
  return rows.map((r) => ({
    id: r.public_id,
    name: r.name,
    status: r.status,
    owners: owners.get(r.public_id) ?? [],
    memberCount: r.member_count,
    createdAt: r.created_at,
    deletedAt: r.deleted_at,
    purgeAfter: r.purge_after,
    bytes: ctx.deps.spaceBytes?.(r.public_id) ?? null,
  }));
}

/** One space as the admin list shows it. */
export function adminSpace(ctx: DirectoryContext, spaceId: number): AdminSpaceDTO {
  const row = ctx.db.get<AdminSpaceRow>(`${ADMIN_SPACE_SELECT} WHERE s.id = :id`, { id: spaceId });
  if (!row) throw notFound('Space');
  return toAdminSpaces(ctx, [row])[0]!;
}

/**
 * GET /api/admin/spaces: every space the directory holds (deleted ones until their purge, and those still
 * being created or imported), newest first. `q` is a part of the name in ASCII lower case, or the space's id.
 */
export function listAdminSpaces(ctx: DirectoryContext, o: { q?: string; cursor?: string; limit?: number }): Page<AdminSpaceDTO> {
  const limit = o.limit ?? ADMIN_PAGE_DEFAULT;
  const q = o.q ? asciiLower(o.q) : null;
  let after: { at: string; id: string } | null = null;
  if (o.cursor !== undefined) {
    const m = SPACE_CURSOR.exec(o.cursor);
    if (!m) throw badRequest('Invalid cursor', [{ path: 'query.cursor', message: 'Invalid cursor' }]);
    after = { at: m[1]!, id: m[2]! };
  }
  const rows = ctx.db.all<AdminSpaceRow>(
    `${ADMIN_SPACE_SELECT}
     WHERE (:q IS NULL OR instr(lower(s.name), :q) > 0 OR s.public_id = :q)
       AND (:at IS NULL OR s.created_at < :at OR (s.created_at = :at AND s.public_id < :after))
     ORDER BY s.created_at DESC, s.public_id DESC LIMIT :limit`,
    { q, at: after?.at ?? null, after: after?.id ?? null, limit: limit + 1 },
  );
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { items: toAdminSpaces(ctx, page), nextCursor: rows.length > limit && last ? `${last.created_at}_${last.public_id}` : null };
}

/** The space of an admin route's :spaceId, whatever its state; 404 when the directory has none. */
export function requireAnySpace(db: Db, publicId: string): SpaceRow {
  const space = isSpaceId(publicId) ? db.get<SpaceRow>('SELECT * FROM spaces WHERE public_id = :publicId', { publicId }) : undefined;
  if (!space) throw notFound('Space');
  return space;
}

/** DELETE /api/admin/spaces/:spaceId's rules, before the re-auth window. */
export function assertAdminDeletable(space: SpaceRow): void {
  if (space.deleted_at !== null) throw conflict('This space is deleted already');
  if (space.status === 'provisioning') throw conflict('This space is still being created. Try again in a moment.');
}

/** Soft-delete as its owner would (§5.8.16), with the admin as deleted_by; returns purge_after. */
export function adminDeleteSpace(ctx: DirectoryContext, o: { admin: UserRow; space: SpaceRow; meta: TrustedMeta }): string {
  const { db } = ctx;
  const nowMs = ctx.now();
  return db.tx(() => {
    const purgeAfter = softDeleteSpace(db, { spaceId: o.space.id, byUserId: o.admin.id, graceDays: ctx.config.spaceDeleteGraceDays, nowMs });
    const data = { space: o.space.public_id, name: o.space.name };
    recordEvent(db, { type: 'admin_space_deleted', userId: o.admin.id, actorId: o.admin.id, meta: o.meta, data, nowMs });
    return purgeAfter;
  });
}

/**
 * POST /api/admin/spaces/:spaceId/restore's rules, before the re-auth window: deleted, within its grace
 * period (Appendix D 20), and with a member left to open it (the last member's account deletion takes its
 * membership with it, and admins get none, so such a space would never be opened nor purged again).
 */
export function assertAdminRestorable(db: Db, space: SpaceRow, nowMs: number): void {
  if (space.deleted_at === null) throw conflict('This space is not deleted');
  if (!isRestorable(space, nowMs)) throw conflict('This space is being removed and can no longer be restored');
  if (!db.get('SELECT 1 AS member FROM memberships WHERE space_id = :id', { id: space.id })) {
    throw conflict('This space has no members left, so nobody could open it again');
  }
}

export function adminRestoreSpace(ctx: DirectoryContext, o: { admin: UserRow; space: SpaceRow; meta: TrustedMeta }): void {
  const { db } = ctx;
  const nowMs = ctx.now();
  db.tx(() => {
    restoreSpace(db, o.space.id, nowMs);
    const data = { space: o.space.public_id, name: o.space.name };
    recordEvent(db, { type: 'admin_space_restored', userId: o.admin.id, actorId: o.admin.id, meta: o.meta, data, nowMs });
  });
}
