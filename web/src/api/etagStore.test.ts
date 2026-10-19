// The conditional-read memory (etagStore.ts) on its own, and as api/client.ts uses it for space reads
// (design §6.4.2): If-None-Match from the store, a 304 answered with the stored body, keys per space,
// forgotten with the user's data and per space.

import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEtagStore, ETAG_MAX_CHARS, ETAG_MAX_ENTRIES, etagKey, sameEtag } from './etagStore';

const A = '7k2m9q4w8x1c3v5b';
const B = '0123456789abcdef';

describe('createEtagStore', () => {
  const entry = (etag: string, text = '{}') => ({ etag, text });

  it('keeps answers by key', () => {
    const store = createEtagStore();
    store.set(etagKey('GET', `/api/s/${A}/bootstrap`), entry('"1"', '{"a":1}'));
    expect(store.get(etagKey('GET', `/api/s/${A}/bootstrap`))).toEqual(entry('"1"', '{"a":1}'));
    expect(store.get(etagKey('GET', `/api/s/${B}/bootstrap`))).toBeUndefined();
  });

  it('a POST read is keyed by its body too', () => {
    expect(etagKey('POST', `/api/s/${A}/tasks/query`, '{"limit":1}')).not.toBe(etagKey('POST', `/api/s/${A}/tasks/query`, '{"limit":2}'));
    expect(etagKey('GET', `/api/s/${A}/tasks/1`)).not.toBe(etagKey('GET', `/api/s/${B}/tasks/1`));
  });

  it('drops the least recently used beyond its entry count', () => {
    const store = createEtagStore({ maxEntries: 3, maxChars: 1_000_000 });
    for (const k of ['a', 'b', 'c']) store.set(k, entry(k));
    store.get('a'); // used: b is now the oldest
    store.set('d', entry('d'));
    expect(store.size).toBe(3);
    expect(store.get('b')).toBeUndefined();
    expect(['a', 'c', 'd'].every((k) => store.get(k))).toBe(true);
  });

  it('drops the least recently used beyond its size, and never keeps an answer larger than all of it', () => {
    const store = createEtagStore({ maxEntries: 100, maxChars: 100 });
    store.set('a', entry('1', 'x'.repeat(40)));
    store.set('b', entry('2', 'y'.repeat(40)));
    expect(store.size).toBe(2);
    store.set('c', entry('3', 'z'.repeat(40)));
    expect(store.get('a')).toBeUndefined();
    expect(store.chars).toBeLessThanOrEqual(100);
    store.set('huge', entry('4', 'h'.repeat(200)));
    expect(store.get('huge')).toBeUndefined();
    expect(store.size).toBe(2);
    // Replacing an entry counts its new size only.
    store.set('b', entry('5', 'w'));
    expect(store.chars).toBe('b'.length + 1 + 1 + 'c'.length + 1 + 40);
  });

  it('forgets one space, or everything', () => {
    const store = createEtagStore();
    store.set(etagKey('GET', `/api/s/${A}/bootstrap`), entry('"1"'));
    store.set(etagKey('POST', `/api/s/${A}/tasks/query`, '{}'), entry('"2"'));
    store.set(etagKey('GET', `/api/s/${B}/bootstrap`), entry('"3"'));
    store.forgetSpace(A);
    expect(store.size).toBe(1);
    expect(store.get(etagKey('GET', `/api/s/${B}/bootstrap`))).toBeDefined();
    store.clear();
    expect(store.size).toBe(0);
    expect(store.chars).toBe(0);
  });

  it('a mark taken before the space, or everything, was forgotten stores nothing', () => {
    const store = createEtagStore();
    const a = etagKey('GET', `/api/s/${A}/bootstrap`);
    const b = etagKey('GET', `/api/s/${B}/bootstrap`);
    const before = { a: store.mark(a), b: store.mark(b) };
    store.forgetSpace(A);
    store.set(a, entry('"1"'), before.a);
    store.set(b, entry('"2"'), before.b);
    expect(store.get(a)).toBeUndefined();
    expect(store.get(b)).toEqual(entry('"2"'));
    // A mark taken afterwards is good again.
    store.set(a, entry('"3"'), store.mark(a));
    expect(store.get(a)).toEqual(entry('"3"'));
    const old = store.mark(b);
    store.clear();
    store.set(b, entry('"4"'), old);
    expect(store.size).toBe(0);
  });

  it('retainSpaces drops the spaces not listed, stored or only asked for', () => {
    const store = createEtagStore();
    const a = etagKey('GET', `/api/s/${A}/bootstrap`);
    const b = etagKey('POST', `/api/s/${B}/tasks/query`, '{}');
    store.set(a, entry('"1"'));
    const inFlight = store.mark(b);
    store.retainSpaces([]);
    expect(store.size).toBe(0);
    store.set(b, entry('"2"'), inFlight);
    expect(store.size).toBe(0);
    store.set(a, entry('"3"'), store.mark(a));
    store.set(b, entry('"4"'), store.mark(b));
    store.retainSpaces([B]);
    expect(store.get(a)).toBeUndefined();
    expect(store.get(b)).toEqual(entry('"4"'));
  });

  it('has the bounds of §6.4.2', () => {
    expect(ETAG_MAX_ENTRIES).toBe(200);
    expect(ETAG_MAX_CHARS).toBe(20 * 1024 * 1024);
  });
});

