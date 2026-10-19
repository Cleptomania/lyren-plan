// What Administration → Overview says about the instance (design §5.8.18, §12.2): the configuration summary,
// the counts, the recent administrative actions as sentences, and the mail test's result.
import { describe, expect, it } from 'vitest';
import type { AdminEventDTO, AdminOverviewDTO } from '@shared/types';
import { addressText, adminEventText, configRows, countsText, limitText, mailText, testMailText } from './overview';

const CONFIG: AdminOverviewDTO['config'] = {
  publicUrl: 'https://plan.example.com',
  mailTransport: 'smtp',
  mailFrom: 'plan@example.com',
  sessionTtlDays: 30,
  sessionMaxDays: 0,
  reauthMinutes: 10,
  invitationTtlDays: 7,
  spaceDeleteGraceDays: 7,
  passwordKdf: 'scrypt',
};

const event = (type: string, o: Partial<AdminEventDTO> = {}): AdminEventDTO => ({
  id: 1,
  type,
  ip: null,
  userAgent: null,
  createdAt: '2026-10-18T12:00:00.000Z',
  data: {},
  actor: { id: 1, displayName: 'Ann' },
  target: null,
  ...o,
});
const bob = { kind: 'user' as const, id: 2, name: 'Bob' };

describe('the configuration summary', () => {
  it('limits and the address for links', () => {
    expect(limitText(null, 'spaces')).toBe('No limit');
    expect(limitText(5, 'spaces')).toBe('5 spaces');
    expect(limitText(20000, 'members')).toBe('20,000 members');
    expect(addressText([])).toBe('Not set (PUBLIC_URL)');
    expect(addressText(['https://plan.example.com'])).toBe('https://plan.example.com');
    expect(addressText(['http://192.168.1.4:43771', 'http://10.0.0.2:43771'])).toBe('http://192.168.1.4:43771, http://10.0.0.2:43771');
  });

  it('a row per setting, with the variables that set it', () => {
    expect(configRows(CONFIG).map((r) => [r.label, r.value, r.variables])).toEqual([
      ['Public address', 'https://plan.example.com', 'PUBLIC_URL'],
      ['Mail', 'SMTP, from plan@example.com', 'MAIL_TRANSPORT, MAIL_FROM'],
      ['Sign-in sessions', 'End 30 days after their last use', 'SESSION_TTL_DAYS, SESSION_MAX_DAYS'],
      ['Password confirmation', 'Sensitive actions ask again after 10 minutes', 'REAUTH_MINUTES'],
      ['Invitations', 'Valid for 7 days', 'INVITATION_TTL_DAYS'],
      ['Deleted spaces', 'Can be restored for 7 days', 'SPACE_DELETE_GRACE_DAYS'],
      ['Password hashing', 'scrypt', 'PASSWORD_KDF'],
    ]);
    const other = configRows({ ...CONFIG, publicUrl: null, sessionMaxDays: 90, spaceDeleteGraceDays: 0, reauthMinutes: 1, invitationTtlDays: 1 });
    expect(other.map((r) => r.value)).toEqual([
      'Not set',
      'SMTP, from plan@example.com',
      'End 30 days after their last use, and after 90 days at the latest',
      'Sensitive actions ask again after 1 minute',
      'Valid for 1 day',
      'Removed at once',
      'scrypt',
    ]);
  });

  it('how mail is sent, and the counts', () => {
    expect(mailText({ mailTransport: 'log', mailFrom: null })).toBe('Not sent: written to the server log (MAIL_TRANSPORT=log)');
    expect(mailText({ mailTransport: 'resend', mailFrom: 'plan@example.com' })).toBe('Resend, from plan@example.com');
    expect(mailText({ mailTransport: 'cloudflare', mailFrom: null })).toBe('Cloudflare Email Service');
    expect(countsText({ users: 1, spaces: 3, sessions: 0 })).toBe('1 account · 3 spaces · 0 signed-in sessions');
  });
});

