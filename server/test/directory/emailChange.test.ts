// The account's email address (design §5.8.6, §5.8.10): verification links (setup's, and POST
// /api/account/email/verify), the change of address (POST /api/account/email: with mail a link to the new
// address, or email_change_taken; without mail at once), and POST /api/auth/email/confirm, whose
// links (verify_email and change_email) work only in a session of their account.

import { describe, expect, it } from 'vitest';
import type { AuthStatusDTO, MemberDTO } from '@shared/types';
import { createLogTransport } from '../../src/mail/log';
import { createDirectoryHarness, OWNER_EMAIL, PASSWORD } from '../support/directoryHarness';
import { linkToken } from '../support/mail';

const PUBLIC = { PUBLIC_URL: 'https://plan.example.com' };

type Harness = ReturnType<typeof createDirectoryHarness>;

/** The last link of `template` in the outbox, after the deferred mail. */
async function lastLink(h: Harness, template: string): Promise<string> {
  await h.settle();
  return linkToken(h.outbox.filter((m) => m.template === template).at(-1));
}

describe('verification (§5.8.6)', () => {
  it('setup mails a verification link; it verifies the address once, in a session of the account (on any device)', async () => {
    const h = createDirectoryHarness({ vars: PUBLIC });
    const { client } = await h.setup();
    expect((await client.get<AuthStatusDTO>('/api/auth/status')).body.user?.emailVerified).toBe(false);
    const token = await lastLink(h, 'verify_email');
    expect(h.outbox[0]!.text).toContain('https://plan.example.com/email/confirm#t=');
    // Signed out, and signed in as another account: refused, nothing consumed.
    const phone = h.client({ ip: '198.51.100.110' });
    expect(await phone.post('/api/auth/email/confirm', { token })).toMatchObject({
      status: 401,
      body: { error: { code: 'unauthorized', message: 'Sign in as Owner to confirm this address', details: [{ path: 'displayName', message: 'Owner' }] } },
    });
    const mallory = await h.addUser({ email: 'mallory@example.com', ip: '198.51.100.111' });
    expect(await mallory.client.post('/api/auth/email/confirm', { token })).toMatchObject({
      status: 403,
      body: { error: { code: 'forbidden', message: 'This link belongs to another account' } },
    });
    expect(h.db.all('SELECT id FROM email_tokens WHERE used_at IS NOT NULL')).toEqual([]);
    await phone.post('/api/auth/login', { identifier: OWNER_EMAIL, password: PASSWORD });
    expect(await phone.post('/api/auth/email/confirm', { token })).toMatchObject({
      status: 200,
      body: { ok: true, email: OWNER_EMAIL, purpose: 'verify_email' },
    });
    expect((await client.get<AuthStatusDTO>('/api/auth/status')).body.user?.emailVerified).toBe(true);
    expect(h.db.all("SELECT type FROM security_events WHERE type = 'email_verified'")).toHaveLength(1);
    expect((await phone.post('/api/auth/email/confirm', { token })).body.error.code).toBe('invalid_token');
  });

  it('an address attached without proof is not verified for the squatter when its owner follows the link', async () => {
    // Without mail an email change is made at once, unverified; mail is configured later.
    const quiet = createDirectoryHarness({ vars: PUBLIC, mail: createLogTransport({ logBodies: false }, () => {}) });
    await quiet.setup();
    const mallory = await quiet.addUser({ email: 'mallory@example.com' });
    expect((await mallory.client.post('/api/account/email', { email: 'victim@example.com' })).body).toMatchObject({ pending: false });
    const h = quiet.restart({ mail: undefined });
    const squatter = h.client();
    await squatter.post('/api/auth/login', { identifier: 'victim@example.com', password: PASSWORD });
    expect((await squatter.post('/api/account/email/verify')).status).toBe(202);
    const token = await lastLink(h, 'verify_email');
    // The owner of the address opens it, signed out or in their own account elsewhere: nothing happens.
    expect((await h.client({ ip: '198.51.100.120' }).post('/api/auth/email/confirm', { token })).body.error.message).toBe(
      'Sign in as mallory to confirm this address',
    );
    expect(h.db.get<{ email_verified_at: string | null }>("SELECT email_verified_at FROM users WHERE email = 'victim@example.com'")!.email_verified_at).toBeNull();
  });

  it('POST /api/account/email/verify sends a new link (the older one dies); 409 when verified already or without an address', async () => {
    const h = createDirectoryHarness({ vars: PUBLIC });
    const { client } = await h.setup();
    const first = await lastLink(h, 'verify_email');
    expect(await client.post('/api/account/email/verify')).toMatchObject({ status: 202, body: { ok: true } });
    const second = await lastLink(h, 'verify_email');
    expect((await client.post('/api/auth/email/confirm', { token: first })).body.error.code).toBe('invalid_token');
    expect((await client.post('/api/auth/email/confirm', { token: second })).status).toBe(200);
    expect(await client.post('/api/account/email/verify')).toMatchObject({ status: 409, body: { error: { code: 'conflict', message: 'Your email address is verified already' } } });
    h.db.run("UPDATE users SET email = NULL, email_key = NULL, email_verified_at = NULL, username = 'legacy'");
    expect((await client.post('/api/account/email/verify')).body.error.message).toBe('Your account has no email address. Add one first.');
  });

  it('needs a transport that delivers mail (409 mail_not_configured), and counts on mh', async () => {
    const quiet = createDirectoryHarness({ vars: PUBLIC, mail: createLogTransport({ logBodies: false }, () => {}) });
    const { client } = await quiet.setup();
    expect(quiet.db.all('SELECT id FROM email_tokens')).toEqual([]);
    expect(await client.post('/api/account/email/verify')).toMatchObject({ status: 409, body: { error: { code: 'mail_not_configured' } } });

    const h = createDirectoryHarness({ vars: PUBLIC });
    const owner = await h.setup();
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await owner.client.post('/api/account/email/verify')).status);
    expect(statuses).toEqual([202, 202, 202, 429]);
  });

  it('a verification link dies when the address changes (it confirms the current address only)', async () => {
    // Without mail the change is made at once; the link comes from the same directory with mail.
    const h = createDirectoryHarness({ vars: PUBLIC, mail: createLogTransport({ logBodies: false }, () => {}) });
    const { client } = await h.setup();
    const mailed = createDirectoryHarness({ vars: PUBLIC, db: h.db, clock: h.clock });
    const signedIn = mailed.client();
    await signedIn.post('/api/auth/login', { identifier: OWNER_EMAIL, password: PASSWORD });
    await signedIn.post('/api/account/email/verify');
    const token = await lastLink(mailed, 'verify_email');
    expect((await client.post('/api/account/email', { email: 'renamed@example.com' })).body.pending).toBe(false);
    expect((await client.post('/api/auth/email/confirm', { token })).body.error.code).toBe('invalid_token');
    expect(h.db.get<{ email_verified_at: string | null }>('SELECT email_verified_at FROM users')!.email_verified_at).toBeNull();
  });
});

