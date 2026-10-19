// The Worker's half of the gateway table (server/test/gateway/cases.ts, design §14.3, §10.2): every case
// that applies to Cloudflare, sent to handleRequest with stub Durable Object namespaces that record what
// reached them (the meta as the object decodes it from x-lyren-meta). The Node gateway runs the same table
// in server/test/gateway/gateway.test.ts. The real objects behind the Worker: e2e.test.ts.

import { describe, expect, it } from 'vitest';
import { decodeMeta, META_HEADER } from '../src/core/meta';
import { DIRECTORY_NAME } from '../src/runtime/cloudflare/clients';
import type { Env } from '../src/runtime/cloudflare/env';
import { handleRequest } from '../src/runtime/cloudflare/worker';
import {
  caseRequest,
  CLIENT_IP,
  expectGatewayCase,
  GATEWAY_CASES,
  LARGE_BODY,
  LIMITS,
  PUBLIC_HOST,
  type GatewayCall,
  type GatewayHarnessOptions,
  type GatewayUnderTest,
} from '../test/gateway/cases';

/** A Worker whose Durable Object namespaces record what reached them. */
function workerGateway(o: GatewayHarnessOptions): GatewayUnderTest & { env: Env } {
  const calls: GatewayCall[] = [];
  const namespace = (to: GatewayCall['to']) => ({
    getByName: (name: string) => ({
      fetch: async (request: Request) => {
        if (o.unreachable) throw new Error('Durable Object is overloaded (test)');
        if (to === 'directory' && name !== DIRECTORY_NAME) throw new Error(`the directory is ${DIRECTORY_NAME}, not ${name}`);
        const url = new URL(request.url);
        const meta = decodeMeta(request.headers.get(META_HEADER));
        if (!meta) throw new Error('a request without a valid meta header reached an object');
        calls.push({
          to,
          spaceId: to === 'space' ? name : undefined,
          method: request.method,
          path: url.pathname + url.search,
          headers: Object.fromEntries(request.headers),
          meta,
        });
        return Response.json(o.large ? LARGE_BODY : { ok: true });
      },
    }),
  });
  const env = {
    ASSETS: { fetch: async () => new Response('static page') },
    DIRECTORY: namespace('directory'),
    SPACES: namespace('space'),
    PUBLIC_URL: `https://${PUBLIC_HOST}`,
    BODY_LIMIT: String(LIMITS.bodyLimit),
    IMPORT_BODY_LIMIT: String(LIMITS.importBodyLimit),
  } as unknown as Env;
  return {
    env,
    calls,
    secure: o.secure,
    request: (c) => {
      const { method, headers, body } = caseRequest(c, o.secure);
      const url = `${o.secure ? 'https' : 'http'}://${c.host ?? PUBLIC_HOST}${c.path}`;
      return handleRequest(new Request(url, { method, headers: { 'CF-Connecting-IP': CLIENT_IP, ...headers }, body }), env);
    },
  };
}

describe('the gateway table (§14.3), Cloudflare Worker', () => {
  const cases = GATEWAY_CASES.filter((c) => !c.runtimes || c.runtimes.includes('cloudflare'));

  it.each(cases.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    // HTTPS unless the case says otherwise: PUBLIC_URL is https, so the Worker refuses plain HTTP (cases.ts).
    const gateway = workerGateway({
      secure: c.secure ?? true,
      large: c.large ?? false,
      unreachable: c.unreachable ?? false,
    });
    await expectGatewayCase(c, gateway, await gateway.request(c));
  });
});

