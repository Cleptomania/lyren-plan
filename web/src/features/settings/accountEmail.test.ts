// Account settings → Profile's email address (design §5.1, §5.8.6, §5.8.10).
import { describe, expect, it } from 'vitest';
import { emailChangeText, emailDescription, emailState } from './accountEmail';

describe('emailState', () => {
  it('verified means something only on an instance that mails', () => {
    expect(emailState({ email: null, emailVerified: false }, true)).toBe('none');
    expect(emailState({ email: 'a@example.com', emailVerified: true }, true)).toBe('verified');
    expect(emailState({ email: 'a@example.com', emailVerified: false }, true)).toBe('unverified');
    expect(emailState({ email: 'a@example.com', emailVerified: false }, false)).toBe('unverifiable');
  });

  it('the account from before email addresses is told why to add one', () => {
    expect(emailDescription('none')).toMatch(/^Your account signs in with its username\. Add an email address/);
    expect(emailDescription('unverifiable')).toMatch(/sends no email/);
  });
});

describe('emailChangeText', () => {
  it('with mail: the link goes to the new address, which takes over only once confirmed in this account', () => {
    expect(emailChangeText({ ok: true, pending: true }, 'new@example.com', { email: 'old@example.com', username: null })).toBe(
      'We sent a confirmation link to new@example.com. Open it within an hour, in a browser where you are signed in to this account. ' +
        'Until then you keep signing in with old@example.com.',
    );
    expect(emailChangeText({ ok: true, pending: true }, 'new@example.com', { email: null, username: 'bob' })).toMatch(/keep signing in with your username\.$/);
  });

  it('without mail: changed at once', () => {
    expect(emailChangeText({ ok: true, pending: false, email: 'new@example.com' }, 'new@example.com', { email: 'old@example.com', username: null })).toBe(
      'Your email address is now new@example.com.',
    );
  });
});
