// Administration → Users (design §5.8.17, §5.8.18, §7.2): GET /api/admin/users (newest first, paged with a
// cursor, searched in the address, the username and the name), GET /api/admin/users/:userId (its spaces and
// security log), PATCH (disable and enable, promote and demote: never one's own account, the last active
// admin stays one) and DELETE (§5.8.17 with the admin as the actor). Every write needs the re-auth window
// and is an event with actor_id. Disabling ends the account's sessions and device tokens, revokes its open
// invitations and tells its spaces before it answers; demoting revokes the instance invitations it sent.

import { describe, expect, it } from 'vitest';
import type { AdminUserDetailDTO, AdminUserDTO, Page } from '@shared/types';
import { changeUser, NOT_SELF } from '../../src/directory/admin';
import { createInvitation } from '../../src/directory/invitations';
import { findUser } from '../../src/directory/users';
import { addMembership, createDirectoryHarness, PASSWORD, testMeta } from '../support/directoryHarness';

const PUBLIC = { PUBLIC_URL: 'https://plan.example.com' };

async function instance(o: Parameters<typeof createDirectoryHarness>[0] = {}) {
  const h = createDirectoryHarness({ vars: PUBLIC, ...o });
  const admin = await h.setup();
  return { h, admin };
}

type Instance = Awaited<ReturnType<typeof instance>>;

const verifyAll = (t: Instance) => t.h.db.run('UPDATE users SET email_verified_at = :now', { now: new Date(t.h.clock.now()).toISOString() });

const events = (t: Instance, type: string) =>
  t.h.db.all<{ user_id: number | null; actor_id: number | null; data: string }>('SELECT user_id, actor_id, data FROM security_events WHERE type = :type ORDER BY id', { type });

describe('GET /api/admin/users', () => {
  it('newest first, 50 a page by default, with a cursor; for instance admins only', async () => {
    const t = await instance();
    for (let i = 1; i <= 6; i++) await t.h.addUser({ email: `user${i}@example.com`, displayName: `User ${i}` });
    const member = await t.h.addUser({ email: 'member@example.com', spaceId: t.admin.spaceId });
    expect((await t.h.client().get('/api/admin/users')).status).toBe(401);
    expect((await member.client.get('/api/admin/users')).status).toBe(403);

    const all = await t.admin.client.get<Page<AdminUserDTO>>('/api/admin/users');
    expect(all.body.items.map((u) => u.email)).toEqual([
      'member@example.com',
      ...[6, 5, 4, 3, 2, 1].map((i) => `user${i}@example.com`),
      'owner@example.com',
    ]);
    expect(all.body.nextCursor).toBeNull();
    expect(all.body.items.at(-1)).toEqual({
      id: t.admin.user.id,
      email: 'owner@example.com',
      username: null,
      displayName: 'Owner',
      emailVerified: false,
      isInstanceAdmin: true,
      status: 'active',
      hasPassword: true,
      passkeys: 0,
      usablePasskeys: 0,
      spaces: 1,
      createdAt: t.admin.user.createdAt,
      // Setup signed it in.
      lastLoginAt: expect.any(String),
    });
    expect(all.body.items[0]).toMatchObject({ spaces: 1, isInstanceAdmin: false, lastLoginAt: expect.any(String) });

    const pages: string[][] = [];
    let cursor: string | null = null;
    do {
      const res: { body: Page<AdminUserDTO> } = await t.admin.client.get(`/api/admin/users?limit=3${cursor ? `&cursor=${cursor}` : ''}`);
      pages.push(res.body.items.map((u) => u.displayName));
      cursor = res.body.nextCursor;
    } while (cursor !== null);
    expect(pages).toEqual([
      ['member', 'User 6', 'User 5'],
      ['User 4', 'User 3', 'User 2'],
      ['User 1', 'Owner'],
    ]);
    for (const query of ['limit=0', 'limit=101', 'cursor=abc', 'cursor=-1', `q=${'x'.repeat(101)}`]) {
      expect((await t.admin.client.get(`/api/admin/users?${query}`)).body.error.code, query).toBe('validation_error');
    }
  });

  it('searches the address, the legacy username and the name, ASCII case-insensitively', async () => {
    const t = await instance();
    await t.h.addUser({ email: 'ann@example.org', displayName: 'Ann Lee' });
    await t.h.addUser({ email: 'bert@example.com', displayName: 'Bert Ånstrom' });
    const legacy = await t.h.addUser({ email: 'legacy@example.com', displayName: 'Old Timer' });
    t.h.db.run("UPDATE users SET email = NULL, email_key = NULL, username = 'TheLegacy' WHERE id = :id", { id: legacy.user.id });
    const names = async (q: string) =>
      (await t.admin.client.get<Page<AdminUserDTO>>(`/api/admin/users?q=${encodeURIComponent(q)}`)).body.items.map((u) => u.displayName);
    expect(await names('ANN')).toEqual(['Ann Lee']);
    expect(await names('example.org')).toEqual(['Ann Lee']);
    expect(await names('@EXAMPLE.COM')).toEqual(['Bert Ånstrom', 'Owner']);
    expect(await names('thelegacy')).toEqual(['Old Timer']);
    expect(await names('Ånstrom')).toEqual(['Bert Ånstrom']);
    expect(await names('  lee ')).toEqual(['Ann Lee']);
    expect(await names('')).toHaveLength(4);
    expect(await names('nobody')).toEqual([]);
    // A search with a percent sign or an underscore matches them literally (instr, never LIKE).
    expect(await names('%')).toEqual([]);
    expect(await names('_')).toEqual([]);
  });
});

