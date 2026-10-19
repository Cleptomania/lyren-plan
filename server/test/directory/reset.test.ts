// Forgot and reset password (design §5.8.9): POST /api/auth/password/forgot answers 202 for every address
// and mails, after the answer, a reset link (30 minutes) to an active account with that address, when
// links can be mailed; /password/reset/inspect and /password/reset turn the link into a new password, a new
// auth_epoch and an account signed out everywhere, with the password_changed notice listing the week's
// grants. Reset links an admin or the recovery token makes are adminResetLink.test.ts's and
// recovery.test.ts's; their redemption is the same route.

import { describe, expect, it } from 'vitest';
import type { AuthStatusDTO } from '@shared/types';
import { sha256Hex } from '../../src/core/crypto';
import { createLogTransport } from '../../src/mail/log';
import { createDirectoryHarness, OWNER_EMAIL, PASSWORD } from '../support/directoryHarness';
import { linkToken } from '../support/mail';

const PUBLIC = { PUBLIC_URL: 'https://plan.example.com' };
const NEW_PASSWORD = 'an entirely new password';

async function instance(o: Parameters<typeof createDirectoryHarness>[0] = {}) {
  const h = createDirectoryHarness({ vars: PUBLIC, ...o });
  const owner = await h.setup();
  h.db.run('UPDATE users SET email_verified_at = :now', { now: new Date(h.clock.now()).toISOString() });
  await h.settle();
  h.outbox.length = 0;
  return { h, owner };
}

/** forgot for `email`, then the link the mail carries. */
async function forgotLink(h: Awaited<ReturnType<typeof instance>>['h'], email = OWNER_EMAIL, ip = '198.51.100.70'): Promise<string> {
  const res = await h.client({ ip }).post('/api/auth/password/forgot', { email });
  expect(res).toMatchObject({ status: 202, body: { ok: true } });
  await h.settle();
  return linkToken(h.outbox.filter((m) => m.template === 'password_reset').at(-1));
}

