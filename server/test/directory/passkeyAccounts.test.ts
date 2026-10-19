// Accounts and passkeys (design §5.6, §5.8.5 step 6, §5.8.8, §5.8.9 step 4, §5.8.12): removing the password
// (a usable passkey and a way back in, with the reasons of each runtime), creating an account with a passkey
// instead of a password from a sign-up link or an invitation, setting up a passkey with a reset link, and
// domain moves (passkeys registered for another RP ID: shown, not counted, warned about).

import { describe, expect, it } from 'vitest';
import type {
  AdminOverviewDTO,
  AdminUserDTO,
  AuthStatusDTO,
  CeremonyDTO,
  InvitationCreatedDTO,
  Page,
  PasskeyDTO,
  PasswordResetPreviewDTO,
} from '@shared/types';
import { randomToken } from '../../src/core/crypto';
import { listAdminUsers } from '../../src/directory/admin';
import { POLICIES } from '../../src/directory/throttle';
import { orphanedAccounts } from '../../src/passkeys/credentials';
import { createLogTransport } from '../../src/mail/log';
import { SoftAuthenticator } from '../support/authenticator';
import { createDirectoryHarness, OWNER_EMAIL, PASSWORD, type DirectoryTestClient } from '../support/directoryHarness';
import { linkToken, tokenOfLink } from '../support/mail';

const ORIGIN = 'https://plan.example.com';
const PUBLIC = { PUBLIC_URL: ORIGIN };
const MINUTE = 60_000;

type Harness = ReturnType<typeof createDirectoryHarness>;

async function instance(o: Parameters<typeof createDirectoryHarness>[0] = {}, verified = true) {
  const h = createDirectoryHarness({ vars: PUBLIC, ...o });
  const owner = await h.setup();
  if (verified) h.db.run('UPDATE users SET email_verified_at = :now', { now: new Date(h.clock.now()).toISOString() });
  await h.settle();
  h.outbox.length = 0;
  return { h, owner };
}

const mailless = () => createLogTransport({ logBodies: false }, () => {});

async function addPasskey(client: DirectoryTestClient, origin = ORIGIN) {
  const options = await client.post<CeremonyDTO<any>>('/api/account/passkeys/options');
  expect(options.status, JSON.stringify(options.body)).toBe(200);
  const auth = await SoftAuthenticator.create({ origin });
  const res = await send(client, '/api/account/passkeys', options.body, await auth.register(options.body.options));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { auth, passkey: res.body };
}

async function signInWith(h: Harness, auth: SoftAuthenticator, client = h.client()) {
  const { body } = await client.post<CeremonyDTO<any>>('/api/auth/passkey/login/options', {});
  return client.post('/api/auth/passkey/login', { ceremonyId: body.ceremonyId, response: await auth.assert(body.options) });
}

const events = (h: Harness, type: string) =>
  h.db.all<{ user_id: number | null; data: string }>('SELECT user_id, data FROM security_events WHERE type = :type ORDER BY id', { type }).map((e) => ({
    userId: e.user_id,
    data: JSON.parse(e.data) as Record<string, unknown>,
  }));

const lastCredential = (message: string) => ({ status: 409, body: { error: { code: 'last_credential', message } } });

/** POST `path` with the ceremony of an options call and the browser's answer (and more fields). */
const send = (client: DirectoryTestClient, path: string, ceremony: CeremonyDTO, response: unknown, extra: Record<string, unknown> = {}) =>
  client.post(path, { ceremonyId: ceremony.ceremonyId, response, ...extra });

