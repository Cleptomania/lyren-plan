// Invitations (design §5.8.8): to a space with a role (members and viewers from its admins, admins from
// its owners), or to the instance (space NULL, role NULL: an account without a space, sent by instance
// admins only). The routes check who may act and the re-auth window; this module keeps the rules of the
// invitations themselves.
//
// - Delivery is 'mail' whenever the transport delivers mail: the row is inserted, the message is sent at
//   once (10 s), and when it is not sent the row goes again and the inviter gets a 503, so the token never
//   reaches anyone but the invited address. Without mail (MAIL_TRANSPORT=log) delivery is 'link': the
//   inviter is given the link to pass on, which no log ever holds.
// - Quotas (§11.4): open invitations per space (MAX_OPEN_INVITATIONS_PER_SPACE; the instance invitations
//   count as one more scope), members plus open invitations (MAX_MEMBERS_PER_SPACE), the inviter's sends a
//   day (iv:<userId>, INVITATIONS_PER_DAY, 5 for an account younger than a day) and, with mail, the mails
//   to one address a day across the instance (ir:<email_key>). Expired invitations count for none of them.
// - An invitation works while it is open and unexpired, its space is active, and its inviter could still
//   send it: an active account with the role (admin, or owner for an admin invitation) or, for an instance
//   invitation, an instance admin. Revocations keep the rows tidy (an inviter that loses the right, a
//   disabled or deleted inviter, a deleted space), and every check at acceptance asks again.
// - Accepting consumes the invitation with one UPDATE that succeeds once, inside the transaction that adds
//   the membership (and, for a new account, creates it).

import { canInviteRole, ROLE_RANK, type InvitableRole, type SpaceRole } from '@shared/roles';
import type { InvitationCreatedDTO, InvitationDTO, InvitationPreviewDTO, PendingInvitationDTO } from '@shared/types';
import { randomToken, sha256Hex } from '../core/crypto';
import type { Db } from '../core/db';
import type { TrustedMeta } from '../core/ports';
import { conflict, forbidden, invalidToken, notFound, quotaExceeded, rateLimited, spaceUnavailable, unavailable } from '../http/errors';
import type { DirectoryContext } from './context';
import { isLinkToken } from './emailTokens';
import { addMember } from './members';
import { recordEvent } from './security';
import type { SpaceRow } from './spaces';
import { invitationsPolicy, POLICIES, type ThrottlePolicy } from './throttle';
import { findUser, findUserByEmailKey, type UserRow } from './users';

export interface InvitationRow {
  id: number;
  token_hash: string;
  /** NULL: an instance invitation. */
  space_id: number | null;
  email: string;
  email_key: string;
  /** NULL exactly for an instance invitation. */
  role: InvitableRole | null;
  invited_by: number | null;
  delivery: 'mail' | 'link';
  created_at: string;
  expires_at: string;
  last_sent_at: string;
  send_count: number;
  accepted_at: string | null;
  accepted_by: number | null;
  revoked_at: string | null;
  revoked_by: number | null;
}

/** An invitation that can be accepted now (§5.8.8 checks 1 and 2), with its space and inviter. */
export interface AcceptableInvitation {
  invitation: InvitationRow;
  /** null for an instance invitation. */
  space: SpaceRow | null;
  inviter: UserRow;
}

const DAY_MS = 86_400_000;
/** A resend waits this long after the last send. */
const RESEND_INTERVAL_MS = 10 * 60_000;
/** Sends of one invitation in all, the first included. */
export const MAX_SENDS = 5;
/** Accounts younger than a day send at most this many a day (§5.9 iv), instance admins excepted. */
const YOUNG_INVITATIONS_PER_DAY = 5;

export const VERIFY_BEFORE_INVITING = 'Verify your email address before inviting people';
export const INVITATION_NOT_SENT = 'The invitation email could not be sent. Try again later.';

const iso = (ms: number) => new Date(ms).toISOString();

/** The rows of one scope: a space (internal id) or the instance's invitations (null). */
const inScope = (spaceId: number | null, alias = '') => (spaceId === null ? `${alias}space_id IS NULL` : `${alias}space_id = :spaceId`);

// ---------------------------------------------------------------------------
// Rights and quotas
// ---------------------------------------------------------------------------

