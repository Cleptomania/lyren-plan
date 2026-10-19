// What Administration → Users shows of an account and offers to do with it (design §5.8.11, §5.8.18).
import { describe, expect, it } from 'vitest';
import type { AdminUserDTO } from '@shared/types';
import { cannotSignInHere, deleteConfirmation, resetLinkNote, resetLinkResult, signInMethodsText, userActions, userBadges, userIdentifier } from './users';

const user = (o: Partial<AdminUserDTO> = {}): AdminUserDTO => ({
  id: 2,
  email: 'bob@example.com',
  username: null,
  displayName: 'Bob',
  emailVerified: true,
  isInstanceAdmin: false,
  status: 'active',
  hasPassword: true,
  passkeys: 0,
  usablePasskeys: 0,
  spaces: 1,
  createdAt: '2026-10-01T10:00:00.000Z',
  lastLoginAt: null,
  ...o,
});

describe('userBadges', () => {
  it('you, administrator, disabled, and an unverified address where mail makes it matter', () => {
    const labels = (u: AdminUserDTO, mail = true, meId = 1) => userBadges(u, { meId, mail }).map((b) => b.label);
    expect(labels(user())).toEqual([]);
    expect(labels(user({ id: 1, isInstanceAdmin: true }))).toEqual(['You', 'Administrator']);
    expect(labels(user({ status: 'disabled', emailVerified: false }))).toEqual(['Disabled', 'Unverified']);
    expect(labels(user({ emailVerified: false }), false)).toEqual([]);
    expect(labels(user({ email: null, username: 'old', emailVerified: false }))).toEqual([]);
    expect(userBadges(user({ status: 'disabled' }), { meId: 1, mail: true })[0]!.variant).toBe('danger');
  });

  it('an active account whose only way in is passkeys that do not work here (§5.6’s warning)', () => {
    const labels = (u: AdminUserDTO) => userBadges(u, { meId: 1, mail: true }).map((b) => b.label);
    expect(labels(user({ hasPassword: false, passkeys: 2, usablePasskeys: 0 }))).toEqual(['Can’t sign in here']);
    expect(labels(user({ hasPassword: false, passkeys: 2, usablePasskeys: 1 }))).toEqual([]);
    expect(labels(user({ hasPassword: true, passkeys: 2, usablePasskeys: 0 }))).toEqual([]);
    expect(labels(user({ hasPassword: false, passkeys: 0, usablePasskeys: 0 }))).toEqual([]);
    expect(labels(user({ hasPassword: false, passkeys: 1, usablePasskeys: 0, status: 'disabled' }))).toEqual(['Disabled']);
    expect(cannotSignInHere(user({ hasPassword: false, passkeys: 1, usablePasskeys: 0 }))).toBe(true);
  });
});

describe('userActions', () => {
  it('nothing on one’s own account but a look; no reset link for an administrator', () => {
    expect(userActions(user(), 1)).toEqual({ status: 'disable', admin: 'promote', resetLink: true, delete: true });
    expect(userActions(user({ status: 'disabled', isInstanceAdmin: true }), 1)).toEqual({ status: 'enable', admin: 'demote', resetLink: false, delete: true });
    expect(userActions(user({ id: 1, isInstanceAdmin: true }), 1)).toEqual({ status: null, admin: null, resetLink: false, delete: false });
    expect(resetLinkNote(user())).toBeNull();
    expect(resetLinkNote(user({ isInstanceAdmin: true }))).toContain('recovery token');
  });
});

describe('texts', () => {
  it('the identifier and the typed confirmation of a deletion', () => {
    expect(userIdentifier(user())).toBe('bob@example.com');
    expect(userIdentifier(user({ email: null, username: 'bob' }))).toBe('Username bob');
    expect(deleteConfirmation(user())).toBe('bob@example.com');
    expect(deleteConfirmation(user({ email: null, username: 'bob' }))).toBe('bob');
  });

  it('a reset link: sent by mail (no copy for the admin), or handed over until it expires', () => {
    expect(resetLinkResult({ sent: true }, user())).toBe('A link to choose a new password was sent to bob@example.com. You don’t get a copy of it.');
    const handed = resetLinkResult({ sent: false, link: 'https://plan.example.com/reset#t=abc', expiresAt: '2026-10-19T12:00:00.000Z' }, user());
    expect(handed).toMatch(/^This link lets Bob choose a new password once, until .+2026.+\. Give it to them yourself/);
    expect(handed).toContain('whoever has it can sign in as them');
  });
});

describe('signInMethodsText', () => {
  it('names the password and counts the passkeys', () => {
    expect(signInMethodsText(user())).toBe('A password');
    expect(signInMethodsText(user({ passkeys: 1, usablePasskeys: 1 }))).toBe('A password and 1 passkey');
    expect(signInMethodsText(user({ hasPassword: false, passkeys: 2, usablePasskeys: 2 }))).toBe('2 passkeys, no password');
    // Those of another address (a domain move, §5.6).
    expect(signInMethodsText(user({ hasPassword: false, passkeys: 1 }))).toBe('1 passkey that doesn’t work on this address, no password');
    expect(signInMethodsText(user({ passkeys: 2 }))).toBe('A password and 2 passkeys that don’t work on this address');
    expect(signInMethodsText(user({ hasPassword: false, passkeys: 3, usablePasskeys: 2 }))).toBe('3 passkeys (1 doesn’t work on this address), no password');
    expect(signInMethodsText(user({ hasPassword: false }))).toBe('No password');
  });
});