describe('GET /api/admin/users/:userId', () => {
  it('the account, the spaces it is a member of (not deleted ones) and its last 50 security events', async () => {
    const t = await instance();
    const bob = await t.h.addUser({ email: 'bob@example.com', displayName: 'Bob', spaceId: t.admin.spaceId, role: 'admin' });
    const own = (await bob.client.post('/api/spaces', { name: 'Bob’s own' })).body.id as string;
    const gone = (await bob.client.post('/api/spaces', { name: 'Gone' })).body.id as string;
    await bob.client.delete(`/api/spaces/${gone}`, { confirmName: 'Gone' });
    for (let i = 0; i < 55; i++) await bob.client.post('/api/account/sessions/revoke-others');
    const res = await t.admin.client.get<AdminUserDetailDTO>(`/api/admin/users/${bob.user.id}`);
    expect(res.body).toMatchObject({ id: bob.user.id, displayName: 'Bob', spaces: 2 });
    expect(res.body.memberships).toEqual([
      { space: { id: own, name: 'Bob’s own' }, role: 'owner' },
      { space: { id: t.admin.spaceId, name: "Owner's space" }, role: 'admin' },
    ]);
    expect(res.body.events).toHaveLength(50);
    expect(res.body.events[0]).toMatchObject({ type: 'sessions_revoked', ip: '192.0.2.10' });
    expect((await t.admin.client.get('/api/admin/users/999')).status).toBe(404);
    expect((await t.admin.client.get('/api/admin/users/abc')).status).toBe(400);
  });

  it('the account’s own log shows no address or user agent of the admin or operator who acted on it; the admin’s view does', async () => {
    const t = await instance({ vars: { ...PUBLIC, RECOVERY_TOKEN: 'r'.repeat(40) } });
    const admin = t.h.client({ ip: '203.0.113.99', userAgent: 'AdminBrowser/1.0' });
    await admin.post('/api/auth/login', { identifier: 'owner@example.com', password: PASSWORD });
    const bob = await t.h.addUser({ email: 'bob@example.com', displayName: 'Bob' });
    expect((await admin.post(`/api/admin/users/${bob.user.id}/reset-link`)).status).toBe(200);
    expect((await admin.patch(`/api/admin/users/${bob.user.id}`, { isInstanceAdmin: true })).status).toBe(200);
    const operator = t.h.client({ ip: '203.0.113.100', userAgent: 'OperatorBrowser/1.0' });
    expect((await operator.post('/api/auth/recover', { token: 'r'.repeat(40), identifier: 'bob@example.com' })).status).toBe(200);
    await t.h.settle();
    const facts = (list: Array<{ type: string; ip: string | null; userAgent: string | null }>) =>
      list.filter((e) => e.type !== 'login').map((e) => [e.type, e.ip, e.userAgent]);
    expect(facts((await bob.client.get('/api/account/security-events')).body)).toEqual([
      ['recovery_used', null, null],
      ['admin_granted', null, null],
      ['admin_reset_link', null, null],
    ]);
    expect(facts((await admin.get<AdminUserDetailDTO>(`/api/admin/users/${bob.user.id}`)).body.events)).toEqual([
      ['recovery_used', '203.0.113.100', 'OperatorBrowser/1.0'],
      ['admin_granted', '203.0.113.99', 'AdminBrowser/1.0'],
      ['admin_reset_link', '203.0.113.99', 'AdminBrowser/1.0'],
    ]);
    // The account's own requests keep theirs.
    expect((await bob.client.get('/api/account/security-events')).body.find((e: { type: string }) => e.type === 'login')).toMatchObject({ ip: '192.0.2.10' });
  });
});