function roleIn(db: Db, spaceId: number, userId: number): SpaceRole | null {
  return db.get<{ role: SpaceRole }>('SELECT role FROM memberships WHERE space_id = :spaceId AND user_id = :userId', { spaceId, userId })?.role ?? null;
}

/**
 * Whether `inviter` may send an invitation of this kind now (and so resend or revoke it, and have it
 * accepted): an active account with a space role that may invite with `role` (canInviteRole), or, for an
 * instance invitation, an instance admin.
 */
export function maySendInvitation(db: Db, inviter: UserRow | null, o: { spaceId: number | null; role: InvitableRole | null }): boolean {
  if (inviter === null || inviter.status !== 'active') return false;
  if (o.spaceId === null) return inviter.is_instance_admin === 1;
  const role = roleIn(db, o.spaceId, inviter.id);
  return role !== null && o.role !== null && canInviteRole(role, o.role);
}

/** Open invitations of the scope that still work, but `exceptId`. */
function openCount(db: Db, spaceId: number | null, nowMs: number, exceptId: number | null): number {
  return db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM invitations
     WHERE ${inScope(spaceId)} AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > :now AND id IS NOT :exceptId`,
    { spaceId, now: iso(nowMs), exceptId },
  )!.n;
}

function memberCount(db: Db, spaceId: number): number {
  return db.get<{ n: number }>('SELECT COUNT(*) AS n FROM memberships WHERE space_id = :spaceId', { spaceId })!.n;
}

/** Room for one more open invitation in the scope (409 quota_exceeded): a create, or the resend of an expired one. */
function assertRoom(ctx: DirectoryContext, spaceId: number | null, nowMs: number, exceptId: number | null): void {
  const { maxOpenInvitationsPerSpace: maxOpen, maxMembersPerSpace: maxMembers } = ctx.config.quotas;
  const open = openCount(ctx.db, spaceId, nowMs, exceptId);
  if (maxOpen > 0 && open >= maxOpen) {
    throw quotaExceeded(spaceId === null ? `There can be at most ${maxOpen} open instance invitations` : `A space can have at most ${maxOpen} open invitations`);
  }
  if (spaceId !== null && maxMembers > 0 && memberCount(ctx.db, spaceId) + open >= maxMembers) {
    throw quotaExceeded(`A space can have at most ${maxMembers} members, open invitations included`);
  }
}

/**
 * At acceptance (§5.8.8 check 5): the space still keeps within MAX_MEMBERS_PER_SPACE, members and open
 * invitations, this one included. An account that is a member already takes no room.
 */
export function assertMemberRoom(ctx: DirectoryContext, found: AcceptableInvitation, userId: number | null): void {
  const max = ctx.config.quotas.maxMembersPerSpace;
  const spaceId = found.invitation.space_id;
  if (spaceId === null || max <= 0) return;
  if (userId !== null && roleIn(ctx.db, spaceId, userId) !== null) return;
  if (memberCount(ctx.db, spaceId) + openCount(ctx.db, spaceId, ctx.now(), null) > max) {
    throw quotaExceeded(`This space has reached its limit of ${max} members`);
  }
}

/**
 * The send limits of one invitation mail or link (§5.9): iv:<inviter> and, with mail, ir:<email_key>. The
 * first day's lower limit is not for instance admins: the first admin of a new instance is minutes old
 * when it invites its people, and an admin was made one by the operator or by another admin.
 */
function sendLimits(ctx: DirectoryContext, inviter: UserRow, emailKey: string, mail: boolean): Array<[string, ThrottlePolicy, string]> {
  const limits: Array<[string, ThrottlePolicy, string]> = [];
  const perDay = ctx.config.quotas.invitationsPerDay;
  if (perDay > 0) {
    const young = inviter.is_instance_admin !== 1 && ctx.now() - Date.parse(inviter.created_at) < DAY_MS && perDay > YOUNG_INVITATIONS_PER_DAY;
    const policy = invitationsPolicy(young ? YOUNG_INVITATIONS_PER_DAY : perDay);
    const message = young
      ? `A new account can send ${YOUNG_INVITATIONS_PER_DAY} invitations on its first day`
      : 'You have sent as many invitations as you can today';
    limits.push([`iv:${inviter.id}`, policy, message]);
  }
  if (mail) limits.push([`ir:${emailKey}`, POLICIES.ir, 'Too many invitations were sent to this address today']);
  return limits;
}

/** 429 when one of the limits is used up; otherwise each counts the send (given back when the mail fails). */
function spendSendLimits(ctx: DirectoryContext, limits: Array<[string, ThrottlePolicy, string]>): void {
  for (const [key, policy, message] of limits) {
    const state = ctx.throttle.check(key, policy);
    if (state.blocked) throw rateLimited(message, state.retryAfterMs / 1000);
  }
  for (const [key, policy] of limits) ctx.throttle.hit(key, policy);
}

function giveBack(ctx: DirectoryContext, limits: Array<[string, ThrottlePolicy, string]>): void {
  for (const [key, policy] of limits) ctx.throttle.forgive(key, policy);
}

/** With mail, the inviter is named by a verified address (§5.8.8 step 2, §5.10.3). */
function assertMayMail(ctx: DirectoryContext, inviter: UserRow): void {
  if (ctx.mailer.deliversMail && (inviter.email === null || inviter.email_verified_at === null)) throw forbidden(VERIFY_BEFORE_INVITING);
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

interface ListedRow extends InvitationRow {
  inviter_name: string | null;
}

const LISTED_SELECT = 'SELECT i.*, u.display_name AS inviter_name FROM invitations i LEFT JOIN users u ON u.id = i.invited_by';

function toInvitationDTO(row: ListedRow, nowMs: number): InvitationDTO {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    invitedBy: row.invited_by === null || row.inviter_name === null ? null : { id: row.invited_by, displayName: row.inviter_name },
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastSentAt: row.last_sent_at,
    sendCount: row.send_count,
    delivery: row.delivery,
    status: Date.parse(row.expires_at) > nowMs ? 'pending' : 'expired',
  };
}

function invitationDTO(db: Db, id: number, nowMs: number): InvitationDTO {
  const row = db.get<ListedRow>(`${LISTED_SELECT} WHERE i.id = :id`, { id });
  if (!row) throw notFound('Invitation');
  return toInvitationDTO(row, nowMs);
}

/**
 * The open invitations of a space (internal id) or the instance's (null), newest first: pending ones and
 * expired ones not replaced yet. Never a token or a link.
 */
export function listInvitations(db: Db, spaceId: number | null, nowMs: number): InvitationDTO[] {
  return db
    .all<ListedRow>(`${LISTED_SELECT} WHERE ${inScope(spaceId, 'i.')} AND i.accepted_at IS NULL AND i.revoked_at IS NULL ORDER BY i.created_at DESC, i.id DESC`, {
      spaceId,
    })
    .map((row) => toInvitationDTO(row, nowMs));
}

/** The open invitation `id` of the scope, expired or not; null when there is none. */
export function findOpenInvitation(db: Db, spaceId: number | null, id: number): InvitationRow | null {
  return (
    db.get<InvitationRow>(`SELECT * FROM invitations WHERE id = :id AND ${inScope(spaceId)} AND accepted_at IS NULL AND revoked_at IS NULL`, {
      id,
      spaceId,
    }) ?? null
  );
}

// ---------------------------------------------------------------------------
// Creating, resending, revoking
// ---------------------------------------------------------------------------

/**
 * Invite `email` to the space with `role`, or to the instance (space and role null). The caller has
 * checked the inviter's right and the re-auth window on the rows it just read. 201's body.
 */
export async function createInvitation(
  ctx: DirectoryContext,
  o: { inviter: UserRow; space: SpaceRow | null; email: { address: string; key: string }; role: InvitableRole | null; meta: TrustedMeta },
): Promise<InvitationCreatedDTO> {
  const { db, mailer } = ctx;
  const nowMs = ctx.now();
  const spaceId = o.space?.id ?? null;
  if (o.space && o.space.status !== 'active') throw spaceUnavailable();
  assertMayMail(ctx, o.inviter);
  if (spaceId !== null) {
    const member = db.get(
      'SELECT 1 AS member FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.space_id = :spaceId AND u.email_key = :key',
      { spaceId, key: o.email.key },
    );
    if (member) throw conflict(`${o.email.address} is already a member`);
  } else if (findUserByEmailKey(db, o.email.key)) {
    throw conflict(`${o.email.address} already has an account`);
  }
  const open = db.get<InvitationRow>(
    `SELECT * FROM invitations WHERE ${inScope(spaceId)} AND email_key = :key AND accepted_at IS NULL AND revoked_at IS NULL`,
    { spaceId, key: o.email.key },
  );
  if (open && Date.parse(open.expires_at) > nowMs) throw conflict('An invitation to this address is pending');
  assertRoom(ctx, spaceId, nowMs, null);
  const mail = mailer.deliversMail;
  const limits = sendLimits(ctx, o.inviter, o.email.key, mail);
  spendSendLimits(ctx, limits);
  const token = randomToken();
  const now = iso(nowMs);
  const expiresAt = iso(nowMs + ctx.config.invitationTtlDays * DAY_MS);
  const id = db.tx(() => {
    // An expired one is replaced (revoked_by NULL), so the open index takes the new row.
    if (open) db.run('UPDATE invitations SET revoked_at = :now WHERE id = :id AND revoked_at IS NULL', { id: open.id, now });
    return db.get<{ id: number }>(
      `INSERT INTO invitations (token_hash, space_id, email, email_key, role, invited_by, delivery, created_at, expires_at, last_sent_at)
       VALUES (:hash, :spaceId, :email, :key, :role, :invitedBy, :delivery, :now, :expiresAt, :now) RETURNING id`,
      {
        hash: sha256Hex(token),
        spaceId,
        email: o.email.address,
        key: o.email.key,
        role: o.role,
        invitedBy: o.inviter.id,
        delivery: mail ? 'mail' : 'link',
        now,
        expiresAt,
      },
    )!.id;
  });
  if (mail) {
    const result = await mailer.invitation({
      to: o.email.address,
      token,
      inviter: { displayName: o.inviter.display_name, email: o.inviter.email! },
      spaceName: o.space?.name ?? null,
      role: o.role,
      expiresAt,
      meta: o.meta,
    });
    if (!result.sent) {
      db.run('DELETE FROM invitations WHERE id = :id AND accepted_at IS NULL', { id });
      giveBack(ctx, limits);
      throw unavailable(INVITATION_NOT_SENT);
    }
  }
  return { invitation: invitationDTO(db, id, ctx.now()), link: mail ? null : mailer.link(`/invite#t=${token}`) };
}

