// Request bodies are never buffered for requests the server is going to refuse anyway
// (no CSRF header, no session), and the public auth endpoints accept only small bodies.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { CSRF_HEADER } from '@shared/constants';
import { handleError } from '../src/http/errors';
import { AUTH_BODY_LIMIT } from '../src/app';
import { createTestContext } from './helpers';

const CHUNK = new Uint8Array(1024).fill(0x20);

/**
 * A chunked request body that keeps producing 1 KiB chunks (up to `maxChunks`) and then stalls
 * forever without closing. `pulled()` reports how many bytes the server has read so far.
 */
function stallingBody(maxChunks = Infinity) {
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= maxChunks) return new Promise<void>(() => {}); // stall: never closes
      sent++;
      controller.enqueue(CHUNK);
    },
  });
  return { stream, pulled: () => sent * CHUNK.length };
}

/** Resolves with the response, or rejects when the server keeps waiting for the body. */
function within<T>(promise: Promise<T>, ms = 2000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`no response within ${ms} ms`)), ms)),
  ]);
}

type RequestApp = { request: (path: string, init: RequestInit) => Response | Promise<Response> };

function post(app: RequestApp, path: string, body: ReadableStream, headers: Record<string, string> = {}) {
  // `duplex` is required by undici for stream bodies (not yet in the RequestInit typings).
  const init = { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body, duplex: 'half' };
  return within(Promise.resolve(app.request(path, init as RequestInit)));
}

describe('body limits and refusal order', () => {
  afterEach(() => vi.restoreAllMocks());

  it('refuses a stalled chunked upload without a session before reading the body', async () => {
    const ctx = createTestContext();
    await ctx.signedIn();
    const csrf = { [CSRF_HEADER]: '1' };

    // An endless body: the refusal must come without the server consuming it.
    const anon = stallingBody();
    const res = await post(ctx.app, '/api/data/import', anon.stream, csrf);
    expect(res.status).toBe(401);
    expect(anon.pulled()).toBeLessThanOrEqual(2 * CHUNK.length); // only the stream's own read-ahead

    const noCsrf = stallingBody(4);
    expect((await post(ctx.app, '/api/data/import', noCsrf.stream)).status).toBe(403);
    expect((await post(ctx.app, '/api/tasks/query', stallingBody(4).stream)).status).toBe(403);
    expect((await post(ctx.app, '/api/tasks/query', stallingBody(4).stream, csrf)).status).toBe(401);
  });

  it('caps public auth endpoints at a small body limit', async () => {
    const ctx = createTestContext();
    const csrf = { [CSRF_HEADER]: '1' };
    for (const path of ['/api/auth/login', '/api/auth/setup', '/api/auth/logout']) {
      const body = stallingBody();
      const res = await post(ctx.app, path, body.stream, csrf);
      expect(res.status).toBe(413);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('payload_too_large');
      // Reading stopped right after the limit (well below the 2 MB default limit).
      expect(body.pulled()).toBeLessThanOrEqual(AUTH_BODY_LIMIT + 4 * CHUNK.length);
    }
    // Normal sign-in still works.
    await ctx.signedIn();
  });

  it('still applies the regular limits to signed-in requests', async () => {
    const ctx = createTestContext({ bodyLimit: 4096, importBodyLimit: 16384 });
    const { client } = await ctx.signedIn();
    const csrf = { [CSRF_HEADER]: '1', Cookie: client.cookie! };
    const tooBig = stallingBody(5);
    expect((await post(ctx.app, '/api/tasks/query', tooBig.stream, csrf)).status).toBe(413);
    expect(tooBig.pulled()).toBe(5 * CHUNK.length);
    expect((await client.post('/api/tasks/query', { pad: 'x'.repeat(3000) })).status).toBe(200); // under the limit
  });

  it('treats an aborted request body as a quiet client abort (no stack trace logged)', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fake = { json: (body: unknown, s: number) => new Response(JSON.stringify(body), { status: s }) };
    // What reading an aborted upload throws on Node (IncomingMessage 'aborted' / ECONNRESET).
    for (const err of [
      Object.assign(new Error('aborted'), { code: 'ECONNRESET' }),
      new Error('aborted'),
      Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
    ]) {
      expect(handleError(err, fake as never).status).toBe(400);
    }
    expect(errors).not.toHaveBeenCalled();
    // Other unexpected errors are still logged as 500s.
    expect(handleError(new Error('boom'), fake as never).status).toBe(500);
    expect(errors).toHaveBeenCalledTimes(1);
  });
});