describe('DELETE /api/account/password (§5.8.12)', () => {
  it('needs a passkey that works here: none, or only orphaned ones, is 409 last_credential', async () => {
    const { h, owner } = await instance();
    const needsPasskey = lastCredential('Add a passkey that works on this address before you remove your password.');
    expect(await owner.client.delete('/api/account/password')).toMatchObject(needsPasskey);
    const { passkey } = await addPasskey(owner.client);
    h.db.run("UPDATE passkeys SET rp_id = 'old.example.com' WHERE id = :id", { id: passkey.id });
    expect(await owner.client.delete('/api/account/password')).toMatchObject(needsPasskey);
  });

  it('on Node (the reset-password command is a way back in): removed, the epoch bumped, the event recorded', async () => {
    const { h, owner } = await instance({ mail: mailless() });
    const { auth } = await addPasskey(owner.client);
    const epoch = h.db.get<{ auth_epoch: number }>('SELECT auth_epoch FROM users')!.auth_epoch;
    h.clock.advance(11 * MINUTE);
    // The rules pass, then the re-auth window is asked for.
    expect((await owner.client.delete('/api/account/password')).body.error.code).toBe('reauth_required');
    const options = await owner.client.post<CeremonyDTO<any>>('/api/account/reauth/passkey/options');
    expect((await send(owner.client, '/api/account/reauth/passkey', options.body, await auth.assert(options.body.options))).status).toBe(200);
    expect(await owner.client.delete('/api/account/password')).toMatchObject({ status: 200, body: { ok: true } });
    const row = h.db.get('SELECT password_hash, password_changed_at, auth_epoch FROM users');
    expect(row).toEqual({ password_hash: null, password_changed_at: null, auth_epoch: epoch + 1 });
    expect(events(h, 'password_removed')).toEqual([{ userId: owner.user.id, data: {} }]);
    expect((await owner.client.get('/api/account')).body).toMatchObject({ hasPassword: false, passkeyCount: 1 });
    expect((await h.client().post('/api/auth/login', { identifier: OWNER_EMAIL, password: PASSWORD })).status).toBe(401);
    expect((await signInWith(h, auth)).status).toBe(200);
    const none = { status: 409, body: { error: { code: 'conflict', message: 'This account has no password.' } } };
    expect(await owner.client.delete('/api/account/password')).toMatchObject(none);
    // A first password needs the re-auth window again (§5.8.12), and brings the account back.
    expect((await owner.client.post('/api/account/password', { newPassword: 'a brand new password' })).status).toBe(200);
  });

  it('on Cloudflare: a verified address with mail, or an admin who may make a reset link; otherwise the reason', async () => {
    // Mail, but the only admin's address is not verified yet; verified, it may go.
    const mail = await instance({ runtime: 'cloudflare' }, false);
    await addPasskey(mail.owner.client);
    expect(await mail.owner.client.delete('/api/account/password')).toMatchObject(
      lastCredential('Your account needs a verified email address first: a reset link by mail is how you would get back in if you lost your passkeys.'),
    );
    mail.h.db.run('UPDATE users SET email_verified_at = :now', { now: new Date(mail.h.clock.now()).toISOString() });
    expect((await mail.owner.client.delete('/api/account/password')).status).toBe(200);

    // No mail: the only admin keeps a password, as does any admin (admins make no reset links for each other).
    const { h, owner } = await instance({ runtime: 'cloudflare', mail: mailless() });
    await addPasskey(owner.client);
    expect(await owner.client.delete('/api/account/password')).toMatchObject(
      lastCredential('You are the only administrator and this instance cannot send mail: keep your password'),
    );
    const admin = await h.addUser({ email: 'admin@example.com', isInstanceAdmin: true });
    expect(await owner.client.delete('/api/account/password')).toMatchObject(
      lastCredential('This instance cannot send mail, and administrators cannot create reset links for each other: keep your password'),
    );
    // A member: an active admin can make it a reset link, so it may.
    const member = await h.addUser({ email: 'member@example.com', spaceId: owner.spaceId });
    await addPasskey(member.client);
    expect((await member.client.delete('/api/account/password')).status).toBe(200);
    // One demoted lately is out of the admins' reach (§5.8.11, Appendix D 56).
    const demoted = await h.addUser({ email: 'demoted@example.com' });
    await addPasskey(demoted.client);
    h.db.run(
      `INSERT INTO security_events (user_id, actor_id, type, data, created_at) VALUES (:id, :actor, 'admin_revoked', '{}', :now)`,
      { id: demoted.user.id, actor: admin.user.id, now: new Date(h.clock.now()).toISOString() },
    );
    expect(await demoted.client.delete('/api/account/password')).toMatchObject(
      lastCredential('This instance cannot send mail, and no administrator can create a reset link for your account: keep your password'),
    );
  });
});

