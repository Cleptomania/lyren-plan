// /api/spaces (design §5.8.16): create (SpaceAdminClient.init, quotas, the daily limit, a failed init),
// list, detail, rename, soft delete, restore and the purge, and authorizeSpace's not_found for spaces
// that are deleted, provisioning or someone else's; and writes and restores that race other requests.

import { describe, expect, it, vi } from 'vitest';
import type { DeletedSpaceDTO, SpaceDetailDTO, SpaceSummaryDTO } from '@shared/types';
import { sha256Hex } from '../../src/core/crypto';
import { createDirectoryHarness, type DirectoryHarness, type DirectoryTestClient } from '../support/directoryHarness';
import { heldBody, settle } from '../support/heldBody';

const DAY = 86_400_000;

async function authorize(h: DirectoryHarness, client: DirectoryTestClient, spaceId: string) {
  return h.service.authorizeSpace({ tokenHash: sha256Hex(client.jar.get('lyren_session')!), spaceId, cookie: 'plain', secure: false });
}

describe('POST /api/spaces', () => {
  it('creates a space: provisioning row, owner membership, init, then active', async () => {
    const h = createDirectoryHarness();
    const { client, user } = await h.setup();
    h.spaces.calls.length = 0;
    const res = await client.post<SpaceSummaryDTO>('/api/spaces', { name: '  Team  ', createSampleData: true, today: '2026-10-17' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: expect.stringMatching(/^[0-9a-hjkmnp-tv-z]{16}$/), name: 'Team', role: 'owner', status: 'active', memberCount: 1, createdAt: new Date(h.clock.now()).toISOString() });
    expect(h.spaces.calls).toEqual([
      {
        op: 'init',
        spaceId: res.body.id,
        init: { spaceId: res.body.id, name: 'Team', owner: { userId: user.id, displayName: 'Owner', email: 'owner@example.com' }, syncVersion: 1, sampleData: { today: '2026-10-17' } },
      },
    ]);
    expect(h.db.get('SELECT 1 AS present FROM space_people sp JOIN spaces s ON s.id = sp.space_id WHERE s.public_id = :id', { id: res.body.id })).toBeTruthy();
    const list = await client.get<SpaceSummaryDTO[]>('/api/spaces');
    expect(list.body.map((s) => s.name)).toEqual(["Owner's space", 'Team']);
  });

  it('forImport: empty and importing; the status reaches the identity', async () => {
    const h = createDirectoryHarness();
    const { client } = await h.setup();
    const res = await client.post<SpaceSummaryDTO>('/api/spaces', { name: 'Import', forImport: true, createSampleData: true });
    expect(res.body.status).toBe('importing');
    expect(h.spaces.calls.at(-1)?.init?.sampleData).toBeNull();
    const auth = await authorize(h, client, res.body.id);
    expect(auth).toMatchObject({ ok: true, identity: { space: { status: 'importing' } } });
    await h.service.importCommitted({ spaceId: res.body.id, userId: 1, mode: 'new', mappedUserIds: [] });
    expect((await client.get<SpaceDetailDTO>(`/api/spaces/${res.body.id}`)).body.status).toBe('active');
  });

  it('a failed init deletes the row again and answers 503', async () => {
    const h = createDirectoryHarness();
    const { client } = await h.setup();
    h.spaces.failInit = true;
    const res = await client.post('/api/spaces', { name: 'Broken' });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('unavailable');
    expect(h.db.all("SELECT id FROM spaces WHERE name = 'Broken'")).toEqual([]);
    await h.settle();
    expect(h.spaces.ids('destroy')).toHaveLength(1);
  });

  it('MAX_SPACES_PER_USER counts owned spaces, deleted ones included until purged', async () => {
    const h = createDirectoryHarness({ vars: { MAX_SPACES_PER_USER: '2' } });
    const { client } = await h.setup();
    const second = await client.post<SpaceSummaryDTO>('/api/spaces', { name: 'Second' });
    expect(second.status).toBe(201);
    const third = await client.post('/api/spaces', { name: 'Third' });
    expect(third.status).toBe(409);
    expect(third.body.error.code).toBe('quota_exceeded');
    await client.delete(`/api/spaces/${second.body.id}`, { confirmName: 'Second' });
    expect((await client.post('/api/spaces', { name: 'Third' })).status).toBe(409);
    h.clock.advance(8 * DAY);
    await h.service.maintenance();
    expect((await client.post('/api/spaces', { name: 'Third' })).status).toBe(201);
  });

  it('SPACES_CREATED_PER_DAY limits creation per account per day (sc:<userId>, exact)', async () => {
    const h = createDirectoryHarness({ vars: { SPACES_CREATED_PER_DAY: '2' } });
    const { client } = await h.setup();
    expect((await client.post('/api/spaces', { name: 'A' })).status).toBe(201);
    expect((await client.post('/api/spaces', { name: 'B' })).status).toBe(201);
    const third = await client.post('/api/spaces', { name: 'C' });
    expect(third.status).toBe(429);
    expect(third.headers.get('retry-after')).toBe(String(24 * 3600));
    h.clock.advance(DAY);
    expect((await client.post('/api/spaces', { name: 'C' })).status).toBe(201);
  });
});

