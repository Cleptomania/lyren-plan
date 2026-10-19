// Link tokens (design §5.7, directory/emailTokens.ts): stored as sha256 only, inspected without being
// consumed, redeemed once, bound to their purpose (a link of one kind works at no other endpoint), to the
// account's auth_epoch and, for verification, to the address. The flows' own TTLs and replacements are
// in their files (signup, reset, emailChange, adminResetLink, recovery).

import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../../src/core/crypto';
import { findEmailToken, issueEmailToken, redeemEmailToken, TOKEN_TTL_MS } from '../../src/directory/emailTokens';
import { setSignupPolicy } from '../../src/directory/settings';
import { createDirectoryHarness, OWNER_EMAIL, PASSWORD } from '../support/directoryHarness';
import { linkToken } from '../support/mail';

const PUBLIC = { PUBLIC_URL: 'https://plan.example.com' };

describe('emailTokens', () => {
  it('stores the hash only; inspecting consumes nothing; redeeming works once; a stale epoch is refused (and consumed)', async () => {
    const h = createDirectoryHarness();
    const { user } = await h.setup();
    const now = h.clock.now();
    const { token, expiresAt } = issueEmailToken(h.db, {
      purpose: 'reset_password',
      user: { id: user.id, auth_epoch: 0 },
      email: { address: OWNER_EMAIL, key: OWNER_EMAIL },
      meta: null,
      nowMs: now,
    });
    expect(Date.parse(expiresAt) - now).toBe(TOKEN_TTL_MS.reset_password);
    const row = h.db.get<Record<string, unknown>>("SELECT * FROM email_tokens WHERE purpose = 'reset_password'")!;
    expect(row.token_hash).toBe(sha256Hex(token));
    expect(Object.values(row)).not.toContain(token);
    expect(findEmailToken(h.db, token, ['reset_password'], now)).not.toBeNull();
    expect(findEmailToken(h.db, token, ['verify_email'], now)).toBeNull();
    expect(redeemEmailToken(h.db, token, 'verify_email', now)).toBeNull();
    expect(redeemEmailToken(h.db, token, 'reset_password', now)).toMatchObject({ user_id: user.id });
    expect(redeemEmailToken(h.db, token, 'reset_password', now)).toBeNull();

    const second = issueEmailToken(h.db, {
      purpose: 'reset_password',
      user: { id: user.id, auth_epoch: 0 },
      email: { address: OWNER_EMAIL, key: OWNER_EMAIL },
      meta: null,
      nowMs: now,
    });
    h.db.run('UPDATE users SET auth_epoch = auth_epoch + 1');
    expect(findEmailToken(h.db, second.token, ['reset_password'], now)).toBeNull();
    expect(redeemEmailToken(h.db, second.token, 'reset_password', now)).toBeNull();
    expect(h.db.get<{ used_at: string | null }>('SELECT used_at FROM email_tokens WHERE token_hash = :hash', { hash: sha256Hex(second.token) })!.used_at).not.toBeNull();
  });
});

describe('a link works at its own endpoint only', () => {
  it('sign-up, verification, email change, reset and invitation tokens are refused everywhere else', async () => {
    const h = createDirectoryHarness({ vars: PUBLIC });
    const owner = await h.setup();
    h.db.run('UPDATE users SET email_verified_at = :now', { now: new Date(h.clock.now()).toISOString() });
    setSignupPolicy(h.db, 'open', true);
    await h.settle();
    const verify = linkToken(h.outbox.find((m) => m.template === 'verify_email'));
    await h.client({ ip: '198.51.100.1' }).post('/api/auth/signup', { email: 'new@example.com' });
    await h.client({ ip: '198.51.100.2' }).post('/api/auth/password/forgot', { email: OWNER_EMAIL });
    await owner.client.post('/api/account/email', { email: 'changed@example.com' });
    await owner.client.post(`/api/spaces/${owner.spaceId}/invitations`, { email: 'invited@example.com', role: 'member' });
    await h.settle();
    const of = (template: string) => linkToken(h.outbox.find((m) => m.template === template));
    const tokens = {
      signup: of('signup_verify'),
      reset: of('password_reset'),
      change: of('email_change_confirm'),
      invite: of('invitation'),
      verify,
    };
    const endpoints: Array<[string, keyof typeof tokens, Record<string, string>]> = [
      ['/api/auth/signup/inspect', 'signup', {}],
      ['/api/auth/signup/complete', 'signup', { displayName: 'X', password: PASSWORD }],
      ['/api/auth/password/reset/inspect', 'reset', {}],
      ['/api/auth/password/reset', 'reset', { password: PASSWORD }],
      ['/api/auth/email/confirm', 'verify', {}],
      ['/api/invitations/inspect', 'invite', {}],
    ];
    for (const [index, [path, own, extra]] of endpoints.entries()) {
      // A client per endpoint: 20 invalid tokens from one address are all tk:<ip> lets through.
      const visitor = h.client({ ip: `198.51.100.${10 + index}` });
      for (const [kind, token] of Object.entries(tokens)) {
        if (kind === own || (path === '/api/auth/email/confirm' && kind === 'change')) continue;
        const res = await visitor.post(path, { token, ...extra });
        expect([path, kind, res.body.error?.code]).toEqual([path, kind, 'invalid_token']);
      }
    }
    // Nothing was consumed by the wrong endpoints.
    expect(h.db.all('SELECT purpose FROM email_tokens WHERE used_at IS NOT NULL')).toEqual([]);
    expect(h.db.all('SELECT id FROM invitations WHERE accepted_at IS NOT NULL OR revoked_at IS NOT NULL')).toEqual([]);
  });

  it('a verification link is for the address it was sent to, and works for 24 hours', async () => {
    const h = createDirectoryHarness({ vars: PUBLIC });
    const { user } = await h.setup();
    await h.settle();
    const token = linkToken(h.outbox.find((m) => m.template === 'verify_email'));
    // The address replaced behind the epoch's back (defence in depth: the epoch alone would catch a real change).
    h.db.run("UPDATE users SET email = 'other@example.com', email_key = 'other@example.com' WHERE id = :id", { id: user.id });
    const owner = h.client();
    await owner.post('/api/auth/login', { identifier: 'other@example.com', password: PASSWORD });
    expect((await owner.post('/api/auth/email/confirm', { token })).body.error.code).toBe('invalid_token');
    expect(h.db.get<{ email_verified_at: string | null }>('SELECT email_verified_at FROM users')!.email_verified_at).toBeNull();

    h.db.run("UPDATE users SET email = 'owner@example.com', email_key = 'owner@example.com' WHERE id = :id", { id: user.id });
    const signedIn = h.client();
    await signedIn.post('/api/auth/login', { identifier: OWNER_EMAIL, password: PASSWORD });
    await signedIn.post('/api/account/email/verify');
    await h.settle();
    const fresh = linkToken(h.outbox.filter((m) => m.template === 'verify_email').at(-1));
    h.clock.advance(24 * 3600_000);
    expect((await signedIn.post('/api/auth/email/confirm', { token: fresh })).body.error.code).toBe('invalid_token');
  });
});
