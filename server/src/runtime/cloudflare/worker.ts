// The Worker (design §2.1, §2.2 c and d, §10.2): the gateway on Cloudflare, and the entry Wrangler bundles.
// It applies the checks of gateway/guards.ts, the same as the Node gateway, and hands each /api request to
// a Durable Object: /api/s/<spaceId>/… to the SpaceDO of that id (the session token hashed, the Cookie
// header removed), every other /api path to the DirectoryDO (cookie and all; the directory owns it), with
// the TrustedMeta in x-lyren-meta (clients.ts). It runs no database code. Static files are Workers Static
// Assets, which answer everything but /api and /api/* before the Worker runs (run_worker_first), so anything
// else reaches it only by mistake and goes to env.ASSETS. Nothing is compressed here: Cloudflare
// compresses responses itself (§10.6).
//
// What only the Worker does: the origin check (421 wrong_host for another origin than PUBLIC_URL's, or for
// plain HTTP off this machine without one, §10.2 step 2, Appendix D 66), the client address from
// CF-Connecting-IP only (X-Forwarded-For can carry entries a client wrote; TRUST_PROXY does not apply), 503
// when an object cannot be reached, and HSTS on every response to an HTTPS request.
// Like the Node gateway, it gives every /api answer Cache-Control: no-store (unless the answer has its own)
// and the security headers of http/headers.ts, its own refusals included. An invalid variable makes every
// /api request answer 503 with the reason, as the directory does (§10.3), health included.

import { Hono } from 'hono';
import { CSRF_HEADER } from '@shared/constants';
import type { AppConfig } from '../../core/config';
import type { TrustedMeta } from '../../core/ports';
import { APP_VERSION } from '../../core/version';
import {
  apiTarget,
  bodyLimitFor,
  checkContentLength,
  checkCsrf,
  checkHost,
  isCanonicalApiPath,
  requestMeta,
  requireSpaceId,
  spaceSession,
} from '../../gateway/guards';
import { errorResponse, HttpError, unavailable } from '../../http/errors';
import { securityHeaders } from '../../http/headers';
import { DoDirectoryClient, DoSpaceHostClient } from './clients';
import { cfConfig } from './config';
import type { Env } from './env';
import { unavailableMessage } from './objects';

export { DirectoryDO } from './directoryDo';
export { SpaceDO } from './spaceDo';

/** §10.2 step 10: an object that cannot be reached (overloaded, reset, a platform limit). */
const UNREACHABLE_MESSAGE = 'Lyren Plan is temporarily unavailable. Try again in a minute.';

const HSTS = 'max-age=31536000';

const notFound = () => new HttpError(404, 'not_found', 'Not found');

/** Each isolate parses the configuration once (or remembers why it could not). */
const configs = new WeakMap<Env, AppConfig | HttpError>();

function workerConfig(env: Env): AppConfig {
  let config = configs.get(env);
  if (config === undefined) {
    try {
      config = cfConfig(env);
    } catch (err) {
      console.error('[lyren] The configuration is invalid:', err);
      config = unavailable(unavailableMessage(err));
    }
    configs.set(env, config);
  }
  if (config instanceof HttpError) throw config;
  return config;
}

/** CF-Connecting-IP, which Cloudflare sets; '' when it is missing (wrangler dev) or not an address. */
function clientIp(request: Request): string {
  const ip = request.headers.get('CF-Connecting-IP')?.trim() ?? '';
  return /^[0-9A-Fa-f:.]{2,45}$/.test(ip) ? ip : '';
}

/** Every /api answer: a mutable copy with the security headers, no-store unless it has its own, HSTS on HTTPS. */
const apiAnswer = new Hono<{ Bindings: { response: Response; secure: boolean } }>();
apiAnswer.use('*', securityHeaders());
apiAnswer.all('*', (c) => {
  const res = new Response(c.env.response.body, c.env.response);
  if (!res.headers.has('Cache-Control')) res.headers.set('Cache-Control', 'no-store');
  if (c.env.secure) res.headers.set('Strict-Transport-Security', HSTS);
  return res;
});

/** §10.2 steps 2-10 for an /api request. HttpErrors are the Worker's own answers. */
async function serveApi(request: Request, env: Env, url: URL, config: AppConfig): Promise<Response> {
  checkHost(url, config.publicUrl);
  const path = url.pathname;
  if (!isCanonicalApiPath(path)) throw notFound();
  const target = apiTarget(path);
  if (target.kind === 'health') {
    if (request.method !== 'GET' && request.method !== 'HEAD') throw notFound();
    return Response.json({ ok: true, version: APP_VERSION });
  }
  checkCsrf(request.method, request.headers.get(CSRF_HEADER));
  checkContentLength(request.headers.get('content-length'), bodyLimitFor(target, path, config));
  const meta = requestMeta(request, { clientIp: clientIp(request), secure: url.protocol === 'https:' });

  let reach: () => Promise<Response>;
  if (target.kind === 'space') {
    const spaceId = requireSpaceId(target);
    const session = spaceSession(request.headers.get('cookie'), meta.secure, 'cloudflare');
    const spaceMeta: TrustedMeta = { ...meta, sessionTokenHash: session.tokenHash, sessionCookie: session.cookie };
    reach = () => new DoSpaceHostClient(env).serve(spaceId, request, spaceMeta);
  } else {
    reach = () => new DoDirectoryClient(env).serve(request, meta);
  }
  try {
    return await reach();
  } catch (err) {
    console.error(`[lyren] ${request.method} ${path} could not reach its Durable Object:`, err);
    throw unavailable(UNREACHABLE_MESSAGE);
  }
}

export async function handleRequest(request: Request, env: Env, _ctx?: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const secure = url.protocol === 'https:';
  if (url.pathname !== '/api' && !url.pathname.startsWith('/api/')) {
    const asset = await env.ASSETS.fetch(request);
    if (!secure) return asset;
    const res = new Response(asset.body, asset);
    res.headers.set('Strict-Transport-Security', HSTS);
    return res;
  }

  let config: AppConfig | null = null;
  let response: Response;
  try {
    config = workerConfig(env);
    response = await serveApi(request, env, url, config);
  } catch (err) {
    if (!(err instanceof HttpError)) console.error(`[lyren] ${request.method} ${url.pathname} failed:`, err);
    // A refusal leaves the body unread, which the platform discards. Cancelling it here broke the connection
    // under wrangler dev: the refusal of a large upload answered 500 instead of 413, and so did the next
    // request on a kept-alive connection (Appendix D 45; scripts/cf/oversize-check.mjs).
    response = errorResponse(err instanceof HttpError ? err : unavailable(UNREACHABLE_MESSAGE));
  }
  if (config?.logRequests) console.log(`[lyren] ${request.method} ${url.pathname} ${response.status}`);
  return apiAnswer.fetch(request, { response, secure });
}

export default { fetch: handleRequest } satisfies ExportedHandler<Env>;
