// What an import commit writes, measured where it is billed (design §8.9, §14.4): estimateRowWrites against
// DoDb's meter for the platform review's 2,000-task archive (support/archiveFixture.ts), into a new space and
// over a space that holds it already, with and without the activity history, each within ±10%. The commit runs
// inside a fresh TestDbDO as the route runs it (planImport, writeImport, writeState.uncounted, then the write
// generation the gate writes); the import through the Worker, with its limits, is archive.test.ts's. Each case
// prints a line ("[cost] …", --reporter=verbose shows it); docs/cloudflare.md has the numbers. Also: the rows
// an import writes on DoDb are Node's, every table and column (the import contract).

import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { ImportCandidateDTO, SpaceArchiveDTO } from '@shared/types';
import { DoDb } from '../src/runtime/cloudflare/doDb';
import { planImport, rowsToInsert, writeImport } from '../src/space/archive/commit';
import { estimateRowWrites, rowsToDelete } from '../src/space/archive/estimate';
import { validateArchive } from '../src/space/archive/validate';
import { initSpaceDb } from '../src/space/init';
import { createWriteState } from '../src/space/writeState';
import { checkSpaceDb } from '../test/contract/fixtures';
import { defineImportContract } from '../test/contract/import.contract';
import { reviewArchive } from '../test/support/archiveFixture';
import { withDoSpaceDb } from './spaceDb';

const OWNER = { userId: 1, displayName: 'Owner', email: 'owner@example.com' };
const CANDIDATES: ImportCandidateDTO[] = [
  { userId: 1, displayName: 'Owner', email: 'owner@example.com', isYou: true },
  { userId: 2, displayName: 'Bob', email: 'bob@example.com', isYou: false },
  { userId: 3, displayName: 'Carol', email: 'carol@example.com', isYou: false },
];
const MAPPING = [
  { archiveId: -1, target: { kind: 'placeholder' as const } },
  ...CANDIDATES.map((c) => ({ archiveId: c.userId, target: { kind: 'user' as const, userId: c.userId } })),
];

let objects = 0;

/** The estimate of committing `archive` into `db` as it is now, and the rows the commit then wrote. */
function commit(db: DoDb, archive: SpaceArchiveDTO, skipActivity: boolean) {
  const plan = planImport(validateArchive(JSON.parse(JSON.stringify(archive))), {
    mapping: { mapping: MAPPING, skipActivity },
    candidates: CANDIDATES,
    importerId: OWNER.userId,
  });
  const estimate = estimateRowWrites(rowsToInsert(plan), rowsToDelete(db));
  const writeState = createWriteState(db, { dailyRowWrites: 0 });
  const before = db.meter.rowsWritten;
  writeState.uncounted(() => writeImport(db, plan, { now: new Date().toISOString(), safety: null }));
  writeState.bump(before);
  return { estimate, written: db.meter.rowsWritten - before };
}

/** In a fresh space object: a space as init leaves it (its seeded defaults), filled with the archive first when `replace`. */
function measure(o: { replace: boolean; skipActivity: boolean }) {
  return runInDurableObject(env.TEST_DB.getByName(`import-cost-${++objects}`), (_instance, state) => {
    const db = new DoDb(state.storage);
    initSpaceDb(db, { spaceId: '7k2m9q4w8x1c3v5b', name: 'Review space', owner: OWNER, syncVersion: 1, sampleData: null });
    const archive = reviewArchive();
    if (o.replace) commit(db, archive, false);
    const result = commit(db, archive, o.skipActivity);
    checkSpaceDb(db);
    expect(db.all('PRAGMA foreign_key_check')).toEqual([]);
    return result;
  });
}

describe('the estimate against the meter (2,001 tasks, 4,002 tag rows, 306 comments, 2,417 activity entries)', () => {
  for (const replace of [false, true]) {
    for (const skipActivity of [false, true]) {
      const label = `${replace ? 'replace' : 'new'}, ${skipActivity ? 'without' : 'with'} the activity`;
      it(`${label}: within ±10%`, async () => {
        const { estimate, written } = await measure({ replace, skipActivity });
        const off = (estimate - written) / written;
        console.log(`[cost] import (${label}): rows written ${written}, estimated ${estimate} (${(off * 100).toFixed(1)}%)`);
        expect(Math.abs(off)).toBeLessThanOrEqual(0.1);
      });
    }
  }
});

// The same rows as on Node, every table and column (server/test/contract/import.contract.ts).
defineImportContract('durable-object', withDoSpaceDb);
