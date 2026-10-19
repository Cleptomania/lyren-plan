// The space host and app on DoDb, in workerd (design §2.5, §10.3): initSpaceDb with sample data, the
// gate's conditional reads, the users mirror sync, fold search with long token lists, the interim v1
// export and import, and the daily write budget from DoDb's meter, overlapping requests included. The
// Node suites (server/test/space) cover the behaviour in depth; this proves the SQL works where a SpaceDO
// runs it.

import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { SearchResultDTO } from '@shared/types';
import { parseAppConfig } from '../src/core/config';
import { sha256Hex } from '../src/core/crypto';
import type { SpaceAuthResult, SpaceDirectoryPort, SpaceSyncPayload, TrustedMeta } from '../src/core/ports';
import { DoDb } from '../src/runtime/cloudflare/doDb';
import { createSpaceHost } from '../src/space/host';
import { initSpaceDb } from '../src/space/init';
import { mirrorRow } from '../src/space/mirror';
import { NO_SAFETY } from '../src/space/safety';
import { createWriteState, readWriteState } from '../src/space/writeState';
import { importForm, unpackArchive, v1Of } from '../test/support/archive';

const SPACE_ID = '7k2m9q4w8x1c3v5b';
const TOKEN = 'owner-session-token';
let objects = 0;

const meta = (): TrustedMeta => ({
  clientIp: '192.0.2.10',
  secure: true,
  requestId: crypto.randomUUID(),
  userAgent: 'vitest',
  sessionTokenHash: sha256Hex(TOKEN),
  sessionCookie: 'host',
});