describe('sign-up with a passkey (§5.8.5 step 6)', () => {
  async function signupLink(h: Harness, email = 'newcomer@example.com') {
    expect((await h.client().post('/api/auth/signup', { email })).status).toBe(202);
    await h.settle();
    return linkToken(h.outbox.filter((m) => m.template === 'signup_verify' && m.to === email).at(-1));
  }
  const open = { config: { seed: { signupPolicy: 'open' as const, passwordMinLength: 8 } } };

  it('creates the account with the passkey and no password, its address verified; the passkey then signs in', async () => {
    const { h } = await instance(open);
    const token = await signupLink(h);
    const browser = h.client();
    const options = await browser.post<CeremonyDTO<any>>('/api/auth/signup/passkey/options', { token, displayName: 'Newcomer' });
    expect(options.status, JSON.stringify(options.body)).toBe(200);
    expect(options.body.options).toMatchObject({
      rp: { id: 'plan.example.com' },
      user: { name: 'newcomer@example.com', displayName: 'Newcomer' },
      excludeCredentials: [],
    });
    // The link is inspected, not used up; the ceremony is bound to it and carries the account's handle.
    expect((await h.client().post('/api/auth/signup/inspect', { token })).status).toBe(200);
    const row = h.db.get<{ purpose: string; pending_user_handle: string }>('SELECT purpose, pending_user_handle FROM webauthn_challenges')!;
    expect(row).toMatchObject({ purpose: 'signup', pending_user_handle: options.body.options.user.id });
    const auth = await SoftAuthenticator.create({ origin: ORIGIN });
    const res = await browser.post('/api/auth/signup/passkey/complete', {
      token,
      ceremonyId: options.body.ceremonyId,
      response: await auth.register(options.body.options),
      displayName: 'Newcomer',
      passkeyName: 'My phone',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.user).toMatchObject({ email: 'newcomer@example.com', emailVerified: true, hasPassword: false, passkeyCount: 1, displayName: 'Newcomer' });
    const user = h.db.get<{ id: number; webauthn_user_id: string; password_hash: string | null }>(
      "SELECT id, webauthn_user_id, password_hash FROM users WHERE email_key = 'newcomer@example.com'",
    )!;
    expect(user).toMatchObject({ webauthn_user_id: row.pending_user_handle, password_hash: null });
    const signedIn = h.db.get<{ last_login_at: string | null; created_at: string }>(
      'SELECT u.last_login_at, s.created_at FROM users u JOIN sessions s ON s.user_id = u.id WHERE u.id = :id',
      { id: user.id },
    )!;
    expect(signedIn.last_login_at).toBe(signedIn.created_at);
    expect((await browser.get<PasskeyDTO[]>('/api/account/passkeys')).body.map((p) => p.name)).toEqual(['My phone']);
    expect((await browser.get<AuthStatusDTO>('/api/auth/status')).body.spaces.map((s) => s.name)).toEqual(["Newcomer's space"]);
    expect(events(h, 'account_created').at(-1)).toEqual({ userId: user.id, data: { authMethod: 'signup' } });
    expect(events(h, 'passkey_added')).toEqual([{ userId: user.id, data: { passkeyId: expect.any(Number), name: 'My phone', via: 'signup' } }]);
    // The link is used up; the passkey signs in.
    expect((await h.client().post('/api/auth/signup/inspect', { token })).body.error.code).toBe('invalid_token');
    expect((await signInWith(h, auth)).status).toBe(200);
  });

  it('a ceremony of another link, a bad answer or a closed policy creates nothing; the link keeps working', async () => {
    const { h } = await instance(open);
    const token = await signupLink(h);
    const otherToken = await signupLink(h, 'second@example.com');
    const other = await h.client().post<CeremonyDTO<any>>('/api/auth/signup/passkey/options', { token: otherToken, displayName: 'Second' });
    const auth = await SoftAuthenticator.create({ origin: ORIGIN });
    const complete = (body: Record<string, unknown>) => h.client().post('/api/auth/signup/passkey/complete', { token, displayName: 'Newcomer', ...body });
    expect(await complete({ ceremonyId: other.body.ceremonyId, response: await auth.register(other.body.options) })).toMatchObject({
      status: 400,
      body: { error: { code: 'passkey_error', message: 'This passkey could not be set up. Try again.' } },
    });
    const options = await h.client().post<CeremonyDTO<any>>('/api/auth/signup/passkey/options', { token, displayName: 'Newcomer' });
    const unverified = await auth.register(options.body.options, { userVerified: false });
    expect((await complete({ ceremonyId: options.body.ceremonyId, response: unverified })).body.error.code).toBe('passkey_error');
    const again = await h.client().post<CeremonyDTO<any>>('/api/auth/signup/passkey/options', { token, displayName: 'Newcomer' });
    h.db.run(`UPDATE instance_settings SET value = '"invite_only"' WHERE key = 'signupPolicy'`);
    expect((await complete({ ceremonyId: again.body.ceremonyId, response: await auth.register(again.body.options) })).body.error.code).toBe('signup_disabled');
    expect((await h.client().post('/api/auth/signup/passkey/options', { token, displayName: 'Newcomer' })).body.error.code).toBe('signup_disabled');
    expect(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE email_key = 'newcomer@example.com'")!.n).toBe(0);
    expect((await h.client().post('/api/auth/signup/inspect', { token })).status).toBe(200);
    // An unknown link counts on tk (invalid_token).
    expect((await h.client().post('/api/auth/signup/passkey/options', { token: randomToken(), displayName: 'X' })).body.error.code).toBe('invalid_token');
  });
});

describe('accepting an invitation with a passkey (§5.8.8)', () => {
  it('a new account with the passkey and its membership; works signed out', async () => {
    const { h, owner } = await instance({ mail: mailless() });
    const created = await owner.client.post<InvitationCreatedDTO>(`/api/spaces/${owner.spaceId}/invitations`, { email: 'Guest@Example.com', role: 'member' });
    expect(created.status).toBe(201);
    const token = tokenOfLink(created.body.link!);
    const browser = h.client();
    const options = await browser.post<CeremonyDTO<any>>('/api/invitations/accept/passkey/options', { token, displayName: 'Guest' });
    expect(options.status, JSON.stringify(options.body)).toBe(200);
    expect(options.body.options.user).toMatchObject({ name: 'Guest@example.com', displayName: 'Guest' });
    expect(h.db.get('SELECT purpose, invitation_id FROM webauthn_challenges')).toEqual({ purpose: 'invite', invitation_id: created.body.invitation.id });
    const auth = await SoftAuthenticator.create({ origin: ORIGIN, alg: -8 });
    const registered = await auth.register(options.body.options);
    const res = await send(browser, '/api/invitations/accept/passkey', options.body, registered, { token, displayName: 'Guest' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    // A copied link proves no address (§5.1): not verified.
    expect(res.body).toMatchObject({ spaceId: owner.spaceId, user: { email: 'Guest@example.com', emailVerified: false, hasPassword: false, passkeyCount: 1 } });
    const members = await owner.client.get(`/api/spaces/${owner.spaceId}/members`);
    expect(members.body.map((m: { email: string; role: string }) => [m.email, m.role])).toContainEqual(['Guest@example.com', 'member']);
    expect((await browser.get<PasskeyDTO[]>('/api/account/passkeys')).body.map((p) => p.name)).toEqual(['Passkey 1']);
    expect(events(h, 'passkey_added').at(-1)?.data).toMatchObject({ via: 'invite' });
    const signedIn = h.db.get<{ last_login_at: string | null; created_at: string }>(
      'SELECT u.last_login_at, s.created_at FROM users u JOIN sessions s ON s.user_id = u.id WHERE u.id = :id',
      { id: res.body.user.id },
    )!;
    expect(signedIn.last_login_at).toBe(signedIn.created_at);
    expect((await h.client().post('/api/invitations/inspect', { token })).body.error.code).toBe('invalid_token');
    expect((await signInWith(h, auth)).status).toBe(200);
  });

  it('refuses an address that has an account, another invitation’s ceremony and a bad answer, leaving the invitation open', async () => {
    const { h, owner } = await instance({ mail: mailless() });
    const link = async (email: string) =>
      tokenOfLink((await owner.client.post<InvitationCreatedDTO>(`/api/spaces/${owner.spaceId}/invitations`, { email, role: 'viewer' })).body.link!);
    const token = await link('guest@example.com');
    const otherToken = await link('second@example.com');
    const other = await h.client().post<CeremonyDTO<any>>('/api/invitations/accept/passkey/options', { token: otherToken, displayName: 'Second' });
    const auth = await SoftAuthenticator.create({ origin: ORIGIN });
    const accept = (body: Record<string, unknown>) => h.client().post('/api/invitations/accept/passkey', { token, displayName: 'Guest', ...body });
    expect((await accept({ ceremonyId: other.body.ceremonyId, response: await auth.register(other.body.options) })).body.error.code).toBe('passkey_error');
    const options = await h.client().post<CeremonyDTO<any>>('/api/invitations/accept/passkey/options', { token, displayName: 'Guest' });
    const elsewhere = await auth.register(options.body.options, { origin: 'https://evil.example' });
    expect((await accept({ ceremonyId: options.body.ceremonyId, response: elsewhere })).body.error.code).toBe('passkey_error');
    expect((await h.client().post('/api/invitations/inspect', { token })).status).toBe(200);
    // The address gets an account meanwhile: 409, as for a password.
    const later = await h.client().post<CeremonyDTO<any>>('/api/invitations/accept/passkey/options', { token, displayName: 'Guest' });
    await h.addUser({ email: 'guest@example.com' });
    expect(await accept({ ceremonyId: later.body.ceremonyId, response: await auth.register(later.body.options) })).toMatchObject({
      status: 409,
      body: { error: { message: 'An account with this email exists. Sign in to accept.' } },
    });
    expect((await h.client().post('/api/invitations/accept/passkey/options', { token, displayName: 'Guest' })).status).toBe(409);
  });
});

describe('a passkey through a reset link (§5.8.9 step 4)', () => {
  async function resetLink(h: Harness, email = OWNER_EMAIL) {
    expect((await h.client().post('/api/auth/password/forgot', { email })).status).toBe(202);
    await h.settle();
    return linkToken(h.outbox.filter((m) => m.template === 'password_reset').at(-1));
  }

  it('the preview says whether a passkey can be set up', async () => {
    const { h } = await instance();
    const token = await resetLink(h);
    expect((await h.client().post<PasswordResetPreviewDTO>('/api/auth/password/reset/inspect', { token })).body).toEqual({
      email: OWNER_EMAIL,
      username: null,
      hasPassword: true,
      canUsePasskey: true,
      passkeyKeepsPassword: null,
    });
    const now = new Date(h.clock.now()).toISOString();
    for (let i = 0; i < 20; i++) {
      h.db.run(
        `INSERT INTO passkeys (user_id, credential_id, public_key, algorithm, device_type, rp_id, name, created_at)
         VALUES (1, :id, 'x', -7, 'multiDevice', 'plan.example.com', 'k', :now)`,
        { id: randomToken(16), now },
      );
    }
    expect((await h.client().post<PasswordResetPreviewDTO>('/api/auth/password/reset/inspect', { token })).body.canUsePasskey).toBe(false);
    const full = await h.client().post('/api/auth/password/reset/passkey/options', { token });
    expect(full).toMatchObject({ status: 409, body: { error: { code: 'quota_exceeded' } } });
    // Without passkeys (PUBLIC_URL is plain http): false, and the options are refused.
    const { h: off } = await instance({ vars: { PUBLIC_URL: 'http://plan.example.com' } });
    const offToken = await resetLink(off);
    expect((await off.client().post<PasswordResetPreviewDTO>('/api/auth/password/reset/inspect', { token: offToken })).body.canUsePasskey).toBe(false);
    expect((await off.client().post('/api/auth/password/reset/passkey/options', { token: offToken })).status).toBe(409);
  });

  it('adds the passkey in place of the password and signs the account out everywhere, as a new password would; the notice goes by mail', async () => {
    const { h, owner } = await instance();
    const existing = await addPasskey(owner.client);
    const token = await resetLink(h);
    h.outbox.length = 0;
    const epoch = h.db.get<{ auth_epoch: number }>('SELECT auth_epoch FROM users')!.auth_epoch;
    for (let i = 0; i < 25; i++) h.ctx.throttle.hit(`lid:a:${owner.user.id}`, POLICIES.lid);
    const browser = owner.client;
    const options = await browser.post<CeremonyDTO<any>>('/api/auth/password/reset/passkey/options', { token });
    expect(options.status, JSON.stringify(options.body)).toBe(200);
    const handle = h.db.get<{ webauthn_user_id: string }>('SELECT webauthn_user_id FROM users')!.webauthn_user_id;
    expect(options.body.options).toMatchObject({
      user: { id: handle, name: OWNER_EMAIL, displayName: 'Owner' },
      excludeCredentials: [{ id: existing.auth.credentialId, type: 'public-key' }],
    });
    expect(h.db.get('SELECT purpose, user_id FROM webauthn_challenges')).toEqual({ purpose: 'reset', user_id: owner.user.id });
    const auth = await SoftAuthenticator.create({ origin: ORIGIN });
    const registered = await auth.register(options.body.options);
    const res = await send(browser, '/api/auth/password/reset/passkey', options.body, registered, { token, name: 'Recovery key' });
    expect(res).toMatchObject({ status: 200, body: { ok: true, passwordRemoved: true, passwordKept: null } });
    // Signed out everywhere (this browser too), no device token left, the epoch bumped, the password and its lock-out gone.
    expect(h.db.get('SELECT COUNT(*) AS n FROM sessions')).toEqual({ n: 0 });
    expect(h.db.get('SELECT COUNT(*) AS n FROM device_tokens')).toEqual({ n: 0 });
    expect(h.db.get<{ auth_epoch: number }>('SELECT auth_epoch FROM users')!.auth_epoch).toBe(epoch + 1);
    expect(browser.jar.has('lyren_session')).toBe(false);
    expect(h.db.get('SELECT password_hash, password_changed_at FROM users')).toEqual({ password_hash: null, password_changed_at: null });
    expect(h.ctx.throttle.check(`lid:a:${owner.user.id}`, POLICIES.lid).count).toBe(0);
    expect(events(h, 'passkey_added').at(-1)).toEqual({ userId: owner.user.id, data: { passkeyId: expect.any(Number), name: 'Recovery key', via: 'reset' } });
    expect(events(h, 'password_removed')).toEqual([{ userId: owner.user.id, data: { via: 'reset' } }]);
    await h.settle();
    expect(h.outbox.map((m) => [m.template, m.to])).toEqual([['passkey_added', OWNER_EMAIL]]);
    expect(h.outbox[0]!.text).toContain('Recovery key');
    // The link is used up; the new passkey signs in, the old password no longer does.
    expect((await h.client().post('/api/auth/password/reset/inspect', { token })).body.error.code).toBe('invalid_token');
    expect((await signInWith(h, auth)).status).toBe(200);
    expect((await h.client().post('/api/auth/login', { identifier: OWNER_EMAIL, password: PASSWORD })).status).toBe(401);
  });

  it('keeps the password, and says why, when the account would have no way back in without it', async () => {
    // Cloudflare without mail: the only administrator keeps its password (§5.8.12), and its lock-out with it.
    const { h, owner } = await instance({ runtime: 'cloudflare', mail: mailless(), vars: { ...PUBLIC, RECOVERY_TOKEN: 'r'.repeat(40) } });
    const keep = 'You are the only administrator and this instance cannot send mail: keep your password';
    const recovered = await h.client().post<{ link: string }>('/api/auth/recover', { token: 'r'.repeat(40), identifier: OWNER_EMAIL });
    expect(recovered.status, JSON.stringify(recovered.body)).toBe(200);
    const token = tokenOfLink(recovered.body.link);
    expect((await h.client().post<PasswordResetPreviewDTO>('/api/auth/password/reset/inspect', { token })).body).toMatchObject({
      hasPassword: true,
      canUsePasskey: true,
      passkeyKeepsPassword: keep,
    });
    for (let i = 0; i < 25; i++) h.ctx.throttle.hit(`lid:a:${owner.user.id}`, POLICIES.lid);
    const options = await h.client().post<CeremonyDTO<any>>('/api/auth/password/reset/passkey/options', { token });
    const auth = await SoftAuthenticator.create({ origin: ORIGIN });
    const res = await send(h.client(), '/api/auth/password/reset/passkey', options.body, await auth.register(options.body.options), { token });
    expect(res).toMatchObject({ status: 200, body: { ok: true, passwordRemoved: false, passwordKept: keep } });
    expect(h.db.get('SELECT password_hash IS NOT NULL AS kept FROM users')).toEqual({ kept: 1 });
    expect(events(h, 'password_removed')).toEqual([]);
    expect(h.ctx.throttle.check(`lid:a:${owner.user.id}`, POLICIES.lid).count).toBe(25);
    expect((await signInWith(h, auth)).status).toBe(200);
  });

  it('recovers a passkey-only account whose passkeys are lost; a bad answer leaves the link working', async () => {
    const { h, owner } = await instance();
    await addPasskey(owner.client);
    expect((await owner.client.delete('/api/account/password')).status).toBe(200);
    const token = await resetLink(h);
    const preview = await h.client().post<PasswordResetPreviewDTO>('/api/auth/password/reset/inspect', { token });
    expect(preview.body).toMatchObject({ hasPassword: false, canUsePasskey: true });
    const auth = await SoftAuthenticator.create({ origin: ORIGIN });
    const first = await h.client().post<CeremonyDTO<any>>('/api/auth/password/reset/passkey/options', { token });
    const elsewhere = await auth.register(first.body.options, { rpId: 'evil.example' });
    const bad = await send(h.client(), '/api/auth/password/reset/passkey', first.body, elsewhere, { token });
    expect(bad.body.error.code).toBe('passkey_error');
    expect((await h.client().post('/api/auth/password/reset/inspect', { token })).status).toBe(200);
    // A ceremony of another link (an older one dies when a new one is issued, so: a link of another account).
    const second = await h.addUser({ email: 'second@example.com' });
    h.db.run('UPDATE users SET email_verified_at = :now WHERE id = :id', { id: second.user.id, now: new Date(h.clock.now()).toISOString() });
    const otherToken = await resetLink(h, 'second@example.com');
    const theirs = await h.client().post<CeremonyDTO<any>>('/api/auth/password/reset/passkey/options', { token: otherToken });
    const crossed = await send(h.client(), '/api/auth/password/reset/passkey', theirs.body, await auth.register(theirs.body.options), { token });
    expect(crossed.body.error.code).toBe('passkey_error');
    const options = await h.client().post<CeremonyDTO<any>>('/api/auth/password/reset/passkey/options', { token });
    expect((await send(h.client(), '/api/auth/password/reset/passkey', options.body, await auth.register(options.body.options), { token })).status).toBe(200);
    expect((await signInWith(h, auth)).status).toBe(200);
    expect(h.db.get('SELECT password_hash FROM users WHERE id = :id', { id: owner.user.id })).toEqual({ password_hash: null });
  });
});

describe('domain moves (§5.6)', () => {
  it('passkeys of another RP ID are shown as such, sign in nowhere, and the startup log and the overview warn', async () => {
    const { h, owner } = await instance();
    const { auth } = await addPasskey(owner.client);
    const member = await h.addUser({ email: 'member@example.com', spaceId: owner.spaceId });
    const memberKey = await addPasskey(member.client);
    expect((await member.client.delete('/api/account/password')).status).toBe(200);
    expect(h.service.startupWarnings).toEqual([]);

    // The instance moves to another host: a restart with the new PUBLIC_URL.
    const moved = h.restart({ vars: { PUBLIC_URL: 'https://plan.example.org' } });
    const warning =
      '1 account can only sign in with passkeys that do not work on this address. Create a reset link for it (Admin → Users), or run reset-password <email> on the server.';
    expect(moved.service.startupWarnings).toContain(warning);
    expect(moved.service.passkeyWarning()).toBe(warning);
    const admin = moved.client();
    expect((await admin.post('/api/auth/login', { identifier: OWNER_EMAIL, password: PASSWORD })).status).toBe(200);
    expect((await admin.get<PasskeyDTO[]>('/api/account/passkeys')).body.map((p) => p.rpIdMatches)).toEqual([false]);
    const overview = await admin.get<AdminOverviewDTO>('/api/admin/overview');
    expect(overview.body.warnings).toContain(warning);
    expect(overview.body.orphanedPasskeyAccounts).toBe(1);
    // The admin list names the account, and lists it alone with ?orphaned=1.
    const all = await admin.get<Page<AdminUserDTO>>('/api/admin/users');
    expect(all.body.items.map((u) => [u.id, u.passkeys, u.usablePasskeys, u.hasPassword])).toEqual([
      [member.user.id, 1, 0, false],
      [owner.user.id, 1, 0, true],
    ]);
    const orphaned = await admin.get<Page<AdminUserDTO>>('/api/admin/users?orphaned=1');
    expect(orphaned.body.items.map((u) => u.id)).toEqual([member.user.id]);
    expect((await admin.get<Page<AdminUserDTO>>('/api/admin/users?orphaned=1&q=owner')).body.items).toEqual([]);
    expect((await admin.get<AdminUserDTO>(`/api/admin/users/${member.user.id}`)).body).toMatchObject({ passkeys: 1, usablePasskeys: 0 });
    // An old passkey is unknown here (a browser would not even offer it), and does not count as a credential.
    const options = await moved.client().post<CeremonyDTO<any>>('/api/auth/passkey/login/options', {});
    const res = await send(moved.client(), '/api/auth/passkey/login', options.body, await memberKey.auth.assert(options.body.options));
    expect(res.body.error.details).toEqual([{ path: 'credential', message: 'unknown' }]);
    const needsPasskey = lastCredential('Add a passkey that works on this address before you remove your password.');
    expect(await admin.delete('/api/account/password')).toMatchObject(needsPasskey);
    // Back at the old host, the owner's passkey works again.
    const back = moved.restart({ vars: PUBLIC });
    expect((await signInWith(back, auth)).status).toBe(200);

    // Two such accounts, and passkeys switched off altogether.
    back.db.run('UPDATE users SET password_hash = NULL WHERE id = :id', { id: owner.user.id });
    const off = back.restart({ vars: {} });
    const two =
      '2 accounts can only sign in with passkeys that do not work on this address. Create reset links for them (Admin → Users), or run reset-password <email> on the server for each.';
    expect(off.service.startupWarnings).toContain(two);
  });

  it('the count (from the passkeys) and the admin list’s filter (from the accounts) agree', async () => {
    const { h } = await instance();
    const now = new Date(h.clock.now()).toISOString();
    const account = (email: string, o: { password?: boolean; status?: string; rpIds?: string[] }) => {
      const id = h.db.get<{ id: number }>(
        `INSERT INTO users (email, email_key, display_name, password_hash, webauthn_user_id, status, created_at, updated_at)
         VALUES (:email, :email, :email, :hash, :handle, :status, :now, :now) RETURNING id`,
        { email, hash: o.password ? 'x' : null, handle: randomToken(32), status: o.status ?? 'active', now },
      )!.id;
      for (const rpId of o.rpIds ?? []) {
        h.db.run(
          `INSERT INTO passkeys (user_id, credential_id, public_key, algorithm, device_type, rp_id, name, created_at)
           VALUES (:id, :credential, 'k', -7, 'multiDevice', :rpId, 'k', :now)`,
          { id, credential: randomToken(16), rpId, now },
        );
      }
      return id;
    };
    const stranded = [account('a@example.com', { rpIds: ['old.example.com'] }), account('b@example.com', { rpIds: ['old.example.com', 'older.example.com'] })];
    account('c@example.com', { rpIds: ['old.example.com', 'plan.example.com'] });
    account('d@example.com', { password: true, rpIds: ['old.example.com'] });
    account('e@example.com', { status: 'disabled', rpIds: ['old.example.com'] });
    account('f@example.com', { rpIds: ['plan.example.com'] });
    const listed = (rpId: string | null) =>
      listAdminUsers({ db: h.db, config: { ...h.config, passkeys: { ...h.config.passkeys, enabled: rpId !== null, rpId } } }, { orphaned: true }).items.map((u) => u.id);
    expect(orphanedAccounts(h.db, 'plan.example.com')).toBe(2);
    expect(listed('plan.example.com').sort()).toEqual(stranded.sort());
    // Passkeys off: every account without a password that has a passkey (c and f too; the owner has a password).
    expect(orphanedAccounts(h.db, null)).toBe(4);
    expect(listed(null)).toHaveLength(4);
  });

  it('on Cloudflare the warning is not computed at a start (it reads every passkey): the alarm and the overview have it', async () => {
    const { h, owner } = await instance({ runtime: 'cloudflare' });
    await addPasskey(owner.client);
    expect((await owner.client.delete('/api/account/password')).status).toBe(200);
    const moved = h.restart({ vars: { PUBLIC_URL: 'https://plan.example.org' } });
    const warning =
      '1 account can only sign in with passkeys that do not work on this address. Create a reset link for it (Admin → Users), or, for an administrator’s account, use the recovery token (RECOVERY_TOKEN).';
    expect(moved.service.startupWarnings).toEqual([]);
    expect(moved.service.passkeyWarning()).toBe(warning);
  });
});
