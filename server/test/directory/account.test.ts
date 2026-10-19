// /api/account (design §7.2): name and preferences, the password change (§5.8.12), the re-auth window
// (§5.8.14), sessions (§5.8.15), the security log, and account deletion with the last-account rule
// (§5.8.17); and writes whose body arrives late, which act on the session and account as they are then (§5).

import { describe, expect, it } from 'vitest';
import type { AuthStatusDTO, SessionDTO } from '@shared/types';
import { sha256Hex } from '../../src/core/crypto';
import { createDirectoryHarness, OWNER_EMAIL, PASSWORD } from '../support/directoryHarness';
import { heldBody, settle } from '../support/heldBody';

describe('GET/PATCH /api/account', () => {
  it('needs a session', async () => {
    const h = createDirectoryHarness();
    expect((await h.client().get('/api/account')).status).toBe(401);
    // The passkeys too (signed in, an account from setup has none).
    expect((await h.client().get('/api/account/passkeys')).status).toBe(401);
    const { client } = await h.setup();
    expect((await client.get('/api/account/passkeys')).body).toEqual([]);
  });

  it('renames the account and bumps every space that shows the name', async () => {
    const h = createDirectoryHarness();
    const { client, spaceId } = await h.setup();
    const before = h.db.get<{ sync_version: number }>('SELECT sync_version FROM spaces')!.sync_version;
    const res = await client.patch('/api/account', { displayName: '  New Name ' });
    expect(res.status).toBe(200);
    expect(res.body.displayName).toBe('New Name');
    expect(h.db.get<{ sync_version: number }>('SELECT sync_version FROM spaces')!.sync_version).toBe(before + 1);
    await h.settle();
    expect(h.spaces.ids('invalidate')).toEqual([spaceId]);
    expect((await client.get('/api/account')).body.displayName).toBe('New Name');
  });

  it('stores preferences per user, merged with what is there', async () => {
    const h = createDirectoryHarness();
    const { client } = await h.setup();
    expect((await client.patch('/api/account/preferences', { weekStartsOn: 0 })).body).toEqual({ weekStartsOn: 0, homePage: 'dashboard' });
    expect((await client.patch('/api/account/preferences', { homePage: 'default_board' })).body).toEqual({ weekStartsOn: 0, homePage: 'default_board' });
    expect((await client.patch('/api/account/preferences', { weekStartsOn: 3 })).status).toBe(400);
    expect((await client.get<AuthStatusDTO>('/api/auth/status')).body.preferences).toEqual({ weekStartsOn: 0, homePage: 'default_board' });
  });
});

