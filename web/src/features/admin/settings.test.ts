// Administration → Settings (design §5.3, §5.5): the policy's choices, the mail requirement of `open`, the
// password minimum and the change sent.
import { describe, expect, it } from 'vitest';
import { SIGNUP_POLICIES } from '@shared/constants';
import { adminSettingsInput } from '@shared/schemas';
import { parsePasswordMinimum, POLICY_CHOICES, policyUnavailable, settingsChange } from './settings';

describe('the signup policy', () => {
  it('explains every policy, in the order of the constants', () => {
    expect(POLICY_CHOICES.map((c) => c.value)).toEqual([...SIGNUP_POLICIES]);
    for (const c of POLICY_CHOICES) expect(c.description.length).toBeGreaterThan(40);
    expect(POLICY_CHOICES.find((c) => c.value === 'closed')!.description).toContain('administrator');
  });

  it('open needs mail; the others never', () => {
    expect(policyUnavailable('open', false)).toContain('MAIL_TRANSPORT');
    expect(policyUnavailable('open', true)).toBeNull();
    expect(policyUnavailable('invite_only', false)).toBeNull();
    expect(policyUnavailable('closed', false)).toBeNull();
  });
});

describe('the password minimum', () => {
  it('a whole number from 8 to 64, as the server accepts', () => {
    expect(parsePasswordMinimum('12')).toEqual({ value: 12 });
    expect(parsePasswordMinimum(' 8 ')).toEqual({ value: 8 });
    expect(parsePasswordMinimum('64')).toEqual({ value: 64 });
    for (const text of ['7', '65', '', 'ten', '12.5', '-9', '1e1']) {
      expect(parsePasswordMinimum(text), text).toEqual({ error: 'Enter a number from 8 to 64' });
    }
    for (const n of [8, 64]) expect(adminSettingsInput.safeParse({ passwordMinLength: n }).success).toBe(true);
    for (const n of [7, 65]) expect(adminSettingsInput.safeParse({ passwordMinLength: n }).success).toBe(false);
  });
});

describe('settingsChange', () => {
  it('sends only what changed, or nothing', () => {
    const current = { signupPolicy: 'invite_only' as const, passwordMinLength: 8 };
    expect(settingsChange(current, current)).toBeNull();
    expect(settingsChange(current, { ...current, signupPolicy: 'closed' })).toEqual({ signupPolicy: 'closed' });
    expect(settingsChange(current, { signupPolicy: 'open', passwordMinLength: 12 })).toEqual({ signupPolicy: 'open', passwordMinLength: 12 });
  });
});
