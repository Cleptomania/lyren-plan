// Space roles and what each may do (design §6.1-§6.3). The server's checks (the space gate, the
// directory's member routes) and the web client's show/hide logic use these same functions.
//
//   owner (3) > admin (2) > member (1) > viewer (0)
//
// - viewer: reads everything in the space, changes nothing; can leave.
// - member: also creates and edits content (projects without deleting them, milestones, epics,
//   tasks, boards, tags, comments and work logs).
// - admin: also deletes projects, manages statuses, tag deletes and merges and the space settings,
//   deletes anyone's comments and work logs, invites members and viewers, and changes or removes
//   members and viewers.
// - owner: everything, admins and owners included, renaming, export, replace imports, deleting and
//   restoring the space, and transferring ownership. A space may have several owners.
// Instance admin is a flag on the account, not a role: in a space it gives only the role held there.
// Rules a role alone cannot decide (the last owner, re-auth windows) are applied by their callers.

export const SPACE_ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
export type SpaceRole = (typeof SPACE_ROLES)[number];

/** Roles an invitation can grant: never owner (ownership is transferred, §6.3). */
export const INVITABLE_ROLES = ['admin', 'member', 'viewer'] as const;
export type InvitableRole = Exclude<SpaceRole, 'owner'>;

export const ROLE_RANK: Readonly<Record<SpaceRole, number>> = { owner: 3, admin: 2, member: 1, viewer: 0 };

export function isSpaceRole(value: unknown): value is SpaceRole {
  return typeof value === 'string' && (SPACE_ROLES as readonly string[]).includes(value);
}

/** `role` ranks at least as high as `need`. */
export function atLeast(role: SpaceRole, need: SpaceRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[need];
}

/** Admins invite members and viewers; owners also admins. Nobody invites an owner. */
export function canInviteRole(actor: SpaceRole, role: SpaceRole): boolean {
  if (role === 'owner') return false;
  if (actor === 'owner') return true;
  return actor === 'admin' && role !== 'admin';
}

/**
 * Whether `actor` may change a member's role from `targetCurrent` to `targetNew` (PATCH
 * …/members/:userId). Nobody changes their own role (leave or transfer instead). An admin acts on
 * members and viewers only, and only sets member or viewer; an owner acts on anyone else, other
 * owners included (the acting owner remains one, so the space keeps an owner).
 */
export function canChangeRole(actor: SpaceRole, targetCurrent: SpaceRole, targetNew: SpaceRole, isSelf: boolean): boolean {
  if (isSelf) return false;
  if (actor === 'owner') return true;
  return actor === 'admin' && !atLeast(targetCurrent, 'admin') && !atLeast(targetNew, 'admin');
}

/**
 * Whether `actor` may remove a member whose role is `target`. Admins remove members and viewers;
 * owners anyone else. Removing oneself is leaving (POST …/leave, with the last-owner rule).
 */
export function canRemove(actor: SpaceRole, target: SpaceRole, isSelf: boolean): boolean {
  if (isSelf) return false;
  if (actor === 'owner') return true;
  return actor === 'admin' && !atLeast(target, 'admin');
}

/**
 * Whether a role change that `canChangeRole` allows also needs the re-auth window (§5.4.4): every
 * grant of admin, and promotions to and demotions from owner. Demoting an admin does not.
 */
export function roleChangeNeedsReauth(targetCurrent: SpaceRole, targetNew: SpaceRole): boolean {
  if (targetCurrent === targetNew) return false;
  return targetNew === 'admin' || targetNew === 'owner' || targetCurrent === 'owner';
}

/** Whether inviting with `role` needs the re-auth window (§5.4.4): admin invitations do. */
export function inviteNeedsReauth(role: SpaceRole): boolean {
  return role === 'admin';
}

export interface SpacePermissions {
  /** Create and edit projects, milestones, epics, tasks, boards, tags, comments and work logs; delete all but projects. */
  write: boolean;
  deleteProjects: boolean;
  /** Statuses, deleting and merging tags, the space settings. */
  manageStructure: boolean;
  /** Delete anyone's comments and work logs; reassign placeholders' and former members' authorship. */
  moderate: boolean;
  /** Invite members and viewers; list invitations; resend and revoke member and viewer invitations. */
  invite: boolean;
  /** Invite admins; resend and revoke admin invitations. */
  inviteAdmins: boolean;
  /** Change roles between member and viewer; remove members and viewers. */
  manageMembers: boolean;
  /** Make admins and owners, demote them, remove them; transfer ownership. */
  manageOwners: boolean;
  export: boolean;
  importReplace: boolean;
  /** Delete the space, and restore it within the grace period. */
  deleteSpace: boolean;
  rename: boolean;
}

/** What `role` may do in a space (the matrix of §6.2; every role reads everything). */
export function spacePermissions(role: SpaceRole): SpacePermissions {
  const member = atLeast(role, 'member');
  const admin = atLeast(role, 'admin');
  const owner = role === 'owner';
  return {
    write: member,
    deleteProjects: admin,
    manageStructure: admin,
    moderate: admin,
    invite: admin,
    inviteAdmins: owner,
    manageMembers: admin,
    manageOwners: owner,
    export: owner,
    importReplace: owner,
    deleteSpace: owner,
    rename: owner,
  };
}
