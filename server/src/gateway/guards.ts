// The gateway's checks (design §2.1, §2.2, §6.4.1, §7.1, §10.2), runtime-neutral: the Node gateway
// (gateway/app.ts) and the Cloudflare Worker (runtime/cloudflare/worker.ts) both use them, so the
// two refuse the same requests. Nothing here touches a database. The checks throw HttpError (the Node
// gateway's onError renders it; the Worker renders it itself), in the order of §2.2:
//
//   1. the canonical path (isCanonicalApiPath; else 404);
//   2. CSRF: X-Lyren-Request: 1 on every method but GET, HEAD and OPTIONS (else 403);
//   3. Content-Length against the path's body limit (else 413; a body without one is left to the
//      app's bodyLimit);
//   4. space requests: a valid space id (else 404) and a session cookie holding a well-formed token
//      (else 401, before any space is opened); the token is sent on only as its sha256.
//
// A space request then reaches its space host without the Cookie header and without any x-lyren-meta
// header a client sent (spaceRequest).

import { CSRF_HEADER } from '@shared/constants';
import { AUTH_BODY_LIMIT, isLoopbackHost, isPublicDirectoryPath, type RuntimeKind } from '../core/config';
import { readSessionToken } from '../core/cookies';
import { sha256Hex } from '../core/crypto';
import { isSpaceId } from '../core/ids';
import { META_HEADER } from '../core/meta';
import type { TrustedMeta } from '../core/ports';
import { forbidden, HttpError, payloadTooLarge, unauthorized } from '../http/errors';

/** Space requests are /api/s/<spaceId>/<path the space app knows, without /api>. */
export const SPACE_PREFIX = '/api/s/';

/** Space paths that take an import file (the rest take BODY_LIMIT); after /api/s/<id>. */
const SPACE_IMPORT_PATHS: ReadonlySet<string> = new Set(['/data/import/analyze', '/data/import/commit']);

/** A session token: 32 random bytes, base64url (directory/sessions.ts). */
const SESSION_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

const notFound = () => new HttpError(404, 'not_found', 'Not found');
const wrongHost = (origin: string) =>
  new HttpError(421, 'wrong_host', `This Lyren Plan instance is at ${origin}`, [{ path: 'publicUrl', message: origin }]);

/** The path of a request URL, still percent-encoded (Hono decodes it only to route). */
export function requestPath(url: string): string {
  return new URL(url).pathname;
}

/**
 * §6.4.1: an /api path no route needs any of: `%`, `\`, `//`, a `.` or `..` segment, or a trailing `/`.
 * Checked on the path before decoding. Defence in depth: the space gate judges the route that
 * actually runs (§6.4) whatever the spelling; this keeps logs and rate-limit keys simple.
 */
export function isCanonicalApiPath(path: string): boolean {
  if (path.includes('%') || path.includes('\\') || path.includes('//') || path.endsWith('/')) return false;
  return !path.split('/').some((segment) => segment === '.' || segment === '..');
}

/**
 * §10.2 (Cloudflare): an /api request for any other origin than PUBLIC_URL's (another host or port, or
 * plain HTTP) answers 421 wrong_host with PUBLIC_URL in its details, and the SPA, which the static assets
 * serve from any host, moves there (§12.3). So a second origin (the *.workers.dev name of a custom-domain
 * deployment, http:// on a zone without Always Use HTTPS) cannot be used to get around the zone's rules,
 * to register passkeys that never work, or to sign in over cleartext. Without PUBLIC_URL any host is
 * served, over HTTPS only, except on this machine (wrangler dev); a plain-HTTP request is sent to the same
 * host over HTTPS (Appendix D 66). Node leaves hosts and schemes to its reverse proxy.
 */
export function checkHost(url: URL, publicUrl: string | null): void {
  if (publicUrl === null) {
    if (url.protocol === 'https:' || isLoopbackHost(url.hostname)) return;
    throw wrongHost(`https://${url.hostname}`);
  }
  if (url.origin !== new URL(publicUrl).origin) throw wrongHost(publicUrl);
}

/** Where an /api request goes. */
export type ApiTarget =
  /** GET /api/health, answered by the gateway itself. */
  | { kind: 'health' }
  /** /api/s/<spaceId>/…: `spaceId` is null when it is not a valid id; `path` is the rest (/tasks/12). */
  | { kind: 'space'; spaceId: string | null; path: string }
  /** Everything else: the directory app. */
  | { kind: 'directory' };

