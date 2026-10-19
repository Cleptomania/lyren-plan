// Validation is bounded in workerd too (design Appendix D 44): every body of server/test/support/hostileBodies.ts
// through the real Worker and SpaceDO answers as it should, where it answered 500 before (a stack overflow in zod
// for the query and the boards, the object's memory for the imports), whether its items fail on type or on a
// check; and the hostile archives of §14.5 answer with their statuses at Cloudflare's import limits (the 4 MiB
// imports hold more than its 300,000 JSON values: 413 before they are parsed). The Node half, with a capped
// heap: server/test/validationBounds.test.ts.

import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { CSRF_HEADER } from '@shared/constants';
import { HOSTILE_REQUESTS, hostileBody, hostileStatus, type HostileCase, type HostileRequest } from '../test/support/hostileBodies';
import { inDirectory, ORIGIN, setupOwner, type WorkerClient } from './support';

let owner: WorkerClient;
let spaceId: string;

beforeAll(async () => {
  ({ client: owner, spaceId } = await setupOwner());
});

/** POST a case's body to the space as the owner (an import's as its form): its status, error and wall time. */
async function post(c: HostileRequest) {
  // Every import counts on the owner's 10 an hour (im, Appendix D 62): each case starts afresh.
  if (c.form) await inDirectory((db) => db.run("DELETE FROM auth_throttle WHERE substr(key, 1, 3) = 'im:'"));
  const { body, contentType } = hostileBody(c);
  const started = performance.now();
  const res = await SELF.fetch(`${ORIGIN}/api/s/${spaceId}${c.path}`, {
    method: 'POST',
    headers: { Cookie: owner.cookieHeader(), [CSRF_HEADER]: '1', ...(contentType ? { 'Content-Type': contentType } : {}) },
    body,
  });
  const json = (await res.json()) as { error?: { code: string; message: string; details?: unknown[] } };
  return { status: res.status, error: json.error, ms: performance.now() - started };
}

describe('every hostile body answers (Appendix D 44, design §14.5)', () => {
  it.each(Object.keys(HOSTILE_REQUESTS) as HostileCase[])('%s', async (name) => {
    const c: HostileRequest = HOSTILE_REQUESTS[name];
    const status = hostileStatus(c, 'cloudflare');
    const res = await post(c);
    expect(res.status).toBe(status);
    if (status === 400) expect(res.error?.code).toBe(c.code ?? 'validation_error');
    if (status === 413 && c.form) expect(res.error?.code).toBe('payload_too_large');
    expect(res.ms).toBeLessThan(3000);
  });

  it('a body too large to describe answers without details; an import, the first 50 problems; a value bomb, 413', async () => {
    expect((await post(HOSTILE_REQUESTS['query, project ids 0'])).error).toEqual({
      code: 'validation_error',
      message: 'Invalid input (too many values to list its problems)',
    });
    const res = await post(HOSTILE_REQUESTS['import under the value cap, tasks {"id":1}']);
    expect(res.error?.message).toMatch(/^Invalid export file \(more than 50 problems\): tasks\.0\./);
    expect(res.error?.details).toHaveLength(51);
    expect((await post(HOSTILE_REQUESTS['import, tasks {"id":1}'])).error).toEqual({
      code: 'payload_too_large',
      message: 'The archive has more entries than this instance accepts.',
    });
    expect((await post(HOSTILE_REQUESTS['archive, a 16 KiB gzip of [{},{},…]'])).error).toEqual({
      code: 'payload_too_large',
      message: 'The archive is larger than 4 MB unpacked',
    });
  });

  it('the space still answers afterwards; the imported board has the default filter', async () => {
    await post(HOSTILE_REQUESTS['import under the value cap, a board config with project ids 0']);
    const boards = await owner.get(`/api/s/${spaceId}/boards`);
    expect(boards.status).toBe(200);
    expect(boards.body.map((b: { config: { filter: unknown } }) => b.config.filter)).toEqual([{ closedWithinDays: 14 }]);
  });
});
