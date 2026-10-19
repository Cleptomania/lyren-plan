// The users mirror and its synchronization (design §3.5), and initSpaceDb.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_STATUSES } from '@shared/constants';
import { sha256Hex } from '../../src/core/crypto';
import { migrate } from '../../src/core/migrate';
import { APP_VERSION } from '../../src/core/version';
import { NodeDb } from '../../src/runtime/node/nodeDb';
import { createSpaceHost } from '../../src/space/host';
import { initSpaceDb } from '../../src/space/init';
import { appliedSyncVersion, applySync, mirrorRow, mirrorUserIds } from '../../src/space/mirror';
import { SPACE_MIGRATIONS } from '../../src/space/schema';
import { createWriteState } from '../../src/space/writeState';
import { createDirectoryHarness } from '../support/directoryHarness';
import { assertFoldsConsistent } from '../support/folds';
import { createSpaceHarness, FakeImportGate, FakeSafety, mirrorRows, OWNER_ID } from '../support/spaceHarness';

const T = '2026-10-17T12:00:00.000Z';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sync', () => {
  it('brings the mirror to the directory\'s members, names and space name', async () => {
    const h = createSpaceHarness();
    const bob = h.addUser({ displayName: 'Bob', email: 'bob@example.com' });
    h.directory.space.name = 'Renamed space';
    h.directory.bump();
    expect((await h.owner.client.get('/api/tags')).status).toBe(200);
    expect(h.directory.calls.find((c) => c.op === 'spaceSync')!.input).toEqual({ spaceId: h.spaceId, mirrorUserIds: [OWNER_ID] });
    expect(mirrorRows(h.db)).toEqual([
      { id: OWNER_ID, kind: 'account', display_name: 'Owner', email: 'owner@example.com', is_member: 1, deleted: 0 },
      { id: bob.userId, kind: 'account', display_name: 'Bob', email: 'bob@example.com', is_member: 1, deleted: 0 },
    ]);
    expect(appliedSyncVersion(h.db)).toBe(h.directory.space.syncVersion);
    expect(h.db.get("SELECT value FROM _meta WHERE key = 'space_name'")).toEqual({ value: 'Renamed space' });

    // Up to date: no further sync.
    await h.owner.client.get('/api/tags');
    expect(h.directory.count('spaceSync')).toBe(1);
  });

  it('keeps a removed member\'s row as a former member, with their name and address', async () => {
    const h = createSpaceHarness();
    const bob = h.addUser({ displayName: 'Bob', email: 'bob@example.com' });
    await bob.client.get('/api/tags');
    h.directory.removeMember(bob.userId);
    expect((await bob.client.get('/api/tags')).status).toBe(404);
    await h.owner.client.get('/api/tags');
    expect(mirrorRow(h.db, bob.userId)).toMatchObject({ display_name: 'Bob', email: 'bob@example.com', is_member: 0, deleted: 0 });
    // A former member is still asked about, and their renames still arrive.
    h.directory.updateAccount(bob.userId, { displayName: 'Robert' });
    await h.owner.client.get('/api/tags');
    expect(h.directory.calls.filter((c) => c.op === 'spaceSync').at(-1)!.input).toEqual({
      spaceId: h.spaceId,
      mirrorUserIds: [OWNER_ID, bob.userId],
    });
    expect(mirrorRow(h.db, bob.userId)).toMatchObject({ display_name: 'Robert', is_member: 0 });
  });

  it('writes only the rows that change', () => {
    const db = spaceDb();
    const payload = {
      name: 'S',
      status: 'active' as const,
      syncVersion: 2,
      members: [{ userId: OWNER_ID, displayName: 'Owner', email: 'owner@example.com' }, { userId: 2, displayName: 'B', email: null }],
      others: [],
    };
    expect(applySync(db, payload, T)).toBe(2); // B inserted, space_name changed
    expect(applySync(db, payload, T)).toBe(0);
    expect(applySync(db, { ...payload, syncVersion: 3, members: payload.members.slice(0, 1) }, T)).toBe(1);
    expect(appliedSyncVersion(db)).toBe(3);
    expect(applySync(db, { ...payload, syncVersion: 4, members: payload.members.slice(0, 1), others: [{ userId: 2, displayName: 'B' }] }, T)).toBe(0);
  });

  it('a failed sync leaves the request working and is retried on the next one', async () => {
    const h = createSpaceHarness();
    const bob = h.addUser({ displayName: 'Bob' });
    h.directory.failures.spaceSync = new Error('directory down (test)');
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect((await h.owner.client.get('/api/tags')).status).toBe(200);
    expect(error.mock.calls[0]![0]).toMatch(/Users mirror sync of space .* failed/);
    expect(mirrorRow(h.db, bob.userId)).toBeUndefined();
    delete h.directory.failures.spaceSync;
    await h.owner.client.get('/api/tags');
    expect(mirrorRow(h.db, bob.userId)).toMatchObject({ is_member: 1 });
  });

  it('runs after an invalidate even when the version did not move', async () => {
    const h = createSpaceHarness();
    await h.owner.client.get('/api/tags');
    h.directory.accounts.get(OWNER_ID)!.email = 'new@example.com';
    h.host.invalidate();
    await h.owner.client.get('/api/tags');
    expect(h.directory.count('spaceSync')).toBe(1);
    expect(mirrorRow(h.db, OWNER_ID)!.email).toBe('new@example.com');
  });
});