export function apiTarget(path: string): ApiTarget {
  if (path === '/api/health') return { kind: 'health' };
  if (path.startsWith(SPACE_PREFIX)) {
    const rest = path.slice(SPACE_PREFIX.length);
    const slash = rest.indexOf('/');
    // /api/s/<id> alone names no route.
    if (slash <= 0) return { kind: 'space', spaceId: null, path: '' };
    const spaceId = rest.slice(0, slash);
    return { kind: 'space', spaceId: isSpaceId(spaceId) ? spaceId : null, path: rest.slice(slash) };
  }
  return { kind: 'directory' };
}

/** 403 unless a state-changing request carries the CSRF header (browsers cannot add it cross-site without CORS). */
export function checkCsrf(method: string, header: string | null | undefined): void {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
  if (header !== '1') throw forbidden(`Missing ${CSRF_HEADER} header`);
}

export interface BodyLimits {
  /** BODY_LIMIT. */
  bodyLimit: number;
  /** IMPORT_BODY_LIMIT. */
  importBodyLimit: number;
}

/** The body limit of a space path (after /api/s/<id>): IMPORT_BODY_LIMIT for imports, else BODY_LIMIT. */
function spaceBodyLimit(path: string, limits: BodyLimits): number {
  return SPACE_IMPORT_PATHS.has(path) ? limits.importBodyLimit : limits.bodyLimit;
}

/**
 * The body limit of a request (§7.1): space imports IMPORT_BODY_LIMIT; the public directory endpoints
 * (/api/auth/…, the invitation page's) 64 KiB; everything else BODY_LIMIT. The apps enforce their own
 * limits as well.
 */
export function bodyLimitFor(target: ApiTarget, path: string, limits: BodyLimits): number {
  if (target.kind === 'space') return spaceBodyLimit(target.path, limits);
  if (isPublicDirectoryPath(path)) return Math.min(limits.bodyLimit, AUTH_BODY_LIMIT);
  return limits.bodyLimit;
}

/** 413 when Content-Length announces more than `limit` bytes. */
export function checkContentLength(header: string | null | undefined, limit: number): void {
  if (header === null || header === undefined || header.trim() === '') return;
  const length = Number(header);
  if (Number.isFinite(length) && length > limit) throw payloadTooLarge();
}

/** 404 for an invalid space id (no space is opened). */
export function requireSpaceId(target: Extract<ApiTarget, { kind: 'space' }>): string {
  if (target.spaceId === null) throw notFound();
  return target.spaceId;
}

/**
 * The session of a space request (§5.4.1): the session cookie's token (by the naming rule of
 * core/cookies.ts), which must look like a token, else 401 before any space is opened. Only its sha256
 * travels on (TrustedMeta.sessionTokenHash), and which cookie name carried it.
 */
export function spaceSession(
  cookieHeader: string | null | undefined,
  secure: boolean,
  runtime: RuntimeKind,
): { tokenHash: string; cookie: 'host' | 'plain' } {
  const found = readSessionToken(cookieHeader, secure, runtime);
  if (!found || !SESSION_TOKEN_RE.test(found.token)) throw unauthorized();
  return { tokenHash: sha256Hex(found.token), cookie: found.source };
}

/** The TrustedMeta of a request, from the connection facts the runtime established. */
export function requestMeta(request: Request, connection: { clientIp: string; secure: boolean }): TrustedMeta {
  return {
    clientIp: connection.clientIp,
    secure: connection.secure,
    requestId: crypto.randomUUID(),
    userAgent: (request.headers.get('user-agent') ?? '').slice(0, 300) || null,
    sessionTokenHash: null,
    sessionCookie: null,
  };
}

/** The request's headers without any x-lyren-meta a client sent (the Worker then sets its own). */
export function withoutMeta(headers: Headers): Headers {
  const copy = new Headers(headers);
  copy.delete(META_HEADER);
  return copy;
}

/**
 * The request a space host gets (§2.2, §10.2): the same method, URL and body, without the Cookie header
 * and without a client-sent x-lyren-meta.
 */
export function spaceRequest(request: Request): Request {
  const headers = withoutMeta(request.headers);
  headers.delete('cookie');
  const init: RequestInit & { duplex?: 'half' } = { method: request.method, headers, signal: request.signal };
  if (request.body !== null && request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body;
    init.duplex = 'half';
  }
  return new Request(request.url, init);
}
