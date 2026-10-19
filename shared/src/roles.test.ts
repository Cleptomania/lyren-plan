// The permission matrix (design §6.2) and the membership rules (§6.3), written out in full.

import { describe, expect, it } from 'vitest';
import {
  atLeast,
  canChangeRole,
  canInviteRole,
  canRemove,
  INVITABLE_ROLES,
  inviteNeedsReauth,
  isSpaceRole,
  ROLE_RANK,
  roleChangeNeedsReauth,
  SPACE_ROLES,
  spacePermissions,
  type SpacePermissions,
  type SpaceRole,
} from './roles';

const [owner, admin, member, viewer] = SPACE_ROLES;

describe('roles', () => {
  it('rank owner > admin > member > viewer', () => {
    expect(SPACE_ROLES).toEqual(['owner', 'admin', 'member', 'viewer']);
    expect(ROLE_RANK).toEqual({ owner: 3, admin: 2, member: 1, viewer: 0 });
    expect(INVITABLE_ROLES).toEqual(['admin', 'member', 'viewer']);
    const table = SPACE_ROLES.map((role) => SPACE_ROLES.map((need) => atLeast(role, need)));
    expect(table).toEqual([
      // need: owner admin member viewer
      [true, true, true, true], // owner
      [false, true, true, true], // admin
      [false, false, true, true], // member
      [false, false, false, true], // viewer
    ]);
  });

  it('isSpaceRole accepts the four roles only', () => {
    for (const role of SPACE_ROLES) expect(isSpaceRole(role)).toBe(true);
    for (const value of ['Owner', 'instance_admin', '', null, 3]) expect(isSpaceRole(value)).toBe(false);
  });
});

describe('spacePermissions (§6.2)', () => {
  // One column per role, in the matrix's order: viewer, member, admin, owner.
  const matrix: Record<keyof SpacePermissions, [boolean, boolean, boolean, boolean]> = {
    // Create/edit projects, milestones, epics, tasks, boards; reorder; bulk edit; duplicate; delete
    // milestones, epics, tasks, boards; create and rename tags; add, edit and delete own comments
    // and work logs.
    write: [false, true, true, true],
    deleteProjects: [false, false, true, true],
    // Statuses; deleting and merging tags; the space settings.
    manageStructure: [false, false, true, true],
    // Deleting someone else's comment or work log; reassigning a placeholder's authorship.
    moderate: [false, false, true, true],
    // Inviting members and viewers; listing invitations; resending and revoking theirs.
    invite: [false, false, true, true],
    inviteAdmins: [false, false, false, true],
    // Changing roles between member and viewer; removing members and viewers.
    manageMembers: [false, false, true, true],
    // Making someone admin or owner, demoting admins and owners, removing them, transferring.
    manageOwners: [false, false, false, true],
    export: [false, false, false, true],
    importReplace: [false, false, false, true],
    deleteSpace: [false, false, false, true],
    rename: [false, false, false, true],
  };

  it.each([viewer, member, admin, owner])('%s', (role) => {
    const column = [viewer, member, admin, owner].indexOf(role);
    const expected = Object.fromEntries(Object.entries(matrix).map(([key, row]) => [key, row[column]]));
    expect(spacePermissions(role)).toEqual(expected);
  });
});

describe('membership rules (§6.3)', () => {
  it('canInviteRole: admins invite members and viewers, owners also admins, nobody owners', () => {
    const table = SPACE_ROLES.map((actor) => SPACE_ROLES.map((role) => canInviteRole(actor, role)));
    expect(table).toEqual([
      // invite as: owner admin member viewer
      [false, true, true, true], // owner
      [false, false, true, true], // admin
      [false, false, false, false], // member
      [false, false, false, false], // viewer
    ]);
  });

  it('canChangeRole: an admin moves members and viewers between member and viewer only', () => {
    for (const current of SPACE_ROLES) {
      for (const next of SPACE_ROLES) {
        const lower = (r: SpaceRole) => r === member || r === viewer;
        expect(canChangeRole(admin, current, next, false), `${current} -> ${next}`).toBe(lower(current) && lower(next));
      }
    }
  });

  it('canChangeRole: an owner changes anyone else, other owners included', () => {
    for (const current of SPACE_ROLES) {
      for (const next of SPACE_ROLES) expect(canChangeRole(owner, current, next, false), `${current} -> ${next}`).toBe(true);
    }
  });

  it('canChangeRole: members and viewers change nobody, and nobody changes their own role', () => {
    for (const actor of SPACE_ROLES) {
      for (const current of SPACE_ROLES) {
        for (const next of SPACE_ROLES) {
          if (actor === member || actor === viewer) expect(canChangeRole(actor, current, next, false)).toBe(false);
          expect(canChangeRole(actor, current, next, true), `${actor} self ${current} -> ${next}`).toBe(false);
        }
      }
    }
  });

  it('canRemove: admins remove members and viewers, owners anyone else; removing oneself is leaving', () => {
    const table = SPACE_ROLES.map((actor) => SPACE_ROLES.map((target) => canRemove(actor, target, false)));
    expect(table).toEqual([
      // remove: owner admin member viewer
      [true, true, true, true], // owner
      [false, false, true, true], // admin
      [false, false, false, false], // member
      [false, false, false, false], // viewer
    ]);
    for (const actor of SPACE_ROLES) {
      for (const target of SPACE_ROLES) expect(canRemove(actor, target, true)).toBe(false);
    }
  });

  it('re-auth: for granting admin, and for promotions to and demotions from owner', () => {
    const table = SPACE_ROLES.map((current) => SPACE_ROLES.map((next) => roleChangeNeedsReauth(current, next)));
    expect(table).toEqual([
      // to: owner admin member viewer
      [false, true, true, true], // from owner
      [true, false, false, false], // from admin: demoting an admin needs none
      [true, true, false, false], // from member
      [true, true, false, false], // from viewer
    ]);
    expect(SPACE_ROLES.map(inviteNeedsReauth)).toEqual([false, true, false, false]);
  });
});