/**
 * Send the open invitation again with a new token (§5.8.8 Resend): at most once in 10 minutes and 5 times
 * in all; it counts on iv and ir like a new one. With mail the message goes first, and only once it is
 * sent are the token and the expiry replaced, so a failed resend (503) leaves the earlier link working.
 * Without mail the token is rotated and the new link returned. The delivery follows the transport, and the
 * one who resends becomes the inviter (the message names them, and their right is what acceptance checks).
 */
export async function resendInvitation(
  ctx: DirectoryContext,
  o: { inviter: UserRow; invitation: InvitationRow; space: SpaceRow | null; meta: TrustedMeta },
): Promise<InvitationCreatedDTO> {
  const { db, mailer } = ctx;
  const inv = o.invitation;
  const nowMs = ctx.now();
  if (o.space && o.space.status !== 'active') throw spaceUnavailable();
  const wait = Date.parse(inv.last_sent_at) + RESEND_INTERVAL_MS - nowMs;
  if (wait > 0) throw rateLimited('This invitation was sent a moment ago. Try again in a few minutes.', wait / 1000);
  if (inv.send_count >= MAX_SENDS) throw quotaExceeded(`This invitation was sent ${MAX_SENDS} times. Revoke it and invite again.`);
  assertMayMail(ctx, o.inviter);
  // An expired invitation comes back to life: it needs room like a new one.
  if (Date.parse(inv.expires_at) <= nowMs) assertRoom(ctx, inv.space_id, nowMs, inv.id);
  const mail = mailer.deliversMail;
  const limits = sendLimits(ctx, o.inviter, inv.email_key, mail);
  spendSendLimits(ctx, limits);
  const token = randomToken();
  const expiresAt = iso(nowMs + ctx.config.invitationTtlDays * DAY_MS);
  if (mail) {
    const result = await mailer.invitation({
      to: inv.email,
      token,
      inviter: { displayName: o.inviter.display_name, email: o.inviter.email! },
      spaceName: o.space?.name ?? null,
      role: inv.role,
      expiresAt,
      meta: o.meta,
    });
    if (!result.sent) {
      giveBack(ctx, limits);
      throw unavailable(INVITATION_NOT_SENT);
    }
  }
  const done = ctx.now();
  // Re-read: the invitation may have been accepted or revoked during the send.
  const { changes } = db.run(
    `UPDATE invitations SET token_hash = :hash, invited_by = :inviterId, delivery = :delivery, expires_at = :expiresAt,
       last_sent_at = :now, send_count = send_count + 1
     WHERE id = :id AND accepted_at IS NULL AND revoked_at IS NULL`,
    { id: inv.id, hash: sha256Hex(token), inviterId: o.inviter.id, delivery: mail ? 'mail' : 'link', expiresAt, now: iso(done) },
  );
  if (changes === 0) throw notFound('Invitation');
  return { invitation: invitationDTO(db, inv.id, done), link: mail ? null : mailer.link(`/invite#t=${token}`) };
}

