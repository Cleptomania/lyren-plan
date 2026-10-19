// Archive v2 through the Worker (design §8, §14.5, SELF.fetch, Cloudflare's limits: IMPORT_BODY_LIMIT 4 MiB,
// IMPORT_MAX_JSON_VALUES 300,000, IMPORT_MAX_ROW_WRITES 50,000, IMPORT_DAILY_ROW_WRITES 60,000): export → import into
// a new space with remapping; the archive the Node tests check in imports and exports back unchanged (the same
// file on both runtimes); the platform review's 2,000-task archive, its rows written against the analysis's
// estimate; an import over the per-import limit refused (409), and one past the day's budget (429); replace,
// with no safety point here; and an abandoned import. The hostile archives are validation.test.ts's.

import { beforeAll, describe, expect, it } from 'vitest';
import type { ImportAnalysisDTO, ImportResultDTO, SpaceArchiveDTO } from '@shared/types';
import fixture from '../test/fixtures/spaceArchive.json';
import { reviewArchive } from '../test/support/archiveFixture';
import { downloadArchive, identityMapping, importArchive, importForm, sameContent, suggestedMapping } from '../test/support/archive';
import { objectDbs } from './entry';
import { addAccount, inDirectory, setupOwner, type WorkerClient } from './support';

let owner: WorkerClient;
let ownerId: number;
let spaceId: string;
let bob: { client: WorkerClient; user: { id: number } };

beforeAll(async () => {
  const setup = await setupOwner();
  ({ client: owner, spaceId } = setup);
  ownerId = setup.user.id;
  // Bob is the instance's second account (id 2), as in the checked-in archive.
  bob = await addAccount({ email: 'bob@example.com', displayName: 'Bob', spaceId, ip: '192.0.2.31' });
});

const s = (id: string) => `/api/s/${id}/data`;

/** A space created for an import. */
async function newSpace(name = 'Moved'): Promise<string> {
  const res = await owner.post<{ id: string; status: string }>('/api/spaces', { name, forImport: true });
  expect(res.status).toBe(201);
  return res.body.id;
}

/** Forget today's import budget and the import rate limit (each test spends its own). */
const freshBudget = () => inDirectory((db) => db.run("DELETE FROM auth_throttle WHERE substr(key, 1, 3) IN ('imp', 'imr', 'im:')"));

