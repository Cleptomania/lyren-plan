// The directory app and service on DoDb, in workerd (design §2.5, §10.3): the same code as on Node,
// run inside a fresh Durable Object over its SQLite storage. The Node suites (server/test/directory)
// cover the behaviour in depth; this proves the SQL and the KDFs work where a DirectoryDO runs them.

import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { parseAppConfig } from '../src/core/config';
import { sha256Hex } from '../src/core/crypto';
import { migrate } from '../src/core/migrate';
import type { SpaceAdminClient, SpaceInit, TrustedMeta } from '../src/core/ports';
import { APP_VERSION } from '../src/core/version';
import { createDirectoryApp } from '../src/directory/app';
import { addMember } from '../src/directory/members';
import { DIRECTORY_MIGRATIONS } from '../src/directory/schema';
import { createMailTransport } from '../src/mail/transport';
import { DoDb } from '../src/runtime/cloudflare/doDb';

let objects = 0;

const meta = (o: Partial<TrustedMeta> = {}): TrustedMeta => ({
  clientIp: '192.0.2.10',
  secure: true,
  requestId: crypto.randomUUID(),
  userAgent: 'vitest',
  sessionTokenHash: null,
  sessionCookie: null,
  ...o,
});

describe('the directory app on DoDb', () => {
  it('setup, login, spaces and members, authorizeSpace, spaceSync and maintenance', () =>
    runInDurableObject(env.TEST_DB.getByName(`directory-${++objects}`), async (_instance, state) => {
      const db = new DoDb(state.storage);
      migrate(db, DIRECTORY_MIGRATIONS, { appVersion: APP_VERSION });
      const config = parseAppConfig({ SETUP_TOKEN: 'test-code' }, 'cloudflare');
      const inits: SpaceInit[] = [];
      const spaces: SpaceAdminClient = {
        init: async (init) => {
          inits.push(init);
        },
        invalidate: async () => {},
        destroy: async () => {},
        stats: async () => null,
      };
      const deferred: Array<Promise<unknown>> = [];
      const { app, service } = createDirectoryApp({
        db,
        config: config.directory,
        spaces,
        mail: createMailTransport(config.directory.mail),
        defer: (task) => deferred.push(task),
        clock: { now: () => Date.now() },
        runtime: { kind: 'cloudflare', capabilities: { backupDownload: false, fileSnapshots: false } },
        shareOrigins: () => [],
        sleep: async () => {},
      });
      let cookie = '';
      const call = async (method: string, path: string, body?: unknown, ip?: string) => {
        const res = await app.fetch(
          new Request(`https://plan.example.com${path}`, {
            method,
            headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
            body: body === undefined ? undefined : JSON.stringify(body),
          }),
          { meta: meta(ip ? { clientIp: ip } : {}) },
        );
        const session = res.headers.getSetCookie().find((c) => c.startsWith('__Host-lyren_session=') && !c.includes('Max-Age=0'));
        if (session) cookie = session.split(';')[0]!;
        return { status: res.status, body: (await res.json()) as any, cookies: res.headers.getSetCookie() };
      };

      expect((await call('GET', '/api/auth/status')).body).toMatchObject({ setupRequired: true, instance: { runtime: 'cloudflare', passwordMinLength: 12 } });
      const setup = await call('POST', '/api/auth/setup', {
        email: 'owner@example.com',
        password: 'correct horse battery',
        displayName: 'Owner',
        setupCode: 'test-code',
      });
      expect(setup.status).toBe(201);
      expect(setup.cookies.some((c) => c.startsWith('__Host-lyren_device='))).toBe(true);
      const owner = setup.body.user;
      const spaceId = inits[0]!.spaceId;

      // A wrong password, then the right one (rehash-free: the target is CF's p = 1).
      expect((await call('POST', '/api/auth/login', { identifier: 'owner@example.com', password: 'wrong password' }, '198.51.100.1')).status).toBe(401);
      const login = await call('POST', '/api/auth/login', { identifier: 'OWNER@example.com', password: 'correct horse battery' });
      expect(login.status).toBe(200);

      const created = await call('POST', '/api/spaces', { name: 'Team' });
      expect(created.status).toBe(201);
      expect((await call('GET', '/api/spaces')).body.map((s: { name: string }) => s.name)).toEqual(["Owner's space", 'Team']);

      const handle = crypto.randomUUID();
      const member = db.get<{ id: number }>(
        `INSERT INTO users (email, email_key, display_name, webauthn_user_id, created_at, updated_at)
         VALUES ('m@example.com', 'm@example.com', 'Member', :handle, 'x', 'x') RETURNING id`,
        { handle },
      )!;
      const team = db.get<{ id: number }>('SELECT id FROM spaces WHERE public_id = :id', { id: created.body.id })!;
      addMember(db, { spaceId: team.id, userId: member.id, role: 'viewer', addedBy: owner.id, nowMs: Date.now() });
      const patched = await call('PATCH', `/api/spaces/${created.body.id}/members/${member.id}`, { role: 'member' });
      expect(patched.body).toMatchObject({ userId: member.id, role: 'member' });

      const tokenHash = sha256Hex(cookie.split('=')[1]!);
      const auth = await service.authorizeSpace({ tokenHash, spaceId: created.body.id, cookie: 'host', secure: true });
      expect(auth).toMatchObject({ ok: true, identity: { userId: owner.id, role: 'owner', space: { name: 'Team', syncVersion: 3 } } });
      const sync = await service.spaceSync({ spaceId: created.body.id, mirrorUserIds: [owner.id, member.id, 999] });
      expect(sync?.members.map((m) => m.userId)).toEqual([owner.id, member.id]);
      expect(sync?.others).toEqual([{ userId: 999, deleted: true }]);
      expect(await service.authorizeSpace({ tokenHash, spaceId, cookie: 'plain', secure: true })).toEqual({ ok: false, reason: 'unauthenticated' });

      // The only owner of a space with another member, and the last admin: last_owner is answered first.
      expect((await call('DELETE', '/api/account', { confirm: 'owner@example.com' })).body.error.code).toBe('last_owner');
      expect(await service.maintenance()).toMatchObject({ sessions: 0, spacesPurged: 0 });
      await Promise.all(deferred);
    }));
});