/** Revoke (or decline) an open invitation; false when it is not open. */
export function revokeInvitation(db: Db, o: { invitationId: number; byUserId: number | null; nowMs: number }): boolean {
  return (
    db.run(
      'UPDATE invitations SET revoked_at = :now, revoked_by = :by WHERE id = :id AND accepted_at IS NULL AND revoked_at IS NULL',
      { id: o.invitationId, by: o.byUserId, now: iso(o.nowMs) },
    ).changes > 0
  );
}

/**
 * Lifecycle (§5.8.8): revoke the open invitations `userId` sent (revoked_by NULL): all of them when the
 * account is disabled or deleted, its instance invitations when it stops being an instance admin. The
 * invitations of a space whose role it loses are members.ts's; a deleted space's, spaces.ts's.
 */
export function revokeInvitationsSentBy(db: Db, userId: number, nowMs: number, o: { instanceOnly?: boolean } = {}): number {
  return db.run(
    `UPDATE invitations SET revoked_at = :now
     WHERE invited_by = :userId AND accepted_at IS NULL AND revoked_at IS NULL AND (:all = 1 OR space_id IS NULL)`,
    { userId, all: !o.instanceOnly, now: iso(nowMs) },
  ).changes;
}

// ---------------------------------------------------------------------------
// Inspecting and accepting
// ---------------------------------------------------------------------------