describe('POST /api/account/email with mail (§5.8.10)', () => {
  async function instance() {
    const h = createDirectoryHarness({ vars: PUBLIC });
    const owner = await h.setup();
    h.db.run('UPDATE users SET email_verified_at = :now', { now: new Date(h.clock.now()).toISOString() });
    await h.settle();
    h.outbox.length = 0;
    return { h, owner };
  }

  it('needs the re-auth window; the same address is a validation error', async () => {
    const { h, owner } = await instance();
    expect((await owner.client.post('/api/account/email', { email: 'Owner@example.com' })).body.error).toMatchObject({
      code: 'validation_error',
      details: [{ path: 'email', message: 'This is your email address already' }],
    });
    h.clock.advance(11 * 60_000);
    expect((await owner.client.post('/api/account/email', { email: 'new@example.com' })).body.error.code).toBe('reauth_required');
  });

  it('a free address: 202 pending, a 1-hour link to it, confirmed in the account’s session: verified, epoch + 1, notice to the old address', async () => {
    const { h, owner } = await instance();
    const bob = await h.addUser({ email: 'bob@example.com', spaceId: owner.spaceId, role: 'member' });
    const res = await owner.client.post('/api/account/email', { email: 'Owner.New@Example.com' });
    expect(res).toMatchObject({ status: 202, body: { ok: true, pending: true } });
    expect(h.db.all("SELECT type FROM security_events WHERE type = 'email_change_requested'")).toHaveLength(1);
    const token = await lastLink(h, 'email_change_confirm');
    const message = h.outbox.find((m) => m.template === 'email_change_confirm')!;
    expect(message.to).toBe('Owner.New@example.com');
    // It names the account that asked.
    expect(message.text).toContain('the account Owner (owner@example.com)');
    const row = h.db.get<{ expires_at: string; email_key: string }>("SELECT * FROM email_tokens WHERE purpose = 'change_email'")!;
    expect(Date.parse(row.expires_at) - h.clock.now()).toBe(3600_000);
    expect(row.email_key).toBe('owner.new@example.com');
    // Nothing changed yet.
    expect((await owner.client.get('/api/account')).body.email).toBe(OWNER_EMAIL);

    const before = h.db.get<{ sync_version: number }>('SELECT sync_version FROM spaces')!.sync_version;
    h.outbox.length = 0;
    const confirmed = await owner.client.post('/api/auth/email/confirm', { token });
    expect(confirmed).toMatchObject({ status: 200, body: { ok: true, email: 'Owner.New@example.com', purpose: 'change_email' } });
    const account = h.db.get<{ email: string; email_key: string; email_verified_at: string | null; auth_epoch: number }>('SELECT * FROM users WHERE id = :id', {
      id: owner.user.id,
    })!;
    expect(account).toMatchObject({ email: 'Owner.New@example.com', email_key: 'owner.new@example.com', auth_epoch: 1 });
    expect(account.email_verified_at).not.toBeNull();
    expect(h.db.get<{ sync_version: number }>('SELECT sync_version FROM spaces')!.sync_version).toBe(before + 1);
    expect((await bob.client.get<MemberDTO[]>(`/api/spaces/${owner.spaceId}/members`)).body.find((m) => m.isYou === false)?.email).toBe(
      'Owner.New@example.com',
    );
    await h.settle();
    expect(h.outbox.map((m) => [m.template, m.to])).toEqual([['email_changed_notice', OWNER_EMAIL]]);
    expect(h.spaces.ids('invalidate')).toContain(owner.spaceId);
    // Sign in with the new address.
    expect((await h.client().post('/api/auth/login', { identifier: 'owner.new@example.com', password: PASSWORD })).status).toBe(200);
  });

  it('a taken address: the same 202, then email_change_taken to it and no token', async () => {
    const { h, owner } = await instance();
    await h.addUser({ email: 'taken@example.com' });
    h.outbox.length = 0;
    const res = await owner.client.post('/api/account/email', { email: 'TAKEN@example.com' });
    expect(res).toMatchObject({ status: 202, body: { ok: true, pending: true } });
    await h.settle();
    expect(h.outbox.map((m) => [m.template, m.to])).toEqual([['email_change_taken', 'TAKEN@example.com']]);
    expect(h.outbox[0]!.text).not.toContain('#t=');
    expect(h.db.all("SELECT id FROM email_tokens WHERE purpose = 'change_email'")).toEqual([]);
  });

  it('the link is bound to the account that asked: signed out 401 (nothing consumed), another account 403, then the owner confirms', async () => {
    const { h, owner } = await instance();
    const mallory = await h.addUser({ email: 'mallory@example.com', displayName: 'Mallory' });
    await owner.client.post('/api/account/email', { email: 'owner2@example.com' });
    const token = await lastLink(h, 'email_change_confirm');
    expect(await h.client().post('/api/auth/email/confirm', { token })).toMatchObject({
      status: 401,
      body: { error: { code: 'unauthorized', message: 'Sign in as Owner to confirm this address', details: [{ path: 'displayName', message: 'Owner' }] } },
    });
    expect(await mallory.client.post('/api/auth/email/confirm', { token })).toMatchObject({
      status: 403,
      body: { error: { code: 'forbidden', message: 'This link belongs to another account' } },
    });
    expect(h.db.get<{ used_at: string | null }>("SELECT used_at FROM email_tokens WHERE purpose = 'change_email'")!.used_at).toBeNull();
    // Another session of the owner's (signed in after opening the link) confirms it.
    const later = h.client({ ip: '198.51.100.120' });
    await later.post('/api/auth/login', { identifier: OWNER_EMAIL, password: PASSWORD });
    expect((await later.post('/api/auth/email/confirm', { token })).status).toBe(200);
    expect((await mallory.client.get('/api/account')).body.email).toBe('mallory@example.com');
  });

  it('an address taken between the request and the confirmation: 409, and the link is left as it was', async () => {
    const { h, owner } = await instance();
    await owner.client.post('/api/account/email', { email: 'race@example.com' });
    const token = await lastLink(h, 'email_change_confirm');
    await h.addUser({ email: 'race@example.com' });
    expect(await owner.client.post('/api/auth/email/confirm', { token })).toMatchObject({
      status: 409,
      body: { error: { code: 'conflict', message: 'That email address is used by another account' } },
    });
    expect(h.db.get<{ used_at: string | null }>("SELECT used_at FROM email_tokens WHERE purpose = 'change_email'")!.used_at).toBeNull();
  });

  it('a link works for an hour and dies with a password change (epoch); an unverified old address gets no notice', async () => {
    const { h, owner } = await instance();
    h.db.run('UPDATE users SET email_verified_at = NULL');
    await owner.client.post('/api/account/email', { email: 'later@example.com' });
    const token = await lastLink(h, 'email_change_confirm');
    h.clock.advance(3600_000);
    expect((await owner.client.post('/api/auth/email/confirm', { token })).body.error.code).toBe('invalid_token');
    h.clock.advance(3600_000);
    await owner.client.post('/api/account/reauth/password', { password: PASSWORD });
    await owner.client.post('/api/account/email', { email: 'later@example.com' });
    const second = await lastLink(h, 'email_change_confirm');
    await owner.client.post('/api/account/password', { currentPassword: PASSWORD, newPassword: 'a newer password here' });
    expect((await owner.client.post('/api/auth/email/confirm', { token: second })).body.error.code).toBe('invalid_token');
    h.clock.advance(3600_000);
    await owner.client.post('/api/account/reauth/password', { password: 'a newer password here' });
    await owner.client.post('/api/account/email', { email: 'later@example.com' });
    const third = await lastLink(h, 'email_change_confirm');
    h.outbox.length = 0;
    expect((await owner.client.post('/api/auth/email/confirm', { token: third })).status).toBe(200);
    await h.settle();
    expect(h.outbox).toEqual([]);
  });

  it('limits mh and md on the new address', async () => {
    const { owner } = await instance();
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await owner.client.post('/api/account/email', { email: 'flood@example.com' })).status);
    expect(statuses).toEqual([202, 202, 202, 429]);
  });
});

