// Memberships (design §6.3). Who may change what comes from shared/src/roles.ts, the same functions
// the web client uses to show and hide controls; the rules a role alone cannot decide are here: nobody
// changes their own role (leave or transfer instead), a space always keeps an owner, and some changes
// need the re-auth window (the routes check that).
//
// Every membership change bumps the space's sync_version (identities cached by the space carry the
// role) and keeps the person's space_people row: removing or leaving keeps their mirror row in the
// space, so what they wrote keeps their name, shown as a former member. Grants (member_added,
// member_role_changed) are security events of the account that granted them.

import { atLeast, canChangeRole, canRemove, ROLE_RANK, type SpaceRole } from '@shared/roles';
import type { MemberDTO } from '@shared/types';
import type { Db } from '../core/db';
import type { TrustedMeta } from '../core/ports';
import { forbidden, lastOwner, notFound } from '../http/errors';
import { recordEvent } from './security';
import type { MemberSpace } from './spaces';

export interface MembershipRow {
  space_id: number;
  user_id: number;
  role: SpaceRole;
  added_by: number | null;
  created_at: string;
  updated_at: string;
}

interface MemberRow {
  user_id: number;
  display_name: string;
  email: string | null;
  role: SpaceRole;
  status: 'active' | 'disabled';
  created_at: string;
}

const iso = (ms: number) => new Date(ms).toISOString();

const toMemberDTO = (r: MemberRow, viewerId: number): MemberDTO => ({
  userId: r.user_id,
  displayName: r.display_name,
  email: r.email,
  role: r.role,
  status: r.status,
  joinedAt: r.created_at,
  isYou: r.user_id === viewerId,
});

const MEMBER_SELECT = `SELECT m.user_id, u.display_name, u.email, m.role, u.status, m.created_at
  FROM memberships m JOIN users u ON u.id = m.user_id`;

/** The members of a space, owners first, then by when they joined. Every member sees the others' emails. */
export function listMembers(db: Db, spaceId: number, viewerId: number): MemberDTO[] {
  const rows = db.all<MemberRow>(`${MEMBER_SELECT} WHERE m.space_id = :spaceId ORDER BY m.created_at, m.user_id`, { spaceId });
  return rows.sort((a, b) => ROLE_RANK[b.role] - ROLE_RANK[a.role]).map((r) => toMemberDTO(r, viewerId));
}

function memberRow(db: Db, spaceId: number, userId: number): MemberRow | null {
  return db.get<MemberRow>(`${MEMBER_SELECT} WHERE m.space_id = :spaceId AND m.user_id = :userId`, { spaceId, userId }) ?? null;
}

export function getMember(db: Db, spaceId: number, userId: number, viewerId: number): MemberDTO {
  const row = memberRow(db, spaceId, userId);
  if (!row) throw notFound('Member');
  return toMemberDTO(row, viewerId);
}

function ownerCount(db: Db, spaceId: number): number {
  return db.get<{ n: number }>("SELECT COUNT(*) AS n FROM memberships WHERE space_id = :spaceId AND role = 'owner'", { spaceId })!.n;
}

function setRole(db: Db, spaceId: number, userId: number, role: SpaceRole, nowMs: number): void {
  db.run('UPDATE memberships SET role = :role, updated_at = :now WHERE space_id = :spaceId AND user_id = :userId', {
    spaceId,
    userId,
    role,
    now: iso(nowMs),
  });
}

const bump = (db: Db, spaceId: number) =>
  db.run('UPDATE spaces SET sync_version = sync_version + 1 WHERE id = :spaceId', { spaceId });

/**
 * Revoke the open invitations that `userId` may no longer send in this space after dropping to `role`
 * (§5.8.8 lifecycle): all of them below admin, the admin-role ones below owner.
 */
function revokeInvitationsAfterRole(db: Db, spaceId: number, userId: number, role: SpaceRole | null, nowMs: number): void {
  if (role === 'owner') return;
  db.run(
    `UPDATE invitations SET revoked_at = :now
     WHERE space_id = :spaceId AND invited_by = :userId AND accepted_at IS NULL AND revoked_at IS NULL
       AND (:allRoles = 1 OR role = 'admin')`,
    { spaceId, userId, allRoles: role === null || !atLeast(role, 'admin'), now: iso(nowMs) },
  );
}

/**
 * Add `userId` to the space with `role` (or change their role), with its space_people row and a
 * sync_version bump. Invitations (P5) call it on acceptance; tests use it to add members directly.
 */
export function addMember(db: Db, o: { spaceId: number; userId: number; role: SpaceRole; addedBy: number | null; nowMs: number }): void {
  const now = iso(o.nowMs);
  db.tx(() => {
    db.run(
      `INSERT INTO memberships (space_id, user_id, role, added_by, created_at, updated_at)
       VALUES (:spaceId, :userId, :role, :addedBy, :now, :now)
       ON CONFLICT (space_id, user_id) DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at`,
      { spaceId: o.spaceId, userId: o.userId, role: o.role, addedBy: o.addedBy, now },
    );
    db.run('INSERT OR IGNORE INTO space_people (space_id, user_id) VALUES (:spaceId, :userId)', {
      spaceId: o.spaceId,
      userId: o.userId,
    });
    bump(db, o.spaceId);
  });
}

