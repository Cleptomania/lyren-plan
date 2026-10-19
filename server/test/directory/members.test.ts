// Memberships through the API (design §6.3, §6.2): the whole role-change and removal matrix, the
// re-auth column, nobody changing their own role, leaving, transferring ownership and the last-owner
// rule, with the sync_version bumps and pushes that follow; and that a write whose body arrives late
// acts on the actor's role and session as they are then (§5).

import { describe, expect, it, vi } from 'vitest';
import { canChangeRole, canRemove, roleChangeNeedsReauth, SPACE_ROLES, type SpaceRole } from '@shared/roles';
import type { MemberDTO } from '@shared/types';
import { sha256Hex } from '../../src/core/crypto';
import { createDirectoryHarness, OWNER_EMAIL, PASSWORD, type DirectoryTestClient } from '../support/directoryHarness';
import { heldBody, settle } from '../support/heldBody';

const REAUTH_GONE = 11 * 60_000;

/** A space with an actor of `actorRole` and one target member per role (the owner from setup acts as owner). */
async function spaceWithRoles(actorRole: SpaceRole) {
  const h = createDirectoryHarness();
  const owner = await h.setup();
  const actor =
    actorRole === 'owner' ? { client: owner.client, user: owner.user } : await h.addUser({ email: 'actor@example.com', spaceId: owner.spaceId, role: actorRole });
  const targets = {} as Record<SpaceRole, { id: number; client: DirectoryTestClient }>;
  for (const role of SPACE_ROLES) {
    const added = await h.addUser({ email: `target-${role}@example.com`, spaceId: owner.spaceId, role });
    targets[role] = { id: added.user.id, client: added.client };
  }
  const spaceRow = h.db.get<{ id: number }>('SELECT id FROM spaces WHERE public_id = :id', { id: owner.spaceId })!;
  const setRole = (userId: number, role: SpaceRole) =>
    h.db.run('UPDATE memberships SET role = :role WHERE space_id = :s AND user_id = :u', { role, s: spaceRow.id, u: userId });
  return { h, spaceId: owner.spaceId, owner, actor, targets, setRole, spaceRowId: spaceRow.id };
}