describe('sameEtag (as the server compares If-None-Match, Appendix D 23)', () => {
  it('ignores a W/ prefix on either side', () => {
    expect(sameEtag('"5.1.3.abc"', '"5.1.3.abc"')).toBe(true);
    expect(sameEtag('W/"5.1.3.abc"', '"5.1.3.abc"')).toBe(true);
    expect(sameEtag('"5.1.3.abc"', 'W/"5.1.3.abc"')).toBe(true);
    expect(sameEtag('"5.1.3.abc"', '"6.1.3.abc"')).toBe(false);
  });
});

// ---- The client --------------------------------------------------------------------------------

interface Sent {
  url: string;
  method: string;
  ifNoneMatch: string | null;
  cache: RequestCache | undefined;
  contentType: string | null;
  body: BodyInit | null | undefined;
}

/** A fetch whose answers the test queues; it records what was sent. */
function fakeFetch() {
  const sent: Sent[] = [];
  const answers: Array<() => Response> = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    sent.push({
      url,
      method: init.method ?? 'GET',
      ifNoneMatch: headers.get('If-None-Match'),
      cache: init.cache,
      contentType: headers.get('Content-Type'),
      body: init.body,
    });
    const next = answers.shift();
    if (!next) throw new TypeError('no answer queued for ' + url);
    return next();
  });
  return {
    sent,
    answer: (fn: () => Response) => answers.push(fn),
    ok: (body: unknown, etag: string | null) => answers.push(() => Response.json(body, { headers: etag ? { ETag: etag } : {} })),
    notModified: (etag: string | null) => answers.push(() => new Response(null, { status: 304, headers: etag ? { ETag: etag } : {} })),
  };
}