describe('POST /api/auth/password/forgot', () => {
  it('an active account gets a 30-minute link after the answer; a missing address and a disabled account get nothing, with the same answer', async () => {
    const { h } = await instance();
    const res = await h.client().post('/api/auth/password/forgot', { email: 'Owner@Example.com' });
    expect(res).toMatchObject({ status: 202, body: { ok: true } });
    expect(h.db.all("SELECT id FROM email_tokens WHERE purpose = 'reset_password'")).toEqual([]);
    await h.settle();
    expect(h.outbox.map((m) => [m.template, m.to])).toEqual([['password_reset', OWNER_EMAIL]]);
    expect(h.outbox[0]!.text).toContain('https://plan.example.com/reset#t=');
    const row = h.db.get<{ expires_at: string; auth_epoch: number; issued_by: number | null }>("SELECT * FROM email_tokens WHERE purpose = 'reset_password'")!;
    expect(Date.parse(row.expires_at) - h.clock.now()).toBe(30 * 60_000);
    expect(row).toMatchObject({ auth_epoch: 0, issued_by: null });

    h.outbox.length = 0;
    expect(await h.client().post('/api/auth/password/forgot', { email: 'nobody@example.com' })).toMatchObject({ status: 202, body: { ok: true } });
    const disabled = await h.addUser({ email: 'disabled@example.com' });
    h.db.run("UPDATE users SET status = 'disabled' WHERE id = :id", { id: disabled.user.id });
    expect(await h.client().post('/api/auth/password/forgot', { email: 'disabled@example.com' })).toMatchObject({ status: 202, body: { ok: true } });
    await h.settle();
    expect(h.outbox).toEqual([]);
    expect(h.db.all("SELECT id FROM email_tokens WHERE purpose = 'reset_password'")).toHaveLength(1);
  });

  it('with the log transport no token is minted at all, so no live link can reach a log, and nothing is counted', async () => {
    const lines: string[] = [];
    const { h } = await instance({ mail: createLogTransport({ logBodies: false }, (line) => lines.push(line)) });
    for (let i = 0; i < 5; i++) expect((await h.client().post('/api/auth/password/forgot', { email: OWNER_EMAIL })).status).toBe(202);
    await h.settle();
    expect(h.db.all('SELECT id FROM email_tokens')).toEqual([]);
    // A request that can do nothing counts nothing either: no row is written (§13.10).
    expect(h.db.all('SELECT key FROM auth_throttle')).toEqual([]);
    expect(lines.filter((l) => l.includes('password_reset'))).toEqual([]);
    expect(lines.join('\n')).not.toContain('#t=');
    // With the development flag the flow works (the whole message is printed).
    const printed: string[] = [];
    const { h: dev } = await instance({ mail: createLogTransport({ logBodies: true }, (line) => printed.push(line)), vars: { ...PUBLIC, MAIL_LOG_BODIES: '1' } });
    expect((await dev.client().post('/api/auth/password/forgot', { email: OWNER_EMAIL })).status).toBe(202);
    await dev.settle();
    expect(dev.db.all("SELECT id FROM email_tokens WHERE purpose = 'reset_password'")).toHaveLength(1);
    expect(printed.join('\n')).toMatch(/\/reset#t=[A-Za-z0-9_-]{43}/);
  });

  it('counts on mh, md and mi like sign-up: the fourth request in an hour for one address is refused, account or not', async () => {
    const { h } = await instance();
    for (const email of [OWNER_EMAIL, 'nobody@example.com']) {
      const statuses = [];
      for (let i = 0; i < 4; i++) statuses.push((await h.client({ ip: `198.51.100.${80 + i}` }).post('/api/auth/password/forgot', { email })).status);
      expect(statuses).toEqual([202, 202, 202, 429]);
    }
    await h.settle();
    expect(h.outbox.map((m) => m.template)).toEqual(['password_reset', 'password_reset', 'password_reset']);
  });
});

describe('POST /api/auth/password/reset', () => {
  it('inspect names the account; reset sets the password, bumps the epoch and signs the account out everywhere', async () => {
    const { h, owner } = await instance();
    const other = h.client({ ip: '198.51.100.71' });
    await other.post('/api/auth/login', { identifier: OWNER_EMAIL, password: PASSWORD });
    h.db.run("INSERT INTO auth_throttle (key, window_start, count) VALUES (:a, :now, 15), (:b, :now, 50)", {
      a: `lid:a:${owner.user.id}`,
      b: `lda:${owner.user.id}`,
      now: new Date(h.clock.now()).toISOString(),
    });
    const token = await forgotLink(h);
    const browser = h.client({ ip: '198.51.100.72' });
    expect(await browser.post('/api/auth/password/reset/inspect', { token })).toMatchObject({
      status: 200,
      // Passkeys are on (PUBLIC_URL is https): the link could set up a passkey instead (§5.8.9 step 4).
      body: { email: OWNER_EMAIL, username: null, hasPassword: true, canUsePasskey: true },
    });
    h.spaces.calls.length = 0;
    const res = await browser.post('/api/auth/password/reset', { token, password: NEW_PASSWORD });
    expect(res).toMatchObject({ status: 200, body: { ok: true } });
    // No automatic sign-in.
    expect(browser.jar.size).toBe(0);
    // The push to the account's spaces is awaited before the answer.
    expect(h.spaces.ids('invalidate')).toEqual([owner.spaceId]);
    expect(h.db.all('SELECT id FROM sessions')).toEqual([]);
    expect(h.db.all('SELECT id FROM device_tokens')).toEqual([]);
    expect(h.db.all('SELECT key FROM auth_throttle WHERE key LIKE \'l%\'')).toEqual([]);
    expect(h.db.get<{ auth_epoch: number }>('SELECT auth_epoch FROM users WHERE id = :id', { id: owner.user.id })!.auth_epoch).toBe(1);
    expect((await owner.client.get('/api/account')).status).toBe(401);
    expect((await other.get('/api/account')).status).toBe(401);
    expect((await h.client().post('/api/auth/login', { identifier: OWNER_EMAIL, password: PASSWORD })).status).toBe(401);
    expect((await h.client().post('/api/auth/login', { identifier: OWNER_EMAIL, password: NEW_PASSWORD })).status).toBe(200);
    expect(h.db.all("SELECT type FROM security_events WHERE type = 'password_reset'")).toHaveLength(1);
    await h.settle();
    expect(h.outbox.map((m) => m.template)).toEqual(['password_reset', 'password_changed']);
    expect(h.outbox[1]!.text).toContain('was reset on');
    // Once only.
    expect((await browser.post('/api/auth/password/reset', { token, password: 'one more new password' })).body.error.code).toBe('invalid_token');
  });

  it('a reset from a browser signed in to the account expires its session cookie', async () => {
    const { h, owner } = await instance();
    const token = await forgotLink(h);
    const res = await owner.client.post('/api/auth/password/reset', { token, password: NEW_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.setCookies.some((c) => c.startsWith('lyren_session=;'))).toBe(true);
    expect(owner.client.jar.has('lyren_session')).toBe(false);
  });

  it('the notice lists the memberships, roles and invitations the account granted in the last 7 days', async () => {
    const { h, owner } = await instance();
    const bob = await h.addUser({ email: 'bob@example.com', displayName: 'Bob', spaceId: owner.spaceId, role: 'member' });
    await owner.client.patch(`/api/spaces/${owner.spaceId}/members/${bob.user.id}`, { role: 'viewer' });
    expect((await owner.client.post(`/api/spaces/${owner.spaceId}/invitations`, { email: 'carol@example.com', role: 'member' })).status).toBe(201);
    h.outbox.length = 0;
    const token = await forgotLink(h);
    await h.client().post('/api/auth/password/reset', { token, password: NEW_PASSWORD });
    await h.settle();
    const notice = h.outbox.find((m) => m.template === 'password_changed')!;
    expect(notice.text).toContain("- Space Owner's space: an invitation as a member\n");
    expect(notice.text).toContain("- Space Owner's space: Bob as a viewer (read-only)");
    expect(notice.text).not.toContain('carol@example.com');
  });

  it('a link works for 30 minutes, the newest one only, and dies with a password change or an email change', async () => {
    const { h, owner } = await instance();
    const first = await forgotLink(h, OWNER_EMAIL, '198.51.100.73');
    const second = await forgotLink(h, OWNER_EMAIL, '198.51.100.74');
    expect((await h.client().post('/api/auth/password/reset/inspect', { token: first })).body.error.code).toBe('invalid_token');
    h.clock.advance(30 * 60_000);
    expect((await h.client().post('/api/auth/password/reset', { token: second, password: NEW_PASSWORD })).body.error.code).toBe('invalid_token');

    const third = await forgotLink(h, OWNER_EMAIL, '198.51.100.75');
    expect((await owner.client.post('/api/account/password', { currentPassword: PASSWORD, newPassword: NEW_PASSWORD })).status).toBe(200);
    expect((await h.client().post('/api/auth/password/reset', { token: third, password: 'yet another password' })).body.error.code).toBe('invalid_token');

    h.clock.advance(3600_000);
    const fourth = await forgotLink(h, OWNER_EMAIL, '198.51.100.76');
    // An email change (here without mail: at once) bumps the epoch as well.
    const noMail = createDirectoryHarness({ db: h.db, clock: h.clock, mail: createLogTransport({ logBodies: false }, () => {}) });
    const signedIn = noMail.client();
    await signedIn.post('/api/auth/login', { identifier: OWNER_EMAIL, password: NEW_PASSWORD });
    expect((await signedIn.post('/api/account/email', { email: 'owner2@example.com' })).body).toEqual({ ok: true, pending: false, email: 'owner2@example.com' });
    expect((await h.client().post('/api/auth/password/reset', { token: fourth, password: 'yet another password' })).body.error.code).toBe('invalid_token');
  });

  it('checks the instance minimum before anything is consumed', async () => {
    const { h } = await instance();
    // An admin raised the minimum after setup.
    h.db.run("UPDATE instance_settings SET value = '30' WHERE key = 'passwordMinLength'");
    const token = await forgotLink(h);
    const short = await h.client().post('/api/auth/password/reset', { token, password: NEW_PASSWORD });
    expect(short).toMatchObject({ status: 400, body: { error: { code: 'validation_error', details: [{ path: 'password', message: 'At least 30 characters' }] } } });
    expect((await h.client().post('/api/auth/password/reset', { token, password: 'a password of thirty characters' })).status).toBe(200);
    const status = await h.client().get<AuthStatusDTO>('/api/auth/status');
    expect(status.body.instance.passwordMinLength).toBe(30);
    expect(h.db.get<{ token_hash: string }>("SELECT token_hash FROM email_tokens WHERE purpose = 'reset_password'")!.token_hash).toBe(sha256Hex(token));
  });
});
