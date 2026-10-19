// Administration → Overview and Settings (design §5.3, §5.8.18, §7.2): GET /api/admin/overview (warnings,
// the configuration without a secret, counts, the last 20 administrative events of every admin, the
// command line's and the recovery token's included) and PATCH /api/admin/settings (the signup policy, with
// 409 mail_not_configured for `open` without mail, and the password minimum; re-auth; an event).

import { describe, expect, it } from 'vitest';
import type { AdminEventDTO, AdminOverviewDTO, InstanceInfoDTO } from '@shared/types';
import { MAIL_LOG_BODIES_WARNING } from '../../src/core/config';
import { NO_PUBLIC_URL_WARNING, OPEN_WITHOUT_MAIL_WARNING, RECOVERY_TOKEN_WARNING } from '../../src/directory/admin';
import { recordEvent } from '../../src/directory/security';
import { createLogTransport } from '../../src/mail/log';
import { createDirectoryHarness, PASSWORD } from '../support/directoryHarness';

const PUBLIC = { PUBLIC_URL: 'https://plan.example.com' };
const quietLog = () => createLogTransport({ logBodies: false }, () => {});

describe('GET /api/admin/overview', () => {
  it('is for instance admins only (401 signed out, 403 for everyone else); reading needs no re-auth', async () => {
    const h = createDirectoryHarness({ vars: PUBLIC });
    const { client, spaceId } = await h.setup();
    const member = await h.addUser({ email: 'member@example.com', spaceId, role: 'owner' });
    expect((await h.client().get('/api/admin/overview')).status).toBe(401);
    expect(await member.client.get('/api/admin/overview')).toMatchObject({ status: 403, body: { error: { code: 'forbidden' } } });
    h.clock.advance(60 * 60_000);
    expect((await client.get('/api/admin/overview')).status).toBe(200);
  });

  it('the instance, its configuration and counts', async () => {
    const h = createDirectoryHarness({ vars: { ...PUBLIC, SESSION_MAX_DAYS: '60', SPACE_DELETE_GRACE_DAYS: '3', INVITATION_TTL_DAYS: '5' } });
    const { client, spaceId } = await h.setup();
    await h.addUser({ email: 'member@example.com', spaceId });
    await client.post('/api/spaces', { name: 'Second' });
    const res = await client.get<AdminOverviewDTO>('/api/admin/overview');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.body.instance).toEqual((await client.get('/api/auth/status')).body.instance);
    expect(res.body.config).toEqual({
      publicUrl: 'https://plan.example.com',
      mailTransport: 'log',
      mailFrom: null,
      sessionTtlDays: 30,
      sessionMaxDays: 60,
      reauthMinutes: 10,
      invitationTtlDays: 5,
      spaceDeleteGraceDays: 3,
      passwordKdf: 'scrypt',
    });
    expect(res.body.counts).toEqual({ users: 2, spaces: 2, sessions: 2 });
    // A deleted space and an expired session no longer count.
    const second = (await client.get('/api/spaces')).body.find((s: { name: string }) => s.name === 'Second').id;
    await client.delete(`/api/spaces/${second}`, { confirmName: 'Second' });
    h.db.run("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z' WHERE user_id <> :id", { id: (await client.get('/api/account')).body.id });
    expect((await client.get<AdminOverviewDTO>('/api/admin/overview')).body.counts).toEqual({ users: 2, spaces: 1, sessions: 1 });
  });

  it('holds no secret of the configuration', async () => {
    const secrets = {
      SMTP_PASS: 'smtp-password-never-shown',
      RECOVERY_TOKEN: 'recovery-token-never-shown-0123456789',
      SETUP_TOKEN: 'setup-token-never-shown',
    };
    const h = createDirectoryHarness({
      vars: { ...PUBLIC, MAIL_TRANSPORT: 'smtp', MAIL_FROM: 'plan@example.com', SMTP_HOST: 'smtp.example.com', SMTP_USER: 'plan', ...secrets },
    });
    const { client } = await h.setup();
    const res = await client.get<AdminOverviewDTO>('/api/admin/overview');
    expect(res.body.config).toMatchObject({ mailTransport: 'smtp', mailFrom: 'plan@example.com' });
    const text = JSON.stringify(res.body);
    for (const secret of Object.values(secrets)) expect(text).not.toContain(secret);
    const ceremonyKey = h.db.get<{ value: string }>("SELECT value FROM instance_settings WHERE key = 'ceremonyKey'")!.value;
    expect(text).not.toContain(JSON.parse(ceremonyKey));
    const resend = createDirectoryHarness({ vars: { ...PUBLIC, MAIL_TRANSPORT: 'resend', MAIL_FROM: 'plan@example.com', RESEND_API_KEY: 're_never_shown_123' } });
    const body = JSON.stringify((await (await resend.setup()).client.get('/api/admin/overview')).body);
    expect(body).toContain('"mailTransport":"resend"');
    expect(body).not.toContain('re_never_shown_123');
  });

  it('warns while RECOVERY_TOKEN is set, with MAIL_LOG_BODIES on a public origin, for open sign-up without mail, and without PUBLIC_URL', async () => {
    const quiet = createDirectoryHarness({ vars: PUBLIC });
    expect((await (await quiet.setup()).client.get<AdminOverviewDTO>('/api/admin/overview')).body.warnings).toEqual([]);

    const token = 'recovery-token-for-the-tests-0123456789';
    for (const runtime of ['node', 'cloudflare'] as const) {
      const h = createDirectoryHarness({ runtime, vars: { ...PUBLIC, RECOVERY_TOKEN: token, MAIL_LOG_BODIES: '1' }, mail: quietLog() });
      const { client } = await h.setup();
      expect((await client.get<AdminOverviewDTO>('/api/admin/overview')).body.warnings).toEqual([RECOVERY_TOKEN_WARNING[runtime], MAIL_LOG_BODIES_WARNING]);
    }
    expect(RECOVERY_TOKEN_WARNING.cloudflare).toContain('npx wrangler secret delete RECOVERY_TOKEN');

    // The policy was set to open while mail worked; this start has none.
    const withMail = createDirectoryHarness({ vars: PUBLIC });
    const { client } = await withMail.setup();
    expect((await client.patch('/api/admin/settings', { signupPolicy: 'open' })).status).toBe(200);
    const restarted = withMail.restart({ mail: quietLog() });
    const again = restarted.client();
    again.jar.set('lyren_session', client.jar.get('lyren_session')!);
    expect((await again.get<AdminOverviewDTO>('/api/admin/overview')).body.warnings).toEqual([OPEN_WITHOUT_MAIL_WARNING]);

    // No PUBLIC_URL (the desktop app needs none). The SIGNUP_POLICY seed warning is the startup log's only.
    const lan = createDirectoryHarness({ vars: { SIGNUP_POLICY: 'open' }, mail: quietLog() });
    expect(lan.service.startupWarnings.length).toBe(1);
    expect((await (await lan.setup()).client.get<AdminOverviewDTO>('/api/admin/overview')).body.warnings).toEqual([NO_PUBLIC_URL_WARNING]);
    const desktop = createDirectoryHarness({
      desktop: { app: { exe: 'lyren-plan.exe', windows: true }, data: () => ({ exe: 'lyren-plan.exe', windows: true, dataDir: 'C:\\data', dbPath: null, customDataDir: false, exeFolder: null }) },
    });
    expect((await (await desktop.setup()).client.get<AdminOverviewDTO>('/api/admin/overview')).body.warnings).toEqual([]);
  });

  it('the last 20 administrative events of every admin, newest first, with the actor and the target', async () => {
    const h = createDirectoryHarness({ vars: PUBLIC, backup: { create: async () => ({ body: new Blob(['tar']).stream(), size: 3, filename: 'x.tar' }) } });
    const { client, user: owner } = await h.setup();
    const second = await h.addUser({ email: 'second@example.com', displayName: 'Second', isInstanceAdmin: true });
    const bob = await h.addUser({ email: 'bob@example.com', displayName: 'Bob' });
    expect((await client.patch(`/api/admin/users/${bob.user.id}`, { status: 'disabled' })).status).toBe(200);
    expect((await second.client.get('/api/admin/backup')).status).toBe(200);
    expect((await client.patch('/api/admin/settings', { passwordMinLength: 12 })).status).toBe(200);
    // The command line's (no actor) and the recovery token's (the account itself) are shown too.
    recordEvent(h.db, { type: 'admin_granted', userId: bob.user.id, meta: null, data: { via: 'cli' }, nowMs: h.clock.now() });
    recordEvent(h.db, { type: 'recovery_used', userId: owner.id, meta: null, data: { madeAdmin: false }, nowMs: h.clock.now() });
    // Other events are not administrative.
    await client.post('/api/account/sessions/revoke-others');

    const events = (await second.client.get<AdminOverviewDTO>('/api/admin/overview')).body.recentAdminEvents;
    const brief = (e: AdminEventDTO) => [e.type, e.actor?.displayName ?? null, e.target];
    expect(events.map(brief)).toEqual([
      ['recovery_used', null, { kind: 'user', id: owner.id, name: 'Owner' }],
      ['admin_granted', null, { kind: 'user', id: bob.user.id, name: 'Bob' }],
      ['admin_settings_changed', 'Owner', null],
      ['admin_backup_downloaded', 'Second', null],
      ['admin_user_disabled', 'Owner', { kind: 'user', id: bob.user.id, name: 'Bob' }],
    ]);
    expect(events[2]).toMatchObject({ data: { passwordMinLength: { from: 8, to: 12 } }, ip: '192.0.2.10', userAgent: 'vitest' });
    expect(events[1]!.data).toEqual({ via: 'cli' });

    // Bob deleted: the events about him keep his name.
    expect((await second.client.delete(`/api/admin/users/${bob.user.id}`)).status).toBe(200);
    const after = (await client.get<AdminOverviewDTO>('/api/admin/overview')).body.recentAdminEvents;
    expect(after.filter((e) => e.target?.kind === 'user' && e.type !== 'recovery_used').map(brief)).toEqual([
      ['admin_user_deleted', 'Second', { kind: 'user', id: null, name: 'Bob' }],
      ['admin_granted', null, { kind: 'user', id: null, name: 'a deleted account' }],
      ['admin_user_disabled', 'Owner', { kind: 'user', id: null, name: 'Bob' }],
    ]);

    for (let i = 0; i < 25; i++) await client.patch('/api/admin/settings', { passwordMinLength: i % 2 === 0 ? 10 : 11 });
    const latest = (await client.get<AdminOverviewDTO>('/api/admin/overview')).body.recentAdminEvents;
    expect(latest).toHaveLength(20);
    expect(latest.every((e) => e.type === 'admin_settings_changed')).toBe(true);
    expect(latest[0]!.id).toBeGreaterThan(latest[19]!.id);
  });
});

