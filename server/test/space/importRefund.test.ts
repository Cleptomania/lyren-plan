// A commit whose write fails part way (design §8.4, Appendix D 62): its transaction is rolled back, but a Durable
// Object bills the rows it wrote all the same, so the reservation of the daily import budget is given back less
// those rows, and a commit that fails late is not free. The harness's MeteredDb bills as DoDb does, also for a
// transaction that fails; on Node, which has no meter, the whole reservation goes back.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunResult, SqlParams } from '../../src/core/db';
import { downloadArchive, replaceImport } from '../support/archive';
import { createSpaceHarness, OWNER_ID, type MeteredDb } from '../support/spaceHarness';

const OWN_MAPPING = { mapping: [{ archiveId: OWNER_ID, target: { kind: 'user', userId: OWNER_ID } }] };
const RESERVATION = { ok: true as const, reservationId: '2026-10-19.test-reservation', dailyLeft: 0 };

afterEach(() => {
  vi.restoreAllMocks();
});

/** The harness's space with sample data, its import reserving rows, and its activity inserts failing. */
async function failingAtActivity(o: { meter: boolean }) {
  const h = createSpaceHarness({ meter: o.meter, sampleData: true });
  h.directory.rowsReservation = RESERVATION;
  const archive = (await downloadArchive(h.owner.client)).archive!;
  const run = h.db.run.bind(h.db);
  /** The meter as the failing statement ran. */
  const failedAt = { rowsWritten: -1 };
  vi.spyOn(h.db, 'run').mockImplementation((sql: string, params?: SqlParams): RunResult => {
    // As a Durable Object refuses a row over its 2 MB, after the deletes and the tables before it.
    if (sql.includes('INSERT INTO activity')) {
      failedAt.rowsWritten = h.db.meter?.rowsWritten ?? 0;
      throw new Error('string or blob too big (test)');
    }
    return run(sql, params);
  });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  return { h, archive, failedAt };
}

describe('a commit that fails part way', () => {
  it('gives its reservation back less the rows the meter billed', async () => {
    const { h, archive, failedAt } = await failingAtActivity({ meter: true });
    const tasks = h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks')!.n;
    const before = (h.db as MeteredDb).meter.rowsWritten;
    const res = await replaceImport(h.owner.client, archive, { mapping: OWN_MAPPING });
    expect(res.status).toBe(500);
    // What the commit wrote before the failing statement: the deletes, and the inserts up to the activity.
    const spentRows = failedAt.rowsWritten - before;
    expect(spentRows).toBeGreaterThan(2 * tasks);
    expect(h.directory.calls.filter((c) => c.op === 'refundImport').map((c) => c.input)).toEqual([
      { reservationId: RESERVATION.reservationId, spentRows },
    ]);
    // Rolled back: the space is as it was.
    expect(h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks')!.n).toBe(tasks);
  });

  it('without a meter (Node), gives all of it back', async () => {
    const { h, archive } = await failingAtActivity({ meter: false });
    expect((await replaceImport(h.owner.client, archive, { mapping: OWN_MAPPING })).status).toBe(500);
    expect(h.directory.calls.filter((c) => c.op === 'refundImport').map((c) => c.input)).toEqual([
      { reservationId: RESERVATION.reservationId, spentRows: 0 },
    ]);
  });
});
