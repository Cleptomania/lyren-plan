// The invitation page's states (design §5.8.8, §12.7): which way in a preview offers, what joining
// changes for a member, and the sentence that says who invited whom.
import { describe, expect, it } from 'vitest';
import type { InvitationPreviewDTO } from '@shared/types';
import { acceptRefusalHint, inviteSentence, inviteView, joinChange, joinText, signupClosedHelp } from './inviteView';

const preview = (o: Partial<InvitationPreviewDTO> = {}): InvitationPreviewDTO => ({
  kind: 'space',
  spaceName: 'Team',
  inviterName: 'Alice',
  inviterEmail: 'alice@example.com',
  role: 'member',
  email: 'bob@example.com',
  expiresAt: '2026-10-25T12:00:00.000Z',
  account: 'unknown',
  signedIn: null,
  ...o,
});
const me = (o: Partial<NonNullable<InvitationPreviewDTO['signedIn']>> = {}) => ({ email: 'bob@example.com', matches: true, memberRole: null, ...o });

describe('inviteView', () => {
  it('signed out: create, sign in, or both when the server does not say (a copied link)', () => {
    expect(inviteView(preview({ account: 'new' }))).toEqual({ kind: 'create' });
    expect(inviteView(preview({ account: 'exists' }))).toEqual({ kind: 'sign_in' });
    expect(inviteView(preview({ account: 'unknown' }))).toEqual({ kind: 'choose' });
  });

  it('signed in as the invited address: join; as another account: say so', () => {
    expect(inviteView(preview({ account: 'exists', signedIn: me() }))).toEqual({ kind: 'join', change: 'join' });
    expect(inviteView(preview({ signedIn: me({ email: 'carol@example.com', matches: false }) }))).toEqual({ kind: 'wrong_account' });
  });

  it('a member of the space already keeps the higher role; an instance invitation has nothing to accept', () => {
    expect(inviteView(preview({ role: 'admin', signedIn: me({ memberRole: 'viewer' }) }))).toEqual({ kind: 'join', change: 'raise' });
    expect(inviteView(preview({ role: 'member', signedIn: me({ memberRole: 'owner' }) }))).toEqual({ kind: 'join', change: 'none' });
    expect(inviteView(preview({ kind: 'instance', spaceName: null, role: null, signedIn: me() }))).toEqual({ kind: 'has_account' });
    expect(inviteView(preview({ kind: 'instance', spaceName: null, role: null, account: 'new' }))).toEqual({ kind: 'create' });
  });
});

describe('joinChange and joinText', () => {
  it('names what accepting changes', () => {
    expect(joinChange('member', null)).toBe('join');
    expect(joinChange('member', 'member')).toBe('none');
    expect(joinChange('admin', 'member')).toBe('raise');
    expect(joinChange('viewer', 'member')).toBe('none');
    expect(joinText(preview({ signedIn: me() }))).toBe('Join Team with this account.');
    expect(joinText(preview({ role: 'admin', signedIn: me({ memberRole: 'viewer' }) }))).toBe('You are a viewer of Team already. Accepting makes you an admin.');
    expect(joinText(preview({ signedIn: me({ memberRole: 'admin' }) }))).toBe('You are an admin of Team already, so accepting changes nothing.');
  });
});

describe('inviteSentence', () => {
  it('who invited the reader to which space with which role, or to an account of their own', () => {
    expect(inviteSentence(preview(), 'Lyren Plan')).toBe('Alice (alice@example.com) invited you to Team as a member.');
    expect(inviteSentence(preview({ role: 'admin' }), 'Lyren Plan')).toBe('Alice (alice@example.com) invited you to Team as an admin.');
    expect(inviteSentence(preview({ kind: 'instance', spaceName: null, role: null }), 'Plan at Example')).toBe(
      'Alice (alice@example.com) invited you to an account of your own on Plan at Example.',
    );
    expect(inviteSentence(preview({ inviterEmail: null }), 'Lyren Plan')).toBe('Alice invited you to Team as a member.');
    expect(inviteSentence(preview({ inviterName: null, inviterEmail: null }), 'Lyren Plan')).toBe('Someone invited you to Team as a member.');
  });
});

describe('refusals of accepting the reader cannot fix', () => {
  it('sign-up closed: the link is fine; sign in with an account of one’s own, or ask the inviter or an administrator', () => {
    expect(signupClosedHelp(preview())).toEqual({
      title: 'This instance creates no new accounts',
      text: 'Only an administrator’s invitation creates an account here. This invitation still works for an account you have here already: sign in to accept it. Otherwise ask an administrator of this instance to invite you (Alice can ask one for you).',
      signIn: true,
    });
    expect(signupClosedHelp(preview({ account: 'new', inviterName: null }))).toMatchObject({
      text: expect.stringMatching(/cannot make you one\. To join, ask an administrator of this instance to invite you \(whoever invited you can ask one for you\)\.$/),
      signIn: false,
    });
  });

  it('a full space: ask the inviter to make room', () => {
    expect(acceptRefusalHint('quota_exceeded', preview())).toBe('Ask Alice to make room in the space, then accept again.');
    expect(acceptRefusalHint('conflict', preview())).toBeNull();
  });
});
