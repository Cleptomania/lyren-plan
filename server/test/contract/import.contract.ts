// The import's rows are the same on both runtimes (design §14.5 parity), every table and every column: the
// review-shaped archive (support/archiveFixture.ts) committed at a fixed time into a fresh space of the adapter
// under test, its rows (the fold columns, ranks, tag lists, counts, REAL estimates, provenance, the mirror,
// settings and sequences among them) dumped as JSON and hashed. The hash is a constant here, so NodeDb
// (server/test/import.contract.node.test.ts) and DoDb in workerd (server/test-workers/importCost.test.ts) must
// both write exactly those rows; a change to the import or the schema changes it, and then it is updated here.

import { describe, expect, it } from 'vitest';
import type { ImportCandidateDTO } from '@shared/types';
import { sha256Hex } from '../../src/core/crypto';
import type { Db } from '../../src/core/db';
import { planImport, writeImport } from '../../src/space/archive/commit';
import { validateArchive } from '../../src/space/archive/validate';
import { reviewArchive } from '../support/archiveFixture';
import type { WithSpaceDb } from './fixtures';

/** The digest of the rows the import below writes (see the header). */
export const IMPORT_DUMP_SHA256 = '6117c6b0973f3e5ce109892e730aaa19c71c996848b5d301e9eeb09022c73198';

const NOW = '2026-10-18T12:00:00.000Z';

const CANDIDATES: ImportCandidateDTO[] = [
  { userId: 1, displayName: 'Owner', email: 'owner@example.com', isYou: true },
  { userId: 2, displayName: 'Bob', email: 'bob@example.com', isYou: false },
];

/** Every table's rows in key order, every column ('_meta': what the import wrote). */
export function dumpSpace(db: Db): string {
  const tables = ['users', 'settings', 'statuses', 'tags', 'projects', 'milestones', 'epics', 'tasks', 'task_tags', 'comments', 'work_logs', 'activity', 'boards'];
  const out: Record<string, unknown> = {};
  for (const table of tables) {
    const order = table === 'task_tags' ? 'task_id, tag_id' : table === 'settings' ? 'key' : 'id';
    out[table] = db.all(`SELECT * FROM ${table} ORDER BY ${order}`);
  }
  out.sequences = db.all('SELECT name, seq FROM sqlite_sequence ORDER BY name');
  out.meta = db.all("SELECT key, value FROM _meta WHERE key IN ('imported_at', 'import_result') ORDER BY key");
  return JSON.stringify(out);
}

export function defineImportContract(name: string, withDb: WithSpaceDb) {
  describe(`the rows of an import (${name})`, () => {
    it('are the same on both runtimes, every table and column', async () => {
      const dump = await withDb(({ db, userId }) => {
        // Carol has no account here: her rows go to a placeholder, as the archive's own placeholder's do.
        const plan = planImport(validateArchive(JSON.parse(JSON.stringify(reviewArchive()))), {
          mapping: {
            mapping: [
              { archiveId: -1, target: { kind: 'placeholder' } },
              { archiveId: 1, target: { kind: 'user', userId } },
              { archiveId: 2, target: { kind: 'user', userId: 2 } },
              { archiveId: 3, target: { kind: 'placeholder' } },
            ],
          },
          candidates: CANDIDATES,
          importerId: userId,
        });
        writeImport(db, plan, { now: NOW, safety: null });
        return dumpSpace(db);
      });
      expect(dump.length).toBeGreaterThan(1_000_000);
      expect(sha256Hex(dump)).toBe(IMPORT_DUMP_SHA256);
    });
  });
}
