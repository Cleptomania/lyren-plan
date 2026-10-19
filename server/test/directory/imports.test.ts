// The directory's side of an archive import (design §8.4, §8.5, §8.9; directory/imports.ts): the candidates an
// importer may map the archive's users to (and nobody else), the im:<userId> limit, the instance's daily import
// budget with its reservations and refunds, and the purge of a space whose import was never finished.

import { describe, expect, it } from 'vitest';
import { generateSpaceId } from '@shared/ids';
import { randomToken } from '../../src/core/crypto';
import { MAX_CANDIDATES } from '../../src/directory/imports';
import { createDirectoryHarness, type DirectoryHarness } from '../support/directoryHarness';

const HOUR = 3_600_000;

/** An account inserted straight into the directory (no password, no session): its id. */
function account(h: DirectoryHarness, o: { email?: string | null; name: string; status?: 'active' | 'disabled'; admin?: boolean }): number {
  const now = new Date(h.clock.now()).toISOString();
  return h.db.get<{ id: number }>(
    `INSERT INTO users (email, email_key, username, display_name, webauthn_user_id, status, is_instance_admin, created_at, updated_at)
     VALUES (:email, :email, :username, :name, :handle, :status, :admin, :now, :now) RETURNING id`,
    {
      email: o.email ?? null,
      username: o.email ? null : `u${randomToken(6)}`,
      name: o.name,
      handle: randomToken(32),
      status: o.status ?? 'active',
      admin: o.admin ?? false,
      now,
    },
  )!.id;
}

/** A space of `ownerId` (inserted, active unless said) with these members. */
function space(h: DirectoryHarness, o: { ownerId: number; members?: number[]; status?: 'active' | 'importing'; deleted?: boolean }): number {
  const now = new Date(h.clock.now()).toISOString();
  const id = h.db.get<{ id: number }>(
    `INSERT INTO spaces (public_id, name, status, sync_version, created_by, created_at, updated_at, deleted_at, purge_after)
     VALUES (:pid, 'S', :status, 1, :owner, :now, :now, :deleted, :deleted) RETURNING id`,
    { pid: generateSpaceId(), status: o.status ?? 'active', owner: o.ownerId, now, deleted: o.deleted ? now : null },
  )!.id;
  for (const [userId, role] of [[o.ownerId, 'owner'], ...(o.members ?? []).map((m) => [m, 'member'])] as const) {
    h.db.run('INSERT INTO memberships (space_id, user_id, role, created_at, updated_at) VALUES (:id, :userId, :role, :now, :now)', {
      id,
      userId,
      role,
      now,
    });
  }
  return id;
}