describe('POST /api/account/password', () => {
  it('needs the current password, revokes the other sessions and devices, and keeps this browser', async () => {
    const h = createDirectoryHarness();
    const { client, spaceId } = await h.setup();
    const other = h.client({ ip: '198.51.100.2' });
    await other.post('/api/auth/login', { identifier: OWNER_EMAIL, password: PASSWORD });
    expect(h.db.all('SELECT id FROM device_tokens')).toHaveLength(2);
    expect((await client.post('/api/account/password', { newPassword: 'second password' })).status).toBe(400);
    const bad = await client.post('/api/account/password', { currentPassword: 'nope', newPassword: 'second password' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details).toEqual([{ path: 'currentPassword', message: 'Incorrect password' }]);
    const short = await client.post('/api/account/password', { currentPassword: PASSWORD, newPassword: 'short' });
    expect(short.status).toBe(400);
    h.spaces.calls.length = 0;
    const ok = await client.post('/api/account/password', { currentPassword: PASSWORD, newPassword: 'second password' });
    expect(ok.status).toBe(200);
    // The push to the user's spaces is awaited before the answer.
    expect(h.spaces.ids('invalidate')).toEqual([spaceId]);
    expect((await other.get('/api/account')).status).toBe(401);
    expect((await client.get('/api/account')).status).toBe(200);
    const devices = h.db.all<{ token_hash: string }>('SELECT token_hash FROM device_tokens');
    expect(devices).toEqual([{ token_hash: sha256Hex(client.jar.get('lyren_device')!) }]);
    const user = h.db.get<{ auth_epoch: number; password_changed_at: string }>('SELECT * FROM users')!;
    expect(user.auth_epoch).toBe(1);
    expect(h.db.all("SELECT type FROM security_events WHERE type = 'password_changed'")).toHaveLength(1);
    expect((await h.client().post('/api/auth/login', { identifier: OWNER_EMAIL, password: 'second password' })).status).toBe(200);
    expect((await h.client().post('/api/auth/login', { identifier: OWNER_EMAIL, password: PASSWORD })).status).toBe(401);
  });

  it('a correct current password opens the re-auth window', async () => {
    const h = createDirectoryHarness();
    const { client } = await h.setup();
    h.clock.advance(20 * 60_000);
    expect((await client.get<AuthStatusDTO>('/api/auth/status')).body.reauthUntil).toBeNull();
    await client.post('/api/account/password', { currentPassword: PASSWORD, newPassword: 'second password' });
    expect((await client.get<AuthStatusDTO>('/api/auth/status')).body.reauthUntil).toBe(new Date(h.clock.now() + 10 * 60_000).toISOString());
  });

  it('an account without a password needs the re-auth window to set one', async () => {
    const h = createDirectoryHarness();
    const { client } = await h.setup();
    h.db.run('UPDATE users SET password_hash = NULL');
    h.clock.advance(11 * 60_000);
    const res = await client.post('/api/account/password', { newPassword: 'a new password' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('reauth_required');
  });
});

describe('POST /api/account/reauth/password', () => {
  it('opens the window with the right password; wrong ones count on li', async () => {
    const h = createDirectoryHarness();
    const { client } = await h.setup();
    h.clock.advance(11 * 60_000);
    const wrong = await client.post('/api/account/reauth/password', { password: 'nope' });
    expect(wrong.status).toBe(400);
    const ok = await client.post('/api/account/reauth/password', { password: PASSWORD });
    expect(ok.body).toEqual({ ok: true, reauthUntil: new Date(h.clock.now() + 10 * 60_000).toISOString() });
    for (let i = 0; i < 10; i++) await client.post('/api/account/reauth/password', { password: 'nope' });
    expect((await client.post('/api/account/reauth/password', { password: PASSWORD })).status).toBe(429);
  });
});

describe('/api/account/sessions', () => {
  it('lists the sessions with their method, revokes one, and the current one with its cookie', async () => {
    const h = createDirectoryHarness();
    const { client } = await h.setup();
    const other = h.client({ userAgent: 'Other browser' });
    await other.post('/api/auth/login', { identifier: OWNER_EMAIL, password: PASSWORD });
    const list = await client.get<SessionDTO[]>('/api/account/sessions');
    expect(list.body.map((s) => [s.authMethod, s.current])).toEqual(
      expect.arrayContaining([
        ['setup', true],
        ['password', false],
      ]),
    );
    const otherId = list.body.find((s) => !s.current)!.id;
    expect((await client.delete(`/api/account/sessions/${otherId}`)).status).toBe(200);
    expect((await other.get('/api/account')).status).toBe(401);
    expect((await client.delete(`/api/account/sessions/${otherId}`)).status).toBe(404);
    const currentId = list.body.find((s) => s.current)!.id;
    const self = await client.delete(`/api/account/sessions/${currentId}`);
    expect(self.setCookies).toEqual(['lyren_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax']);
    expect((await client.get('/api/account')).status).toBe(401);
  });

  it("cannot touch another account's session", async () => {
    const h = createDirectoryHarness();
    const { client, spaceId } = await h.setup();
    const member = await h.addUser({ email: 'member@example.com', spaceId });
    const theirs = (await member.client.get<SessionDTO[]>('/api/account/sessions')).body[0]!.id;
    expect((await client.delete(`/api/account/sessions/${theirs}`)).status).toBe(404);
    expect((await member.client.get('/api/account')).status).toBe(200);
  });

  it('revoke-others signs out every other session and pushes to the spaces', async () => {
    const h = createDirectoryHarness();
    const { client, spaceId } = await h.setup();
    const a = h.client();
    const b = h.client();
    await a.post('/api/auth/login', { identifier: OWNER_EMAIL, password: PASSWORD });
    await b.post('/api/auth/login', { identifier: OWNER_EMAIL, password: PASSWORD });
    h.spaces.calls.length = 0;
    const res = await client.post('/api/account/sessions/revoke-others');
    expect(res.body).toEqual({ ok: true, revoked: 2 });
    expect(h.spaces.ids('invalidate')).toEqual([spaceId]);
    expect((await a.get('/api/account')).status).toBe(401);
    expect((await client.get('/api/account')).status).toBe(200);
    const events = await client.get('/api/account/security-events');
    expect(events.body.map((e: { type: string }) => e.type)).toEqual(['sessions_revoked', 'login', 'login', 'account_created']);
    expect(events.body[0]).toMatchObject({ ip: '192.0.2.10', userAgent: 'vitest', data: { revoked: 2 } });
  });
});

describe('/api/account/security-events and notices', () => {
  it('pages by id, newest first, 50 at a time', async () => {
    const h = createDirectoryHarness();
    const { client, user } = await h.setup();
    for (let i = 0; i < 60; i++) {
      h.db.run("INSERT INTO security_events (user_id, type, data, created_at) VALUES (:u, 'login', '{}', :now)", {
        u: user.id,
        now: new Date(h.clock.now()).toISOString(),
      });
    }
    const first = await client.get('/api/account/security-events');
    expect(first.body).toHaveLength(50);
    const before = first.body[49].id;
    const second = await client.get(`/api/account/security-events?before=${before}`);
    expect(second.body).toHaveLength(11);
    expect(second.body[0].id).toBe(before - 1);
  });

  it('lists unseen notices until they are marked seen', async () => {
    const h = createDirectoryHarness();
    const { client, user } = await h.setup();
    h.db.run("INSERT INTO security_events (user_id, actor_id, type, data, created_at) VALUES (:u, :u, 'admin_reset_link', '{}', :now)", {
      u: user.id,
      now: new Date(h.clock.now()).toISOString(),
    });
    expect((await client.get<AuthStatusDTO>('/api/auth/status')).body.notices).toEqual([
      { id: expect.any(Number), type: 'admin_reset_link', actorName: 'Owner', createdAt: new Date(h.clock.now()).toISOString() },
    ]);
    h.clock.advance(1000);
    expect((await client.post('/api/account/notices/seen')).status).toBe(200);
    expect((await client.get<AuthStatusDTO>('/api/auth/status')).body.notices).toEqual([]);
  });
});

describe('DELETE /api/account (§5.8.17)', () => {
  it('the last account can never be deleted: 409 last_admin', async () => {
    const h = createDirectoryHarness();
    const { client } = await h.setup();
    const res = await client.delete('/api/account', { confirm: OWNER_EMAIL });
    expect(res.status).toBe(409);
    expect(res.body.error).toEqual({ code: 'last_admin', message: 'This is the only account. To reset the instance, delete its data.' });
  });

  it('the last active admin cannot be deleted while other accounts exist either', async () => {
    const h = createDirectoryHarness();
    const { client } = await h.setup();
    await h.addUser({ email: 'second@example.com' });
    const res = await client.delete('/api/account', { confirm: OWNER_EMAIL });
    expect(res.body.error).toEqual({ code: 'last_admin', message: 'Make another account an administrator first' });
  });

  it('refuses while the account is the only owner of a space with other members', async () => {
    const h = createDirectoryHarness();
    const { spaceId } = await h.setup();
    const admin2 = await h.addUser({ email: 'second@example.com', isInstanceAdmin: true, spaceId, role: 'member' });
    // The owner is the only owner of that space; second is a member there. Owner deletes: last_owner.
    const owner = h.client();
    await owner.post('/api/auth/login', { identifier: OWNER_EMAIL, password: PASSWORD });
    const res = await owner.delete('/api/account', { confirm: OWNER_EMAIL });
    expect(res.status).toBe(409);
    expect(res.body.error).toEqual({
      code: 'last_owner',
      message: 'Transfer ownership or delete these spaces first',
      details: [{ path: `spaces.${spaceId}`, message: "Owner's space" }],
    });
    expect(admin2.user.isInstanceAdmin).toBe(true);
  });

  it('needs the re-auth window and the account address as confirmation', async () => {
    const h = createDirectoryHarness();
    await h.setup();
    const { client } = await h.addUser({ email: 'member@example.com' });
    h.clock.advance(11 * 60_000);
    expect((await client.delete('/api/account', { confirm: 'member@example.com' })).body.error.code).toBe('reauth_required');
    await client.post('/api/account/reauth/password', { password: PASSWORD });
    const wrong = await client.delete('/api/account', { confirm: 'someone@example.com' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.details).toEqual([{ path: 'confirm', message: 'Type member@example.com to confirm' }]);
  });

  it('deletes the account: its lonely spaces are soft-deleted, its other spaces are bumped and pushed', async () => {
    const h = createDirectoryHarness();
    const { client: ownerClient, spaceId: shared } = await h.setup();
    const { client, user } = await h.addUser({ email: 'member@example.com', spaceId: shared, role: 'member' });
    const own = await client.post('/api/spaces', { name: 'Mine' });
    expect(own.status).toBe(201);
    const before = h.db.get<{ sync_version: number }>('SELECT sync_version FROM spaces WHERE public_id = :id', { id: shared })!.sync_version;
    h.spaces.calls.length = 0;
    const res = await client.delete('/api/account', { confirm: 'MEMBER@example.com' });
    expect(res.status).toBe(200);
    expect(res.setCookies).toEqual([
      'lyren_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax',
      'lyren_device=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax',
    ]);
    expect(h.db.get('SELECT id FROM users WHERE id = :id', { id: user.id })).toBeUndefined();
    expect(h.db.get<{ sync_version: number }>('SELECT sync_version FROM spaces WHERE public_id = :id', { id: shared })!.sync_version).toBe(before + 1);
    expect(h.db.get<{ deleted_at: string | null }>('SELECT deleted_at FROM spaces WHERE public_id = :id', { id: own.body.id })!.deleted_at).not.toBeNull();
    expect(h.spaces.ids('invalidate').sort()).toEqual([shared, own.body.id].sort());
    expect(h.db.get('SELECT data FROM security_events WHERE type = :t', { t: 'account_deleted' })).toEqual({ data: JSON.stringify({ userId: user.id }) });
    expect(h.db.all('SELECT id FROM sessions WHERE user_id = :id', { id: user.id })).toEqual([]);
    // The space's sync tells it the account is gone.
    const sync = await h.service.spaceSync({ spaceId: shared, mirrorUserIds: [user.id] });
    expect(sync?.others).toEqual([{ userId: user.id, deleted: true }]);
    expect((await ownerClient.get('/api/account')).status).toBe(200);
  });

  it('with SPACE_DELETE_GRACE_DAYS=0 the lonely spaces are purged at once', async () => {
    const h = createDirectoryHarness({ vars: { SPACE_DELETE_GRACE_DAYS: '0' } });
    await h.setup();
    const { client } = await h.addUser({ email: 'member@example.com' });
    const own = await client.post('/api/spaces', { name: 'Mine' });
    await client.delete('/api/account', { confirm: 'member@example.com' });
    expect(h.spaces.ids('destroy')).toEqual([own.body.id]);
    expect(h.db.get('SELECT id FROM spaces WHERE public_id = :id', { id: own.body.id })).toBeUndefined();
  });
});

describe('a write whose body arrives late acts on the state after it (§5)', () => {
  it('a session revoked meanwhile renames nothing and changes no password (401)', async () => {
    const h = createDirectoryHarness();
    const { client } = await h.setup();
    const rename = heldBody({ displayName: 'Thief' });
    const password = heldBody({ currentPassword: PASSWORD, newPassword: 'chosen by the thief' });
    const pending = [
      client.request('PATCH', '/api/account', rename.stream, rename.headers),
      client.request('POST', '/api/account/password', password.stream, password.headers),
    ];
    await settle();
    const other = h.client();
    expect((await other.post('/api/auth/login', { identifier: OWNER_EMAIL, password: PASSWORD })).status).toBe(200);
    expect((await other.post('/api/account/sessions/revoke-others')).status).toBe(200);
    rename.release();
    password.release();
    expect((await Promise.all(pending)).map((r) => r.status)).toEqual([401, 401]);
    expect((await other.get('/api/account')).body.displayName).toBe('Owner');
    expect((await h.client().post('/api/auth/login', { identifier: OWNER_EMAIL, password: PASSWORD })).status).toBe(200);
  });

  it('the last-admin rule sees the account as it is once the body has arrived', async () => {
    const h = createDirectoryHarness();
    const { user: first } = await h.setup();
    const second = await h.addUser({ email: 'second@example.com' });
    const confirm = heldBody({ confirm: 'second@example.com' });
    const pending = second.client.request('DELETE', '/api/account', confirm.stream, confirm.headers);
    await settle();
    // Meanwhile the account becomes the only administrator (as an admin promotion and demotion would do).
    h.db.run('UPDATE users SET is_instance_admin = (id = :second)', { second: second.user.id });
    confirm.release();
    const res = await pending;
    expect(res.body.error.code).toBe('last_admin');
    expect(h.db.all('SELECT id FROM users ORDER BY id')).toEqual([{ id: first.id }, { id: second.user.id }]);
  });
});
