// The account, space and settings inputs of the multi-user design (§7.4).

import { describe, expect, it } from 'vitest';
import {
  accountDeleteInput,
  changePasswordInput,
  dashboardQueryInput,
  DEFAULT_PREFERENCES,
  DEFAULT_SETTINGS,
  DEFAULT_SPACE_SETTINGS,
  loginInput,
  memberRoleInput,
  preferencesUpdateInput,
  settingsSchema,
  setupInput,
  spaceCreateInput,
  spaceDeleteInput,
  spaceSettingsSchema,
  spaceSettingsUpdateInput,
  transferInput,
  userPreferencesSchema,
  worklogReportQuery,
} from './schemas';

const paths = (result: { success: boolean; error?: { issues: Array<{ path: PropertyKey[] }> } }) =>
  result.error?.issues.map((i) => i.path.join('.'));

describe('setupInput', () => {
  it('takes an email address, normalized, instead of a username', () => {
    const input = { email: ' Owner@Example.COM', password: 'correct horse battery', displayName: 'Owner' };
    expect(setupInput.parse(input)).toEqual({
      email: { address: 'Owner@example.com', key: 'owner@example.com' },
      password: 'correct horse battery',
      displayName: 'Owner',
    });
    expect(paths(setupInput.safeParse({ ...input, email: 'owner' }))).toEqual(['email']);
    expect(paths(setupInput.safeParse({ username: 'owner', password: 'correct horse battery', displayName: 'Owner' }))).toEqual([
      'email',
    ]);
  });
});

describe('loginInput', () => {
  it('parses an identifier, or the legacy username field, to { identifier, password }', () => {
    expect(loginInput.parse({ identifier: ' ann@example.com ', password: 'pw' })).toEqual({ identifier: 'ann@example.com', password: 'pw' });
    expect(loginInput.parse({ username: 'owner', password: 'pw' })).toEqual({ identifier: 'owner', password: 'pw' });
    expect(loginInput.parse({ identifier: 'ann', username: 'owner', password: 'pw' })).toEqual({ identifier: 'ann', password: 'pw' });
  });

  it('requires one of them, and a password', () => {
    expect(paths(loginInput.safeParse({ password: 'pw' }))).toEqual(['identifier']);
    expect(paths(loginInput.safeParse({ identifier: '   ', password: 'pw' }))).toEqual(['identifier']);
    expect(paths(loginInput.safeParse({ identifier: 'ann', password: '' }))).toEqual(['password']);
    expect(loginInput.safeParse({ identifier: 'a'.repeat(321), password: 'pw' }).success).toBe(false);
  });
});

describe('account inputs', () => {
  it('changePasswordInput: currentPassword is optional (accounts without a password use re-auth)', () => {
    expect(changePasswordInput.parse({ newPassword: 'a new password' })).toEqual({ newPassword: 'a new password' });
    expect(changePasswordInput.safeParse({ currentPassword: '', newPassword: 'a new password' }).success).toBe(false);
    expect(paths(changePasswordInput.safeParse({ newPassword: 'short' }))).toEqual(['newPassword']);
  });

  it('accountDeleteInput: confirm is trimmed and required', () => {
    expect(accountDeleteInput.parse({ confirm: ' ann@example.com ' })).toEqual({ confirm: 'ann@example.com' });
    expect(accountDeleteInput.safeParse({ confirm: ' ' }).success).toBe(false);
  });
});

describe('space inputs', () => {
  it('spaceCreateInput: a trimmed name of 1-80 characters, forImport accepted', () => {
    expect(spaceCreateInput.parse({ name: '  Team  ', forImport: true })).toEqual({ name: 'Team', forImport: true });
    expect(spaceCreateInput.safeParse({ name: 'x'.repeat(80) }).success).toBe(true);
    expect(spaceCreateInput.safeParse({ name: 'x'.repeat(81) }).success).toBe(false);
    expect(paths(spaceCreateInput.safeParse({ name: '  ' }))).toEqual(['name']);
  });

  it('spaceDeleteInput, memberRoleInput and transferInput', () => {
    expect(spaceDeleteInput.parse({ confirmName: ' Team ' })).toEqual({ confirmName: 'Team' });
    expect(memberRoleInput.parse({ role: 'owner' })).toEqual({ role: 'owner' });
    expect(memberRoleInput.safeParse({ role: 'superuser' }).success).toBe(false);
    expect(transferInput.parse({ userId: 7, demoteSelfTo: 'member' })).toEqual({ userId: 7, demoteSelfTo: 'member' });
    expect(transferInput.safeParse({ userId: 7, demoteSelfTo: 'owner' }).success).toBe(false);
    expect(transferInput.safeParse({ userId: 0 }).success).toBe(false);
  });
});

describe('settings split', () => {
  it('Settings is SpaceSettings plus UserPreferences, with the same defaults as before', () => {
    expect(DEFAULT_SETTINGS).toEqual({ weekStartsOn: 1, estimateUnit: 'points', defaultBoardId: null, homePage: 'dashboard' });
    expect({ ...DEFAULT_SPACE_SETTINGS, ...DEFAULT_PREFERENCES }).toEqual(DEFAULT_SETTINGS);
    expect(Object.keys(settingsSchema.shape).sort()).toEqual(
      [...Object.keys(spaceSettingsSchema.shape), ...Object.keys(userPreferencesSchema.shape)].sort(),
    );
  });

  it('the update inputs take only their own keys (others are stripped)', () => {
    expect(spaceSettingsUpdateInput.parse({ estimateUnit: 'hours', weekStartsOn: 0 })).toEqual({ estimateUnit: 'hours' });
    expect(preferencesUpdateInput.parse({ homePage: 'default_board', defaultBoardId: 3 })).toEqual({ homePage: 'default_board' });
    expect(preferencesUpdateInput.safeParse({ weekStartsOn: 3 }).success).toBe(false);
  });
});

describe('query inputs', () => {
  it('dashboardQueryInput takes weekStartsOn from the query string', () => {
    expect(dashboardQueryInput.parse({ weekStartsOn: '0' })).toEqual({ weekStartsOn: 0 });
    expect(dashboardQueryInput.parse({ today: '2026-10-17', weekStartsOn: '1' })).toEqual({ today: '2026-10-17', weekStartsOn: 1 });
    expect(dashboardQueryInput.parse({})).toEqual({});
    for (const bad of ['', '2', 'monday']) expect(dashboardQueryInput.safeParse({ weekStartsOn: bad }).success, bad).toBe(false);
  });

  it('worklogReportQuery takes an optional userId', () => {
    expect(worklogReportQuery.parse({ userId: '4' })).toEqual({ userId: 4 });
    expect(worklogReportQuery.safeParse({ userId: '0' }).success).toBe(false);
  });
});