describe('importCandidates (§8.5)', () => {
  it('an importer gets themselves and the members of their active spaces, by name; nobody else', async () => {
    const h = createDirectoryHarness();
    const { user: owner, spaceId } = await h.setup();
    // Not an instance admin, unlike the first account.
    const me = account(h, { email: 'me@example.com', name: 'Me' });
    const zoe = account(h, { email: 'zoe@example.com', name: 'zoe' });
    const adam = account(h, { email: 'adam@example.com', name: 'Adam' });
    const viewer = account(h, { email: 'viewer@example.com', name: 'Viewer' });
    const disabled = account(h, { email: 'off@example.com', name: 'Disabled', status: 'disabled' });
    const deletedSpaceMate = account(h, { email: 'gone@example.com', name: 'In a deleted space' });
    const importingMate = account(h, { email: 'imp@example.com', name: 'In an importing space' });
    const stranger = account(h, { email: 'stranger@example.com', name: 'Stranger' });
    space(h, { ownerId: me, members: [zoe, adam, disabled] });
    space(h, { ownerId: viewer, members: [me] });
    space(h, { ownerId: me, members: [deletedSpaceMate], deleted: true });
    space(h, { ownerId: me, members: [importingMate], status: 'importing' });
    space(h, { ownerId: stranger });

    const candidates = await h.service.importCandidates({ spaceId, userId: me, emailKeys: ['stranger@example.com', 'gone@example.com'] });
    expect(candidates).toEqual([
      { userId: adam, displayName: 'Adam', email: 'adam@example.com', isYou: false },
      { userId: me, displayName: 'Me', email: 'me@example.com', isYou: true },
      { userId: viewer, displayName: 'Viewer', email: 'viewer@example.com', isYou: false },
      { userId: zoe, displayName: 'zoe', email: 'zoe@example.com', isYou: false },
    ]);
    // The instance's first account (an admin) is no member of any of these spaces.
    expect(candidates.map((c) => c.userId)).not.toContain(owner.id);
    // A disabled importer, or an unknown one, gets none.
    expect(await h.service.importCandidates({ spaceId, userId: disabled, emailKeys: [] })).toEqual([]);
    expect(await h.service.importCandidates({ spaceId, userId: 999_999, emailKeys: [] })).toEqual([]);
  });

  it('an instance admin gets every active account; at the cap, the addresses of the archive first', async () => {
    const h = createDirectoryHarness();
    const { user: admin, spaceId } = await h.setup();
    const stranger = account(h, { email: 'stranger@example.com', name: 'Stranger' });
    const legacy = account(h, { email: null, name: 'Legacy' });
    account(h, { email: 'off@example.com', name: 'Disabled', status: 'disabled' });
    const all = await h.service.importCandidates({ spaceId, userId: admin.id, emailKeys: [] });
    expect(all.map((c) => [c.displayName, c.isYou])).toEqual([
      ['Legacy', false],
      ['Owner', true],
      ['Stranger', false],
    ]);
    expect(all.find((c) => c.userId === legacy)!.email).toBeNull();

    // More accounts than an analysis lists: the matched addresses and the importer stay in.
    const now = new Date(h.clock.now()).toISOString();
    h.db.run(
      `INSERT INTO users (email, email_key, display_name, webauthn_user_id, created_at, updated_at)
       SELECT 'a' || value || '@example.com', 'a' || value || '@example.com', 'A ' || value, 'h' || value, :now, :now
         FROM json_each(:ids)`,
      { ids: JSON.stringify(Array.from({ length: MAX_CANDIDATES + 10 }, (_, i) => 1000 + i)), now },
    );
    const capped = await h.service.importCandidates({ spaceId, userId: admin.id, emailKeys: ['stranger@example.com', 'a1999@example.com'] });
    expect(capped).toHaveLength(MAX_CANDIDATES);
    const ids = capped.map((c) => c.userId);
    expect(ids).toContain(admin.id);
    expect(ids).toContain(stranger);
    expect(capped.some((c) => c.email === 'a1999@example.com')).toBe(true);
    expect(capped.map((c) => c.displayName)).toEqual([...capped.map((c) => c.displayName)].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()) || 0));
  });
});

