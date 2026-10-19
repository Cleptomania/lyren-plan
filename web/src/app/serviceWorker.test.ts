// The service worker (web/public/sw.js), run as a browser would run it, with a fake Cache Storage and
// fetch. Design §10.6: Cloudflare's static assets answer a missing /assets/* chunk with index.html and
// 200 (SPA fallback); the service worker must neither cache that page under the chunk's URL nor hand it
// to the page as the chunk, but fail the load, so the chunk-error handling (chunkErrors.ts) reloads.

import { describe, expect, it } from 'vitest';
import source from '../../public/sw.js?raw';

const ORIGIN = 'https://plan.example.com';

type Answer = (request: Request) => Response;

interface FakeFetchEvent {
  request: Request;
  respondWith(response: Promise<Response>): void;
  waitUntil(task: Promise<unknown>): void;
}

/** A response as fetch() gives it for a same-origin request (type 'basic'). */
function basic(body: string, contentType: string): Response {
  const res = new Response(body, { status: 200, headers: { 'Content-Type': contentType } });
  Object.defineProperty(res, 'type', { value: 'basic' });
  return res;
}

function loadServiceWorker(answer: Answer) {
  const listeners = new Map<string, (event: FakeFetchEvent) => void>();
  const stored = new Map<string, Response>();
  const cache = {
    match: async (req: Request) => stored.get(req.url)?.clone(),
    put: async (req: Request, res: Response) => void stored.set(req.url, res),
    keys: async () => [...stored.keys()].map((url) => new Request(url)),
    delete: async (req: Request) => stored.delete(req.url),
  };
  const caches = { open: async () => cache, match: async () => undefined, keys: async () => [], delete: async () => true };
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, listener: (event: FakeFetchEvent) => void) => listeners.set(type, listener),
    skipWaiting: () => {},
    clients: { claim: async () => {} },
  };
  const fetched: string[] = [];
  const fetchFake = async (req: Request) => {
    fetched.push(req.url);
    return answer(req);
  };
  const run = new Function('self', 'caches', 'fetch', `${source}\nreturn { isAssetResponse };`) as (
    ...args: unknown[]
  ) => { isAssetResponse(res: Response): boolean };
  const exported = run(self, caches, fetchFake);

  /** What the service worker answers a GET of `path` with. */
  async function get(path: string): Promise<Response> {
    let response: Promise<Response> | null = null;
    listeners.get('fetch')!({
      request: new Request(`${ORIGIN}${path}`),
      respondWith: (r) => {
        response = r;
      },
      waitUntil: () => {},
    });
    if (!response) throw new Error(`the service worker did not answer ${path}`);
    return response;
  }

  return { ...exported, get, stored, fetched };
}

describe('the service worker and /assets/* answers (§10.6)', () => {
  it('an HTML answer (the SPA fallback for a chunk that is gone) is a failed load and is not cached', async () => {
    const sw = loadServiceWorker(() => basic('<!doctype html><title>Lyren Plan</title>', 'text/html; charset=utf-8'));
    const res = await sw.get('/assets/WorklogPage-CVI4naie.js');
    expect(res.type).toBe('error');
    expect(sw.stored.size).toBe(0);
    // Asked again (the page's one reload), it goes to the network again.
    expect((await sw.get('/assets/WorklogPage-CVI4naie.js')).type).toBe('error');
    expect(sw.fetched).toHaveLength(2);
  });

  it('the asset itself is cached and then served from the cache', async () => {
    const sw = loadServiceWorker(() => basic('console.log(1);', 'text/javascript; charset=utf-8'));
    const res = await sw.get('/assets/index-abc123.js');
    expect(await res.text()).toBe('console.log(1);');
    expect([...sw.stored.keys()]).toEqual([`${ORIGIN}/assets/index-abc123.js`]);
    expect(await (await sw.get('/assets/index-abc123.js')).text()).toBe('console.log(1);');
    expect(sw.fetched).toHaveLength(1);
  });

  it('isAssetResponse: anything but an HTML page', () => {
    const sw = loadServiceWorker(() => new Response(''));
    expect(sw.isAssetResponse(basic('', 'text/html; charset=utf-8'))).toBe(false);
    expect(sw.isAssetResponse(basic('', 'TEXT/HTML'))).toBe(false);
    for (const type of ['text/javascript; charset=utf-8', 'text/css', 'image/png', 'font/woff2', 'application/json']) {
      expect(sw.isAssetResponse(basic('', type)), type).toBe(true);
    }
    expect(sw.isAssetResponse(new Response(''))).toBe(true);
  });
});