describe('PATCH /api/admin/users/:userId', () => {
  it('disabling ends the sessions and device tokens, revokes the open invitations, and tells the spaces before it answers', async () => {
    const t = await instance();
    verifyAll(t);
    const bob = await t.h.addUser({ email: 'bob@example.com', displayName: 'Bob', spaceId: t.admin.spaceId, role: 'admin' });
    verifyAll(t);
    const bobSpace = (await bob.client.post('/api/spaces', { name: 'Bob’s' })).body.id as string;
    expect((await bob.client.post(`/api/spaces/${t.admin.spaceId}/invitations`, { email: 'carol@example.com', role: 'member' })).status).toBe(201);
    expect(t.h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM device_tokens WHERE user_id = :id', { id: bob.user.id })!.n).toBe(1);
    await t.h.settle();
    t.h.spaces.calls.length = 0;
    // The pushes are awaited: held, the answer waits for them.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const invalidate = t.h.spaces.invalidate.bind(t.h.spaces);
    t.h.spaces.invalidate = async (id) => {
      await invalidate(id);
      await held;
    };
    let answered = false;
    const pending = t.admin.client.patch<AdminUserDTO>(`/api/admin/users/${bob.user.id}`, { status: 'disabled' }).then((res) => {
      answered = true;
      return res;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(answered).toBe(false);
    expect(t.h.spaces.ids('invalidate').sort()).toEqual([bobSpace, t.admin.spaceId].sort());
    release();
    const res = await pending;
    expect(res).toMatchObject({ status: 200, body: { id: bob.user.id, status: 'disabled' } });

    expect(t.h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sessions WHERE user_id = :id', { id: bob.user.id })!.n).toBe(0);
    expect(t.h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM device_tokens WHERE user_id = :id', { id: bob.user.id })!.n).toBe(0);
    expect(t.h.db.all('SELECT id FROM invitations WHERE invited_by = :id AND revoked_at IS NULL', { id: bob.user.id })).toEqual([]);
    expect((await bob.client.get('/api/account')).status).toBe(401);
    expect(await t.h.client().post('/api/auth/login', { identifier: 'bob@example.com', password: PASSWORD })).toMatchObject({
      status: 403,
      body: { error: { code: 'account_disabled' } },
    });
    expect(events(t, 'admin_user_disabled')).toEqual([{ user_id: bob.user.id, actor_id: t.admin.user.id, data: '{"displayName":"Bob"}' }]);
    // Still a member, listed as disabled.
    const members = (await t.admin.client.get(`/api/spaces/${t.admin.spaceId}/members`)).body as Array<{ userId: number; status: string }>;
    expect(members.find((m) => m.userId === bob.user.id)?.status).toBe('disabled');

    // Enabling: signs in again.
    expect((await t.admin.client.patch(`/api/admin/users/${bob.user.id}`, { status: 'active' })).body.status).toBe('active');
    expect((await t.h.client().post('/api/auth/login', { identifier: 'bob@example.com', password: PASSWORD })).status).toBe(200);
    expect(events(t, 'admin_user_enabled')).toEqual([{ user_id: bob.user.id, actor_id: t.admin.user.id, data: '{"displayName":"Bob"}' }]);
  });

  it('promoting and demoting; a demoted admin’s instance invitations are revoked, its space invitations stay', async () => {
    const t = await instance();
    verifyAll(t);
    const bob = await t.h.addUser({ email: 'bob@example.com', displayName: 'Bob', spaceId: t.admin.spaceId, role: 'admin' });
    verifyAll(t);
    expect(await t.admin.client.patch(`/api/admin/users/${bob.user.id}`, { isInstanceAdmin: true })).toMatchObject({
      status: 200,
      body: { isInstanceAdmin: true },
    });
    expect((await bob.client.get('/api/admin/users')).status).toBe(200);
    expect((await bob.client.post('/api/admin/invitations', { email: 'new@example.com' })).status).toBe(201);
    expect((await bob.client.post(`/api/spaces/${t.admin.spaceId}/invitations`, { email: 'carol@example.com', role: 'member' })).status).toBe(201);

    expect((await t.admin.client.patch(`/api/admin/users/${bob.user.id}`, { isInstanceAdmin: false })).body.isInstanceAdmin).toBe(false);
    const open = t.h.db.all<{ email: string }>('SELECT email FROM invitations WHERE invited_by = :id AND revoked_at IS NULL', { id: bob.user.id });
    expect(open.map((i) => i.email)).toEqual(['carol@example.com']);
    expect((await bob.client.get('/api/admin/users')).status).toBe(403);
    expect(events(t, 'admin_granted')).toEqual([{ user_id: bob.user.id, actor_id: t.admin.user.id, data: '{"displayName":"Bob"}' }]);
    expect(events(t, 'admin_revoked')).toEqual([{ user_id: bob.user.id, actor_id: t.admin.user.id, data: '{"displayName":"Bob"}' }]);
    // Both at once: one event each.
    expect((await t.admin.client.patch(`/api/admin/users/${bob.user.id}`, { isInstanceAdmin: true, status: 'disabled' })).body).toMatchObject({
      isInstanceAdmin: true,
      status: 'disabled',
    });
    expect(events(t, 'admin_granted')).toHaveLength(2);
    expect(events(t, 'admin_user_disabled')).toHaveLength(1);
    // A change to what is already so writes nothing.
    await t.admin.client.patch(`/api/admin/users/${bob.user.id}`, { isInstanceAdmin: true, status: 'disabled' });
    expect(t.h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM security_events WHERE type LIKE 'admin%'")!.n).toBe(5);
  });

  it('never one’s own account, before anything else; for instance admins with the re-auth window', async () => {
    const t = await instance();
    const bob = await t.h.addUser({ email: 'bob@example.com', spaceId: t.admin.spaceId, role: 'owner' });
    expect((await t.h.client().patch(`/api/admin/users/${bob.user.id}`, { status: 'disabled' })).status).toBe(401);
    expect((await bob.client.patch(`/api/admin/users/${t.admin.user.id}`, { status: 'disabled' })).status).toBe(403);
    t.h.clock.advance(11 * 60_000);
    for (const change of [{ status: 'disabled' }, { isInstanceAdmin: false }, {}]) {
      expect(await t.admin.client.patch(`/api/admin/users/${t.admin.user.id}`, change)).toMatchObject({
        status: 403,
        body: { error: { code: 'forbidden', message: NOT_SELF.change } },
      });
    }
    expect((await t.admin.client.patch('/api/admin/users/999', { status: 'disabled' })).status).toBe(404);
    expect((await t.admin.client.patch(`/api/admin/users/${bob.user.id}`, { status: 'disabled' })).body.error.code).toBe('reauth_required');
    expect((await t.admin.client.patch(`/api/admin/users/${bob.user.id}`, { status: 'gone' })).body.error.code).toBe('validation_error');
    expect(findUser(t.h.db, bob.user.id)!.status).toBe('active');
    await t.admin.client.post('/api/account/reauth/password', { password: PASSWORD });
    expect((await t.admin.client.patch(`/api/admin/users/${bob.user.id}`, { status: 'disabled' })).status).toBe(200);
  });

  it('the last active admin is neither disabled nor demoted (409 last_admin), checked again in the transaction', async () => {
    const t = await instance();
    const other = await t.h.addUser({ email: 'other@example.com', isInstanceAdmin: true });
    // Through the API another active admin always acts; the rule holds where a race could break it.
    const actor = findUser(t.h.db, other.user.id)!;
    t.h.db.run("UPDATE users SET status = 'disabled' WHERE id = :id", { id: other.user.id });
    for (const change of [{ status: 'disabled' as const }, { isInstanceAdmin: false }]) {
      expect(() => changeUser(t.h.ctx, { actor, targetId: t.admin.user.id, change, meta: testMeta() })).toThrow(
        expect.objectContaining({ status: 409, code: 'last_admin', message: 'This is the only active administrator. Make another account an administrator first' }),
      );
    }
    // A disabled admin is no active one: it can be demoted.
    expect(changeUser(t.h.ctx, { actor: findUser(t.h.db, t.admin.user.id)!, targetId: other.user.id, change: { isInstanceAdmin: false }, meta: testMeta() }).user).toMatchObject({
      isInstanceAdmin: false,
      status: 'disabled',
    });
    expect(findUser(t.h.db, t.admin.user.id)).toMatchObject({ is_instance_admin: 1, status: 'active' });
  });
});

describe('DELETE /api/admin/users/:userId', () => {
  it('follows §5.8.17 with the admin as the actor: spaces of its own go, its invitations are revoked, its spaces are told', async () => {
    const t = await instance();
    verifyAll(t);
    const bob = await t.h.addUser({ email: 'bob@example.com', displayName: 'Bob', spaceId: t.admin.spaceId, role: 'admin' });
    verifyAll(t);
    const alone = (await bob.client.post('/api/spaces', { name: 'Bob alone' })).body.id as string;
    expect((await bob.client.post(`/api/spaces/${t.admin.spaceId}/invitations`, { email: 'carol@example.com', role: 'member' })).status).toBe(201);
    await t.h.settle();
    t.h.spaces.calls.length = 0;
    const res = await t.admin.client.delete(`/api/admin/users/${bob.user.id}`);
    expect(res).toMatchObject({ status: 200, body: { ok: true } });
    expect(findUser(t.h.db, bob.user.id)).toBeNull();
    expect(t.h.spaces.ids('invalidate').sort()).toEqual([alone, t.admin.spaceId].sort());
    expect(t.h.db.get<{ deleted_at: string | null }>('SELECT deleted_at FROM spaces WHERE public_id = :id', { id: alone })!.deleted_at).not.toBeNull();
    expect(t.h.db.all('SELECT id FROM invitations WHERE revoked_at IS NULL')).toEqual([]);
    expect(events(t, 'admin_user_deleted')).toEqual([{ user_id: null, actor_id: t.admin.user.id, data: JSON.stringify({ userId: bob.user.id, displayName: 'Bob' }) }]);
    expect(events(t, 'account_deleted')).toEqual([]);
    expect((await bob.client.get('/api/account')).status).toBe(401);
    expect((await t.admin.client.delete(`/api/admin/users/${bob.user.id}`)).status).toBe(404);
  });

  it('refuses one’s own account and the only owner of a shared space (409 last_owner), before the re-auth window', async () => {
    const t = await instance();
    const bob = await t.h.addUser({ email: 'bob@example.com', displayName: 'Bob' });
    const shared = (await bob.client.post('/api/spaces', { name: 'Shared' })).body.id as string;
    addMembership(t.h.db, { spaceId: shared, userId: t.admin.user.id, role: 'member', nowMs: t.h.clock.now() });
    t.h.clock.advance(11 * 60_000);
    expect(await t.admin.client.delete(`/api/admin/users/${t.admin.user.id}`)).toMatchObject({
      status: 403,
      body: { error: { code: 'forbidden', message: NOT_SELF.delete } },
    });
    expect(await t.admin.client.delete(`/api/admin/users/${bob.user.id}`)).toMatchObject({
      status: 409,
      body: {
        error: {
          code: 'last_owner',
          message: 'Bob is the only owner of spaces that have other members. One of those members must become an owner first',
          details: [{ path: `spaces.${shared}`, message: 'Shared' }],
        },
      },
    });
    t.h.db.run("UPDATE memberships SET role = 'owner' WHERE user_id = :id", { id: t.admin.user.id });
    expect((await t.admin.client.delete(`/api/admin/users/${bob.user.id}`)).body.error.code).toBe('reauth_required');
    await t.admin.client.post('/api/account/reauth/password', { password: PASSWORD });
    expect((await t.admin.client.delete(`/api/admin/users/${bob.user.id}`)).status).toBe(200);
  });

  it('is an instance admin’s; with a space grace of 0 the account’s own spaces are purged at once', async () => {
    const t = await instance({ vars: { ...PUBLIC, SPACE_DELETE_GRACE_DAYS: '0' } });
    const bob = await t.h.addUser({ email: 'bob@example.com' });
    const own = (await bob.client.post('/api/spaces', { name: 'Own' })).body.id as string;
    expect((await bob.client.delete(`/api/admin/users/${t.admin.user.id}`)).status).toBe(403);
    expect((await t.h.client().delete(`/api/admin/users/${bob.user.id}`)).status).toBe(401);
    expect((await t.admin.client.delete(`/api/admin/users/${bob.user.id}`)).status).toBe(200);
    expect(t.h.spaces.ids('destroy')).toEqual([own]);
    expect(t.h.db.get('SELECT 1 AS present FROM spaces WHERE public_id = :id', { id: own })).toBeUndefined();
  });
});

describe('instance invitations of a demoted or deleted admin', () => {
  it('createInvitation through the routes is the admin’s; a deleted inviter’s are revoked with it', async () => {
    const t = await instance();
    verifyAll(t);
    const other = await t.h.addUser({ email: 'other@example.com', isInstanceAdmin: true });
    verifyAll(t);
    const inviter = findUser(t.h.db, other.user.id)!;
    await createInvitation(t.h.ctx, { inviter, space: null, email: { address: 'x@example.com', key: 'x@example.com' }, role: null, meta: testMeta() });
    expect((await t.admin.client.delete(`/api/admin/users/${other.user.id}`)).status).toBe(200);
    expect(t.h.db.all('SELECT id FROM invitations WHERE revoked_at IS NULL')).toEqual([]);
  });
});