describe('PATCH /api/spaces/:spaceId/members/:userId: the matrix of §6.3', () => {
  for (const actorRole of SPACE_ROLES) {
    it(`as ${actorRole}`, async () => {
      const { spaceId, actor, targets, setRole } = await spaceWithRoles(actorRole);
      for (const current of SPACE_ROLES) {
        for (const next of SPACE_ROLES) {
          const target = targets[current];
          setRole(target.id, current);
          const res = await actor.client.patch<MemberDTO>(`/api/spaces/${spaceId}/members/${target.id}`, { role: next });
          const allowed = canChangeRole(actorRole, current, next, false);
          expect([actorRole, current, next, res.status]).toEqual([actorRole, current, next, allowed ? 200 : 403]);
          if (allowed) expect(res.body).toMatchObject({ userId: target.id, role: next, isYou: false });
        }
        setRole(targets[current].id, current);
      }
    });
  }

  it('nobody changes their own role, owners included', async () => {
    const { h, spaceId, owner, targets } = await spaceWithRoles('owner');
    for (const role of SPACE_ROLES) {
      const res = await targets[role].client.patch(`/api/spaces/${spaceId}/members/${targets[role].id}`, { role: 'viewer' });
      expect(res.status).toBe(403);
    }
    expect((await owner.client.patch(`/api/spaces/${spaceId}/members/${owner.user.id}`, { role: 'admin' })).status).toBe(403);
    expect(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM memberships WHERE role = 'owner'")!.n).toBe(2);
  });

  it('needs the re-auth window to grant admin and to promote to or demote from owner (R of §6.2)', async () => {
    const { h, spaceId, actor, targets, setRole } = await spaceWithRoles('owner');
    h.clock.advance(REAUTH_GONE);
    for (const current of SPACE_ROLES) {
      for (const next of SPACE_ROLES) {
        setRole(targets[current].id, current);
        const res = await actor.client.patch(`/api/spaces/${spaceId}/members/${targets[current].id}`, { role: next });
        const needs = roleChangeNeedsReauth(current, next);
        expect([current, next, res.status, res.body.error?.code]).toEqual(
          needs ? [current, next, 403, 'reauth_required'] : [current, next, 200, undefined],
        );
      }
    }
  });

  it('a role change bumps sync_version and records member_role_changed for the granting account', async () => {
    const { h, spaceId, actor, targets, spaceRowId } = await spaceWithRoles('owner');
    const version = () => h.db.get<{ v: number }>('SELECT sync_version AS v FROM spaces WHERE id = :id', { id: spaceRowId })!.v;
    const before = version();
    h.spaces.calls.length = 0;
    await actor.client.patch(`/api/spaces/${spaceId}/members/${targets.viewer.id}`, { role: 'admin' });
    expect(version()).toBe(before + 1);
    await h.settle();
    expect(h.spaces.ids('invalidate')).toEqual([spaceId]);
    const event = h.db.get<{ user_id: number; data: string }>("SELECT user_id, data FROM security_events WHERE type = 'member_role_changed'")!;
    expect(event.user_id).toBe(actor.user.id);
    expect(JSON.parse(event.data)).toEqual({ space: spaceId, userId: targets.viewer.id, role: 'admin', from: 'viewer' });
    // The cached identity of the member now carries the new role.
    const auth = await h.service.authorizeSpace({
      tokenHash: sha256Hex(targets.viewer.client.jar.get('lyren_session')!),
      spaceId,
      cookie: 'plain',
      secure: false,
    });
    expect(auth).toMatchObject({ ok: true, identity: { role: 'admin', space: { syncVersion: before + 1 } } });
  });
});

describe('DELETE /api/spaces/:spaceId/members/:userId: the matrix', () => {
  for (const actorRole of SPACE_ROLES) {
    it(`as ${actorRole}`, async () => {
      // One target per role, so each removal leaves the others in place.
      const { h, spaceId, actor, targets } = await spaceWithRoles(actorRole);
      for (const target of SPACE_ROLES) {
        h.spaces.calls.length = 0;
        const res = await actor.client.delete(`/api/spaces/${spaceId}/members/${targets[target].id}`);
        const allowed = canRemove(actorRole, target, false);
        expect([actorRole, target, res.status]).toEqual([actorRole, target, allowed ? 200 : 403]);
        if (allowed) {
          // Awaited push; the person stays in space_people (their mirror row remains, as a former member).
          expect(h.spaces.ids('invalidate')).toEqual([spaceId]);
          expect(h.db.get('SELECT 1 AS kept FROM space_people WHERE user_id = :u', { u: targets[target].id })).toBeTruthy();
          const auth = await h.service.authorizeSpace({
            tokenHash: sha256Hex(targets[target].client.jar.get('lyren_session')!),
            spaceId,
            cookie: 'plain',
            secure: false,
          });
          expect(auth).toEqual({ ok: false, reason: 'not_found' });
        }
      }
    });
  }

  it('waits for the push at most 2 s, then answers anyway', async () => {
    const { h, spaceId, actor, targets } = await spaceWithRoles('owner');
    h.spaces.invalidate = () => new Promise<void>(() => {}); // a space that never answers
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let answered = false;
      const pending = actor.client.delete(`/api/spaces/${spaceId}/members/${targets.viewer.id}`).then((res) => {
        answered = true;
        return res;
      });
      await vi.advanceTimersByTimeAsync(1999);
      expect(answered).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect((await pending).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it('removing yourself is leaving (403 here); unknown members are 404', async () => {
    const { spaceId, actor } = await spaceWithRoles('admin');
    expect((await actor.client.delete(`/api/spaces/${spaceId}/members/${actor.user.id}`)).status).toBe(403);
    expect((await actor.client.delete(`/api/spaces/${spaceId}/members/99999`)).status).toBe(404);
  });
});

describe('POST /api/spaces/:spaceId/leave', () => {
  it('anyone may leave but the last owner (409 last_owner)', async () => {
    const h = createDirectoryHarness();
    const { client, spaceId } = await h.setup();
    const viewer = await h.addUser({ email: 'viewer@example.com', spaceId, role: 'viewer' });
    expect((await viewer.client.post(`/api/spaces/${spaceId}/leave`)).status).toBe(200);
    expect((await viewer.client.get(`/api/spaces/${spaceId}`)).status).toBe(404);
    const res = await client.post(`/api/spaces/${spaceId}/leave`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('last_owner');
    const second = await h.addUser({ email: 'second@example.com', spaceId, role: 'member' });
    await client.patch(`/api/spaces/${spaceId}/members/${second.user.id}`, { role: 'owner' });
    expect((await client.post(`/api/spaces/${spaceId}/leave`)).status).toBe(200);
    expect((await second.client.get<MemberDTO[]>(`/api/spaces/${spaceId}/members`)).body.map((m) => m.role)).toEqual(['owner']);
  });
});

describe('POST /api/spaces/:spaceId/transfer', () => {
  it('makes a member an owner; with demoteSelfTo the caller steps down in the same transaction', async () => {
    const h = createDirectoryHarness();
    const { client, spaceId, user } = await h.setup();
    const member = await h.addUser({ email: 'member@example.com', spaceId, role: 'member' });
    const res = await client.post(`/api/spaces/${spaceId}/transfer`, { userId: member.user.id, demoteSelfTo: 'admin' });
    expect(res.body).toEqual({ ok: true });
    const roles = (await member.client.get<MemberDTO[]>(`/api/spaces/${spaceId}/members`)).body.map((m) => [m.userId, m.role]);
    expect(roles).toEqual([
      [member.user.id, 'owner'],
      [user.id, 'admin'],
    ]);
    // Now an admin: no more transfers.
    expect((await client.post(`/api/spaces/${spaceId}/transfer`, { userId: member.user.id })).status).toBe(403);
  });

  it('needs owner and the re-auth window; the target must be a member', async () => {
    const h = createDirectoryHarness();
    const { client, spaceId } = await h.setup();
    const admin = await h.addUser({ email: 'admin@example.com', spaceId, role: 'admin' });
    const stranger = await h.addUser({ email: 'stranger@example.com' });
    expect((await admin.client.post(`/api/spaces/${spaceId}/transfer`, { userId: admin.user.id })).status).toBe(403);
    expect((await client.post(`/api/spaces/${spaceId}/transfer`, { userId: stranger.user.id })).status).toBe(404);
    h.clock.advance(REAUTH_GONE);
    const res = await client.post(`/api/spaces/${spaceId}/transfer`, { userId: admin.user.id });
    expect(res.body.error.code).toBe('reauth_required');
    await client.post('/api/account/reauth/password', { password: PASSWORD });
    expect((await client.post(`/api/spaces/${spaceId}/transfer`, { userId: admin.user.id })).status).toBe(200);
  });
});

describe('GET /api/spaces/:spaceId/members', () => {
  it('lists every member with email, role and status to every member, owners first', async () => {
    const h = createDirectoryHarness();
    const { spaceId, user } = await h.setup();
    const viewer = await h.addUser({ email: 'viewer@example.com', displayName: 'Vee', spaceId, role: 'viewer' });
    h.db.run("UPDATE users SET status = 'disabled' WHERE email = 'viewer@example.com'");
    const admin = await h.addUser({ email: 'admin@example.com', spaceId, role: 'admin' });
    const res = await admin.client.get<MemberDTO[]>(`/api/spaces/${spaceId}/members`);
    expect(res.body).toEqual([
      { userId: user.id, displayName: 'Owner', email: 'owner@example.com', role: 'owner', status: 'active', joinedAt: expect.any(String), isYou: false },
      { userId: admin.user.id, displayName: 'admin', email: 'admin@example.com', role: 'admin', status: 'active', joinedAt: expect.any(String), isYou: true },
      { userId: viewer.user.id, displayName: 'Vee', email: 'viewer@example.com', role: 'viewer', status: 'disabled', joinedAt: expect.any(String), isYou: false },
    ]);
  });
});

describe('a write whose body arrives late acts on the state after it (§5)', () => {
  it('an owner removed meanwhile can no longer transfer ownership or give roles', async () => {
    const h = createDirectoryHarness();
    const { client, user, spaceId } = await h.setup();
    const second = await h.addUser({ email: 'second@example.com', spaceId, role: 'owner' });
    const puppet = await h.addUser({ email: 'puppet@example.com', spaceId, role: 'viewer' });
    const transfer = heldBody({ userId: puppet.user.id });
    const promote = heldBody({ role: 'owner' });
    const demote = heldBody({ role: 'viewer' });
    const pending = [
      client.request('POST', `/api/spaces/${spaceId}/transfer`, transfer.stream, transfer.headers),
      client.request('PATCH', `/api/spaces/${spaceId}/members/${puppet.user.id}`, promote.stream, promote.headers),
      client.request('PATCH', `/api/spaces/${spaceId}/members/${second.user.id}`, demote.stream, demote.headers),
    ];
    await settle();
    expect((await second.client.delete(`/api/spaces/${spaceId}/members/${user.id}`)).status).toBe(200);
    for (const body of [transfer, promote, demote]) body.release();
    expect((await Promise.all(pending)).map((r) => r.status)).toEqual([404, 404, 404]);
    const roles = (await second.client.get<MemberDTO[]>(`/api/spaces/${spaceId}/members`)).body.map((m) => [m.userId, m.role]);
    expect(roles).toEqual([
      [second.user.id, 'owner'],
      [puppet.user.id, 'viewer'],
    ]);
  });

  it('a session revoked meanwhile changes nothing (401), with a Content-Length or without one', async () => {
    const h = createDirectoryHarness();
    const { client, spaceId } = await h.setup();
    const member = await h.addUser({ email: 'member@example.com', spaceId, role: 'member' });
    // The handler reads this body itself; the one without a length is read by the body limit first.
    const patch = heldBody({ role: 'viewer' });
    const remove = heldBody({}, { chunked: true });
    const pending = [
      client.request('PATCH', `/api/spaces/${spaceId}/members/${member.user.id}`, patch.stream, patch.headers),
      client.request('DELETE', `/api/spaces/${spaceId}/members/${member.user.id}`, remove.stream, remove.headers),
    ];
    await settle();
    // The owner changes the password in another browser: every other session ends.
    const other = h.client();
    expect((await other.post('/api/auth/login', { identifier: OWNER_EMAIL, password: PASSWORD })).status).toBe(200);
    expect((await other.post('/api/account/password', { currentPassword: PASSWORD, newPassword: 'another long password' })).status).toBe(200);
    patch.release();
    remove.release();
    expect((await Promise.all(pending)).map((r) => r.status)).toEqual([401, 401]);
    const members = (await other.get<MemberDTO[]>(`/api/spaces/${spaceId}/members`)).body;
    expect(members.find((m) => m.userId === member.user.id)?.role).toBe('member');
  });
});