describe('GET/PATCH /api/spaces/:spaceId', () => {
  it('shows a space to its members only; others get 404', async () => {
    const h = createDirectoryHarness();
    const { client, spaceId, user } = await h.setup();
    const detail = await client.get<SpaceDetailDTO>(`/api/spaces/${spaceId}`);
    expect(detail.body).toMatchObject({ id: spaceId, role: 'owner', owners: [{ id: user.id, displayName: 'Owner' }] });
    const stranger = await h.addUser({ email: 'stranger@example.com' });
    expect((await stranger.client.get(`/api/spaces/${spaceId}`)).status).toBe(404);
    expect((await client.get('/api/spaces/0000000000000000')).status).toBe(404);
    expect((await client.get('/api/spaces/not-a-space-id')).status).toBe(404);
  });

  it('renames (owner only), bumping sync_version and pushing', async () => {
    const h = createDirectoryHarness();
    const { client, spaceId } = await h.setup();
    const admin = await h.addUser({ email: 'admin@example.com', spaceId, role: 'admin' });
    expect((await admin.client.patch(`/api/spaces/${spaceId}`, { name: 'Nope' })).status).toBe(403);
    const res = await client.patch<SpaceSummaryDTO>(`/api/spaces/${spaceId}`, { name: 'Renamed' });
    expect(res.body.name).toBe('Renamed');
    await h.settle();
    expect(h.spaces.ids('invalidate')).toContain(spaceId);
    const auth = await authorize(h, client, spaceId);
    expect(auth).toMatchObject({ ok: true, identity: { space: { name: 'Renamed', syncVersion: 3 } } });
  });
});

