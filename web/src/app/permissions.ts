// What the viewer's role lets the UI offer in a space (design §6.2, §12.9 viewer mode). The rules
// themselves are shared/src/roles.ts's (spacePermissions, canChangeRole, canRemove, …), which the
// server checks too; these pure decisions apply them to what a page shows, so the gating is
// unit-tested (permissions.test.ts). A control the role may not use is left out or disabled; the
// server refuses the request anyway.

import { canChangeRole, canRemove, roleChangeNeedsReauth, SPACE_ROLES, type SpacePermissions, type SpaceRole } from '@shared/roles';
import type { MemberDTO, PersonDTO, UserRef } from '@shared/types';
import { useSpace } from './space';

/** The page's space permissions (inside a space only). */
export function useSpacePermissions(): SpacePermissions {
  return useSpace().permissions;
}

// ---- Comments and work logs (§6.2, §6.5) -----------------------------------------------------

/** A comment or work log, as far as who may change it goes. */
export interface AuthoredEntry {
  author: UserRef | null;
}

export interface EntryActions {
  edit: boolean;
  delete: boolean;
}

/**
 * What the viewer may do with a comment or work log: members edit and delete their own entries
 * (an imported one attributed to them counts as their own); admins and owners also delete anyone's.
 * Nobody edits someone else's entry, and an entry of a deleted account or of a placeholder (§3.5)
 * has no owner who could edit it.
 */
export function entryActions(
  permissions: Pick<SpacePermissions, 'write' | 'moderate'>,
  entry: AuthoredEntry,
  viewerId: number,
  personById: ReadonlyMap<number, Pick<PersonDTO, 'deleted' | 'kind'>>,
): EntryActions {
  const person = entry.author ? personById.get(entry.author.id) : undefined;
  const own = entry.author !== null && entry.author.id === viewerId && !person?.deleted && person?.kind !== 'placeholder';
  return { edit: permissions.write && own, delete: (permissions.write && own) || permissions.moderate };
}

// ---- Space settings (§12.2) ------------------------------------------------------------------

export type SpaceSettingsSection = 'general' | 'members' | 'invitations' | 'statuses' | 'tags' | 'data' | 'danger';

/**
 * The sections of a space's settings the role sees: General (read-only below admin), the members
 * and the danger zone (leave) for everyone; invitations for admins and owners (who invite); tags for
 * members and up (they create and rename tags; deleting and merging is for admins); statuses for admins
 * and owners; data (export, import) for owners.
 */
export function spaceSettingsSections(permissions: SpacePermissions): SpaceSettingsSection[] {
  const sections: SpaceSettingsSection[] = ['general', 'members'];
  if (permissions.invite) sections.push('invitations');
  if (permissions.manageStructure) sections.push('statuses');
  if (permissions.write) sections.push('tags');
  if (permissions.export) sections.push('data');
  sections.push('danger');
  return sections;
}

// ---- Members (§6.3) --------------------------------------------------------------------------

export interface MemberActions {
  /** The roles the viewer may give this member (its current role excluded), highest first. */
  roles: SpaceRole[];
  remove: boolean;
  /** Make them an owner through a transfer (the viewer may step down in the same step). */
  transfer: boolean;
}

/** What the viewer (`actor`) may do to a member of the list (roles.ts canChangeRole / canRemove). */
export function memberActions(actor: SpaceRole, member: Pick<MemberDTO, 'role' | 'isYou' | 'status'>): MemberActions {
  const roles = SPACE_ROLES.filter((role) => role !== member.role && canChangeRole(actor, member.role, role, member.isYou));
  return {
    roles,
    remove: canRemove(actor, member.role, member.isYou),
    transfer: actor === 'owner' && !member.isYou && member.role !== 'owner' && member.status === 'active',
  };
}

/** A role change that asks for the password again first (§5.4.4): grants of admin, to or from owner. */
export function memberRoleChangeNeedsReauth(member: Pick<MemberDTO, 'role'>, role: SpaceRole): boolean {
  return roleChangeNeedsReauth(member.role, role);
}

/** The members the viewer may transfer ownership to (active members who are not owners already). */
export function transferTargets<M extends Pick<MemberDTO, 'role' | 'isYou' | 'status'>>(actor: SpaceRole, members: readonly M[]): M[] {
  return members.filter((m) => memberActions(actor, m).transfer);
}

export const ROLE_LABELS: Readonly<Record<SpaceRole, string>> = { owner: 'Owner', admin: 'Admin', member: 'Member', viewer: 'Viewer' };

/** What each role may do, for the role menus (§6.1). */
export const ROLE_DESCRIPTIONS: Readonly<Record<SpaceRole, string>> = {
  owner: 'Everything, including members, export, deleting the space and transferring it',
  admin: 'Also manages statuses, tags, settings, members and viewers, and deletes anyone’s comments',
  member: 'Creates and edits projects, tasks, boards, comments and work logs',
  viewer: 'Reads everything, changes nothing',
};

/**
 * Whether leaving is refused (409 last_owner, §6.3): the viewer is the space's only owner, so another
 * member must become an owner first (or the space be deleted). Null while the list is unknown.
 */
export function leaveRefusal(members: readonly Pick<MemberDTO, 'role' | 'isYou'>[] | undefined): 'last_owner' | null {
  if (!members) return null;
  const me = members.find((m) => m.isYou);
  if (me?.role !== 'owner') return null;
  return members.some((m) => !m.isYou && m.role === 'owner') ? null : 'last_owner';
}
