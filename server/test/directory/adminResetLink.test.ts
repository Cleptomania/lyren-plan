// The admin reset link (design §5.8.11): POST /api/admin/users/:userId/reset-link, an instance admin's,
// with the re-auth window and ar:<adminId> (10 a day). Refused for an administrator's account, and for a
// demoted one for 30 days and until it signs in again (Appendix D 56). With mail and a verified address the
// link is mailed to the user and the admin gets none ({ sent: true }); otherwise the admin gets a link that
// works for 24 hours. The user is told by mail (with mail) and at the next sign-in (AuthStatusDTO.notices).

import { describe, expect, it } from 'vitest';
import type { AuthStatusDTO, ResetLinkDTO } from '@shared/types';
import { createLogTransport } from '../../src/mail/log';
import { createDirectoryHarness, PASSWORD } from '../support/directoryHarness';
import { linkToken, tokenOfLink } from '../support/mail';

const PUBLIC = { PUBLIC_URL: 'https://plan.example.com' };
const NEW_PASSWORD = 'chosen after the reset';

async function instance(o: Parameters<typeof createDirectoryHarness>[0] = {}) {
  const h = createDirectoryHarness({ vars: PUBLIC, ...o });
  const admin = await h.setup();
  const user = await h.addUser({ email: 'user@example.com', displayName: 'User' });
  await h.settle();
  h.outbox.length = 0;
  return { h, admin, user };
}

/** The admin's POST …/reset-link (the body is a ResetLinkDTO on 200, an error otherwise). */
const resetLink = (h: Awaited<ReturnType<typeof instance>>, userId: number) =>
  h.admin.client.post(`/api/admin/users/${userId}/reset-link`);