describe('adminEventText', () => {
  it('says who did what to whom', () => {
    expect(adminEventText(event('admin_user_disabled', { target: bob }))).toBe('Ann disabled Bob');
    expect(adminEventText(event('admin_user_enabled', { target: bob }))).toBe('Ann enabled Bob again');
    expect(adminEventText(event('admin_granted', { target: bob }))).toBe('Ann made Bob an administrator');
    expect(adminEventText(event('admin_revoked', { target: bob }))).toBe('Ann took the administrator rights of Bob');
    expect(adminEventText(event('admin_reset_link', { target: bob, data: { delivery: 'link' } }))).toBe('Ann created a password reset link for Bob');
    expect(adminEventText(event('admin_reset_link', { target: bob, data: { delivery: 'mail' } }))).toBe(
      'Ann created a password reset link for Bob (sent to them by mail)',
    );
    expect(adminEventText(event('admin_user_deleted', { target: { kind: 'user', id: null, name: 'Bob' } }))).toBe('Ann deleted the account of Bob');
    const team = { kind: 'space' as const, id: '7k2m9q4w8x1c3v5b', name: 'Team' };
    expect(adminEventText(event('admin_space_deleted', { target: team }))).toBe('Ann deleted the space Team');
    expect(adminEventText(event('admin_space_restored', { target: team }))).toBe('Ann restored the space Team');
    expect(adminEventText(event('admin_backup_downloaded'))).toBe('Ann downloaded a backup of the instance');
    const address = { kind: 'email' as const, email: 'new@example.com' };
    expect(adminEventText(event('admin_invitation_created', { target: address }))).toBe('Ann invited new@example.com to the instance');
    expect(adminEventText(event('admin_invitation_revoked', { target: address }))).toBe('Ann revoked the invitation of new@example.com');
  });

  it('names what changed in the settings', () => {
    const data = { signupPolicy: { from: 'invite_only', to: 'closed' }, passwordMinLength: { from: 8, to: 12 } };
    expect(adminEventText(event('admin_settings_changed', { data }))).toBe(
      'Ann changed the settings: sign-up by invitation → closed; minimum password length 8 → 12',
    );
    expect(adminEventText(event('admin_settings_changed', { data: { signupPolicy: { from: 'closed', to: 'open' } } }))).toBe(
      'Ann changed the settings: sign-up closed → open',
    );
    expect(adminEventText(event('admin_settings_changed'))).toBe('Ann changed the settings');
  });

  it('the command line, the recovery token and a deleted account have no name', () => {
    expect(adminEventText(event('admin_granted', { actor: null, target: bob, data: { via: 'cli' } }))).toBe('The command line made Bob an administrator');
    expect(adminEventText(event('admin_settings_changed', { actor: null, data: { via: 'cli', signupPolicy: { from: 'open', to: 'invite_only' } } }))).toBe(
      'The command line changed the settings: sign-up open → by invitation',
    );
    expect(adminEventText(event('recovery_used', { actor: null, target: bob, data: { madeAdmin: false } }))).toBe('The recovery token gave Bob a password reset link');
    expect(adminEventText(event('recovery_used', { actor: null, target: bob, data: { madeAdmin: true } }))).toBe(
      'The recovery token gave Bob a password reset link and made them an administrator',
    );
    expect(adminEventText(event('admin_user_disabled', { actor: null, target: bob }))).toBe('A deleted account disabled Bob');
    expect(adminEventText(event('admin_something_new'))).toBe('Ann: admin something new');
  });
});

describe('testMailText', () => {
  it('says where the test message went', () => {
    expect(testMailText({ ok: true, messageId: '<abc@example.com>' }, 'ann@example.com', 'smtp')).toBe(
      'The test message to ann@example.com was handed to the mail server (<abc@example.com>). Check that inbox, and its spam folder.',
    );
    expect(testMailText({ ok: true }, 'ann@example.com', 'resend')).toBe('The test message to ann@example.com was handed to the mail server. Check that inbox, and its spam folder.');
    expect(testMailText({ ok: true }, 'ann@example.com', 'log')).toBe(
      'This instance sends no mail (MAIL_TRANSPORT=log): the server log notes a test message for ann@example.com instead.',
    );
  });
});
