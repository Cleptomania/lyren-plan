// A space's Settings → Invitations (design §5.8.8, §12.9): the roles each role invites with, who manages
// which invitation, a row's details, how refusals read, and the account's own invitations on /spaces.
import { describe, expect, it } from 'vitest';
import type { InvitationDTO } from '@shared/types';
import { ApiError } from '../../api/errors';
import { invitationDetails, invitationRefusal, inviteRoles, managesInvitation, pendingInvitationText } from './invitations';

const NOW = Date.parse('2026-10-18T12:00:00.000Z');
const invitation = (o: Partial<InvitationDTO> = {}): InvitationDTO => ({
  id: 1,
  email: 'bob@example.com',
  role: 'member',
  invitedBy: { id: 1, displayName: 'Alice' },
  createdAt: '2026-10-18T10:00:00.000Z',
  expiresAt: '2026-10-25T10:00:00.000Z',
  lastSentAt: '2026-10-18T10:00:00.000Z',
  sendCount: 1,
  delivery: 'mail',
  status: 'pending',
  ...o,
});

describe('who invites with which role', () => {
  it('admins invite members and viewers; owners admins too; nobody an owner', () => {
    expect(inviteRoles('owner')).toEqual(['admin', 'member', 'viewer']);
    expect(inviteRoles('admin')).toEqual(['member', 'viewer']);
    expect(inviteRoles('member')).toEqual([]);
    expect(inviteRoles('viewer')).toEqual([]);
  });

  it('an admin invitation is an owner’s to send again or revoke', () => {
    expect(managesInvitation('owner', invitation({ role: 'admin' }))).toBe(true);
    expect(managesInvitation('admin', invitation({ role: 'admin' }))).toBe(false);
    expect(managesInvitation('admin', invitation({ role: 'viewer' }))).toBe(true);
    expect(managesInvitation('owner', invitation({ role: null }))).toBe(false);
  });
});

describe('invitationDetails', () => {
  it('who sent it, when and how often, until when it works', () => {
    expect(invitationDetails(invitation(), NOW)).toBe('From Alice · sent 2 hours ago · expires in 7 days');
    expect(invitationDetails(invitation({ sendCount: 3, invitedBy: null }), NOW)).toBe('sent 2 hours ago (3 times) · expires in 7 days');
    expect(invitationDetails(invitation({ status: 'expired', expiresAt: '2026-10-17T12:00:00.000Z' }), NOW)).toBe('From Alice · sent 2 hours ago · expired yesterday');
  });
});

describe('invitationRefusal', () => {
  it('the address itself: at the field', () => {
    const invalid = new ApiError(400, 'validation_error', 'email: Enter a valid email address', [{ path: 'email', message: 'Enter a valid email address' }]);
    expect(invitationRefusal(invalid)).toEqual({ field: 'Enter a valid email address' });
    expect(invitationRefusal(new ApiError(409, 'conflict', 'bob@example.com is already a member'))).toEqual({ field: 'bob@example.com is already a member' });
    expect(invitationRefusal(new ApiError(409, 'conflict', 'An invitation to this address is pending'))).toEqual({ field: 'An invitation to this address is pending' });
  });

  it('the quotas and the daily limits: above the form, with what to do', () => {
    const open = invitationRefusal(new ApiError(409, 'quota_exceeded', 'A space can have at most 50 open invitations'));
    expect(open).toEqual({ message: 'A space can have at most 50 open invitations', hint: expect.stringMatching(/^To make room, revoke invitations/) });
    const members = invitationRefusal(new ApiError(409, 'quota_exceeded', 'A space can have at most 10 members, open invitations included'));
    expect(members.message).toBe('A space can have at most 10 members, open invitations included');
    expect(members.hint).toMatch(/remove members/);
    const daily = invitationRefusal(new ApiError(429, 'rate_limited', 'You have sent as many invitations as you can today'));
    expect(daily).toEqual({ message: 'You have sent as many invitations as you can today', hint: expect.stringMatching(/Try again tomorrow\.$/) });
  });

  it('an unverified inviter is pointed at Account settings; a mail that could not be sent keeps the form', () => {
    expect(invitationRefusal(new ApiError(403, 'forbidden', 'Verify your email address before inviting people'))).toEqual({
      message: 'Verify your email address before inviting people',
      verify: true,
    });
    expect(invitationRefusal(new ApiError(503, 'unavailable', 'The invitation email could not be sent. Try again later.'))).toEqual({
      message: 'The invitation email could not be sent. Try again later.',
    });
  });
});

describe('pendingInvitationText', () => {
  it('says who invited the account where, with which role', () => {
    expect(pendingInvitationText({ inviterName: 'Alice', spaceName: 'Team', role: 'viewer' })).toBe('Alice invited you to Team as a viewer.');
    expect(pendingInvitationText({ inviterName: null, spaceName: 'Team', role: 'admin' })).toBe('Someone invited you to Team as an admin.');
  });
});
