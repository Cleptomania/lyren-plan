// /api/data — this space's archive (design §8): the export (archive v2, gzip) and the import's two steps,
// analyze and commit, into a new space (mode=new: the space was created `importing` for it) or over this
// space's content (mode=replace). The gate has checked the role (owner), the re-auth window (always for the
// export, for mode=replace on the import), the space's status for the mode (§6.4 steps 2-3) and the body
// limit (IMPORT_BODY_LIMIT); the instance backup is the directory's GET /api/admin/backup (§9.5).
//
// Import (§8.4):
//   analyze  reserveImport's start (counts im:<userId>; 429 past it) → read and validate the file
//            (space/archive/read.ts) → the candidates (directory) → ImportAnalysisDTO. Stateless: nothing is stored.
//   commit   reserveImport's start, as for an analyze: every commit counts, whatever it answers (Appendix D 62)
//            → read and validate the file again → the mapping, checked against the candidates asked for now →
//            estimateRowWrites (over IMPORT_MAX_ROW_WRITES: 409) → reserveImport's rows, the rows of the daily
//            import budget (429 past it) → for a replace, the safety point (Node's snapshot) → the write, in one
//            transaction (space/archive/commit.ts), its rows left out of the space's write budget
//            (writeState.uncounted, Appendix D 19) → importCommitted (the directory: the space active, the mapped
//            accounts in its space_people) → ImportResultDTO. A commit whose write fails gives its reservation
//            back, less what the failed transaction was billed for (the space's meter, Cloudflare). A commit with
//            mode=new on a space the import already filled (a directory call that failed after the space's
//            transaction) reads nothing and writes nothing again: it repeats importCommitted and answers the
//            stored result (§8.4 step 5, Appendix D 60).
// The gate runs both inside Deps.space.importGate, taken before the body is read (space/gate.ts): one import at
// a time in the process (Node) or in the space (Cloudflare), else 503.

import { Hono } from 'hono';
import { archiveFileName } from '@shared/archive';
import type { ImportAnalysisDTO, ImportResultDTO } from '@shared/types';
import type { ImportReservation } from '../core/ports';
import { APP_VERSION } from '../core/version';
import type { AppEnv, Deps } from '../env';
import { quotaExceeded, rateLimited, unavailable } from '../http/errors';
import { nowIso, serverToday } from '../services/sql';
import { importAnalysis, referencedEmailKeys, referencedUsers, suggestTargets } from '../space/archive/analysis';
import { planImport, rowsToInsert, storedImport, writeImport } from '../space/archive/commit';
import { estimateRowWrites, rowsToDelete } from '../space/archive/estimate';
import { exportArchive } from '../space/archive/export';
import { readImportRequest, readMapping } from '../space/archive/read';
import type { ImportArchive } from '../space/archive/validate';
import { currentIdentity, currentUser } from '../space/context';

/** "a minute", "about 40 minutes", "about an hour": the wait of the hourly refusal (Retry-After has it exactly). */
export function waitText(seconds: number): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return minutes === 1 ? 'a minute' : minutes < 60 ? `about ${minutes} minutes` : 'about an hour';
}

/** A refused reservation (§8.4): too many imports this hour, or not enough left of today's import budget. */
function refusal(r: Extract<ImportReservation, { ok: false }>) {
  return r.reason === 'daily_budget'
    ? rateLimited("This instance has reached today's import limit. It resets at 00:00 UTC.", r.retryAfterSec)
    : rateLimited(`You have started too many imports in the last hour. Try again in ${waitText(r.retryAfterSec)}.`, r.retryAfterSec);
}

const thousands = (n: number) => n.toLocaleString('en-US');

