// Administration → Spaces and Invitations (design §5.8.8, §5.8.16, §5.8.18, §7.2, §13.11, Appendix D 20).
// GET /api/admin/spaces lists every space the directory holds (no content): name, owners, members, state,
// size, newest first, paged and searched. DELETE soft-deletes as the owner would (the admin as deleted_by),
// POST …/restore restores within the grace period only, and only a space someone can still open. Instance
// invitations: GET/POST /api/admin/invitations and DELETE …/:invitationId. Every write needs the re-auth
// window and is an event with actor_id.

import { describe, expect, it } from 'vitest';
import type { AdminSpaceDTO, InvitationCreatedDTO, InvitationDTO, Page } from '@shared/types';
import { createLogTransport } from '../../src/mail/log';
import { addMembership, createDirectoryHarness, PASSWORD } from '../support/directoryHarness';

const PUBLIC = { PUBLIC_URL: 'https://plan.example.com' };
const DAY_MS = 86_400_000;

async function instance(o: Parameters<typeof createDirectoryHarness>[0] = {}) {
  const h = createDirectoryHarness({ vars: PUBLIC, ...o });
  const admin = await h.setup();
  return { h, admin };
}

type Instance = Awaited<ReturnType<typeof instance>>;

const events = (t: Instance, type: string) =>
  t.h.db.all<{ user_id: number | null; actor_id: number | null; data: string }>('SELECT user_id, actor_id, data FROM security_events WHERE type = :type ORDER BY id', { type });

const spaces = async (t: Instance, query = '') => (await t.admin.client.get<Page<AdminSpaceDTO>>(`/api/admin/spaces${query}`)).body;