describe('spaceApi with the conditional-read memory', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  it('sends the stored ETag back and resolves a 304 with the stored body', async () => {
    const { spaceApi } = await import('./client');
    const net = fakeFetch();
    net.ok({ boards: [1, 2] }, '"7.1.3.aaaaaaaaaaaa"');
    expect(await spaceApi(A).get('/bootstrap?today=2026-10-18')).toEqual({ boards: [1, 2] });
    expect(net.sent[0]).toMatchObject({ url: `/api/s/${A}/bootstrap?today=2026-10-18`, ifNoneMatch: null, cache: 'no-store' });

    net.notModified('"7.1.3.aaaaaaaaaaaa"');
    const again = await spaceApi(A).get<{ boards: number[] }>('/bootstrap?today=2026-10-18');
    expect(again).toEqual({ boards: [1, 2] });
    expect(net.sent[1]!.ifNoneMatch).toBe('"7.1.3.aaaaaaaaaaaa"');
    // A fresh copy each time: changing one answer changes nothing stored.
    again.boards.push(3);
    net.notModified(null);
    expect(await spaceApi(A).get('/bootstrap?today=2026-10-18')).toEqual({ boards: [1, 2] });
  });

  it('compares weakly: the gzip answer’s W/ tag (Node) is sent back and matches the 304', async () => {
    const { spaceApi } = await import('./client');
    const net = fakeFetch();
    net.ok({ n: 1 }, 'W/"8.1.3.bbbbbbbbbbbb"');
    await spaceApi(A).get('/dashboard');
    net.notModified('"8.1.3.bbbbbbbbbbbb"');
    expect(await spaceApi(A).get('/dashboard')).toEqual({ n: 1 });
    expect(net.sent[1]!.ifNoneMatch).toBe('W/"8.1.3.bbbbbbbbbbbb"');
  });

  it('keys by space, path and query body', async () => {
    const { spaceApi } = await import('./client');
    const net = fakeFetch();
    net.ok({ space: 'A' }, '"1.1.3.a"');
    net.ok({ space: 'B' }, '"1.1.3.b"');
    net.ok({ page: 1 }, '"1.1.3.q1"');
    net.ok({ page: 2 }, '"1.1.3.q2"');
    await spaceApi(A).get('/tasks/1');
    await spaceApi(B).get('/tasks/1');
    await spaceApi(A).post('/tasks/query', { limit: 1 });
    await spaceApi(A).post('/tasks/query', { limit: 2 });
    expect(net.sent.map((s) => s.ifNoneMatch)).toEqual([null, null, null, null]);
    net.notModified('"1.1.3.q1"');
    net.notModified('"1.1.3.b"');
    expect(await spaceApi(A).post('/tasks/query', { limit: 1 })).toEqual({ page: 1 });
    expect(await spaceApi(B).get('/tasks/1')).toEqual({ space: 'B' });
    expect(net.sent.slice(4).map((s) => s.ifNoneMatch)).toEqual(['"1.1.3.q1"', '"1.1.3.b"']);
  });

  it('writes are never conditional, and other POSTs neither', async () => {
    const { spaceApi } = await import('./client');
    const net = fakeFetch();
    for (let i = 0; i < 4; i++) net.ok({ ok: true }, '"9.1.3.c"');
    await spaceApi(A).post('/tasks', { title: 'x' });
    await spaceApi(A).post('/tasks', { title: 'x' });
    await spaceApi(A).patch('/tasks/1', { title: 'y' });
    await spaceApi(A).del('/tasks/1');
    expect(net.sent.map((s) => [s.ifNoneMatch, s.cache])).toEqual([
      [null, undefined],
      [null, undefined],
      [null, undefined],
      [null, undefined],
    ]);
  });

  it('a 304 it cannot answer (another tag) asks again without the condition', async () => {
    const { spaceApi } = await import('./client');
    const net = fakeFetch();
    net.ok({ v: 1 }, '"1.1.3.a"');
    await spaceApi(A).get('/boards/1');
    net.notModified('"2.1.3.a"');
    net.ok({ v: 2 }, '"2.1.3.a"');
    expect(await spaceApi(A).get('/boards/1')).toEqual({ v: 2 });
    expect(net.sent.map((s) => s.ifNoneMatch)).toEqual([null, '"1.1.3.a"', null]);
  });

  it('forgetUserData clears it, and forgetSpace clears that space only', async () => {
    const { spaceApi } = await import('./client');
    const { forgetUserData } = await import('./auth');
    const { forgetSpace } = await import('./spaces');
    const net = fakeFetch();
    net.ok({ a: 1 }, '"1.1.3.a"');
    net.ok({ b: 1 }, '"1.1.3.b"');
    await spaceApi(A).get('/bootstrap');
    await spaceApi(B).get('/bootstrap');
    forgetSpace(new QueryClient(), A);
    net.ok({ a: 2 }, '"2.1.3.a"');
    net.notModified('"1.1.3.b"');
    await spaceApi(A).get('/bootstrap');
    await spaceApi(B).get('/bootstrap');
    expect(net.sent.slice(2).map((s) => s.ifNoneMatch)).toEqual([null, '"1.1.3.b"']);
    forgetUserData(new QueryClient());
    net.ok({ a: 3 }, '"3.1.3.a"');
    net.ok({ b: 3 }, '"3.1.3.b"');
    await spaceApi(A).get('/bootstrap');
    await spaceApi(B).get('/bootstrap');
    expect(net.sent.slice(4).map((s) => s.ifNoneMatch)).toEqual([null, null]);
  });

  for (const forgotten of ['everything (signing in or out)', 'the space (left or deleted)'] as const) {
    it(`a read in flight while ${forgotten} is forgotten does not put its answer back`, async () => {
      const { spaceApi, forgetEtags } = await import('./client');
      const net = fakeFetch();
      let answer!: (res: Response) => void;
      net.answer(() => new Promise<Response>((resolve) => (answer = resolve)) as unknown as Response);
      const inFlight = spaceApi(A).get('/bootstrap');
      await Promise.resolve();
      forgetEtags(forgotten.startsWith('everything') ? undefined : A);
      answer(Response.json({ people: ['before'] }, { headers: { ETag: '"5.1.3.aaaa"' } }));
      expect(await inFlight).toEqual({ people: ['before'] });
      net.ok({ people: ['now'] }, '"6.2.0.bbbb"');
      await spaceApi(A).get('/bootstrap');
      expect(net.sent.map((s) => s.ifNoneMatch)).toEqual([null, null]);
    });
  }

  it('forgetLostSpaces forgets a lost space’s answers even when the cache holds none of its queries', async () => {
    const { spaceApi } = await import('./client');
    const { forgetLostSpaces } = await import('./spaces');
    const net = fakeFetch();
    net.ok({ a: 1 }, '"3.1.1.abc"');
    net.ok({ b: 1 }, '"3.1.1.def"');
    await spaceApi(A).get('/bootstrap');
    await spaceApi(B).get('/bootstrap');
    // A's queries were garbage-collected long ago; then the account lost A.
    forgetLostSpaces(new QueryClient(), [B]);
    net.ok({ a: 2 }, '"4.1.1.abc"');
    net.notModified('"3.1.1.def"');
    await spaceApi(A).get('/bootstrap');
    expect(await spaceApi(B).get('/bootstrap')).toEqual({ b: 1 });
    expect(net.sent.slice(2).map((s) => s.ifNoneMatch)).toEqual([null, '"3.1.1.def"']);
  });

  it('directory requests keep no memory', async () => {
    const { http } = await import('./client');
    const net = fakeFetch();
    net.ok({ user: null }, '"x"');
    net.ok({ user: null }, '"x"');
    await http.get('/auth/status');
    await http.get('/auth/status');
    expect(net.sent.map((s) => [s.ifNoneMatch, s.cache])).toEqual([
      [null, undefined],
      [null, undefined],
    ]);
  });
});