describe('self-heal', () => {
  it('writes the actor\'s own row before the route, even when the sync fails', async () => {
    const h = createSpaceHarness();
    const carol = h.addUser({ displayName: 'Carol', email: 'carol@example.com' });
    h.directory.failures.spaceSync = new Error('directory down (test)');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const project = await carol.client.post<{ id: number }>('/api/projects', { name: 'Carol\'s', key: 'CAR' });
    expect(project.status).toBe(201);
    expect(mirrorRow(h.db, carol.userId)).toMatchObject({ display_name: 'Carol', email: 'carol@example.com', is_member: 1 });
    expect(h.db.get('SELECT user_id FROM activity WHERE project_id = :id', { id: project.body.id })).toEqual({ user_id: carol.userId });

    // A profile change that no push announced.
    h.directory.accounts.get(carol.userId)!.displayName = 'Caroline';
    await carol.client.get('/api/tags');
    expect(mirrorRow(h.db, carol.userId)!.display_name).toBe('Caroline');
  });
});

describe('deleted accounts lose their email after one sync', () => {
  it('a member, a former member and an import-mapped non-member', async () => {
    const h = createSpaceHarness();
    const member = h.addUser({ displayName: 'Member', email: 'member@example.com' });
    const former = h.addUser({ displayName: 'Former', email: 'former@example.com' });
    await h.owner.client.get('/api/tags');
    h.directory.removeMember(former.userId);
    // An account an import attributed rows to without making it a member (§8.6).
    const mapped = 77;
    h.directory.addAccount({ id: mapped, displayName: 'Mapped', email: 'mapped@example.com' });
    h.db.run(
      `INSERT INTO users (id, kind, display_name, email, is_member, updated_at)
       VALUES (:id, 'account', 'Mapped', 'mapped@example.com', 0, :t)`,
      { id: mapped, t: T },
    );
    await h.owner.client.get('/api/tags');
    expect(mirrorRow(h.db, former.userId)).toMatchObject({ email: 'former@example.com', is_member: 0 });

    const syncs = h.directory.count('spaceSync');
    for (const id of [member.userId, former.userId, mapped]) h.directory.deleteAccount(id);
    await h.owner.client.get('/api/tags');
    expect(h.directory.count('spaceSync')).toBe(syncs + 1);
    for (const [id, name] of [
      [member.userId, 'Member'],
      [former.userId, 'Former'],
      [mapped, 'Mapped'],
    ] as const) {
      expect(mirrorRow(h.db, id)).toMatchObject({ display_name: name, email: null, is_member: 0, deleted: 1 });
    }
    // Deleted rows are no longer asked about.
    expect(mirrorUserIds(h.db)).toEqual([OWNER_ID]);
    const people = (await h.owner.client.get('/api/bootstrap')).body.people;
    expect(people.find((p: { id: number }) => p.id === member.userId)).toEqual({
      id: member.userId,
      displayName: 'Member',
      kind: 'account',
      isMember: false,
      deleted: true,
    });
  });

  it('with the real directory service', async () => {
    const dir = createDirectoryHarness({ config: { setupCodeDisabled: true } });
    const { client: ownerClient, spaceId } = await dir.setup();
    const init = dir.spaces.spaces.get(spaceId)!;
    const db = new NodeDb(':memory:');
    initSpaceDb(db, init);
    const host = createSpaceHost({
      deps: {
        db,
        config: {
          bodyLimit: 2 * 1024 * 1024,
          importBodyLimit: 50 * 1024 * 1024,
          importMaxJsonValues: 4_000_000,
          importMaxRowWrites: 0,
          spaceDailyRowWrites: 0,
          spaceMaxBytes: 0,
          snapshotKeep: 10,
          authCacheSeconds: 0,
          reauthMinutes: 10,
        },
        space: {
          id: spaceId,
          directory: dir.service,
          safety: new FakeSafety(null),
          runtime: { kind: 'node', capabilities: { backupDownload: true, fileSnapshots: true } },
          readSnapshot: (fn) => fn(db),
          writeState: createWriteState(db, { dailyRowWrites: 0, clock: dir.clock }),
          importGate: new FakeImportGate(),
          clock: dir.clock,
        },
      },
      authCacheTtlMs: 0,
    });
    /** `path` as the space app sees it after /api ('/tags'). */
    const serve = (token: string, path: string) =>
      host.serve(
        new Request(`http://127.0.0.1:19621/api/s/${spaceId}${path}`),
        dir.meta({ sessionTokenHash: sha256Hex(token), sessionCookie: 'plain' }),
      );
    const tokenOf = (c: { jar: Map<string, string> }) => c.jar.get('lyren_session')!;

    const bob = await dir.addUser({ email: 'bob@example.com', displayName: 'Bob', role: 'member', spaceId });
    expect((await serve(tokenOf(ownerClient), '/tags')).status).toBe(200);
    const bobId = bob.user.id;
    expect(mirrorRow(db, bobId)).toMatchObject({ display_name: 'Bob', email: 'bob@example.com', is_member: 1 });
    expect((await serve(tokenOf(bob.client), '/bootstrap')).status).toBe(200);

    expect((await bob.client.delete('/api/account', { confirm: 'bob@example.com' })).status).toBe(200);
    expect((await serve(tokenOf(ownerClient), '/tags')).status).toBe(200);
    expect(mirrorRow(db, bobId)).toMatchObject({ display_name: 'Bob', email: null, is_member: 0, deleted: 1 });
  });
});