describe('DELETE /api/spaces/:spaceId and restore', () => {
  it('needs owner, the re-auth window and the name; then soft-deletes with a grace period', async () => {
    const h = createDirectoryHarness();
    const { client, spaceId } = await h.setup();
    const admin = await h.addUser({ email: 'admin@example.com', spaceId, role: 'admin' });
    expect((await admin.client.delete(`/api/spaces/${spaceId}`, { confirmName: "Owner's space" })).status).toBe(403);
    const wrong = await client.delete(`/api/spaces/${spaceId}`, { confirmName: 'Other' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.details[0].path).toBe('confirmName');
    h.clock.advance(11 * 60_000);
    expect((await client.delete(`/api/spaces/${spaceId}`, { confirmName: "Owner's space" })).body.error.code).toBe('reauth_required');
    await client.post('/api/account/reauth/password', { password: 'correct horse battery' });
    h.spaces.calls.length = 0;
    const res = await client.delete(`/api/spaces/${spaceId}`, { confirmName: " Owner's space " });
    expect(res.body).toEqual({ ok: true, purgeAfter: new Date(h.clock.now() + 7 * DAY).toISOString() });
    expect(h.spaces.ids('invalidate')).toEqual([spaceId]);
    // Deleted: gone from lists, 404 for its members, not_found for space requests.
    expect((await client.get<SpaceSummaryDTO[]>('/api/spaces')).body).toEqual([]);
    expect((await admin.client.get(`/api/spaces/${spaceId}`)).status).toBe(404);
    expect(await authorize(h, client, spaceId)).toEqual({ ok: false, reason: 'not_found' });
    expect(await authorize(h, admin.client, spaceId)).toEqual({ ok: false, reason: 'not_found' });
    const deleted = await client.get<DeletedSpaceDTO[]>('/api/spaces/deleted');
    expect(deleted.body).toEqual([{ id: spaceId, name: "Owner's space", deletedAt: new Date(h.clock.now()).toISOString(), purgeAfter: res.body.purgeAfter }]);
    expect((await admin.client.get('/api/spaces/deleted')).body).toEqual([]);
  });

  it('restores within the grace period (owner of record only)', async () => {
    const h = createDirectoryHarness();
    const { client, spaceId } = await h.setup();
    const member = await h.addUser({ email: 'm@example.com', spaceId, role: 'member' });
    expect((await client.post(`/api/spaces/${spaceId}/restore`)).status).toBe(409);
    await client.delete(`/api/spaces/${spaceId}`, { confirmName: "Owner's space" });
    expect((await member.client.post(`/api/spaces/${spaceId}/restore`)).status).toBe(404);
    const res = await client.post<SpaceSummaryDTO>(`/api/spaces/${spaceId}/restore`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: spaceId, status: 'active', memberCount: 2 });
    expect(await authorize(h, member.client, spaceId)).toMatchObject({ ok: true });
  });

  it('maintenance purges a deleted space after the grace period: destroy, then the row', async () => {
    const h = createDirectoryHarness();
    const { client, spaceId } = await h.setup();
    await client.delete(`/api/spaces/${spaceId}`, { confirmName: "Owner's space" });
    h.clock.advance(7 * DAY - 1000);
    expect((await h.service.maintenance()).spacesPurged).toBe(0);
    h.clock.advance(1000);
    h.spaces.failDestroy = true;
    expect((await h.service.maintenance()).spacesPurged).toBe(0);
    expect(h.db.get('SELECT id FROM spaces WHERE public_id = :id', { id: spaceId })).toBeTruthy();
    h.spaces.failDestroy = false;
    expect((await h.service.maintenance()).spacesPurged).toBe(1);
    expect(h.spaces.ids('destroy')).toEqual([spaceId, spaceId]);
    expect(h.db.all('SELECT * FROM memberships')).toEqual([]);
    expect(h.db.all('SELECT * FROM space_people')).toEqual([]);
  });

  it('with a grace of 0, deleting purges at once; an importing space goes at once without confirmation', async () => {
    const h = createDirectoryHarness({ vars: { SPACE_DELETE_GRACE_DAYS: '0' } });
    const { client, spaceId } = await h.setup();
    await client.delete(`/api/spaces/${spaceId}`, { confirmName: "Owner's space" });
    expect(h.spaces.ids('destroy')).toEqual([spaceId]);
    expect(h.db.get('SELECT id FROM spaces WHERE public_id = :id', { id: spaceId })).toBeUndefined();
    const imp = await client.post<SpaceSummaryDTO>('/api/spaces', { name: 'Import', forImport: true });
    h.clock.advance(11 * 60_000);
    expect((await client.delete(`/api/spaces/${imp.body.id}`)).status).toBe(200);
    expect(h.db.get('SELECT id FROM spaces WHERE public_id = :id', { id: imp.body.id })).toBeUndefined();
  });

  it('maintenance purges provisioning rows older than an hour and importing ones older than a day', async () => {
    const h = createDirectoryHarness();
    const { client, user } = await h.setup();
    const imp = await client.post<SpaceSummaryDTO>('/api/spaces', { name: 'Import', forImport: true });
    h.db.run(
      `INSERT INTO spaces (public_id, name, status, created_by, created_at, updated_at)
       VALUES ('aaaaaaaaaaaaaaaa', 'Stuck', 'provisioning', :u, :now, :now)`,
      { u: user.id, now: new Date(h.clock.now()).toISOString() },
    );
    h.clock.advance(61 * 60_000);
    expect((await h.service.maintenance()).spacesPurged).toBe(1);
    expect(h.spaces.ids('destroy')).toEqual(['aaaaaaaaaaaaaaaa']);
    h.clock.advance(DAY);
    expect((await h.service.maintenance()).spacesPurged).toBe(1);
    expect(h.spaces.ids('destroy')).toEqual(['aaaaaaaaaaaaaaaa', imp.body.id]);
  });
});