describe('the client and failed answers', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  it('a 421 wrong_host moves the page to PUBLIC_URL once per page load', async () => {
    const replace = vi.fn();
    vi.stubGlobal('window', {
      location: { origin: 'https://lyren-plan.example.workers.dev', pathname: '/s/7k2m9q4w8x1c3v5b/boards/2', search: '?x=1', hash: '', replace },
    });
    const { http } = await import('./client');
    const net = fakeFetch();
    const wrongHost = () =>
      Response.json(
        { error: { code: 'wrong_host', message: 'This Lyren Plan instance is at https://plan.example.com', details: [{ path: 'publicUrl', message: 'https://plan.example.com' }] } },
        { status: 421 },
      );
    net.answer(wrongHost);
    net.answer(wrongHost);
    await expect(http.get('/auth/status')).rejects.toMatchObject({ status: 421, code: 'wrong_host' });
    await expect(http.get('/auth/status')).rejects.toMatchObject({ status: 421 });
    expect(replace.mock.calls).toEqual([['https://plan.example.com/s/7k2m9q4w8x1c3v5b/boards/2?x=1']]);
  });

  it('a 421 naming something other than an http(s) URL moves nothing', async () => {
    const replace = vi.fn();
    vi.stubGlobal('window', { location: { origin: 'https://a.example', pathname: '/', search: '', hash: '', replace } });
    const { http } = await import('./client');
    const net = fakeFetch();
    net.answer(() => Response.json({ error: { code: 'wrong_host', message: 'x', details: [{ path: 'publicUrl', message: 'javascript:alert(1)' }] } }, { status: 421 }));
    await expect(http.get('/auth/status')).rejects.toMatchObject({ code: 'wrong_host' });
    expect(replace).not.toHaveBeenCalled();
  });

  it('a 401 outside /auth/ tells the listeners; a 401 of /auth/ does not', async () => {
    const { http, onUnauthorized, spaceApi } = await import('./client');
    const net = fakeFetch();
    const heard = vi.fn();
    onUnauthorized(heard);
    const signedOut = () => Response.json({ error: { code: 'unauthorized', message: 'Not signed in' } }, { status: 401 });
    net.answer(signedOut);
    net.answer(signedOut);
    net.answer(signedOut);
    await expect(http.post('/auth/login', {})).rejects.toMatchObject({ status: 401 });
    expect(heard).not.toHaveBeenCalled();
    await expect(spaceApi(A).get('/bootstrap')).rejects.toMatchObject({ status: 401 });
    await expect(http.get('/account/sessions')).rejects.toMatchObject({ status: 401 });
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it('reauth_required asks the installed handler and sends the request once more', async () => {
    const { isReauthDeclined, setReauthHandler, spaceApi } = await import('./client');
    const net = fakeFetch();
    const reauth = () => Response.json({ error: { code: 'reauth_required', message: 'Confirm it’s you to continue' } }, { status: 403 });
    const handler = vi.fn(async () => true);
    const uninstall = setReauthHandler(handler);
    net.answer(reauth);
    net.ok({ ok: true }, null);
    expect(await spaceApi(A).post('/data/import/analyze?mode=replace', { format: 'x' })).toEqual({ ok: true });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(net.sent.map((s) => s.body)).toEqual(['{"format":"x"}', '{"format":"x"}']);
    // A form (an import's file) is sent as it is both times, without a Content-Type of ours (the browser
    // writes the multipart boundary).
    const form = new FormData();
    form.set('file', new Blob(['{}']), 'space.json');
    net.answer(reauth);
    net.ok({ ok: true }, null);
    expect(await spaceApi(A).post('/data/import/commit?mode=replace', form)).toEqual({ ok: true });
    expect(handler).toHaveBeenCalledTimes(2);
    expect(net.sent.slice(2).map((s) => [s.body, s.contentType])).toEqual([
      [form, null],
      [form, null],
    ]);
    // Once only: a second refusal is the caller's.
    net.answer(reauth);
    net.answer(reauth);
    await expect(spaceApi(A).post('/data/import/analyze?mode=replace', {})).rejects.toMatchObject({ code: 'reauth_required' });
    expect(handler).toHaveBeenCalledTimes(3);
    // Cancelled: the refusal, marked as declined (nothing to say about it); no handler: the error as it is.
    handler.mockResolvedValueOnce(false);
    net.answer(reauth);
    const declined = await spaceApi(A).post('/data/import/analyze?mode=replace', {}).catch((err: unknown) => err);
    expect(declined).toMatchObject({ code: 'reauth_required', message: 'Confirm it’s you to continue' });
    expect(isReauthDeclined(declined)).toBe(true);
    uninstall();
    net.answer(reauth);
    const refused = await spaceApi(A).post('/data/import/analyze?mode=replace', {}).catch((err: unknown) => err);
    expect(refused).toMatchObject({ code: 'reauth_required' });
    expect(isReauthDeclined(refused)).toBe(false);
    expect(handler).toHaveBeenCalledTimes(4);
  });
});