describe('initSpaceDb', () => {
  const init = {
    spaceId: '7k2m9q4w8x1c3v5b',
    name: 'Team',
    owner: { userId: 5, displayName: 'Olivia', email: 'olivia@example.com' },
    syncVersion: 1,
    sampleData: { today: '2026-10-17' },
  };

  it('creates the schema, defaults, the owner\'s row and sample data, and is idempotent', () => {
    const db = new NodeDb(':memory:');
    initSpaceDb(db, init);
    const counts = () =>
      db.get('SELECT (SELECT COUNT(*) FROM statuses) AS statuses, (SELECT COUNT(*) FROM projects) AS projects, (SELECT COUNT(*) FROM users) AS users');
    const first = counts();
    expect(first).toMatchObject({ statuses: DEFAULT_STATUSES.length, users: 1 });
    expect((first as { projects: number }).projects).toBeGreaterThan(0);
    expect(mirrorRow(db, 5)).toMatchObject({ kind: 'account', display_name: 'Olivia', email: 'olivia@example.com', is_member: 1 });
    expect(db.all("SELECT DISTINCT created_by FROM tasks")).toEqual([{ created_by: 5 }]);
    expect(db.all("SELECT key, value FROM _meta WHERE key IN ('schema', 'space_id', 'space_name', 'sync_version') ORDER BY key")).toEqual([
      { key: 'schema', value: 'space' },
      { key: 'space_id', value: init.spaceId },
      { key: 'space_name', value: 'Team' },
      { key: 'sync_version', value: '1' },
    ]);
    assertFoldsConsistent(db);

    initSpaceDb(db, { ...init, name: 'Older name' });
    expect(counts()).toEqual(first);
    expect(db.get("SELECT value FROM _meta WHERE key = 'space_name'")).toEqual({ value: 'Team' });
    expect(() => initSpaceDb(db, { ...init, spaceId: '0123456789abcdef' })).toThrow(/belongs to space 7k2m9q4w8x1c3v5b/);
  });

  it('a failure of the sample data leaves a working space', () => {
    const db = new NodeDb(':memory:');
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    initSpaceDb(db, { ...init, sampleData: { today: 'not a date' } });
    expect(error).toHaveBeenCalledWith('[lyren] Failed to create sample data:', expect.anything());
    expect(db.get('SELECT COUNT(*) AS n FROM projects')).toEqual({ n: 0 });
    expect(db.get('SELECT COUNT(*) AS n FROM statuses')).toEqual({ n: DEFAULT_STATUSES.length });
  });
});

/** A migrated space database with the owner's row. */
function spaceDb(): NodeDb {
  const db = new NodeDb(':memory:');
  migrate(db, SPACE_MIGRATIONS, { appVersion: APP_VERSION });
  db.run(
    `INSERT INTO users (id, kind, display_name, email, is_member, updated_at)
     VALUES (:id, 'account', 'Owner', 'owner@example.com', 1, :t)`,
    { id: OWNER_ID, t: T },
  );
  return db;
}