describe('reserveImport and refundImport (§8.9)', () => {
  it('im:<userId> counts 10 analyze and commit starts an hour, then refuses them until the hour is over; reserving rows counts nothing', async () => {
    const h = createDirectoryHarness();
    const { user, spaceId } = await h.setup();
    for (let i = 0; i < 10; i++) {
      expect(await h.service.reserveImport({ spaceId, userId: user.id, step: 'start', rowWrites: 0 })).toEqual({ ok: true, reservationId: null, dailyLeft: null });
      // No budget on Node by default: a commit's rows reserve nothing, and count nothing either.
      expect(await h.service.reserveImport({ spaceId, userId: user.id, step: 'rows', rowWrites: 100 })).toEqual({ ok: true, reservationId: null, dailyLeft: null });
    }
    const refused = await h.service.reserveImport({ spaceId, userId: user.id, step: 'start', rowWrites: 0 });
    expect(refused).toEqual({ ok: false, reason: 'rate_limited', retryAfterSec: 3600 });
    expect(h.db.all("SELECT key FROM auth_throttle WHERE key <> :im", { im: `im:${user.id}` })).toEqual([]);
    h.clock.advance(HOUR);
    expect((await h.service.reserveImport({ spaceId, userId: user.id, step: 'start', rowWrites: 0 })).ok).toBe(true);
  });

  it('the daily budget: a start reports what is left, a commit reserves its rows or is refused until 00:00 UTC; a refund gives them back once', async () => {
    const h = createDirectoryHarness({ vars: { IMPORT_DAILY_ROW_WRITES: '1000' } });
    h.clock.set(Date.parse('2026-10-17T18:00:00.000Z'));
    const { user, spaceId } = await h.setup();
    const reserve = (step: 'start' | 'rows', rowWrites: number) => h.service.reserveImport({ spaceId, userId: user.id, step, rowWrites });
    expect(await reserve('start', 0)).toEqual({ ok: true, reservationId: null, dailyLeft: 1000 });
    const first = await reserve('rows', 600);
    expect(first).toMatchObject({ ok: true, dailyLeft: 400, reservationId: expect.stringMatching(/^2026-10-17\.[A-Za-z0-9_-]{22}$/) });
    expect(await reserve('start', 0)).toMatchObject({ dailyLeft: 400 });
    // An analysis may estimate more than is left; a commit may not.
    expect(await reserve('rows', 401)).toEqual({ ok: false, reason: 'daily_budget', retryAfterSec: 6 * 3600 });
    const second = await reserve('rows', 400);
    expect(second).toMatchObject({ ok: true, dailyLeft: 0 });
    // Only the starts count on im.
    const im = () => h.db.get<{ count: number }>('SELECT count FROM auth_throttle WHERE key = :k', { k: `im:${user.id}` })!.count;
    expect(im()).toBe(2);

    await h.service.refundImport({ reservationId: (first as { reservationId: string }).reservationId });
    expect(await reserve('start', 0)).toMatchObject({ dailyLeft: 600 });
    // Once only, and nothing for an id that names no reservation.
    await h.service.refundImport({ reservationId: (first as { reservationId: string }).reservationId });
    await h.service.refundImport({ reservationId: 'nonsense' });
    await h.service.refundImport({ reservationId: '2026-10-17.unknown' });
    expect(await reserve('start', 0)).toMatchObject({ dailyLeft: 600 });
    // What a failed transaction was billed for stays spent.
    const third = (await reserve('rows', 500)) as { reservationId: string };
    await h.service.refundImport({ reservationId: third.reservationId, spentRows: 120 });
    expect(await reserve('start', 0)).toMatchObject({ dailyLeft: 480 });

    // A new UTC day starts from 0; yesterday's refund changes today's nothing. Maintenance purges the old rows.
    h.clock.set(Date.parse('2026-10-18T00:00:01.000Z'));
    expect(await reserve('start', 0)).toMatchObject({ dailyLeft: 1000 });
    await h.service.refundImport({ reservationId: (second as { reservationId: string }).reservationId });
    expect(await reserve('start', 0)).toMatchObject({ dailyLeft: 1000 });
    h.clock.advance(25 * HOUR);
    await h.service.maintenance();
    expect(h.db.all("SELECT key FROM auth_throttle WHERE substr(key, 1, 3) = 'imp' OR substr(key, 1, 4) = 'imr:'")).toEqual([]);
  });
});

describe('a space created for an import', () => {
  it('is activated by importCommitted, or deleted at once by its owner, or purged by maintenance after a day', async () => {
    const h = createDirectoryHarness();
    const { client, user } = await h.setup();
    const make = async () => (await client.post('/api/spaces', { name: 'Import', forImport: true })).body.id as string;
    const status = (id: string) => h.db.get<{ status: string }>('SELECT status FROM spaces WHERE public_id = :id', { id })?.status;

    const committed = await make();
    await h.service.importCommitted({ spaceId: committed, userId: user.id, mode: 'new', mappedUserIds: [user.id] });
    expect(status(committed)).toBe('active');

    // Abandoned: no re-auth, no typed name.
    const abandoned = await make();
    h.clock.advance(11 * 60_000);
    expect((await client.delete(`/api/spaces/${abandoned}`, { confirmName: '' })).status).toBe(200);
    expect(status(abandoned)).toBeUndefined();
    expect(h.spaces.ids('destroy')).toContain(abandoned);

    const forgotten = await make();
    h.clock.advance(23 * HOUR);
    await h.service.maintenance();
    expect(status(forgotten)).toBe('importing');
    h.clock.advance(HOUR + 1);
    expect((await h.service.maintenance()).spacesPurged).toBe(1);
    expect(status(forgotten)).toBeUndefined();
    expect(status(committed)).toBe('active');
  });
});