describe('PATCH /api/admin/settings', () => {
  it('sets the policy and the password minimum (8-64); answers the InstanceInfoDTO; one event names what changed', async () => {
    const h = createDirectoryHarness({ vars: PUBLIC });
    const { client, user } = await h.setup();
    const res = await client.patch<InstanceInfoDTO>('/api/admin/settings', { signupPolicy: 'open', passwordMinLength: 16 });
    expect(res).toMatchObject({ status: 200, body: { signupPolicy: 'open', passwordMinLength: 16 } });
    expect((await client.get('/api/auth/status')).body.instance).toMatchObject({ signupPolicy: 'open', passwordMinLength: 16 });
    const event = h.db.get<{ user_id: number; actor_id: number; data: string }>("SELECT * FROM security_events WHERE type = 'admin_settings_changed'")!;
    expect(event).toMatchObject({ user_id: user.id, actor_id: user.id });
    expect(JSON.parse(event.data)).toEqual({ signupPolicy: { from: 'invite_only', to: 'open' }, passwordMinLength: { from: 8, to: 16 } });
    // Nothing changed: no event.
    expect((await client.patch('/api/admin/settings', { signupPolicy: 'open' })).status).toBe(200);
    expect(h.db.all("SELECT id FROM security_events WHERE type = 'admin_settings_changed'")).toHaveLength(1);
    // The minimum applies to passwords set from now on.
    const short = await client.post('/api/account/password', { currentPassword: PASSWORD, newPassword: 'fifteen chars!!' });
    expect(short).toMatchObject({ status: 400, body: { error: { details: [{ path: 'newPassword', message: 'At least 16 characters' }] } } });
    for (const passwordMinLength of [7, 65, 12.5, '12']) {
      expect((await client.patch('/api/admin/settings', { passwordMinLength })).body.error.code).toBe('validation_error');
    }
    expect((await client.patch('/api/admin/settings', { signupPolicy: 'everyone' })).body.error.code).toBe('validation_error');
  });

  it('`open` needs a transport that delivers mail: 409 mail_not_configured, before the re-auth window', async () => {
    const h = createDirectoryHarness({ vars: PUBLIC, mail: quietLog() });
    const { client } = await h.setup();
    h.clock.advance(11 * 60_000);
    expect(await client.patch('/api/admin/settings', { signupPolicy: 'open' })).toMatchObject({
      status: 409,
      body: { error: { code: 'mail_not_configured', message: 'Open sign-up needs a mail transport (MAIL_TRANSPORT)' } },
    });
    await client.post('/api/account/reauth/password', { password: PASSWORD });
    expect((await client.patch('/api/admin/settings', { signupPolicy: 'closed' })).body.signupPolicy).toBe('closed');
    expect((await client.patch('/api/admin/settings', { signupPolicy: 'open', passwordMinLength: 20 })).status).toBe(409);
    expect((await client.get('/api/auth/status')).body.instance).toMatchObject({ signupPolicy: 'closed', passwordMinLength: 8 });
  });

  it('`open` with the log transport and MAIL_LOG_BODIES (development): the sign-up links go to the log', async () => {
    const h = createDirectoryHarness({ vars: { ...PUBLIC, MAIL_LOG_BODIES: '1' }, mail: quietLog() });
    const { client } = await h.setup();
    // Invitations still go as links to copy (mail), while the links of sign-up, reset and verification can be logged.
    expect((await client.get('/api/auth/status')).body.instance).toMatchObject({ mail: false, mailLinks: true });
    expect((await client.patch('/api/admin/settings', { signupPolicy: 'open' })).body.signupPolicy).toBe('open');
    expect((await client.get<AdminOverviewDTO>('/api/admin/overview')).body.warnings).not.toContain(OPEN_WITHOUT_MAIL_WARNING);
    // Without it: neither.
    const plain = createDirectoryHarness({ vars: PUBLIC, mail: quietLog() });
    const admin = (await plain.setup()).client;
    expect((await admin.get('/api/auth/status')).body.instance).toMatchObject({ mail: false, mailLinks: false });
  });

  it('is an instance admin’s, with the re-auth window', async () => {
    const h = createDirectoryHarness({ vars: PUBLIC });
    const { client, spaceId } = await h.setup();
    const member = await h.addUser({ email: 'member@example.com', spaceId, role: 'owner' });
    expect((await h.client().patch('/api/admin/settings', { signupPolicy: 'closed' })).status).toBe(401);
    expect((await member.client.patch('/api/admin/settings', { signupPolicy: 'closed' })).status).toBe(403);
    h.clock.advance(11 * 60_000);
    expect((await client.patch('/api/admin/settings', { signupPolicy: 'closed' })).body.error.code).toBe('reauth_required');
    expect((await client.get('/api/auth/status')).body.instance.signupPolicy).toBe('invite_only');
    expect(h.db.all("SELECT id FROM security_events WHERE type = 'admin_settings_changed'")).toEqual([]);
  });
});