describe('archive v2 through the Worker', () => {
  it('export → import into a new space, the users remapped by address; the new space exports the same rows', async () => {
    await freshBudget();
    expect((await bob.client.post(`/api/s/${spaceId}/tags`, { name: 'by Bob' })).status).toBe(201);
    const task = (await owner.post(`/api/s/${spaceId}/tasks`, { projectId: (await owner.post(`/api/s/${spaceId}/projects`, { name: 'Web', key: 'WEB' })).body.id, title: 'Hello' })).body;
    expect((await bob.client.post(`/api/s/${spaceId}/tasks/${task.id}/comments`, { body: 'Bob says hi' })).status).toBe(201);
    const exported = await downloadArchive(owner, `${s(spaceId)}/export`);
    expect(exported.status).toBe(200);
    expect(exported.headers.get('content-type')).toBe('application/gzip');
    expect(exported.headers.get('content-disposition')).toMatch(/^attachment; filename="lyren-space-owner-s-space-\d{4}-\d{2}-\d{2}\.json\.gz"$/);
    const a = exported.archive!;
    expect(a.users.map((u) => [u.id, u.email])).toEqual([
      [ownerId, 'owner@example.com'],
      [bob.user.id, 'bob@example.com'],
    ]);

    const target = await newSpace();
    const { analysis, commit } = await importArchive(owner, { path: s(target), mode: 'new', file: exported.bytes });
    expect(analysis.status).toBe(200);
    const an = analysis.body as ImportAnalysisDTO;
    expect(an.estimate.limit).toBe(50_000);
    expect(an.estimate.dailyLeft).toBe(60_000);
    expect(an.suggestions).toEqual([
      { archiveId: ownerId, target: { kind: 'user', userId: ownerId } },
      { archiveId: bob.user.id, target: { kind: 'user', userId: bob.user.id } },
    ]);
    expect(commit.status, JSON.stringify(commit.body)).toBe(200);
    const result = commit.body as ImportResultDTO;
    expect(result.safety).toBeNull();
    expect(result.nonMemberAuthors.map((u) => u.userId)).toEqual([bob.user.id]);
    expect((await owner.get(`/api/spaces/${target}`)).body.status).toBe('active');
    const again = (await downloadArchive(owner, `${s(target)}/export`)).archive!;
    expect(again.comments.find((c) => c.authorId === bob.user.id)).toMatchObject({ body: 'Bob says hi', importedBy: ownerId });
    expect(again.tasks).toEqual(a.tasks);
    expect(again.tags).toEqual(a.tags);
  });

  it('the checked-in archive (exported by the Node tests) imports and exports back unchanged', async () => {
    await freshBudget();
    const archive = fixture as SpaceArchiveDTO;
    expect(archive.users.map((u) => u.id)).toEqual([-1, ownerId, bob.user.id]);
    const target = await newSpace('Fixture');
    const { commit } = await importArchive(owner, { path: s(target), mode: 'new', file: archive, gzip: true, mapping: identityMapping(archive) });
    expect(commit.status, JSON.stringify(commit.body)).toBe(200);
    const again = (await downloadArchive(owner, `${s(target)}/export`)).archive!;
    expect(sameContent(again)).toEqual(sameContent(archive));
  });

  it("the review's 2,000-task archive: the rows written within ±10% of the analysis's estimate; a second one past the day's budget", async () => {
    await freshBudget();
    const archive = reviewArchive();
    const target = await newSpace('Review');
    const meter = () => ({ ...objectDbs.spaces.get(target)!.meter });
    /** A request, with the rows the space's object read and wrote for it and its wall time, printed. */
    const measured = async <T>(label: string, send: () => Promise<T>) => {
      const before = meter();
      const started = performance.now();
      const res = await send();
      const ms = performance.now() - started;
      const after = meter();
      const cost = { read: after.rowsRead - before.rowsRead, written: after.rowsWritten - before.rowsWritten };
      console.log(`[cost] ${label}: rows read ${cost.read}, rows written ${cost.written}, ${ms.toFixed(0)} ms`);
      return { res, ...cost };
    };
    const analyzed = await measured('POST data/import/analyze (2,001 tasks, gzip, mode=new)', () =>
      owner.post<ImportAnalysisDTO>(`${s(target)}/import/analyze?mode=new`, importForm(archive, { gzip: true })),
    );
    const analysis = analyzed.res.body;
    expect(analyzed.written).toBe(0);
    // Bob and Carol: Carol has no account here, so her rows go to a placeholder (and the archive's own one too).
    const mapping = suggestedMapping(analysis);
    expect(mapping.mapping.map((m) => m.target.kind)).toEqual(['placeholder', 'user', 'user', 'placeholder']);
    const committed = await measured('POST data/import/commit (2,001 tasks, gzip, mode=new)', () =>
      owner.post(`${s(target)}/import/commit?mode=new`, importForm(archive, { gzip: true, mapping })),
    );
    expect(committed.res.status, JSON.stringify(committed.res.body)).toBe(200);
    const written = committed.written;
    const off = (analysis.estimate.rowWrites - written) / written;
    console.log(`[cost] import estimate through the Worker: ${analysis.estimate.rowWrites} for ${written} rows written`);
    expect(Math.abs(off)).toBeLessThanOrEqual(0.1);
    // The import's rows are not the space's write budget's (§6.4.2): the space still takes writes today.
    expect((await owner.post(`/api/s/${target}/tags`, { name: 'after the import' })).status).toBe(201);

    // The day's budget: what is left does not fit a second such import.
    const second = await newSpace('Second');
    const left = (await owner.post<ImportAnalysisDTO>(`${s(second)}/import/analyze?mode=new`, importForm(archive, { gzip: true }))).body;
    expect(left.estimate.dailyLeft).toBe(60_000 - analysis.estimate.rowWrites);
    const refused = await owner.post(`${s(second)}/import/commit?mode=new`, importForm(archive, { gzip: true, mapping: suggestedMapping(left) }));
    expect(refused.status).toBe(429);
    expect(refused.body.error).toEqual({ code: 'rate_limited', message: "This instance has reached today's import limit. It resets at 00:00 UTC." });
    expect(refused.headers.get('retry-after')).toMatch(/^\d+$/);
    // Abandoned: deleted by its owner at once, without a typed name.
    expect((await owner.delete(`/api/spaces/${second}`, { confirmName: '' })).status).toBe(200);
    expect((await owner.get(`/api/spaces/${second}`)).status).toBe(404);
  });

  it('over IMPORT_MAX_ROW_WRITES: refused before anything is reserved; without the activity it fits', async () => {
    await freshBudget();
    const archive = reviewArchive({ tasks: 3500, comments: 300, worklogs: 100, extraActivity: 0 });
    const target = await newSpace('Too big');
    const { analysis, commit } = await importArchive(owner, { path: s(target), mode: 'new', file: archive, gzip: true });
    const { rowWrites, rowWritesWithoutActivity } = (analysis.body as ImportAnalysisDTO).estimate;
    expect(rowWrites).toBeGreaterThan(50_000);
    expect(rowWritesWithoutActivity).toBeLessThan(50_000);
    expect(commit.status).toBe(409);
    expect(commit.body.error).toEqual({
      code: 'quota_exceeded',
      message: `This import needs about ${rowWrites.toLocaleString('en-US')} row writes; this instance allows 50,000 per import.`,
    });
    expect(await inDirectory((db) => db.all("SELECT key FROM auth_throttle WHERE substr(key, 1, 7) = 'import:'"))).toEqual([]);
    const without = await importArchive(owner, { path: s(target), mode: 'new', file: archive, gzip: true, skipActivity: true });
    expect(without.commit.status, JSON.stringify(without.commit.body)).toBe(200);
    expect(without.commit.body.counts).toMatchObject({ tasks: 3500, activity: 0 });
  });

  it('replace: the re-auth window, the typed space stays, no safety point on Cloudflare', async () => {
    await freshBudget();
    const archive = (await downloadArchive(owner, `${s(spaceId)}/export`)).archive!;
    const res = await importArchive(owner, { path: s(spaceId), mode: 'replace', file: archive });
    expect(res.commit.status, JSON.stringify(res.commit.body)).toBe(200);
    expect(res.commit.body.safety).toBeNull();
    // A new import into an active space is refused by the gate (sent without a body: the gate refuses before
    // reading one, which workerd would log for a body the object left unread).
    const late = await owner.post(`${s(spaceId)}/import/commit?mode=new`);
    expect(late.body.error).toEqual({ code: 'conflict', message: 'This space has already been imported' });
    // Members may not export (nor import).
    expect((await bob.client.get(`${s(spaceId)}/export`)).status).toBe(403);
  });
});