describe('requests that interleave (§5)', () => {
  it('a rename or delete whose body arrives after the owner was demoted is refused', async () => {
    const h = createDirectoryHarness();
    const { client, user, spaceId } = await h.setup();
    const second = await h.addUser({ email: 'second@example.com', spaceId, role: 'owner' });
    const remove = heldBody({ confirmName: "Owner's space" });
    const rename = heldBody({ name: 'Taken over' });
    const deleting = client.request('DELETE', `/api/spaces/${spaceId}`, remove.stream, remove.headers);
    const renaming = client.request('PATCH', `/api/spaces/${spaceId}`, rename.stream, rename.headers);
    await settle();
    expect((await second.client.patch(`/api/spaces/${spaceId}/members/${user.id}`, { role: 'viewer' })).status).toBe(200);
    remove.release();
    rename.release();
    const [deleted, renamed] = await Promise.all([deleting, renaming]);
    expect(deleted.body.error).toEqual({ code: 'forbidden', message: 'Only an owner can delete the space' });
    expect(renamed.body.error).toEqual({ code: 'forbidden', message: 'Only an owner can rename the space' });
    expect(h.db.get('SELECT name, deleted_at FROM spaces WHERE public_id = :id', { id: spaceId })).toEqual({
      name: "Owner's space",
      deleted_at: null,
    });
  });

  /** Holds the fake SpaceAdminClient's destroy until the returned function is called. */
  function holdDestroy(h: DirectoryHarness): () => void {
    let release!: () => void;
    h.spaces.destroyHold = new Promise((resolve) => {
      release = resolve;
    });
    return release;
  }

  it('no restore once the grace period is over, while maintenance may be destroying the space', async () => {
    const h = createDirectoryHarness();
    const { client, spaceId } = await h.setup();
    await client.delete(`/api/spaces/${spaceId}`, { confirmName: "Owner's space" });
    h.clock.advance(7 * DAY + 1000);
    const release = holdDestroy(h);
    const maintenance = h.service.maintenance();
    await vi.waitFor(() => expect(h.spaces.ids('destroy')).toEqual([spaceId]));
    expect((await client.get<DeletedSpaceDTO[]>('/api/spaces/deleted')).body).toEqual([]);
    const restore = await client.post(`/api/spaces/${spaceId}/restore`);
    expect(restore.status).toBe(409);
    expect(restore.body.error.message).toBe('This space is being removed and can no longer be restored');
    release();
    expect((await maintenance).spacesPurged).toBe(1);
    expect(h.db.get('SELECT id FROM spaces WHERE public_id = :id', { id: spaceId })).toBeUndefined();
  });

  it('with a grace of 0, no restore while the delete is purging the space', async () => {
    const h = createDirectoryHarness({ vars: { SPACE_DELETE_GRACE_DAYS: '0' } });
    const { client, spaceId } = await h.setup();
    const release = holdDestroy(h);
    const deleting = client.delete(`/api/spaces/${spaceId}`, { confirmName: "Owner's space" });
    await vi.waitFor(() => expect(h.spaces.ids('destroy')).toEqual([spaceId]));
    expect((await client.post(`/api/spaces/${spaceId}/restore`)).status).toBe(409);
    release();
    expect((await deleting).status).toBe(200);
    expect(h.db.get('SELECT id FROM spaces WHERE public_id = :id', { id: spaceId })).toBeUndefined();
  });
});