function acceptable(db: Db, invitation: InvitationRow): AcceptableInvitation | null {
  let space: SpaceRow | null = null;
  if (invitation.space_id !== null) {
    space = db.get<SpaceRow>('SELECT * FROM spaces WHERE id = :id', { id: invitation.space_id }) ?? null;
    if (space === null || space.deleted_at !== null || space.status !== 'active') return null;
  }
  const inviter = invitation.invited_by === null ? null : findUser(db, invitation.invited_by);
  if (inviter === null || !maySendInvitation(db, inviter, { spaceId: invitation.space_id, role: invitation.role })) return null;
  return { invitation, space, inviter };
}

const OPEN_NOW = 'accepted_at IS NULL AND revoked_at IS NULL AND expires_at > :now';

/** The invitation of a link token while it can be accepted (§5.8.8 checks 1 and 2); else null. */
export function findAcceptable(db: Db, token: string, nowMs: number): AcceptableInvitation | null {
  if (!isLinkToken(token)) return null;
  const invitation = db.get<InvitationRow>(`SELECT * FROM invitations WHERE token_hash = :hash AND ${OPEN_NOW}`, {
    hash: sha256Hex(token),
    now: iso(nowMs),
  });
  return invitation ? acceptable(db, invitation) : null;
}

/** A space invitation `id` to the account's address, while it can be accepted (the in-app list); else null. */
export function findPendingFor(db: Db, user: UserRow, id: number, nowMs: number): AcceptableInvitation | null {
  if (user.email_key === null) return null;
  const invitation = db.get<InvitationRow>(`SELECT * FROM invitations WHERE id = :id AND email_key = :key AND space_id IS NOT NULL AND ${OPEN_NOW}`, {
    id,
    key: user.email_key,
    now: iso(nowMs),
  });
  return invitation ? acceptable(db, invitation) : null;
}