describe('Worker extras (§10.2)', () => {
  it('the entry exports only what workerd takes as entry points: the default handler, the classes, functions', async () => {
    // workerd refuses a module with any other named export ("Incorrect type for map entry").
    const entry: Record<string, unknown> = await import('../src/runtime/cloudflare/worker');
    expect(Object.keys(entry).sort()).toEqual(['DirectoryDO', 'SpaceDO', 'default', 'handleRequest']);
    for (const [name, value] of Object.entries(entry)) {
      if (name === 'default') expect(typeof (value as { fetch?: unknown }).fetch).toBe('function');
      else expect(typeof value, name).toBe('function');
    }
  });

  it('paths outside /api go to the static assets, untouched over HTTP and with HSTS over HTTPS', async () => {
    const gateway = workerGateway({ secure: false, large: false, unreachable: false });
    for (const scheme of ['http', 'https']) {
      // Any host: the SPA moves to PUBLIC_URL itself once the API answers 421.
      const res = await handleRequest(new Request(`${scheme}://other.example.com/projects/3`), gateway.env);
      expect(await res.text()).toBe('static page');
      expect(res.headers.get('Strict-Transport-Security')).toBe(scheme === 'https' ? 'max-age=31536000' : null);
      expect(res.headers.get('Cache-Control')).toBeNull();
    }
    expect(gateway.calls).toEqual([]);
  });

  it('an invalid variable makes every /api request answer 503 with the reason', async () => {
    const gateway = workerGateway({ secure: false, large: false, unreachable: false });
    const env = { ...gateway.env, BODY_LIMIT: 'lots' } as Env;
    for (const path of ['/api/health', '/api/auth/status']) {
      const res = await handleRequest(new Request(`https://${PUBLIC_HOST}${path}`), env);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({
        error: { code: 'unavailable', message: 'Configuration error: Invalid value for BODY_LIMIT: lots (expected 1..9007199254740991)' },
      });
      expect(res.headers.get('Cache-Control')).toBe('no-store');
    }
    expect(gateway.calls).toEqual([]);
  });

  it('without PUBLIC_URL every host is served over HTTPS, and plain HTTP only on this machine', async () => {
    const gateway = workerGateway({ secure: false, large: false, unreachable: false });
    const env = { ...gateway.env, PUBLIC_URL: '' } as Env;
    for (const origin of ['https://other.example.com', 'http://127.0.0.1:8787', 'http://localhost:8787', 'http://[::1]:8787']) {
      const res = await handleRequest(new Request(`${origin}/api/auth/status`), env);
      expect(res.status, origin).toBe(200);
    }
    expect(gateway.calls.map((call) => call.to)).toEqual(['directory', 'directory', 'directory', 'directory']);
    // Plain HTTP elsewhere goes to the same host over HTTPS (the SPA moves there).
    const res = await handleRequest(new Request(`http://${PUBLIC_HOST}:8080/api/auth/status`), env);
    expect(res.status).toBe(421);
    expect(await res.json()).toEqual({
      error: {
        code: 'wrong_host',
        message: `This Lyren Plan instance is at https://${PUBLIC_HOST}`,
        details: [{ path: 'publicUrl', message: `https://${PUBLIC_HOST}` }],
      },
    });
    expect(gateway.calls).toHaveLength(4);
  });

  it('PUBLIC_URL may be http only on this machine: wrangler dev, with or without Vite in front', async () => {
    const gateway = workerGateway({ secure: false, large: false, unreachable: false });
    // docs/cloudflare.md, Local development: Vite's proxy keeps the browser's Host, so PUBLIC_URL is Vite's.
    const dev = { ...gateway.env, PUBLIC_URL: 'http://localhost:5173' } as Env;
    expect((await handleRequest(new Request('http://localhost:5173/api/auth/status'), dev)).status).toBe(200);
    const direct = await handleRequest(new Request('http://localhost:8787/api/auth/status'), dev);
    expect(direct.status).toBe(421);
    expect(((await direct.json()) as { error: { message: string } }).error.message).toBe('This Lyren Plan instance is at http://localhost:5173');
    const plain = { ...gateway.env, PUBLIC_URL: `http://${PUBLIC_HOST}` } as Env;
    const res = await handleRequest(new Request(`http://${PUBLIC_HOST}/api/health`), plain);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: {
        code: 'unavailable',
        message:
          `Configuration error: Invalid value for PUBLIC_URL: http://${PUBLIC_HOST} ` +
          '(expected an https origin such as https://plan.example.com; http only for localhost under wrangler dev)',
      },
    });
    expect(gateway.calls.map((call) => call.to)).toEqual(['directory']);
  });
});
