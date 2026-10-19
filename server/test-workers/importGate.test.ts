// One import of a space at a time on Cloudflare too (design §8.4, Appendix D 62; in a file of its own, for
// fresh storage: archive.test.ts uses up the owner's spaces). A commit reads the space (the idempotent retry's
// check, the rows it will delete) and then awaits the directory before it writes: before the gate was one per
// object, three commits sent together into one space all found it unwritten, all wrote it, and the day's budget
// was charged 18% less than the space's meter showed. Now one writes and the others answer 503.

import { beforeAll, describe, expect, it } from 'vitest';
import type { ImportAnalysisDTO } from '@shared/types';
import { reviewArchive } from '../test/support/archiveFixture';
import { importForm, suggestedMapping } from '../test/support/archive';
import { objectDbs } from './entry';
import { inDirectory, setupOwner, type WorkerClient } from './support';

let owner: WorkerClient;

beforeAll(async () => {
  ({ client: owner } = await setupOwner());
});

describe('the import gate of a space object', () => {
  it('commits sent together: one writes, the others answer 503 and count nothing', async () => {
    const archive = reviewArchive({ tasks: 600, comments: 60, worklogs: 20, extraActivity: 0 });
    const target = (await owner.post<{ id: string }>('/api/spaces', { name: 'Together', forImport: true })).body.id;
    const data = `/api/s/${target}/data`;
    const analysis = (await owner.post<ImportAnalysisDTO>(`${data}/import/analyze?mode=new`, importForm(archive, { gzip: true }))).body;
    const mapping = suggestedMapping(analysis);
    const before = objectDbs.spaces.get(target)!.meter.rowsWritten;
    const answers = await Promise.all(
      [0, 1, 2].map(() => owner.post(`${data}/import/commit?mode=new`, importForm(archive, { gzip: true, mapping }))),
    );
    expect(answers.map((a) => a.status).sort()).toEqual([200, 503, 503]);
    for (const refused of answers.filter((a) => a.status === 503)) {
      expect(refused.body.error).toEqual({ code: 'unavailable', message: 'Another import into this space is running. Try again in a minute.' });
    }
    const written = objectDbs.spaces.get(target)!.meter.rowsWritten - before;
    expect(Math.abs(analysis.estimate.rowWrites - written) / written).toBeLessThanOrEqual(0.1);
    // One reservation, of one import's rows; on im, the analysis and the one commit that started.
    expect(await inDirectory((db) => db.all("SELECT count FROM auth_throttle WHERE substr(key, 1, 4) = 'imr:'"))).toEqual([
      { count: analysis.estimate.rowWrites },
    ]);
    expect(await inDirectory((db) => db.all("SELECT count FROM auth_throttle WHERE substr(key, 1, 3) = 'im:'"))).toEqual([{ count: 2 }]);
    // The one commit finished the import.
    expect((await owner.get<{ status: string }>(`/api/spaces/${target}`)).body.status).toBe('active');
  });
});