describe('POST /api/account/email without mail (§5.8.10 step 3)', () => {
  it('a free address is the account’s at once, unverified; a taken one is said so (409); a legacy account adds one', async () => {
    const h = createDirectoryHarness({ vars: PUBLIC, mail: createLogTransport({ logBodies: false }, () => {}) });
    const { client, spaceId } = await h.setup();
    await h.addUser({ email: 'taken@example.com' });
    expect(await client.post('/api/account/email', { email: 'taken@example.com' })).toMatchObject({
      status: 409,
      body: { error: { code: 'conflict', message: 'That email address is used by another account' } },
    });
    const before = h.db.get<{ sync_version: number }>('SELECT sync_version FROM spaces WHERE public_id = :spaceId', { spaceId })!.sync_version;
    expect(await client.post('/api/account/email', { email: 'Fresh@example.com' })).toMatchObject({
      status: 200,
      body: { ok: true, pending: false, email: 'Fresh@example.com' },
    });
    const account = h.db.get<{ email: string; email_verified_at: string | null; auth_epoch: number }>("SELECT * FROM users WHERE email_key = 'fresh@example.com'")!;
    expect(account).toMatchObject({ email: 'Fresh@example.com', email_verified_at: null, auth_epoch: 1 });
    expect(h.db.get<{ sync_version: number }>('SELECT sync_version FROM spaces WHERE public_id = :spaceId', { spaceId })!.sync_version).toBe(before + 1);
    expect(h.db.all('SELECT id FROM email_tokens')).toEqual([]);

    // An account from before email addresses.
    h.db.run("UPDATE users SET email = NULL, email_key = NULL, username = 'legacy' WHERE email_key = 'fresh@example.com'");
    expect((await client.post('/api/account/email', { email: 'legacy@example.com' })).body).toEqual({ ok: true, pending: false, email: 'legacy@example.com' });
    expect((await h.client().post('/api/auth/login', { identifier: 'legacy@example.com', password: PASSWORD })).status).toBe(200);
    expect((await h.client().post('/api/auth/login', { identifier: 'legacy', password: PASSWORD })).status).toBe(200);
  });
});
