// The Node gateway (gateway/app.ts, design §2.2, §6.4.1, §7.1, §14.3). The table of cases.ts runs against
// createGatewayApp with spy clients: what it refuses before any client is called (non-canonical paths,
// CSRF, Content-Length, invalid space ids, missing or malformed session cookies), what a space host
// receives (no Cookie, no client-sent x-lyren-meta, the token's hash), the space paths of the client before
// spaces (the directory's now) and the compression exemptions. The Cloudflare Worker's half
// (server/test-workers/gateway.test.ts) runs the same table. Node's own extras follow: the static site's
// headers, and the directory's answers to those old space paths on a whole stack.

import { describe, expect, it, vi } from 'vitest';
import { CSRF_HEADER } from '@shared/constants';
import type { TaskQueryResult } from '@shared/types';
import { setLegacySpaceId } from '../../src/directory/settings';
import { createGatewayApp } from '../../src/gateway/app';
import { isCanonicalApiPath } from '../../src/gateway/guards';
import { createTestContext } from '../helpers';
import {
  caseRequest,
  CLIENT_IP,
  expectGatewayCase,
  GATEWAY_CASES,
  LARGE_BODY,
  LIMITS,
  UNPREFIXED_SPACE_PATHS,
  type GatewayCall,
  type GatewayHarnessOptions,
  type GatewayUnderTest,
} from './cases';

/** A Node gateway whose clients record what reached them. */
function nodeGateway(o: GatewayHarnessOptions & { web?: boolean }): GatewayUnderTest & { app: ReturnType<typeof createGatewayApp> } {
  const calls: GatewayCall[] = [];
  const record = (to: GatewayCall['to'], request: Request, meta: GatewayCall['meta'], spaceId?: string) => {
    const url = new URL(request.url);
    calls.push({ to, spaceId, method: request.method, path: url.pathname + url.search, headers: Object.fromEntries(request.headers), meta });
    return Response.json(o.large ? LARGE_BODY : { ok: true });
  };
  const app = createGatewayApp({
    limits: LIMITS,
    runtime: 'node',
    directory: { serve: async (request, meta) => record('directory', request, meta) },
    spaces: { serve: async (spaceId, request, meta) => record('space', request, meta, spaceId) },
    connection: () => ({ clientIp: CLIENT_IP, secure: o.secure }),
    compress: true,
    web: o.web ? async (c) => c.text('static page') : null,
  });
  return { app, calls, secure: o.secure, request: (c) => Promise.resolve(app.request(c.path, caseRequest(c, o.secure))) };
}

describe('the gateway table (§14.3), Node', () => {
  const cases = GATEWAY_CASES.filter((c) => !c.runtimes || c.runtimes.includes('node'));

  it.each(cases.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    const gateway = nodeGateway({
      secure: c.secure ?? false,
      large: c.large ?? false,
      unreachable: c.unreachable ?? false,
    });
    await expectGatewayCase(c, gateway, await gateway.request(c));
  });

  it('isCanonicalApiPath refuses what a URL parser would resolve (§6.4.1)', () => {
    for (const path of ['/api/a/../b', '/api/a/./b', '/api/a\\b', '/api/a%2fb', '/api/a/', '/api//a']) expect(isCanonicalApiPath(path), path).toBe(false);
    expect(isCanonicalApiPath('/api/s/7k2m9q4w8x1c3v5b/tasks/12')).toBe(true);
  });
});

describe('Node extras', () => {
  it('the static site carries the security headers too, with its own caching', async () => {
    const { app } = nodeGateway({ secure: false, large: false, unreachable: false, web: true });
    const page = await app.request('/projects/3');
    expect(await page.text()).toBe('static page');
    expect(page.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    expect(page.headers.get('X-Frame-Options')).toBe('DENY');
    expect(page.headers.get('Cache-Control')).toBeNull();
  });
});

describe('the space paths of the client before spaces, on a Node stack (Appendix D 11)', () => {
  it('answer as the directory answers a path it does not know: 401 signed out, 404 signed in', async () => {
    const ctx = createTestContext();
    const owner = await ctx.signedIn();
    // Even for a member of the upgraded install's space, which the shim of P2-P3 sent them to.
    setLegacySpaceId(ctx.directoryDb, owner.spaceId);
    const authorize = vi.spyOn(ctx.stack.directory, 'authorizeSpace');
    for (const path of UNPREFIXED_SPACE_PATHS) {
      // Sent as they are: the test client would rewrite unprefixed paths.
      const signedOut = await ctx.app.request(path);
      expect(signedOut.status, path).toBe(401);
      expect(await signedOut.json()).toEqual({ error: { code: 'unauthorized', message: 'Not signed in' } });
      const signedIn = await ctx.app.request(path, { headers: { Cookie: owner.client.cookieHeader() } });
      expect(signedIn.status, path).toBe(404);
      // The old client, still open in a tab, shows the message (Appendix D 51).
      expect(await signedIn.json()).toEqual({ error: { code: 'not_found', message: 'Lyren Plan has been updated. Reload the page to continue.' } });
    }
    expect(authorize).not.toHaveBeenCalled();
  });

  it('a write there changes nothing in any space', async () => {
    const ctx = createTestContext();
    const owner = await ctx.signedIn();
    const query = () => owner.client.post<TaskQueryResult>(`/api/s/${owner.spaceId}/tasks/query`, { filter: { archived: 'include' } });
    const before = (await query()).body.total;
    const res = await ctx.app.request('/api/tasks', {
      method: 'POST',
      headers: { Cookie: owner.client.cookieHeader(), [CSRF_HEADER]: '1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Lost', projectId: 1 }),
    });
    expect(res.status).toBe(404);
    expect((await query()).body.total).toBe(before);
  });
});