export interface RoleChange {
  member: MemberDTO;
  /** The member lost rights (a demotion): the space pushes are awaited. */
  demoted: boolean;
}

/**
 * PATCH /api/spaces/:spaceId/members/:userId: `actor` (in `space`) sets `targetId`'s role. The caller
 * has already checked the re-auth window when roleChangeNeedsReauth says so.
 */
export function changeRole(
  db: Db,
  o: { space: MemberSpace; actorId: number; targetId: number; role: SpaceRole; meta: TrustedMeta; nowMs: number },
): RoleChange {
  const { space } = o;
  const target = memberRow(db, space.id, o.targetId);
  if (!target) throw notFound('Member');
  const isSelf = o.targetId === o.actorId;
  if (isSelf) throw forbidden('You cannot change your own role. Leave the space or transfer ownership instead.');
  if (!canChangeRole(space.role, target.role, o.role, isSelf)) throw forbidden('You cannot give this member that role');
  if (target.role === o.role) return { member: toMemberDTO(target, o.actorId), demoted: false };
  db.tx(() => {
    setRole(db, space.id, o.targetId, o.role, o.nowMs);
    // The actor stays an owner when demoting another owner, so this only guards against surprises.
    if (ownerCount(db, space.id) === 0) throw lastOwner('A space needs at least one owner');
    revokeInvitationsAfterRole(db, space.id, o.targetId, o.role, o.nowMs);
    bump(db, space.id);
    recordEvent(db, {
      type: 'member_role_changed',
      userId: o.actorId,
      meta: o.meta,
      data: { space: space.public_id, userId: o.targetId, role: o.role, from: target.role },
      nowMs: o.nowMs,
    });
  });
  return { member: getMember(db, space.id, o.targetId, o.actorId), demoted: ROLE_RANK[o.role] < ROLE_RANK[target.role] };
}

/** DELETE /api/spaces/:spaceId/members/:userId. */
export function removeMember(db: Db, o: { space: MemberSpace; actorId: number; targetId: number; nowMs: number }): void {
  const { space } = o;
  const target = memberRow(db, space.id, o.targetId);
  if (!target) throw notFound('Member');
  const isSelf = o.targetId === o.actorId;
  if (isSelf) throw forbidden('To remove yourself, leave the space');
  if (!canRemove(space.role, target.role, isSelf)) throw forbidden('You cannot remove this member');
  db.tx(() => {
    db.run('DELETE FROM memberships WHERE space_id = :spaceId AND user_id = :userId', { spaceId: space.id, userId: o.targetId });
    if (ownerCount(db, space.id) === 0) throw lastOwner('A space needs at least one owner');
    revokeInvitationsAfterRole(db, space.id, o.targetId, null, o.nowMs);
    bump(db, space.id);
  });
}

/** POST /api/spaces/:spaceId/leave: anyone but the last owner. */
export function leaveSpace(db: Db, o: { space: MemberSpace; userId: number; nowMs: number }): void {
  const { space } = o;
  if (space.role === 'owner' && ownerCount(db, space.id) <= 1) {
    throw lastOwner('You are the only owner of this space. Transfer ownership or delete the space first.');
  }
  db.tx(() => {
    db.run('DELETE FROM memberships WHERE space_id = :spaceId AND user_id = :userId', { spaceId: space.id, userId: o.userId });
    revokeInvitationsAfterRole(db, space.id, o.userId, null, o.nowMs);
    bump(db, space.id);
  });
}

/**
 * POST /api/spaces/:spaceId/transfer (owner, re-auth): the member `targetId` becomes an owner; with
 * `demoteSelfTo` the caller takes that role in the same transaction. Returns whether the caller was
 * demoted.
 */
export function transferOwnership(
  db: Db,
  o: { space: MemberSpace; actorId: number; targetId: number; demoteSelfTo?: Exclude<SpaceRole, 'owner'>; meta: TrustedMeta; nowMs: number },
): { demoted: boolean } {
  const { space } = o;
  if (space.role !== 'owner') throw forbidden('Only an owner can transfer ownership');
  if (o.targetId === o.actorId) throw forbidden('You are already an owner');
  const target = memberRow(db, space.id, o.targetId);
  if (!target) throw notFound('Member');
  db.tx(() => {
    if (target.role !== 'owner') {
      setRole(db, space.id, o.targetId, 'owner', o.nowMs);
      recordEvent(db, {
        type: 'member_role_changed',
        userId: o.actorId,
        meta: o.meta,
        data: { space: space.public_id, userId: o.targetId, role: 'owner', from: target.role },
        nowMs: o.nowMs,
      });
    }
    if (o.demoteSelfTo) {
      setRole(db, space.id, o.actorId, o.demoteSelfTo, o.nowMs);
      revokeInvitationsAfterRole(db, space.id, o.actorId, o.demoteSelfTo, o.nowMs);
    }
    bump(db, space.id);
  });
  return { demoted: o.demoteSelfTo !== undefined };
}