/** GET /api/invitations: the space invitations to the account's address that can be accepted, newest first. */
export function listPendingInvitations(db: Db, user: UserRow, nowMs: number): PendingInvitationDTO[] {
  if (user.email_key === null) return [];
  const rows = db.all<InvitationRow>(
    `SELECT * FROM invitations WHERE email_key = :key AND space_id IS NOT NULL AND ${OPEN_NOW} ORDER BY created_at DESC, id DESC LIMIT 100`,
    { key: user.email_key, now: iso(nowMs) },
  );
  const pending: PendingInvitationDTO[] = [];
  for (const row of rows) {
    const found = acceptable(db, row);
    if (found?.space && row.role !== null) {
      pending.push({ id: row.id, spaceName: found.space.name, inviterName: found.inviter.display_name, role: row.role, expiresAt: row.expires_at });
    }
  }
  return pending;
}

/**
 * POST /api/invitations/inspect. Whether the invited address has an account is told only to a holder of
 * a mailed invitation (who controls the address) or to its signed-in owner; anyone else holding a copied
 * link learns 'unknown', whatever the answer would be.
 */
export function previewInvitation(db: Db, found: AcceptableInvitation, signedIn: UserRow | null): InvitationPreviewDTO {
  const inv = found.invitation;
  const matches = signedIn !== null && signedIn.email_key === inv.email_key;
  const told = inv.delivery === 'mail' || matches;
  return {
    kind: inv.space_id === null ? 'instance' : 'space',
    spaceName: found.space?.name ?? null,
    inviterName: found.inviter.display_name,
    inviterEmail: found.inviter.email,
    role: inv.role,
    email: inv.email,
    expiresAt: inv.expires_at,
    account: told ? (findUserByEmailKey(db, inv.email_key) ? 'exists' : 'new') : 'unknown',
    signedIn: signedIn
      ? { email: signedIn.email, matches, memberRole: matches && found.space ? roleIn(db, found.space.id, signedIn.id) : null }
      : null,
  };
}

/**
 * Consume the invitation for `userId` and give the account its membership, inside the caller's
 * transaction (a new account's first one). The UPDATE succeeds once (else 400 invalid_token, which rolls
 * the transaction back). A member already keeps the higher of the two roles. The grant is a security event
 * of the inviter (member_added, or member_role_changed when it raises a role; without the acceptor's
 * address, which is not the inviter's), the acceptance one of the account (invitation_accepted). Returns
 * the space's public id, or null for an instance invitation.
 */
export function consumeInvitation(db: Db, found: AcceptableInvitation, o: { userId: number; meta: TrustedMeta; nowMs: number }): string | null {
  const inv = found.invitation;
  const now = iso(o.nowMs);
  return db.tx(() => {
    const { changes } = db.run(`UPDATE invitations SET accepted_at = :now, accepted_by = :userId WHERE id = :id AND ${OPEN_NOW}`, {
      id: inv.id,
      userId: o.userId,
      now,
    });
    if (changes === 0) throw invalidToken();
    const space = found.space;
    recordEvent(db, {
      type: 'invitation_accepted',
      userId: o.userId,
      meta: o.meta,
      data: space ? { invitationId: inv.id, space: space.public_id, role: inv.role } : { invitationId: inv.id },
      nowMs: o.nowMs,
    });
    if (space === null || inv.role === null) return null;
    const current = roleIn(db, space.id, o.userId);
    if (current === null || ROLE_RANK[inv.role] > ROLE_RANK[current]) {
      addMember(db, { spaceId: space.id, userId: o.userId, role: inv.role, addedBy: found.inviter.id, nowMs: o.nowMs });
      recordEvent(db, {
        type: current === null ? 'member_added' : 'member_role_changed',
        userId: found.inviter.id,
        meta: null,
        data: { space: space.public_id, userId: o.userId, role: inv.role, ...(current ? { from: current } : {}), invitationId: inv.id },
        nowMs: o.nowMs,
      });
    }
    return space.public_id;
  });
}
