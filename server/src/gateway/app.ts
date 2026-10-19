// The gateway on Node (design §2.1, §2.2, §9.1): the only public entry. It applies the checks of
// gateway/guards.ts (the Cloudflare Worker applies the same ones), answers GET /api/health, and routes:
// /api/s/<spaceId>/… to the space client (the token hashed, the Cookie header removed), every other /api
// path to the directory client (cookie and all; the directory app owns the session cookie), and
// everything else to the static site. It never touches a database.
//
// Node's extras: the request log (LOG_REQUESTS), the security headers on every response (the static
// site's too; the apps set them on theirs, but not on every refusal, Appendix D 13), Cache-Control:
// no-store on every /api response, compression of /api responses except downloads that are files (the
// backup set, exports), and the static site with its own caching headers (http/static.ts). The client
// address and the HTTPS flag come from the runtime (runtime/node/clientIp.ts: TRUST_PROXY, COOKIE_SECURE).

import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { compress } from 'hono/compress';
import { logger } from 'hono/logger';
import { CSRF_HEADER } from '@shared/constants';
import type { RuntimeKind } from '../core/config';
import type { DirectoryClient, SpaceHostClient, TrustedMeta } from '../core/ports';
import { APP_VERSION } from '../core/version';
import { errorBody, handleError, HttpError } from '../http/errors';
import { securityHeaders } from '../http/headers';
import {
  apiTarget,
  bodyLimitFor,
  checkContentLength,
  checkCsrf,
  isCanonicalApiPath,
  requestMeta,
  requestPath,
  requireSpaceId,
  spaceRequest,
  spaceSession,
  type BodyLimits,
} from './guards';

export interface GatewayDeps {
  limits: BodyLimits;
  runtime: RuntimeKind;
  directory: Pick<DirectoryClient, 'serve'>;
  spaces: SpaceHostClient;
  /** The client address ('' when unknown) and whether the browser's request was HTTPS. */
  connection(c: Context): { clientIp: string; secure: boolean };
  /** LOG_REQUESTS: prints each request's two lines (Hono's logger); none = no request log. */
  requestLog?: ((line: string) => void) | null;
  /** Compress /api responses (Node; Cloudflare compresses responses itself, §10.6). */
  compress?: boolean;
  /** Serves every path outside /api (Node: http/static.ts); none = API only. */
  web?: MiddlewareHandler | null;
}

/** Downloads that are files: not compressed (§9.1). */
const UNCOMPRESSED = /^\/api\/(?:admin\/backup|s\/[^/]+\/data\/export)$/;

export function createGatewayApp(deps: GatewayDeps): Hono {
  const { limits, runtime } = deps;
  const app = new Hono();

  app.onError(handleError);
  app.notFound((c) => (c.req.path.startsWith('/api') ? c.json(errorBody('not_found', 'Not found'), 404) : c.text('Not found', 404)));

  if (deps.requestLog) app.use('*', logger(deps.requestLog));

  app.use('*', securityHeaders());
  app.use('/api/*', async (c, next) => {
    await next();
    if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store');
  });
  if (deps.compress) {
    const gzip = compress();
    app.use('/api/*', (c, next) => (UNCOMPRESSED.test(requestPath(c.req.url)) ? next() : gzip(c, next)));
  }

  app.all('/api/*', async (c) => {
    const request = c.req.raw;
    const path = requestPath(request.url);
    if (!isCanonicalApiPath(path)) throw new HttpError(404, 'not_found', 'Not found');
    const target = apiTarget(path);
    if (target.kind === 'health') {
      if (request.method !== 'GET' && request.method !== 'HEAD') throw new HttpError(404, 'not_found', 'Not found');
      return c.json({ ok: true, version: APP_VERSION });
    }
    checkCsrf(request.method, c.req.header(CSRF_HEADER));
    const meta = requestMeta(request, deps.connection(c));
    const withSession = (session: { tokenHash: string; cookie: 'host' | 'plain' }): TrustedMeta => ({
      ...meta,
      sessionTokenHash: session.tokenHash,
      sessionCookie: session.cookie,
    });

    if (target.kind === 'space') {
      checkContentLength(c.req.header('content-length'), bodyLimitFor(target, path, limits));
      const spaceId = requireSpaceId(target);
      const session = spaceSession(c.req.header('cookie'), meta.secure, runtime);
      return deps.spaces.serve(spaceId, spaceRequest(request), withSession(session));
    }

    // Every other /api path is the directory's, the unprefixed space paths of the client before spaces
    // (/api/bootstrap, …) included: it answers them as any path it does not know (401, or 404 signed in).
    checkContentLength(c.req.header('content-length'), bodyLimitFor(target, path, limits));
    return deps.directory.serve(request, meta);
  });

  if (deps.web) app.use('*', deps.web);

  return app;
}