describe('the space host on DoDb', () => {
  it('init, conditional reads, the mirror sync, search, the export and an import, and the write budget', () =>
    runInDurableObject(env.TEST_DB.getByName(`space-${++objects}`), async (_instance, state) => {
      const db = new DoDb(state.storage);
      initSpaceDb(db, {
        spaceId: SPACE_ID,
        name: 'Team',
        owner: { userId: 1, displayName: 'Owner', email: 'owner@example.com' },
        syncVersion: 1,
        sampleData: {},
      });
      let syncVersion = 1;
      let payload: SpaceSyncPayload | null = null;
      const directory: SpaceDirectoryPort = {
        authorizeSpace: async (input): Promise<SpaceAuthResult> =>
          input.tokenHash === sha256Hex(TOKEN)
            ? {
                ok: true,
                cacheUntil: Date.now() + 3_600_000,
                identity: {
                  userId: 1,
                  displayName: 'Owner',
                  email: 'owner@example.com',
                  role: 'owner',
                  instanceAdmin: true,
                  sessionId: 1,
                  reauthAt: new Date().toISOString(),
                  space: { id: SPACE_ID, name: 'Team', status: 'active', syncVersion },
                },
              }
            : { ok: false, reason: 'unauthenticated' },
        spaceSync: async () => payload,
        importCandidates: async () => [],
        reserveImport: async () => ({ ok: true, reservationId: null, dailyLeft: null }),
        refundImport: async () => {},
        importCommitted: async () => {},
      };
      const config = { ...parseAppConfig({}, 'cloudflare').space, spaceDailyRowWrites: 1_000_000 };
      const writeState = createWriteState(db, { dailyRowWrites: config.spaceDailyRowWrites });
      const host = createSpaceHost({
        deps: {
          db,
          config,
          space: {
            id: SPACE_ID,
            directory,
            safety: NO_SAFETY,
            runtime: { kind: 'cloudflare', capabilities: { backupDownload: false, fileSnapshots: false } },
            readSnapshot: (fn) => fn(db),
            writeState,
            importGate: { run: (fn) => fn() },
          },
        },
        authCacheTtlMs: 30_000,
      });
      const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
        const res = await host.serve(
          new Request(`https://plan.example.com/api/s/${SPACE_ID}${path}`, {
            method,
            headers: { 'Content-Type': 'application/json', ...headers },
            body: body === undefined ? undefined : JSON.stringify(body),
          }),
          meta(),
        );
        const text = await res.text();
        return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
      };

      const bootstrap = await call('GET', '/bootstrap');
      expect(bootstrap.status).toBe(200);
      expect(bootstrap.body.projects.length).toBeGreaterThan(0);
      const etag = bootstrap.headers.get('etag')!;
      expect((await call('GET', '/bootstrap', undefined, { 'If-None-Match': etag })).status).toBe(304);

      // A member joins and a former account is gone: one sync after the version moved.
      db.run(
        "INSERT INTO users (id, kind, display_name, email, is_member, updated_at) VALUES (9, 'account', 'Gone', 'gone@example.com', 0, :t)",
        { t: new Date().toISOString() },
      );
      syncVersion = 2;
      payload = {
        name: 'Team',
        status: 'active',
        syncVersion: 2,
        members: [
          { userId: 1, displayName: 'Owner', email: 'owner@example.com' },
          { userId: 2, displayName: 'Bob', email: 'bob@example.com' },
        ],
        others: [{ userId: 9, deleted: true }],
      };
      host.invalidate();
      expect((await call('GET', '/bootstrap', undefined, { 'If-None-Match': etag })).status).toBe(200);
      expect(mirrorRow(db, 2)).toMatchObject({ display_name: 'Bob', is_member: 1 });
      expect(mirrorRow(db, 9)).toMatchObject({ display_name: 'Gone', email: null, deleted: 1 });

      // Fold search: Unicode and a token list longer than a statement's 100 parameters.
      const project = (await call('POST', '/projects', { name: 'Überprüfung', key: 'UEB' })).body;
      await call('POST', '/tasks', { projectId: project.id, title: 'the quick brown fox jumps over the lazy dog' });
      const unicode = (await call('GET', `/search?q=${encodeURIComponent('ÜBERPRÜFUNG')}`)).body as SearchResultDTO;
      expect(unicode.projects.map((p) => p.key)).toEqual(['UEB']);
      const q = Array.from({ length: 99 }, (_, i) => String.fromCharCode(97 + (i % 26))).join(' ');
      const long = (await call('GET', `/search?q=${encodeURIComponent(q)}`)).body as SearchResultDTO;
      expect(long.tasks.map((t) => t.title)).toEqual(['the quick brown fox jumps over the lazy dog']);
      expect((await call('POST', '/tags', { name: 'Ärger' })).status).toBe(201);
      expect((await call('POST', '/tags', { name: 'ärger' })).status).toBe(409);

      // The archive (gzip), and a v1 import of its rows: every reference to the importer, no safety point here.
      const exported = await host.serve(new Request(`https://plan.example.com/api/s/${SPACE_ID}/data/export`), meta());
      expect(exported.headers.get('content-type')).toBe('application/gzip');
      const archive = unpackArchive(new Uint8Array(await exported.arrayBuffer()));
      expect(archive.users.map((u) => u.id)).toEqual([1]);
      const committed = await host.serve(
        new Request(`https://plan.example.com/api/s/${SPACE_ID}/data/import/commit?mode=replace`, { method: 'POST', body: importForm(v1Of(archive)) }),
        meta(),
      );
      const imported = (await committed.json()) as { safety: unknown };
      expect(committed.status).toBe(200);
      expect(imported.safety).toBeNull();
      expect(db.all('SELECT DISTINCT created_by FROM tasks')).toEqual([{ created_by: 1 }]);

      // The meter counts today's rows; the budget then refuses writes.
      const rows = writeState.budgetLeft(Date.now());
      expect(rows).toBeLessThan(config.spaceDailyRowWrites);
      const since = db.meter.rowsWritten;
      db.meter.rowsWritten += rows; // as if a write request had used the rest of today's budget
      writeState.bump(since);
      const refused = await call('POST', '/tags', { name: 'late' });
      expect(refused.status).toBe(429);
      expect((await call('GET', '/tags')).status).toBe(200);
    }));

  it('counts the rows of overlapping write requests once each, from the real meter', () =>
    runInDurableObject(env.TEST_DB.getByName(`space-${++objects}`), async (_instance, state) => {
      const db = new DoDb(state.storage);
      const owner = { userId: 1, displayName: 'Owner', email: 'owner@example.com' };
      initSpaceDb(db, { spaceId: SPACE_ID, name: 'Team', owner, syncVersion: 1, sampleData: null });
      const identity = {
        ...owner,
        role: 'owner' as const,
        instanceAdmin: false,
        sessionId: 1,
        reauthAt: new Date().toISOString(),
        space: { id: SPACE_ID, name: 'Team', status: 'active' as const, syncVersion: 1 },
      };
      const directory: SpaceDirectoryPort = {
        authorizeSpace: async () => ({ ok: true, identity, cacheUntil: Date.now() + 3_600_000 }),
        spaceSync: async () => null,
        importCandidates: async () => [],
        reserveImport: async () => ({ ok: true, reservationId: null, dailyLeft: null }),
        refundImport: async () => {},
        importCommitted: async () => {},
      };
      const config = { ...parseAppConfig({}, 'cloudflare').space, spaceDailyRowWrites: 1_000_000 };
      const writeState = createWriteState(db, { dailyRowWrites: config.spaceDailyRowWrites });
      const host = createSpaceHost({
        deps: {
          db,
          config,
          space: {
            id: SPACE_ID,
            directory,
            safety: NO_SAFETY,
            runtime: { kind: 'cloudflare', capabilities: { backupDownload: false, fileSnapshots: false } },
            readSnapshot: (fn) => fn(db),
            writeState,
            importGate: { run: (fn) => fn() },
          },
        },
        authCacheTtlMs: 30_000,
      });
      /** A tag create whose body is sent when the returned release() is called. */
      const createTag = (name: string) => {
        const bytes = new TextEncoder().encode(JSON.stringify({ name }));
        let release!: () => void;
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            await released;
            controller.enqueue(bytes);
            controller.close();
          },
        });
        const headers = { 'Content-Type': 'application/json', 'Content-Length': String(bytes.byteLength) };
        const response = host.serve(new Request(`https://plan.example.com/api/s/${SPACE_ID}/tags`, { method: 'POST', headers, body }), meta());
        return { release, response };
      };

      const alone = createTag('alone');
      alone.release();
      expect((await alone.response).status).toBe(201);
      const one = readWriteState(db).rows;
      expect(one).toBeGreaterThan(0);
      const both = [createTag('a'), createTag('b')];
      await new Promise((resolve) => setTimeout(resolve, 10));
      for (const tag of both) tag.release();
      expect((await Promise.all(both.map((tag) => tag.response))).map((res) => res.status)).toEqual([201, 201]);
      expect(readWriteState(db).rows).toBe(3 * one);
    }));
});