describe('POST /api/admin/users/:userId/reset-link', () => {
  it('is an instance admin’s, with the re-auth window; unknown accounts are 404', async () => {
    const t = await instance();
    expect((await t.h.client().post(`/api/admin/users/${t.user.user.id}/reset-link`)).status).toBe(401);
    expect(await t.user.client.post(`/api/admin/users/${t.admin.user.id}/reset-link`)).toMatchObject({
      status: 403,
      body: { error: { code: 'forbidden', message: 'Only an administrator of this instance can do this' } },
    });
    expect((await resetLink(t, 999)).status).toBe(404);
    t.h.clock.advance(11 * 60_000);
    expect((await resetLink(t, t.user.user.id)).body.error.code).toBe('reauth_required');
  });

  it('refuses an administrator’s account (another admin, or one’s own) before asking for the password', async () => {
    const t = await instance();
    const other = await t.h.addUser({ email: 'admin2@example.com', isInstanceAdmin: true });
    t.h.clock.advance(11 * 60_000);
    for (const id of [other.user.id, t.admin.user.id]) {
      expect(await resetLink(t, id)).toMatchObject({
        status: 403,
        body: { error: { code: 'forbidden', message: 'Reset links for administrators can only be created with the command line or the recovery token' } },
      });
    }
    expect(t.h.db.all("SELECT id FROM email_tokens WHERE purpose = 'reset_password'")).toEqual([]);
  });

  it('refuses a demoted admin’s account for 30 days, and until it signs in again: demoting is no way around the rule', async () => {
    for (const mail of ['with mail', 'without mail'] as const) {
      const t = await instance(mail === 'without mail' ? { mail: createLogTransport({ logBodies: false }, () => {}) } : {});
      const other = await t.h.addUser({ email: 'admin2@example.com', isInstanceAdmin: true });
      const third = await t.h.addUser({ email: 'admin3@example.com', isInstanceAdmin: true });
      for (const { user } of [other, third]) {
        expect((await t.admin.client.patch(`/api/admin/users/${user.id}`, { isInstanceAdmin: false })).body.isInstanceAdmin).toBe(false);
      }
      const refused = {
        status: 403,
        body: {
          error: {
            code: 'forbidden',
            message: 'This account was an administrator until recently, so its reset links can only be created with the command line or the recovery token',
          },
        },
      };
      expect(await resetLink(t, other.user.id)).toMatchObject(refused);
      // A sign-in since the demotion is not enough within the 30 days, nor are 30 days without one.
      t.h.clock.advance(60_000);
      await t.h.client().post('/api/auth/login', { identifier: 'admin2@example.com', password: PASSWORD });
      t.h.clock.advance(29 * 86_400_000);
      const admin = t.h.client();
      await admin.post('/api/auth/login', { identifier: 'owner@example.com', password: PASSWORD });
      expect(await admin.post(`/api/admin/users/${other.user.id}/reset-link`)).toMatchObject(refused);
      t.h.clock.advance(2 * 86_400_000);
      await admin.post('/api/auth/login', { identifier: 'owner@example.com', password: PASSWORD });
      expect(await admin.post(`/api/admin/users/${third.user.id}/reset-link`)).toMatchObject(refused);
      expect(await admin.post(`/api/admin/users/${other.user.id}/reset-link`)).toMatchObject({ status: 200 });
      await t.h.client().post('/api/auth/login', { identifier: 'admin3@example.com', password: PASSWORD });
      expect(await admin.post(`/api/admin/users/${third.user.id}/reset-link`)).toMatchObject({ status: 200 });
      expect(t.h.db.all("SELECT user_id FROM email_tokens WHERE purpose = 'reset_password' ORDER BY id")).toEqual([
        { user_id: other.user.id },
        { user_id: third.user.id },
      ]);
    }
  });

  it('a verified address with mail: { sent: true }, the link goes to the user (30 minutes), the admin holds none', async () => {
    const t = await instance();
    t.h.db.run('UPDATE users SET email_verified_at = :now WHERE id = :id', { id: t.user.user.id, now: new Date(t.h.clock.now()).toISOString() });
    const res = await resetLink(t, t.user.user.id);
    expect(res).toMatchObject({ status: 200 });
    expect(res.body).toEqual({ sent: true });
    const row = t.h.db.get<{ issued_by: number; expires_at: string; purpose: string }>("SELECT * FROM email_tokens WHERE purpose = 'reset_password'")!;
    expect(row).toMatchObject({ purpose: 'reset_password', issued_by: t.admin.user.id });
    expect(Date.parse(row.expires_at) - t.h.clock.now()).toBe(30 * 60_000);
    const event = t.h.db.get<{ user_id: number; actor_id: number; data: string }>("SELECT * FROM security_events WHERE type = 'admin_reset_link'")!;
    expect(event).toMatchObject({ user_id: t.user.user.id, actor_id: t.admin.user.id, data: '{"delivery":"mail","displayName":"User"}' });
    await t.h.settle();
    expect(t.h.outbox.map((m) => [m.template, m.to])).toEqual([
      ['password_reset', 'user@example.com'],
      ['password_reset_by_admin', 'user@example.com'],
    ]);
    expect(t.h.outbox[0]!.text).toContain('An administrator of Lyren Plan sent you a link to choose a new password');
    expect(t.h.outbox[1]!.text).toContain('Owner, created a password reset link for your account');
    const token = linkToken(t.h.outbox[0]);
    expect((await t.h.client().post('/api/auth/password/reset', { token, password: NEW_PASSWORD })).status).toBe(200);
    expect((await t.h.client().post('/api/auth/login', { identifier: 'user@example.com', password: NEW_PASSWORD })).status).toBe(200);
  });

  it('an unverified address, or no mail: a 24-hour link for the admin to pass on; the user sees a notice at the next sign-in', async () => {
    for (const mail of ['unverified', 'none'] as const) {
      const t = await instance(mail === 'none' ? { mail: createLogTransport({ logBodies: false }, () => {}) } : {});
      const res: { status: number; body: ResetLinkDTO } = await resetLink(t, t.user.user.id);
      expect(res.status).toBe(200);
      if (res.body.sent) throw new Error('expected a link');
      expect(res.body.link).toMatch(/^https:\/\/plan\.example\.com\/reset#t=[A-Za-z0-9_-]{43}$/);
      expect(Date.parse(res.body.expiresAt) - t.h.clock.now()).toBe(24 * 3600_000);
      expect(t.h.db.get<{ data: string }>("SELECT data FROM security_events WHERE type = 'admin_reset_link'")!.data).toBe('{"delivery":"link","displayName":"User"}');
      await t.h.settle();
      // Nothing goes to an unverified address (the notice is a security notice).
      expect(t.h.outbox).toEqual([]);
      const token = tokenOfLink(res.body.link);
      t.h.clock.advance(23 * 3600_000);
      expect((await t.h.client().post('/api/auth/password/reset', { token, password: NEW_PASSWORD })).status).toBe(200);
      const browser = t.h.client();
      await browser.post('/api/auth/login', { identifier: 'user@example.com', password: NEW_PASSWORD });
      const status = await browser.get<AuthStatusDTO>('/api/auth/status');
      expect(status.body.notices).toEqual([{ id: expect.any(Number), type: 'admin_reset_link', actorName: 'Owner', createdAt: expect.any(String) }]);
      await browser.post('/api/account/notices/seen');
      expect((await browser.get<AuthStatusDTO>('/api/auth/status')).body.notices).toEqual([]);
    }
  });

  it('an account from before email addresses gets a link too', async () => {
    const t = await instance();
    t.h.db.run("UPDATE users SET email = NULL, email_key = NULL, username = 'legacy' WHERE id = :id", { id: t.user.user.id });
    const res = await resetLink(t, t.user.user.id);
    if (res.body.sent) throw new Error('expected a link');
    const token = tokenOfLink(res.body.link);
    expect((await t.h.client().post('/api/auth/password/reset/inspect', { token })).body).toEqual({
      email: null,
      username: 'legacy',
      hasPassword: true,
      canUsePasskey: true,
      // Node: the reset-password command is its way back in, so a passkey would replace the password.
      passkeyKeepsPassword: null,
    });
    expect((await t.h.client().post('/api/auth/password/reset', { token, password: NEW_PASSWORD })).status).toBe(200);
    expect((await t.h.client().post('/api/auth/login', { identifier: 'legacy', password: NEW_PASSWORD })).status).toBe(200);
  });

  it('at most 10 a day per admin (ar); the newest link replaces the older one', async () => {
    const t = await instance();
    const links: string[] = [];
    for (let i = 0; i < 10; i++) {
      const res = await resetLink(t, t.user.user.id);
      if (res.body.sent) throw new Error('expected a link');
      links.push(res.body.link);
    }
    expect(await resetLink(t, t.user.user.id)).toMatchObject({ status: 429, body: { error: { message: 'You have created as many reset links as you can today' } } });
    expect((await t.h.client().post('/api/auth/password/reset/inspect', { token: tokenOfLink(links[0]!) })).body.error.code).toBe('invalid_token');
    expect((await t.h.client().post('/api/auth/password/reset/inspect', { token: tokenOfLink(links[9]!) })).status).toBe(200);
    // The user's old password works until the link is used.
    expect((await t.h.client().post('/api/auth/login', { identifier: 'user@example.com', password: PASSWORD })).status).toBe(200);
  });
});
