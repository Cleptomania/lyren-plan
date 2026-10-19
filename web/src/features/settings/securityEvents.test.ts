// The account's security log as Account settings → Security lists it (design §5.11).
import { describe, expect, it } from 'vitest';
import { isWarningEvent, securityEventText } from './securityEvents';

const event = (type: string, data: Record<string, unknown> = {}) => ({ type, data });

describe('securityEventText', () => {
  it('describes the events of this version', () => {
    expect(securityEventText(event('account_created'))).toBe('Account created');
    expect(securityEventText(event('login', { method: 'password' }))).toBe('Signed in');
    expect(securityEventText(event('password_changed'))).toBe('Password changed');
    expect(securityEventText(event('admin_backup_downloaded'))).toBe('Downloaded a backup of the instance');
  });

  it('counts failed sign-ins and revoked devices', () => {
    expect(securityEventText(event('login_failed', { failures: 4 }))).toBe('Failed sign-in attempts (4)');
    expect(securityEventText(event('login_failed', { failures: 1 }))).toBe('Failed sign-in attempt');
    expect(securityEventText(event('login_failed'))).toBe('Failed sign-in attempt');
    expect(securityEventText(event('sessions_revoked', { revoked: 2 }))).toBe('Signed out 2 other devices');
    expect(securityEventText(event('sessions_revoked', { revoked: 1 }))).toBe('Signed out 1 other device');
    expect(securityEventText(event('sessions_revoked', { revoked: 'x' }))).toBe('Signed out other devices');
  });

  it('names the role and, when the account still has it, the space of a role change', () => {
    const names = new Map([['7k2m9q4w8x1c3v5b', 'Team']]);
    expect(securityEventText(event('member_role_changed', { space: '7k2m9q4w8x1c3v5b', role: 'admin' }), names)).toBe('Made someone an admin of Team');
    expect(securityEventText(event('member_role_changed', { space: 'gone', role: 'owner' }), names)).toBe('Made someone an owner of a space');
    expect(securityEventText(event('member_role_changed', { role: 'nonsense' }))).toBe('Changed a member’s role');
  });

  it('describes what administrators did, to the account or to the instance', () => {
    expect(securityEventText(event('admin_user_disabled'))).toBe('An administrator disabled the account');
    expect(securityEventText(event('admin_user_enabled'))).toBe('An administrator enabled the account again');
    expect(securityEventText(event('admin_granted', { via: 'cli' }))).toBe('Made an administrator of the instance');
    expect(securityEventText(event('admin_revoked'))).toBe('No longer an administrator of the instance');
    expect(securityEventText(event('admin_reset_link', { delivery: 'link' }))).toBe('An administrator created a password reset link');
    expect(securityEventText(event('recovery_used', { madeAdmin: true }))).toBe('The recovery token was used for this account');
    expect(securityEventText(event('admin_settings_changed', { signupPolicy: { from: 'open', to: 'closed' } }))).toBe('Changed the instance settings');
    expect(securityEventText(event('admin_space_deleted', { space: '7k2m9q4w8x1c3v5b', name: 'Team' }))).toBe('Deleted the space Team (administration)');
    expect(securityEventText(event('admin_space_restored', {}))).toBe('Restored a space (administration)');
    expect(securityEventText(event('admin_invitation_created', { email: 'x@example.com' }))).toBe('Invited someone to the instance');
    expect(securityEventText(event('admin_invitation_revoked'))).toBe('Revoked an invitation to the instance');
  });

  it('describes resets, email changes and invitations', () => {
    const names = new Map([['7k2m9q4w8x1c3v5b', 'Team']]);
    expect(securityEventText(event('password_reset'))).toBe('Password reset with a link');
    expect(securityEventText(event('password_reset', { issuedBy: 3 }))).toBe('Password reset with a link from an administrator');
    expect(securityEventText(event('email_change_requested', { email: 'new@example.com' }))).toBe('Asked to change the email address to new@example.com');
    expect(securityEventText(event('email_changed', { email: 'new@example.com', from: 'old@example.com' }))).toBe(
      'Email address changed from old@example.com to new@example.com',
    );
    expect(securityEventText(event('email_changed', { email: 'new@example.com' }))).toBe('Email address set to new@example.com');
    expect(securityEventText(event('email_changed'))).toBe('Email address changed');
    expect(securityEventText(event('email_verified', { email: 'a@example.com' }))).toBe('Email address a@example.com verified');
    expect(securityEventText(event('invitation_accepted', { invitationId: 4, space: '7k2m9q4w8x1c3v5b', role: 'member' }), names)).toBe(
      'Accepted an invitation to Team as a member',
    );
    expect(securityEventText(event('invitation_accepted', { invitationId: 4, space: 'gone', role: 'viewer' }), names)).toBe(
      'Accepted an invitation to a space as a viewer',
    );
    expect(securityEventText(event('invitation_accepted', { invitationId: 5 }))).toBe('Accepted an invitation to this instance');
    expect(securityEventText(event('member_added', { space: '7k2m9q4w8x1c3v5b', userId: 9, role: 'admin' }), names)).toBe(
      'Someone you invited joined Team as an admin',
    );
    expect(securityEventText(event('mail_failed', { template: 'verify_email', reason: 'cap', budget: 'mr' }))).toBe(
      'An email to you was not sent: the daily limit was reached',
    );
    expect(securityEventText(event('mail_failed', { template: 'verify_email', reason: 'transport' }))).toBe('An email to you could not be sent');
  });

  it('describes the passkeys: sign-ins, added (and how), removed, a refused copy; and a removed password', () => {
    expect(securityEventText(event('passkey_login', { passkeyId: 3, name: 'Chrome on Linux' }))).toBe('Signed in with the passkey “Chrome on Linux”');
    expect(securityEventText(event('passkey_login'))).toBe('Signed in with a passkey');
    expect(securityEventText(event('passkey_added', { passkeyId: 3, name: 'Phone', via: 'settings' }))).toBe('Passkey “Phone” added');
    expect(securityEventText(event('passkey_added'))).toBe('Passkey added');
    expect(securityEventText(event('passkey_added', { name: 'Phone', via: 'reset' }))).toBe('Passkey “Phone” set up with a reset link');
    expect(securityEventText(event('passkey_added', { name: 'Phone', via: 'reset', issuedBy: 1 }))).toBe(
      'Passkey “Phone” set up with a reset link from an administrator',
    );
    expect(securityEventText(event('passkey_added', { name: 'Passkey 1', via: 'signup' }))).toBe('Passkey “Passkey 1” set up with the new account');
    expect(securityEventText(event('passkey_added', { name: 'Passkey 1', via: 'invite' }))).toBe('Passkey “Passkey 1” set up with the new account');
    expect(securityEventText(event('passkey_removed', { name: 'Old laptop' }))).toBe('Passkey “Old laptop” removed');
    expect(securityEventText(event('password_removed'))).toBe('Password removed: the account signs in with passkeys');
    expect(securityEventText(event('password_removed', { via: 'reset' }))).toBe('Password removed with a reset link: the account signs in with passkeys');
    expect(securityEventText(event('passkey_counter_regression', { name: 'Key', stored: 9, received: 4, purpose: 'login' }))).toBe(
      'A sign-in with the passkey “Key” was refused: its counter went backwards, which can mean that the passkey was copied',
    );
    expect(securityEventText(event('passkey_counter_regression', { name: 'Key', stored: 9, received: 4, purpose: 'reauth' }))).toBe(
      'A confirmation with the passkey “Key” was refused: its counter went backwards, which can mean that the passkey was copied',
    );
    // Recorded before the purpose was.
    expect(securityEventText(event('passkey_counter_regression', { name: 'Key', stored: 9, received: 4 }))).toBe(
      'A use of the passkey “Key” was refused: its counter went backwards, which can mean that the passkey was copied',
    );
  });

  it('marks failed sign-ins and a refused copy of a passkey as warnings', () => {
    expect(isWarningEvent('login_failed')).toBe(true);
    expect(isWarningEvent('passkey_counter_regression')).toBe(true);
    expect(isWarningEvent('passkey_login')).toBe(false);
    expect(isWarningEvent('login')).toBe(false);
  });

  it('reads an event of a later version by its type', () => {
    expect(securityEventText(event('session_moved_elsewhere'))).toBe('Session moved elsewhere');
    expect(securityEventText(event(''))).toBe('Security event');
  });
});
