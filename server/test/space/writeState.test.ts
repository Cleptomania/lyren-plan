// The write generation, conditional reads and the daily write budget (design §6.4.2).

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TagDTO, TaskQueryResult } from '@shared/types';
import { createWriteState, readWriteState } from '../../src/space/writeState';
import { downloadArchive, formBytes, importForm, replaceImport } from '../support/archive';
import { heldBody as heldJson, heldBytes } from '../support/heldBody';
import { createSpaceHarness, OTHER_SPACE_ID, OWNER_ID } from '../support/spaceHarness';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** An archive of the harness's space mapped back to its owner (OWNER_ID). */
const OWN_MAPPING = { mapping: [{ archiveId: OWNER_ID, target: { kind: 'user', userId: OWNER_ID } }] };

afterEach(() => {
  vi.restoreAllMocks();
});

/** A request body the test releases when it wants (the route waits for it). */
function heldBody(): { stream: ReadableStream<Uint8Array>; release(text: string): void } {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    stream,
    release(text) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  };
}

/** Let pending request work (the gate, the host) run up to its next real wait. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('conditional reads', () => {
  it('answer 304 while nothing changed, and 200 with a new ETag after a write', async () => {
    const h = createSpaceHarness();
    const owner = h.owner.client;
    const first = await owner.get<TagDTO[]>('/api/tags');
    const etag = first.headers.get('etag')!;
    expect(etag).toMatch(new RegExp(`^"${h.writeState.gen}\\.1\\.3\\.[0-9a-f]{12}"$`));
    expect(first.headers.get('cache-control')).toBe('no-store');

    const again = await owner.get('/api/tags', { 'If-None-Match': etag });
    expect(again.status).toBe(304);
    expect(again.body).toBeNull();
    expect(again.headers.get('etag')).toBe(etag);
    expect(again.headers.get('cache-control')).toBe('no-store');
    expect((await owner.head('/api/tags', { 'If-None-Match': etag })).status).toBe(304);
    // Compared weakly (Appendix D 23): the Node gateway's compression sends it back as W/"…".
    expect((await owner.get('/api/tags', { 'If-None-Match': `W/${etag}` })).status).toBe(304);

    expect((await owner.post('/api/tags', { name: 'urgent' })).status).toBe(201);
    const after = await owner.get<TagDTO[]>('/api/tags', { 'If-None-Match': etag });
    expect(after.status).toBe(200);
    expect(after.body.map((t) => t.name)).toEqual(['urgent']);
    expect(after.headers.get('etag')).not.toBe(etag);
  });

  it('key the ETag on the viewer, the role, the path, the query and a POST body', async () => {
    const h = createSpaceHarness();
    const owner = h.owner.client;
    const member = h.addUser({ role: 'member' });
    await member.client.get('/api/tags'); // the sync of the new member is a change of its own
    const etag = (await owner.get('/api/tags')).headers.get('etag')!;
    expect((await member.client.get('/api/tags', { 'If-None-Match': etag })).status).toBe(200);
    expect((await owner.get('/api/statuses', { 'If-None-Match': etag })).status).toBe(200);
    expect((await owner.get('/api/tags?x=1', { 'If-None-Match': etag })).status).toBe(200);

    // `today` absent means the server's date, so naming that date is the same request.
    const today = new Date(h.clock.now()).toISOString().slice(0, 10);
    const bootstrap = (await owner.get('/api/bootstrap')).headers.get('etag')!;
    expect((await owner.get(`/api/bootstrap?today=${today}`, { 'If-None-Match': bootstrap })).status).toBe(304);
    expect((await owner.get('/api/bootstrap?today=2001-01-01', { 'If-None-Match': bootstrap })).status).toBe(200);
    h.clock.advance(DAY_MS);
    expect((await owner.get('/api/bootstrap', { 'If-None-Match': bootstrap })).status).toBe(200);

    const query = (body: unknown, headers: Record<string, string> = {}) => owner.post<TaskQueryResult>('/api/tasks/query', body, headers);
    const all = (await query({})).headers.get('etag')!;
    expect((await query({}, { 'If-None-Match': all })).status).toBe(304);
    expect((await query({ limit: 5 }, { 'If-None-Match': all })).status).toBe(200);

    // A role change (it reaches the space through the directory's version bump) changes every ETag.
    const memberTag = (await member.client.get('/api/tags')).headers.get('etag')!;
    h.directory.setRole(member.userId, 'viewer');
    const demoted = await member.client.get('/api/tags', { 'If-None-Match': memberTag });
    expect(demoted.status).toBe(200);
    expect(demoted.headers.get('etag')!.split('.')[2]).toBe('0');
  });

  it('also key the ETag on the space, the names bootstrap shows and the UTC hour (Appendix D 18)', async () => {
    const h = createSpaceHarness();
    const owner = h.owner.client;
    // The same request in another space with the same generation is another ETag.
    const other = createSpaceHarness({ spaceId: OTHER_SPACE_ID, clock: h.clock });
    const tags = (await owner.get('/api/tags')).headers.get('etag')!;
    expect(h.writeState.gen).toBe(other.writeState.gen);
    expect((await other.owner.client.get('/api/tags')).headers.get('etag')).not.toBe(tags);

    // A rename whose sync fails never reaches the generation, yet bootstrap answers with the new name.
    const bootstrap = (await owner.get('/api/bootstrap')).headers.get('etag')!;
    h.directory.space.name = 'Renamed space';
    h.directory.bump();
    h.directory.failures.spaceSync = new Error('directory down (test)');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const renamed = await owner.get('/api/bootstrap', { 'If-None-Match': bootstrap });
    expect(renamed.status).toBe(200);
    expect(renamed.body.space.name).toBe('Renamed space');
    delete h.directory.failures.spaceSync;

    // Answers that follow the clock (closedWithinDays) are checked again every hour.
    h.clock.set(Date.parse('2026-10-17T10:00:00.000Z'));
    const morning = (await owner.get('/api/dashboard')).headers.get('etag')!;
    h.clock.set(Date.parse('2026-10-17T10:59:59.999Z'));
    expect((await owner.get('/api/dashboard', { 'If-None-Match': morning })).status).toBe(304);
    h.clock.set(Date.parse('2026-10-17T11:00:00.000Z'));
    expect((await owner.get('/api/dashboard', { 'If-None-Match': morning })).status).toBe(200);
  });

  it('never apply to writes or to the export', async () => {
    const h = createSpaceHarness();
    const created = await h.owner.client.post('/api/tags', { name: 'x' });
    expect(created.headers.get('etag')).toBeNull();
    expect((await h.owner.client.raw('GET', '/api/data/export')).headers.get('etag')).toBeNull();
  });
});

describe('the write generation', () => {
  it('is bumped after every write request, whatever its status, and persisted', async () => {
    const h = createSpaceHarness();
    const viewer = h.addUser({ role: 'viewer' }).client;
    await viewer.get('/api/tags'); // syncs the new member (a change of its own)
    const gen = h.writeState.gen;
    expect((await h.owner.client.post('/api/tags', {})).status).toBe(400);
    expect(h.writeState.gen).toBe(gen + 1);
    expect((await h.owner.client.get('/api/tags')).status).toBe(200);
    expect(h.writeState.gen).toBe(gen + 1);
    expect((await viewer.post('/api/tags', { name: 'y' })).status).toBe(403);
    expect(h.writeState.gen).toBe(gen + 1); // refused by the gate: the route never ran
    expect(readWriteState(h.db)).toMatchObject({ gen: gen + 1 });
    expect(createWriteState(h.db, { dailyRowWrites: 0 }).gen).toBe(gen + 1);
  });

  it('is bumped after a mirror sync or a self-heal that changed rows, and not after one that did not', async () => {
    const h = createSpaceHarness();
    const owner = h.owner.client;
    const etag = (await owner.get('/api/bootstrap')).headers.get('etag')!;

    h.directory.bump(); // a sync with nothing to change
    expect((await owner.get('/api/bootstrap', { 'If-None-Match': etag })).status).toBe(304);
    expect(h.directory.count('spaceSync')).toBe(1);

    h.directory.updateAccount(h.owner.userId, { displayName: 'Renamed' });
    const renamed = await owner.get('/api/bootstrap', { 'If-None-Match': etag });
    expect(renamed.status).toBe(200);
    expect(renamed.body.user.displayName).toBe('Renamed');

    // A profile change whose push and version bump never arrived: the actor's own row heals.
    const healedTag = renamed.headers.get('etag')!;
    h.directory.accounts.get(h.owner.userId)!.displayName = 'Healed';
    const healed = await owner.get('/api/bootstrap', { 'If-None-Match': healedTag });
    expect(healed.status).toBe(200);
    expect(healed.body.people.find((p: { id: number }) => p.id === h.owner.userId).displayName).toBe('Healed');
  });

  it('moves past every earlier generation when a process reopens the file', () => {
    const h = createSpaceHarness();
    h.writeState.bump(0);
    const reopened = createWriteState(h.db, { dailyRowWrites: 0, clock: h.clock, reopened: true });
    expect(reopened.gen).toBe(h.clock.now());
    expect(readWriteState(h.db).gen).toBe(h.clock.now());
    const again = createWriteState(h.db, { dailyRowWrites: 0, clock: h.clock, reopened: true });
    expect(again.gen).toBe(h.clock.now() + 1);
  });

  it('a read during a write\'s await keeps the old generation, so it is refetched afterwards', async () => {
    const h = createSpaceHarness();
    const owner = h.owner.client;
    const body = heldBody();
    const write = owner.request('POST', '/api/tags', body.stream, { 'Content-Type': 'application/json' });
    await settle();

    const during = await owner.get<TagDTO[]>('/api/tags');
    expect(during.body).toEqual([]);
    body.release(JSON.stringify({ name: 'late' }));
    expect((await write).status).toBe(201);

    const after = await owner.get<TagDTO[]>('/api/tags', { 'If-None-Match': during.headers.get('etag')! });
    expect(after.status).toBe(200);
    expect(after.body.map((t) => t.name)).toEqual(['late']);
  });

  it('a conditional read whose own body comes late is tagged with the data it read', async () => {
    const h = createSpaceHarness();
    const owner = h.owner.client;
    const project = (await owner.post<{ id: number }>('/api/projects', { name: 'Web', key: 'WEB' })).body;
    const body = heldBody();
    const read = owner.request<TaskQueryResult>('POST', '/api/tasks/query', body.stream, { 'Content-Type': 'application/json' });
    await settle();
    expect((await owner.post('/api/tasks', { projectId: project.id, title: 'Meanwhile' })).status).toBe(201);
    body.release('{}');
    const res = await read;
    expect(res.body.tasks.map((t) => t.title)).toEqual(['Meanwhile']);
    expect((await owner.post('/api/tasks/query', {}, { 'If-None-Match': res.headers.get('etag')! })).status).toBe(304);
  });
});

describe('the daily write budget', () => {
  it('refuses writes (not reads, deletes or imports) once today\'s rows are used, until 00:00 UTC', async () => {
    const h = createSpaceHarness({ meter: true, config: { spaceDailyRowWrites: 3 } });
    const owner = h.owner.client;
    h.clock.set(Date.parse('2026-10-17T22:00:00.000Z'));
    for (const name of ['a', 'b', 'c']) expect((await owner.post('/api/tags', { name })).status).toBe(201);
    expect(readWriteState(h.db)).toMatchObject({ day: '2026-10-17', rows: 3 });
    expect(h.writeState.budgetLeft(h.clock.now())).toBe(0);

    const refused = await owner.post('/api/tags', { name: 'd' });
    expect(refused.status).toBe(429);
    expect(refused.body.error).toEqual({
      code: 'rate_limited',
      message: "This space has reached today's write limit on this instance. It resets at 00:00 UTC.",
    });
    expect(refused.headers.get('retry-after')).toBe(String(2 * 3600));
    expect((await owner.get('/api/tags')).status).toBe(200);
    expect((await owner.delete('/api/tags/1')).status).toBe(200);
    const file = (await downloadArchive(owner)).archive!;
    expect((await replaceImport(owner, file, { mapping: OWN_MAPPING })).status).toBe(200);
    expect(readWriteState(h.db).rows).toBe(4); // the delete counted; the import did not

    h.clock.set(Date.parse('2026-10-18T00:00:01.000Z'));
    expect(h.writeState.budgetLeft(h.clock.now())).toBe(3);
    expect((await owner.post('/api/tags', { name: 'd' })).status).toBe(201);
    expect(readWriteState(h.db)).toMatchObject({ day: '2026-10-18', rows: 1 });
  });

  it('counts each row once when write requests overlap, and an overlapping import not at all', async () => {
    const h = createSpaceHarness({ meter: true, config: { spaceDailyRowWrites: 100_000 } });
    const owner = h.owner.client;
    expect((await owner.post('/api/tags', { name: 'alone' })).status).toBe(201);
    const one = readWriteState(h.db).rows;
    expect(one).toBeGreaterThan(0);

    // Two creates whose bodies arrive together: each one's rows, not each other's too.
    const bodies = [heldJson({ name: 'a' }), heldJson({ name: 'b' })];
    const creates = bodies.map((b) => owner.request('POST', '/api/tags', b.stream, b.headers));
    await settle();
    for (const b of bodies) b.release();
    expect((await Promise.all(creates)).map((r) => r.status)).toEqual([201, 201]);
    expect(readWriteState(h.db).rows).toBe(3 * one);

    // A create beside a replace import: the create's rows only.
    const form = await formBytes(importForm((await downloadArchive(owner)).archive!, { mapping: OWN_MAPPING }));
    const tag = heldJson({ name: 'meanwhile' });
    const imported = heldBytes(form.body, form.contentType);
    const pending = [
      owner.request('POST', '/api/data/import/commit?mode=replace', imported.stream, imported.headers),
      owner.request('POST', '/api/tags', tag.stream, tag.headers),
    ];
    await settle();
    imported.release();
    tag.release();
    expect((await Promise.all(pending)).map((r) => r.status)).toEqual([200, 201]);
    expect(readWriteState(h.db).rows).toBe(4 * one);
  });

  it('is off without a meter (NodeDb), whatever SPACE_DAILY_ROW_WRITES says', async () => {
    const h = createSpaceHarness({ config: { spaceDailyRowWrites: 1 } });
    for (const name of ['a', 'b', 'c']) expect((await h.owner.client.post('/api/tags', { name })).status).toBe(201);
    expect(h.writeState.budgetLeft(h.clock.now())).toBe(Infinity);
    expect(readWriteState(h.db).rows).toBe(0);
  });
});