describe('GET /api/admin/spaces', () => {
  it('every space, newest first: owners, members, state and size, never content; for instance admins only', async () => {
    // The Node stack measures the file (spaceBytes); without it (Cloudflare) the size is null.
    const sizes = new Map<string, number>();
    const t = await instance({ spaceBytes: (id) => sizes.get(id) ?? null });
    const bob = await t.h.addUser({ email: 'bob@example.com', displayName: 'Bob' });
    t.h.clock.advance(1000);
    const team = (await bob.client.post('/api/spaces', { name: 'Team' })).body.id as string;
    sizes.set(team, 8192);
    addMembership(t.h.db, { spaceId: team, userId: t.admin.user.id, role: 'member', nowMs: t.h.clock.now() });
    expect((await t.h.client().get('/api/admin/spaces')).status).toBe(401);
    expect((await bob.client.get('/api/admin/spaces')).status).toBe(403);
    const page = await spaces(t);
    expect(page.nextCursor).toBeNull();
    expect(page.items).toEqual([
      {
        id: team,
        name: 'Team',
        status: 'active',
        owners: [{ id: bob.user.id, displayName: 'Bob' }],
        memberCount: 2,
        createdAt: new Date(t.h.clock.now()).toISOString(),
        deletedAt: null,
        purgeAfter: null,
        bytes: 8192,
      },
      expect.objectContaining({ id: t.admin.spaceId, name: "Owner's space", owners: [{ id: t.admin.user.id, displayName: 'Owner' }], memberCount: 1, bytes: null }),
    ]);
    // A deleted space stays listed until its purge.
    await bob.client.delete(`/api/spaces/${team}`, { confirmName: 'Team' });
    expect((await spaces(t)).items[0]).toMatchObject({ id: team, deletedAt: expect.any(String), purgeAfter: expect.any(String) });
  });

  it('pages with a cursor of the sort key (no internal id) and searches the name, or the id exactly', async () => {
    const t = await instance();
    const ids: string[] = [];
    for (let i = 1; i <= 5; i++) {
      // Two of them at the same moment: the id breaks the tie.
      if (i !== 3) t.h.clock.advance(1000);
      ids.push((await t.admin.client.post('/api/spaces', { name: `Project ${i}` })).body.id);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: Page<AdminSpaceDTO> = await spaces(t, `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      seen.push(...page.items.map((s) => s.name));
      cursor = page.nextCursor;
      if (cursor) expect(cursor).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z_[0-9a-z]{16}$/);
    } while (cursor !== null);
    expect(seen).toHaveLength(6);
    expect(seen.slice(0, 2)).toEqual(['Project 5', 'Project 4']);
    expect(new Set(seen).size).toBe(6);
    expect(seen.at(-1)).toBe("Owner's space");
    expect((await spaces(t, '?q=PROJECT%203')).items.map((s) => s.name)).toEqual(['Project 3']);
    expect((await spaces(t, `?q=${ids[0]}`)).items.map((s) => s.name)).toEqual(['Project 1']);
    expect((await spaces(t, `?q=${ids[0]!.slice(0, 8)}`)).items).toEqual([]);
    expect((await spaces(t, '?q=owner')).items.map((s) => s.name)).toEqual(["Owner's space"]);
    for (const query of ['?cursor=nonsense', '?limit=0', '?limit=500']) {
      expect((await t.admin.client.get(`/api/admin/spaces${query}`)).status, query).toBe(400);
    }
  });
});

describe('DELETE /api/admin/spaces/:spaceId', () => {
  it('soft-deletes as the owner would, with the admin as deleted_by: everyone loses access at once; an event', async () => {
    const t = await instance();
    const bob = await t.h.addUser({ email: 'bob@example.com', displayName: 'Bob' });
    const team = (await bob.client.post('/api/spaces', { name: 'Team' })).body.id as string;
    t.h.spaces.calls.length = 0;
    const res = await t.admin.client.delete(`/api/admin/spaces/${team}`);
    expect(res).toMatchObject({ status: 200, body: { ok: true } });
    expect(Date.parse(res.body.purgeAfter) - t.h.clock.now()).toBe(7 * DAY_MS);
    expect(t.h.spaces.ids('invalidate')).toEqual([team]);
    expect(t.h.db.get('SELECT deleted_by FROM spaces WHERE public_id = :id', { id: team })).toEqual({ deleted_by: t.admin.user.id });
    expect((await bob.client.get(`/api/spaces/${team}`)).status).toBe(404);
    // Its owner can restore it like any deleted space.
    expect((await bob.client.get('/api/spaces/deleted')).body.map((s: { id: string }) => s.id)).toEqual([team]);
    expect(events(t, 'admin_space_deleted')).toEqual([{ user_id: t.admin.user.id, actor_id: t.admin.user.id, data: JSON.stringify({ space: team, name: 'Team' }) }]);
    expect(await t.admin.client.delete(`/api/admin/spaces/${team}`)).toMatchObject({ status: 409, body: { error: { message: 'This space is deleted already' } } });
    expect((await t.admin.client.delete('/api/admin/spaces/7k2m9q4w8x1c3v5b')).status).toBe(404);
    expect((await t.admin.client.delete('/api/admin/spaces/not-an-id')).status).toBe(404);
  });

  it('a space still being imported is purged at once; one being created is refused; a grace of 0 purges at once', async () => {
    const t = await instance({ vars: { ...PUBLIC, SPACE_DELETE_GRACE_DAYS: '0' } });
    const importing = (await t.admin.client.post('/api/spaces', { name: 'Import', forImport: true })).body.id as string;
    expect((await t.admin.client.delete(`/api/admin/spaces/${importing}`)).status).toBe(200);
    expect(t.h.spaces.ids('destroy')).toEqual([importing]);
    expect(t.h.db.get('SELECT 1 AS present FROM spaces WHERE public_id = :id', { id: importing })).toBeUndefined();
    t.h.db.run("UPDATE spaces SET status = 'provisioning' WHERE public_id = :id", { id: t.admin.spaceId });
    expect(await t.admin.client.delete(`/api/admin/spaces/${t.admin.spaceId}`)).toMatchObject({
      status: 409,
      body: { error: { message: 'This space is still being created. Try again in a moment.' } },
    });
    t.h.db.run("UPDATE spaces SET status = 'active' WHERE public_id = :id", { id: t.admin.spaceId });
    expect((await t.admin.client.delete(`/api/admin/spaces/${t.admin.spaceId}`)).status).toBe(200);
    expect(t.h.spaces.ids('destroy')).toEqual([importing, t.admin.spaceId]);
    expect(events(t, 'admin_space_deleted')).toHaveLength(2);
  });

  it('is an instance admin’s, with the re-auth window (asked for after the refusals)', async () => {
    const t = await instance();
    const bob = await t.h.addUser({ email: 'bob@example.com', spaceId: t.admin.spaceId, role: 'owner' });
    expect((await bob.client.delete(`/api/admin/spaces/${t.admin.spaceId}`)).status).toBe(403);
    expect((await t.h.client().delete(`/api/admin/spaces/${t.admin.spaceId}`)).status).toBe(401);
    t.h.clock.advance(11 * 60_000);
    expect((await t.admin.client.delete('/api/admin/spaces/7k2m9q4w8x1c3v5b')).status).toBe(404);
    expect((await t.admin.client.delete(`/api/admin/spaces/${t.admin.spaceId}`)).body.error.code).toBe('reauth_required');
    expect(t.h.db.get<{ deleted_at: string | null }>('SELECT deleted_at FROM spaces WHERE public_id = :id', { id: t.admin.spaceId })!.deleted_at).toBeNull();
  });
});

describe('POST /api/admin/spaces/:spaceId/restore', () => {
  it('restores within the grace period and answers the AdminSpaceDTO; an event', async () => {
    const t = await instance();
    const bob = await t.h.addUser({ email: 'bob@example.com', displayName: 'Bob' });
    const team = (await bob.client.post('/api/spaces', { name: 'Team' })).body.id as string;
    await bob.client.delete(`/api/spaces/${team}`, { confirmName: 'Team' });
    expect(await t.admin.client.post(`/api/admin/spaces/${t.admin.spaceId}/restore`)).toMatchObject({
      status: 409,
      body: { error: { message: 'This space is not deleted' } },
    });
    const res = await t.admin.client.post<AdminSpaceDTO>(`/api/admin/spaces/${team}/restore`);
    expect(res).toMatchObject({ status: 200, body: { id: team, name: 'Team', deletedAt: null, purgeAfter: null, owners: [{ id: bob.user.id }] } });
    expect((await bob.client.get(`/api/spaces/${team}`)).status).toBe(200);
    expect(events(t, 'admin_space_restored')).toEqual([{ user_id: t.admin.user.id, actor_id: t.admin.user.id, data: JSON.stringify({ space: team, name: 'Team' }) }]);
  });

  it('no restore once the grace period is over (Appendix D 20), nor of a space nobody could open again', async () => {
    const t = await instance();
    const bob = await t.h.addUser({ email: 'bob@example.com', displayName: 'Bob' });
    const team = (await bob.client.post('/api/spaces', { name: 'Team' })).body.id as string;
    await bob.client.delete(`/api/spaces/${team}`, { confirmName: 'Team' });
    t.h.clock.advance(7 * DAY_MS);
    expect(await t.admin.client.post(`/api/admin/spaces/${team}/restore`)).toMatchObject({
      status: 409,
      body: { error: { code: 'conflict', message: 'This space is being removed and can no longer be restored' } },
    });
    // Bob's account goes, and with it the only membership of his other space.
    const t2 = await instance();
    const carol = await t2.h.addUser({ email: 'carol@example.com', displayName: 'Carol' });
    const own = (await carol.client.post('/api/spaces', { name: 'Own' })).body.id as string;
    expect((await t2.admin.client.delete(`/api/admin/users/${carol.user.id}`)).status).toBe(200);
    const listed = (await t2.admin.client.get<Page<AdminSpaceDTO>>('/api/admin/spaces')).body.items.find((s) => s.id === own);
    expect(listed).toMatchObject({ memberCount: 0, owners: [], deletedAt: expect.any(String) });
    expect(await t2.admin.client.post(`/api/admin/spaces/${own}/restore`)).toMatchObject({
      status: 409,
      body: { error: { message: 'This space has no members left, so nobody could open it again' } },
    });
    // Refusals come before the re-auth window; unknown spaces are 404.
    t2.h.clock.advance(11 * 60_000);
    expect((await t2.admin.client.post(`/api/admin/spaces/${own}/restore`)).status).toBe(409);
    expect((await t2.admin.client.post('/api/admin/spaces/7k2m9q4w8x1c3v5b/restore')).status).toBe(404);
  });

  it('is an instance admin’s, with the re-auth window', async () => {
    const t = await instance();
    const bob = await t.h.addUser({ email: 'bob@example.com', displayName: 'Bob' });
    const team = (await bob.client.post('/api/spaces', { name: 'Team' })).body.id as string;
    await bob.client.delete(`/api/spaces/${team}`, { confirmName: 'Team' });
    expect((await bob.client.post(`/api/admin/spaces/${team}/restore`)).status).toBe(403);
    t.h.clock.advance(11 * 60_000);
    expect((await t.admin.client.post(`/api/admin/spaces/${team}/restore`)).body.error.code).toBe('reauth_required');
    await t.admin.client.post('/api/account/reauth/password', { password: PASSWORD });
    expect((await t.admin.client.post(`/api/admin/spaces/${team}/restore`)).status).toBe(200);
  });
});

describe('/api/admin/invitations', () => {
  it('without mail: create (a link to pass on), list and revoke instance invitations; events with the address', async () => {
    const t = await instance({ mail: createLogTransport({ logBodies: false }, () => {}) });
    const created = await t.admin.client.post<InvitationCreatedDTO>('/api/admin/invitations', { email: 'New@Example.com' });
    expect(created.status).toBe(201);
    expect(created.body.link).toMatch(/^https:\/\/plan\.example\.com\/invite#t=[A-Za-z0-9_-]{43}$/);
    expect(created.body.invitation).toMatchObject({ email: 'New@example.com', role: null, delivery: 'link', status: 'pending', invitedBy: { id: t.admin.user.id } });
    // A space's invitations are not the instance's.
    await t.admin.client.post(`/api/spaces/${t.admin.spaceId}/invitations`, { email: 'member@example.com', role: 'member' });
    const list = await t.admin.client.get<InvitationDTO[]>('/api/admin/invitations');
    expect(list.body.map((i) => i.email)).toEqual(['New@example.com']);
    expect(JSON.stringify(list.body)).not.toContain('#t=');
    // The invited address can make an account through the link.
    const accepted = await t.h.client().post('/api/invitations/accept', {
      token: created.body.link!.split('#t=')[1],
      displayName: 'New',
      password: 'a new password',
    });
    expect(accepted).toMatchObject({ status: 201, body: { spaceId: null } });

    const second = await t.admin.client.post<InvitationCreatedDTO>('/api/admin/invitations', { email: 'second@example.com' });
    expect((await t.admin.client.delete(`/api/admin/invitations/${second.body.invitation.id}`)).body).toEqual({ ok: true });
    expect((await t.admin.client.get('/api/admin/invitations')).body).toEqual([]);
    expect((await t.admin.client.delete(`/api/admin/invitations/${second.body.invitation.id}`)).status).toBe(404);
    expect(events(t, 'admin_invitation_created').map((e) => [e.actor_id, JSON.parse(e.data).email])).toEqual([
      [t.admin.user.id, 'New@example.com'],
      [t.admin.user.id, 'second@example.com'],
    ]);
    expect(events(t, 'admin_invitation_revoked').map((e) => JSON.parse(e.data))).toEqual([{ invitationId: second.body.invitation.id, email: 'second@example.com' }]);
    // A space invitation is no instance invitation to revoke here.
    const spaceInvitation = t.h.db.get<{ id: number }>('SELECT id FROM invitations WHERE space_id IS NOT NULL')!;
    expect((await t.admin.client.delete(`/api/admin/invitations/${spaceInvitation.id}`)).status).toBe(404);
  });

  it('with mail: sent at once (no link); the address of an account is refused; for instance admins with the re-auth window', async () => {
    const t = await instance();
    t.h.db.run('UPDATE users SET email_verified_at = :now', { now: new Date(t.h.clock.now()).toISOString() });
    await t.h.settle();
    t.h.outbox.length = 0;
    const res = await t.admin.client.post<InvitationCreatedDTO>('/api/admin/invitations', { email: 'friend@example.com' });
    expect(res).toMatchObject({ status: 201, body: { link: null, invitation: { delivery: 'mail' } } });
    expect(t.h.outbox.map((m) => [m.template, m.to])).toEqual([['invitation', 'friend@example.com']]);
    expect(await t.admin.client.post('/api/admin/invitations', { email: 'owner@example.com' })).toMatchObject({
      status: 409,
      body: { error: { message: 'owner@example.com already has an account' } },
    });
    const bob = await t.h.addUser({ email: 'bob@example.com', spaceId: t.admin.spaceId, role: 'owner' });
    expect((await bob.client.get('/api/admin/invitations')).status).toBe(403);
    expect((await bob.client.post('/api/admin/invitations', { email: 'x@example.com' })).status).toBe(403);
    expect((await t.h.client().get('/api/admin/invitations')).status).toBe(401);
    t.h.clock.advance(11 * 60_000);
    expect((await t.admin.client.post('/api/admin/invitations', { email: 'other@example.com' })).body.error.code).toBe('reauth_required');
    expect((await t.admin.client.delete(`/api/admin/invitations/${res.body.invitation.id}`)).body.error.code).toBe('reauth_required');
    expect((await t.admin.client.get('/api/admin/invitations')).body).toHaveLength(1);
    expect((await t.admin.client.post('/api/admin/invitations', { email: 'not an address' })).body.error.code).toBe('validation_error');
  });
});
