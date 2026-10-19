// The DirectoryService (design §2.3, §3.5, §9.8): authorizeSpace (401 and 404 reasons, cacheUntil, the
// cookie-name rule, the hourly touch), spaceSync (members, former members, deleted accounts),
// importCommitted (idempotent), and maintenance. The other import calls: imports.test.ts.

import { describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '../../src/core/crypto';
import { createDirectoryHarness, PASSWORD, type DirectoryHarness, type DirectoryTestClient } from '../support/directoryHarness';

const DAY = 86_400_000;

const tokenHash = (client: DirectoryTestClient) =>
  sha256Hex(client.jar.get('lyren_session') ?? client.jar.get('__Host-lyren_session')!);

function authorize(h: DirectoryHarness, client: DirectoryTestClient, spaceId: string, o: { cookie?: 'host' | 'plain'; secure?: boolean } = {}) {
  return h.service.authorizeSpace({ tokenHash: tokenHash(client), spaceId, cookie: o.cookie ?? 'plain', secure: o.secure ?? false });
}

describe('authorizeSpace', () => {
  it('answers the identity of a member, cached no longer than the session lives', async () => {
    const h = createDirectoryHarness({ vars: { SESSION_MAX_DAYS: '3' } });
    const { client, user, spaceId } = await h.setup();
    const session = h.db.get<{ id: number; reauth_at: string; expires_at: string }>('SELECT * FROM sessions')!;
    const result = await authorize(h, client, spaceId);
    expect(result).toEqual({
      ok: true,
      identity: {
        userId: user.id,
        displayName: 'Owner',
        email: 'owner@example.com',
        role: 'owner',
        instanceAdmin: true,
        sessionId: session.id,
        reauthAt: session.reauth_at,
        space: { id: spaceId, name: "Owner's space", status: 'active', syncVersion: 1 },
      },
      cacheUntil: Date.parse(session.expires_at),
    });
    expect(result.ok && result.cacheUntil).toBe(h.clock.now() + 3 * DAY);
  });

  it('unauthenticated: an unknown or expired token, a disabled account, a revoked session', async () => {
    const h = createDirectoryHarness();
    const { client, spaceId } = await h.setup();
    expect(await h.service.authorizeSpace({ tokenHash: sha256Hex('nope'), spaceId, cookie: 'plain', secure: false })).toEqual({
      ok: false,
      reason: 'unauthenticated',
    });
    expect(await h.service.authorizeSpace({ tokenHash: 'not hex', spaceId, cookie: 'plain', secure: false })).toEqual({
      ok: false,
      reason: 'unauthenticated',
    });
    h.db.run("UPDATE users SET status = 'disabled'");
    expect(await authorize(h, client, spaceId)).toEqual({ ok: false, reason: 'unauthenticated' });
    h.db.run("UPDATE users SET status = 'active'");
    h.clock.advance(31 * DAY);
    expect(await authorize(h, client, spaceId)).toEqual({ ok: false, reason: 'unauthenticated' });
    expect(h.db.all('SELECT id FROM sessions')).toEqual([]);
  });

  it('not_found: not a member, a deleted or provisioning space, an unknown id', async () => {
    const h = createDirectoryHarness();
    const { client, spaceId, user } = await h.setup();
    const stranger = await h.addUser({ email: 'stranger@example.com' });
    expect(await authorize(h, stranger.client, spaceId)).toEqual({ ok: false, reason: 'not_found' });
    expect(await authorize(h, client, 'zzzzzzzzzzzzzzzz')).toEqual({ ok: false, reason: 'not_found' });
    h.db.run(
      `INSERT INTO spaces (public_id, name, status, created_by, created_at, updated_at) VALUES ('bbbbbbbbbbbbbbbb', 'P', 'provisioning', :u, 'x', 'x')`,
      { u: user.id },
    );
    h.db.run("INSERT INTO memberships (space_id, user_id, role, created_at, updated_at) SELECT id, :u, 'owner', 'x', 'x' FROM spaces WHERE public_id = 'bbbbbbbbbbbbbbbb'", { u: user.id });
    expect(await authorize(h, client, 'bbbbbbbbbbbbbbbb')).toEqual({ ok: false, reason: 'not_found' });
    await client.delete(`/api/spaces/${spaceId}`, { confirmName: "Owner's space" });
    expect(await authorize(h, client, spaceId)).toEqual({ ok: false, reason: 'not_found' });
  });

  it('on HTTPS the unprefixed cookie name counts only for a legacy session', async () => {
    const h = createDirectoryHarness();
    const { client, spaceId } = await h.setup();
    expect(await authorize(h, client, spaceId, { cookie: 'plain', secure: true })).toEqual({ ok: false, reason: 'unauthenticated' });
    expect(await authorize(h, client, spaceId, { cookie: 'host', secure: true })).toMatchObject({ ok: true });
    h.db.run("UPDATE sessions SET auth_method = 'legacy'");
    expect(await authorize(h, client, spaceId, { cookie: 'plain', secure: true })).toMatchObject({ ok: true });
  });

  it('touches the session at most hourly, like the directory middleware', async () => {
    const h = createDirectoryHarness();
    const { client, spaceId } = await h.setup();
    const expires = () => h.db.get<{ expires_at: string }>('SELECT expires_at FROM sessions')!.expires_at;
    const first = expires();
    h.clock.advance(30 * 60_000);
    await authorize(h, client, spaceId);
    expect(expires()).toBe(first);
    h.clock.advance(31 * 60_000);
    const result = await authorize(h, client, spaceId);
    expect(expires()).toBe(new Date(h.clock.now() + 30 * DAY).toISOString());
    expect(result.ok && result.cacheUntil).toBe(h.clock.now() + 30 * DAY);
  });
});

describe('spaceSync', () => {
  it('answers the members, and for every other mirror id its name or that it is deleted', async () => {
    const h = createDirectoryHarness();
    const { client, spaceId, user } = await h.setup();
    const member = await h.addUser({ email: 'member@example.com', displayName: 'Mem', spaceId, role: 'member' });
    const former = await h.addUser({ email: 'former@example.com', displayName: 'Former', spaceId, role: 'viewer' });
    await client.delete(`/api/spaces/${spaceId}/members/${former.user.id}`);
    const gone = await h.addUser({ email: 'gone@example.com', spaceId, role: 'viewer' });
    h.db.run('DELETE FROM users WHERE id = :id', { id: gone.user.id });
    const sync = await h.service.spaceSync({
      spaceId,
      mirrorUserIds: [user.id, member.user.id, former.user.id, gone.user.id, gone.user.id, 0, -3],
    });
    expect(sync).toEqual({
      name: "Owner's space",
      status: 'active',
      syncVersion: expect.any(Number),
      members: [
        { userId: user.id, displayName: 'Owner', email: 'owner@example.com' },
        { userId: member.user.id, displayName: 'Mem', email: 'member@example.com' },
      ],
      others: [
        { userId: former.user.id, displayName: 'Former' },
        { userId: gone.user.id, deleted: true },
      ],
    });
  });

  it('takes a large mirror in one statement (json_each), and answers null for a space that is gone', async () => {
    const h = createDirectoryHarness();
    const { client, spaceId } = await h.setup();
    const ids = Array.from({ length: 1500 }, (_, i) => 1000 + i);
    const sync = await h.service.spaceSync({ spaceId, mirrorUserIds: ids });
    expect(sync?.others).toHaveLength(1500);
    await client.delete(`/api/spaces/${spaceId}`, { confirmName: "Owner's space" });
    expect(await h.service.spaceSync({ spaceId, mirrorUserIds: [] })).toBeNull();
    expect(await h.service.spaceSync({ spaceId: 'zzzzzzzzzzzzzzzz', mirrorUserIds: [] })).toBeNull();
  });
});

describe('importCommitted', () => {
  it('activates an importing space, records the mapped accounts in space_people and bumps; idempotent', async () => {
    const h = createDirectoryHarness();
    const { client, user } = await h.setup();
    const other = await h.addUser({ email: 'author@example.com' });
    const created = await client.post('/api/spaces', { name: 'Import', forImport: true });
    const spaceId = created.body.id as string;
    const version = () => h.db.get<{ v: number; status: string }>('SELECT sync_version AS v, status FROM spaces WHERE public_id = :id', { id: spaceId })!;
    const input = { spaceId, userId: user.id, mode: 'new' as const, mappedUserIds: [other.user.id, 424242] };
    await h.service.importCommitted(input);
    expect(version()).toEqual({ v: 2, status: 'active' });
    const people = () =>
      h.db
        .all<{ user_id: number }>('SELECT user_id FROM space_people sp JOIN spaces s ON s.id = sp.space_id WHERE s.public_id = :id ORDER BY user_id', { id: spaceId })
        .map((r) => r.user_id);
    expect(people()).toEqual([user.id, other.user.id]);
    await h.service.importCommitted(input);
    expect(version().status).toBe('active');
    expect(people()).toEqual([user.id, other.user.id]);
    // The mapped author is not a member: spaceSync names them among the others.
    const sync = await h.service.spaceSync({ spaceId, mirrorUserIds: [user.id, other.user.id] });
    expect(sync?.others).toEqual([{ userId: other.user.id, displayName: 'author' }]);
  });
});

describe('maintenance', () => {
  it('purges expired sessions, device tokens, old events, closed invitations and throttle rows', async () => {
    const h = createDirectoryHarness();
    const { client, user } = await h.setup();
    const now = () => new Date(h.clock.now()).toISOString();
    h.db.run(
      "INSERT INTO security_events (user_id, type, data, created_at) VALUES (:u, 'login', '{}', '2026-01-01T00:00:00.000Z')",
      { u: user.id },
    );
    h.db.run(
      `INSERT INTO invitations (token_hash, space_id, email, email_key, role, invited_by, delivery, created_at, expires_at, last_sent_at, revoked_at)
       VALUES ('h1', NULL, 'x@example.com', 'x@example.com', NULL, :u, 'link', :now, :now, :now, :now)`,
      { u: user.id, now: now() },
    );
    for (let i = 0; i < 3; i++) await h.client({ ip: '203.0.113.9' }).post('/api/auth/login', { identifier: 'owner@example.com', password: 'nope nope' });
    expect(h.db.all('SELECT key FROM auth_throttle').length).toBeGreaterThan(0);
    const first = await h.service.maintenance();
    expect(first).toMatchObject({ sessions: 0, securityEvents: 1, invitations: 0 });
    h.clock.advance(400 * DAY);
    const later = await h.service.maintenance();
    expect(later).toMatchObject({ sessions: 1, deviceTokens: 1, invitations: 1, spacesPurged: 0 });
    expect(later.throttleRows).toBeGreaterThan(0);
    expect(h.db.all('SELECT key FROM auth_throttle')).toEqual([]);
    expect((await client.get('/api/account')).status).toBe(401);
  });

  it('flushes buffered throttle counts, so a restart keeps them', async () => {
    const h = createDirectoryHarness();
    await h.setup();
    const attacker = h.client({ ip: '203.0.113.9' });
    for (let i = 0; i < 5; i++) await attacker.post('/api/auth/login', { identifier: 'owner@example.com', password: 'nope nope' });
    const count = () => h.db.get<{ count: number }>("SELECT count FROM auth_throttle WHERE key = 'li:203.0.113.9'")?.count;
    expect(count()).toBe(3);
    await h.service.maintenance();
    expect(count()).toBe(5);
    const restarted = h.restart();
    const again = restarted.client({ ip: '203.0.113.9' });
    for (let i = 0; i < 5; i++) await again.post('/api/auth/login', { identifier: 'owner@example.com', password: 'nope nope' });
    expect((await again.post('/api/auth/login', { identifier: 'owner@example.com', password: PASSWORD })).status).toBe(429);
  });

  it('one failing task does not stop the others', async () => {
    const h = createDirectoryHarness();
    await h.setup();
    h.clock.advance(400 * DAY);
    const run = h.db.run.bind(h.db);
    const spy = vi.spyOn(h.db, 'run').mockImplementation((sql, params) => {
      if (sql.includes('DELETE FROM device_tokens')) throw new Error('disk on fire (test)');
      return run(sql, params);
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await h.service.maintenance();
    spy.mockRestore();
    expect(errors).toHaveBeenCalledWith('[lyren] Maintenance task "device tokens" failed:', expect.any(Error));
    errors.mockRestore();
    expect(result).toMatchObject({ sessions: 1, deviceTokens: 0 });
    expect(h.db.all('SELECT id FROM device_tokens')).toHaveLength(1);
  });
});
