// The UI's gating decisions (design §6.2, §12.9): what each role is offered for comments and work logs,
// which space settings sections it sees, and what it may do to the members of a space.
import { describe, expect, it } from 'vitest';
import { spacePermissions, type SpaceRole } from '@shared/roles';
import type { MemberDTO, PersonDTO } from '@shared/types';
import { entryActions, leaveRefusal, memberActions, memberRoleChangeNeedsReauth, spaceSettingsSections, transferTargets } from './permissions';

const ME = 1;
const people = new Map<number, Pick<PersonDTO, 'deleted' | 'kind'>>([
  [1, { deleted: false, kind: 'account' }],
  [2, { deleted: false, kind: 'account' }],
  [3, { deleted: true, kind: 'account' }],
  [-4, { deleted: false, kind: 'placeholder' }],
]);
const by = (id: number | null) => ({ author: id === null ? null : { id, displayName: `P${id}` } });

describe('entryActions (comments and work logs)', () => {
  it('members edit and delete their own entries only', () => {
    const p = spacePermissions('member');
    expect(entryActions(p, by(ME), ME, people)).toEqual({ edit: true, delete: true });
    expect(entryActions(p, by(2), ME, people)).toEqual({ edit: false, delete: false });
  });

  it('admins and owners also delete anyone’s, but never edit someone else’s', () => {
    for (const role of ['admin', 'owner'] as const) {
      const p = spacePermissions(role);
      expect(entryActions(p, by(2), ME, people)).toEqual({ edit: false, delete: true });
      expect(entryActions(p, by(3), ME, people)).toEqual({ edit: false, delete: true });
      expect(entryActions(p, by(null), ME, people)).toEqual({ edit: false, delete: true });
      expect(entryActions(p, by(ME), ME, people)).toEqual({ edit: true, delete: true });
    }
  });

  it('viewers change nothing, not even their own entries (from before a demotion)', () => {
    const p = spacePermissions('viewer');
    expect(entryActions(p, by(ME), ME, people)).toEqual({ edit: false, delete: false });
    expect(entryActions(p, by(2), ME, people)).toEqual({ edit: false, delete: false });
  });

  it('an entry of a deleted account or a placeholder is nobody’s own', () => {
    const p = spacePermissions('member');
    expect(entryActions(p, by(3), 3, people)).toEqual({ edit: false, delete: false });
    expect(entryActions(p, by(-4), -4, people)).toEqual({ edit: false, delete: false });
  });
});

describe('spaceSettingsSections', () => {
  const sections = (role: SpaceRole) => spaceSettingsSections(spacePermissions(role));
  it('shows each role the sections it can use', () => {
    expect(sections('viewer')).toEqual(['general', 'members', 'danger']);
    expect(sections('member')).toEqual(['general', 'members', 'tags', 'danger']);
    expect(sections('admin')).toEqual(['general', 'members', 'invitations', 'statuses', 'tags', 'danger']);
    expect(sections('owner')).toEqual(['general', 'members', 'invitations', 'statuses', 'tags', 'data', 'danger']);
  });
});

const member = (role: SpaceRole, o: Partial<Pick<MemberDTO, 'isYou' | 'status'>> = {}): Pick<MemberDTO, 'role' | 'isYou' | 'status'> => ({
  role,
  isYou: o.isYou ?? false,
  status: o.status ?? 'active',
});

describe('memberActions (roles.ts canChangeRole / canRemove)', () => {
  it('owners change anyone else to any role, remove them and transfer to non-owners', () => {
    expect(memberActions('owner', member('member'))).toEqual({ roles: ['owner', 'admin', 'viewer'], remove: true, transfer: true });
    expect(memberActions('owner', member('owner'))).toEqual({ roles: ['admin', 'member', 'viewer'], remove: true, transfer: false });
    expect(memberActions('owner', member('admin', { status: 'disabled' })).transfer).toBe(false);
  });

  it('admins move members and viewers between those two roles and remove them, and leave admins and owners alone', () => {
    expect(memberActions('admin', member('member'))).toEqual({ roles: ['viewer'], remove: true, transfer: false });
    expect(memberActions('admin', member('viewer'))).toEqual({ roles: ['member'], remove: true, transfer: false });
    expect(memberActions('admin', member('admin'))).toEqual({ roles: [], remove: false, transfer: false });
    expect(memberActions('admin', member('owner'))).toEqual({ roles: [], remove: false, transfer: false });
  });

  it('members and viewers change nobody, and nobody changes or removes themselves', () => {
    for (const actor of ['member', 'viewer'] as const) {
      expect(memberActions(actor, member('viewer'))).toEqual({ roles: [], remove: false, transfer: false });
    }
    expect(memberActions('owner', member('owner', { isYou: true }))).toEqual({ roles: [], remove: false, transfer: false });
  });

  it('asks for the password for grants of admin and changes to or from owner', () => {
    expect(memberRoleChangeNeedsReauth(member('member'), 'admin')).toBe(true);
    expect(memberRoleChangeNeedsReauth(member('member'), 'owner')).toBe(true);
    expect(memberRoleChangeNeedsReauth(member('owner'), 'member')).toBe(true);
    expect(memberRoleChangeNeedsReauth(member('admin'), 'member')).toBe(false);
    expect(memberRoleChangeNeedsReauth(member('member'), 'viewer')).toBe(false);
  });

  it('transferTargets: an owner’s active members who are not owners yet; nobody for anyone else', () => {
    const list = [member('owner', { isYou: true }), member('admin'), member('owner'), member('viewer', { status: 'disabled' }), member('member')];
    expect(transferTargets('owner', list).map((m) => m.role)).toEqual(['admin', 'member']);
    expect(transferTargets('admin', list)).toEqual([]);
  });
});

describe('leaveRefusal', () => {
  it('refuses the only owner, and nobody else', () => {
    expect(leaveRefusal([member('owner', { isYou: true }), member('member')])).toBe('last_owner');
    expect(leaveRefusal([member('owner', { isYou: true })])).toBe('last_owner');
    expect(leaveRefusal([member('owner', { isYou: true }), member('owner')])).toBeNull();
    expect(leaveRefusal([member('viewer', { isYou: true }), member('owner')])).toBeNull();
    expect(leaveRefusal(undefined)).toBeNull();
  });
});