export function dataRoutes({ db, config, space }: Deps) {
  const r = new Hono<AppEnv>();
  const { directory } = space;
  /** IMPORT_MAX_ROW_WRITES, or null when there is none. */
  const perImport = config.importMaxRowWrites > 0 ? config.importMaxRowWrites : null;

  /** The candidates for the archive's referenced users (none to ask for when no row names a user). */
  const candidatesFor = (archive: ImportArchive, userId: number) =>
    referencedUsers(archive).size === 0
      ? Promise.resolve([])
      : directory.importCandidates({ spaceId: space.id, userId, emailKeys: referencedEmailKeys(archive) });


  r.get('/export', async (c) => {
    const identity = currentIdentity(c);
    c.header('Content-Type', 'application/gzip');
    c.header('Content-Disposition', `attachment; filename="${archiveFileName(identity.space.name, serverToday())}"`);
    // Hono routes HEAD here too: answer with the headers only, without building the archive.
    if (c.req.method === 'HEAD') return c.body(null, 200);
    const chunks = await exportArchive(space, {
      spaceId: space.id,
      name: identity.space.name,
      exportedBy: identity.userId,
      appVersion: APP_VERSION,
    });
    const archive = new Blob(chunks);
    c.header('Content-Length', String(archive.size));
    return c.body(archive.stream(), 200);
  });

  r.post('/import/analyze', async (c) => {
    const user = currentUser(c);
    const started = await directory.reserveImport({ spaceId: space.id, userId: user.id, step: 'start', rowWrites: 0 });
    if (!started.ok) throw refusal(started);
    const { archive } = await readImportRequest(c, config);
    const candidates = await candidatesFor(archive, user.id);
    // Estimated as the suggestions would map the users (at most one mirror row each, whatever the mapping).
    const suggestions = suggestTargets(archive, candidates, user.id);
    const inserted = rowsToInsert(planImport(archive, { mapping: { mapping: suggestions }, candidates, importerId: user.id }));
    const deleted = rowsToDelete(db);
    return c.json<ImportAnalysisDTO>(
      importAnalysis({
        archive,
        mode: c.var.importMode!,
        candidates,
        importerId: user.id,
        estimate: {
          rowWrites: estimateRowWrites(inserted, deleted),
          rowWritesWithoutActivity: estimateRowWrites({ ...inserted, activity: 0 }, deleted),
          limit: perImport,
          dailyLeft: started.dailyLeft,
        },
      }),
    );
  });

  r.post('/import/commit', async (c) => {
    const user = currentUser(c);
    const mode = c.var.importMode!;
    const commit = async (mappedUserIds: number[]) => {
      try {
        await directory.importCommitted({ spaceId: space.id, userId: user.id, mode, mappedUserIds });
      } catch (err) {
        console.error(`[lyren] Could not record the import of space ${space.id}:`, err);
        throw unavailable('The import was saved, but it could not be completed. Send it again to finish.');
      }
      // The space is active now: the importer's cached identity (Cloudflare's auth cache) still says importing,
      // which would refuse their next requests until it ran out. A fresh one replaces it (§10.5).
      if (mode === 'new') {
        await c.env.reauthorize().catch((err) => console.error(`[lyren] Could not refresh an identity of space ${space.id}:`, err));
      }
    };

    // Filled by an earlier commit whose answer was lost: nothing is written again.
    const stored = mode === 'new' ? storedImport(db) : null;
    if (stored) {
      await commit(stored.mappedUserIds);
      return c.json<ImportResultDTO>(stored.result);
    }

    const started = await directory.reserveImport({ spaceId: space.id, userId: user.id, step: 'start', rowWrites: 0 });
    if (!started.ok) throw refusal(started);
    const { archive, mapping } = await readImportRequest(c, config);
    const candidates = await candidatesFor(archive, user.id);
    const plan = planImport(archive, { mapping: readMapping(mapping), candidates, importerId: user.id });
    const rowWrites = estimateRowWrites(rowsToInsert(plan), rowsToDelete(db));
    if (perImport !== null && rowWrites > perImport) {
      throw quotaExceeded(
        `This import needs about ${thousands(rowWrites)} row writes; this instance allows ${thousands(perImport)} per import.`,
      );
    }
    const reservation = await directory.reserveImport({ spaceId: space.id, userId: user.id, step: 'rows', rowWrites });
    if (!reservation.ok) throw refusal(reservation);

    let written;
    /** The space's meter as the write began (Cloudflare; Node has none). */
    let meterBefore: number | null = null;
    try {
      // Taken after validation and before anything is replaced; a failure aborts the import (500).
      const safety = mode === 'replace' ? await space.safety.beforeReplace() : null;
      meterBefore = db.meter?.rowsWritten ?? null;
      // Imports have their own budget (§8.9): the space's write budget leaves these rows out (§6.4.2).
      written = space.writeState.uncounted(() => writeImport(db, plan, { now: nowIso(), safety }));
    } catch (err) {
      if (reservation.reservationId !== null) {
        // A Durable Object bills the writes of a transaction it rolls back: those rows stay spent.
        const spentRows = meterBefore === null ? 0 : db.meter!.rowsWritten - meterBefore;
        await directory.refundImport({ reservationId: reservation.reservationId, spentRows }).catch((e) => {
          console.error(`[lyren] Could not give back the import reservation of space ${space.id}:`, e);
        });
      }
      throw err;
    }
    await commit(written.mappedUserIds);
    return c.json<ImportResultDTO>(written.result);
  });

  return r;
}
