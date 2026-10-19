// The gateway's behaviour as one table (design §14.3), runtime-neutral. gateway.test.ts runs it against
// the Node gateway (createGatewayApp with spy clients), and server/test-workers/gateway.test.ts against the
// Worker's handleRequest with stub Durable Object namespaces, since both apply gateway/guards.ts. Each
// case is one request and what must come of it: the status, the gateway's own error answer, and which
// client the request reached with what (the space host never sees the Cookie header or a client-sent
// x-lyren-meta, only the token's hash). Cases that only one runtime has (compression and the unprefixed
// cookie over HTTPS on Node; the host check, HSTS and unreachable objects on the Worker) name it in
// `runtimes`.
//
// A harness serves each case from a fresh gateway whose clients record what reached them and answer
// 200 with `{ ok: true }` (or LARGE_BODY when the case says `large`); the client address is CLIENT_IP
// (the Worker's harness sends it as CF-Connecting-IP), and requests go to PUBLIC_HOST unless the case
// names another `host`. A case that names no `secure` goes over the harness's default scheme: plain HTTP
// on Node, HTTPS on the Worker (whose PUBLIC_URL is https, so it refuses plain HTTP, Appendix D 66), and
// `signedIn` sends the session cookie under the name a browser has for that scheme.

import { expect } from 'vitest';
import { CSRF_HEADER, SESSION_COOKIE, SESSION_COOKIE_SECURE } from '@shared/constants';
import { AUTH_BODY_LIMIT, type RuntimeKind } from '../../src/core/config';
import { sha256Hex } from '../../src/core/crypto';
import { META_HEADER } from '../../src/core/meta';
import type { TrustedMeta } from '../../src/core/ports';

export const SPACE = '7k2m9q4w8x1c3v5b';
export const TOKEN = 'k'.repeat(43);
/** The session cookie under its plain name (HTTP; a session from before __Host- on Node over HTTPS, §5.4.1). */
export const COOKIE = `lyren_session=${TOKEN}`;
/** The session cookie's name in a browser: `__Host-lyren_session` over HTTPS, `lyren_session` over HTTP. */
const sessionCookieName = (secure: boolean): string => (secure ? SESSION_COOKIE_SECURE : SESSION_COOKIE);
/** The session cookie as a browser sends it over HTTPS (`secure`) or HTTP. */
export const sessionCookie = (secure: boolean): string => `${sessionCookieName(secure)}=${TOKEN}`;
/** In a case's Cookie header: the session cookie's name for the request's scheme (caseRequest). */
const SESSION = '<session>';
export const CLIENT_IP = '192.0.2.10';
/** The host of the Worker's PUBLIC_URL (the Node gateway checks no host). */
export const PUBLIC_HOST = 'plan.example.com';
/** BODY_LIMIT and IMPORT_BODY_LIMIT of the gateway under test. */
export const LIMITS = { bodyLimit: 100_000, importBodyLimit: 500_000 };
/** What the clients answer with for a `large` case: big enough to be compressed. */
export const LARGE_BODY = { items: Array.from({ length: 200 }, (_, i) => ({ id: i, title: `Task number ${i}` })) };

/** What reached a client. */
export interface GatewayCall {
  to: 'directory' | 'space';
  /** The space id the request was routed to (space calls). */
  spaceId?: string;
  method: string;
  /** Path and query of the request the client received. */
  path: string;
  /** Its headers, names lower-cased. */
  headers: Record<string, string>;
  /** The connection facts and session the gateway established (Node: the argument; Worker: x-lyren-meta). */
  meta: TrustedMeta;
}

/** One gateway the harness built for a case. */
export interface GatewayUnderTest {
  request(c: GatewayCase): Promise<Response>;
  /** What reached the clients, in order. */
  calls: GatewayCall[];
  /** The case's request is HTTPS (GatewayHarnessOptions.secure). */
  secure: boolean;
}

export interface GatewayHarnessOptions {
  /** The browser's request was HTTPS: the case's `secure`, else the harness's default (see the header). */
  secure: boolean;
  /** The clients answer with LARGE_BODY. */
  large: boolean;
  /** The clients cannot be reached (they throw: an overloaded or reset Durable Object). */
  unreachable: boolean;
}

export interface GatewayCase {
  name: string;
  /** Default GET. */
  method?: string;
  path: string;
  headers?: Record<string, string>;
  /** The request body: a string, or that many bytes with their Content-Length. */
  body?: string | { bytes: number };
  /** Runtimes the case applies to (default both). */
  runtimes?: readonly RuntimeKind[];
  /** HTTPS (true) or plain HTTP (false); default the harness's (see the header). */
  secure?: boolean;
  /** The request's host (default PUBLIC_HOST). */
  host?: string;
  large?: boolean;
  unreachable?: boolean;
  status: number;
  /** The gateway's own error answer (when it answers itself). */
  error?: { code: string; message: string; details?: Array<{ path: string; message: string }> };
  /** Or its own answer (toMatchObject). */
  answer?: Record<string, unknown>;
  /** Who the request reached: nobody (the gateway answered), the directory, or a space at a path. */
  reaches: 'none' | 'directory' | { spaceId: string; path: string };
  /** With Accept-Encoding: gzip, the Content-Encoding the response must have (Node's compress()). */
  encoding?: 'gzip' | null;
  /** Response headers the answer must have (null: must not have). */
  responseHeaders?: Record<string, string | null>;
  /** More checks, on what reached the clients (gateway.calls). */
  check?: (gateway: GatewayUnderTest) => void;
}

/** The request of a case over HTTPS (`secure`) or HTTP, as the harness sends it (the harness adds its origin). */
export function caseRequest(c: GatewayCase, secure: boolean): { method: string; headers: Record<string, string>; body?: string } {
  const method = c.method ?? 'GET';
  const headers: Record<string, string> = { ...c.headers };
  if (headers.Cookie !== undefined) headers.Cookie = headers.Cookie.replaceAll(SESSION, sessionCookieName(secure));
  if (c.encoding !== undefined) headers['Accept-Encoding'] = 'gzip';
  if (c.body === undefined) return { method, headers };
  if (typeof c.body === 'string') return { method, headers, body: c.body };
  return { method, headers: { ...headers, 'Content-Length': String(c.body.bytes) }, body: 'x'.repeat(c.body.bytes) };
}

const write = { [CSRF_HEADER]: '1', 'Content-Type': 'application/json' };
const signedIn = { Cookie: `${SESSION}=${TOKEN}` };
const NOT_FOUND = { code: 'not_found', message: 'Not found' };
const NOT_SIGNED_IN = { code: 'unauthorized', message: 'Not signed in' };
const TOO_LARGE = { code: 'payload_too_large', message: 'Request body too large' };
const space = (path: string) => ({ spaceId: SPACE, path: `/api/s/${SPACE}${path}` });
const WRONG_HOST = {
  code: 'wrong_host',
  message: `This Lyren Plan instance is at https://${PUBLIC_HOST}`,
  details: [{ path: 'publicUrl', message: `https://${PUBLIC_HOST}` }],
};
const HSTS = 'max-age=31536000';

/** The meta of a request with the session cookie of `signedIn`, over HTTPS (`secure`) or plain HTTP. */
const sessionMeta = (secure: boolean) => ({
  clientIp: CLIENT_IP,
  secure,
  sessionTokenHash: sha256Hex(TOKEN),
  sessionCookie: secure ? 'host' : 'plain',
});

/**
 * The space paths of the client before spaces, one per space route (the temporary shim of §7.3 mapped them
 * to the session's space until P4). The gateways send them to the directory as they are, which answers
 * them as any path it does not know: 401 signed out, 404 signed in (Appendix D 11), whose message asks to
 * reload the page (Appendix D 51); the Node stack test and server/test-workers/e2e.test.ts check those
 * answers.
 */
export const UNPREFIXED_SPACE_PATHS: readonly string[] = [
  '/api/bootstrap?today=2026-10-17',
  '/api/projects',
  '/api/milestones/1',
  '/api/epics/1',
  '/api/tasks/12/timeline',
  '/api/comments/1',
  '/api/worklogs?from=2026-10-01&to=2026-10-31',
  '/api/activity',
  '/api/boards',
  '/api/tags',
  '/api/statuses',
  '/api/settings',
  '/api/data/export',
  '/api/dashboard',
  '/api/search?q=x',
  '/api/people/me/disown',
];

const CSRF_PATHS = ['/api/auth/login', '/api/account/password', '/api/spaces', `/api/s/${SPACE}/tasks`, '/api/tasks', '/api/admin/x', '/api/invitations/accept'];

export const GATEWAY_CASES: readonly GatewayCase[] = [
  // ---- Answered by the gateway itself ---------------------------------------------------------
  { name: 'GET /api/health', path: '/api/health', status: 200, answer: { ok: true }, reaches: 'none' },
  { name: 'POST /api/health is no route', method: 'POST', path: '/api/health', headers: write, status: 404, error: NOT_FOUND, reaches: 'none' },
  // /api alone is an API path, the directory's (on Cloudflare run_worker_first lists it, Appendix D 45).
  { name: 'GET /api goes to the directory', path: '/api', headers: signedIn, status: 200, reaches: 'directory' },

  // ---- §6.4.1: non-canonical paths --------------------------------------------------------------
  // (A URL parser has already resolved `\`, `.` and `..`; isCanonicalApiPath refuses them too.)
  ...[`/api/s/${SPACE}//tasks`, `/api/s/${SPACE}/tasks/`, `/api/s/${SPACE}/%74asks`, '/api/auth/status/', '/api//auth/status', '/api/a%2fb'].map(
    (path): GatewayCase => ({ name: `non-canonical ${path}`, path, headers: signedIn, status: 404, error: NOT_FOUND, reaches: 'none' }),
  ),

  // ---- CSRF on every prefix ----------------------------------------------------------------------
  ...CSRF_PATHS.flatMap((path) =>
    ['POST', 'PATCH', 'PUT', 'DELETE'].map(
      (method): GatewayCase => ({
        name: `${method} ${path} without the CSRF header`,
        method,
        path,
        headers: { ...signedIn, 'Content-Type': 'application/json' },
        body: '{}',
        status: 403,
        error: { code: 'forbidden', message: `Missing ${CSRF_HEADER} header` },
        reaches: 'none',
      }),
    ),
  ),
  {
    name: 'a CSRF header other than 1',
    method: 'POST',
    path: `/api/s/${SPACE}/tasks`,
    headers: { ...signedIn, [CSRF_HEADER]: '0' },
    body: '{}',
    status: 403,
    reaches: 'none',
  },
  { name: 'GET needs no CSRF header', path: `/api/s/${SPACE}/tasks`, headers: signedIn, status: 200, reaches: space('/tasks') },

  // ---- Invalid space ids: 404, no space opened ------------------------------------------------------
  ...['7K2M9Q4W8X1C3V5B', '7k2m9q4w8x1c3v5', '7k2m9q4w8x1c3v5bb', 'ilouilouilouilou', 'not-a-space-id!!'].map(
    (id): GatewayCase => ({ name: `space id ${id}`, path: `/api/s/${id}/tasks`, headers: signedIn, status: 404, error: NOT_FOUND, reaches: 'none' }),
  ),
  { name: 'a space id without a path', path: `/api/s/${SPACE}`, headers: signedIn, status: 404, error: NOT_FOUND, reaches: 'none' },

  // ---- A missing or malformed session cookie: 401 before any space is opened -----------------------
  ...[undefined, 'other=1', `${SESSION}=`, `${SESSION}=short`, `${SESSION}=${'k'.repeat(44)}`, `${SESSION}=${'*'.repeat(43)}`].map(
    (cookie): GatewayCase => ({
      name: `space request with cookie ${String(cookie)}`,
      path: `/api/s/${SPACE}/bootstrap`,
      headers: cookie === undefined ? {} : { Cookie: cookie },
      status: 401,
      error: NOT_SIGNED_IN,
      reaches: 'none',
    }),
  ),
  {
    name: 'over HTTPS, the __Host- cookie',
    path: `/api/s/${SPACE}/bootstrap`,
    headers: { Cookie: `__Host-lyren_session=${TOKEN}` },
    secure: true,
    status: 200,
    reaches: space('/bootstrap'),
    check: (g) => expect(g.calls[0]!.meta).toMatchObject({ secure: true, sessionTokenHash: sha256Hex(TOKEN), sessionCookie: 'host' }),
  },
  {
    // The directory decides whether a session may use it (a legacy one, §5.4.1). The Worker reads the
    // __Host- name only over HTTPS.
    name: 'over HTTPS, the unprefixed cookie travels as plain',
    runtimes: ['node'],
    path: `/api/s/${SPACE}/bootstrap`,
    headers: { Cookie: COOKIE },
    secure: true,
    status: 200,
    reaches: space('/bootstrap'),
    check: (g) => expect(g.calls[0]!.meta).toMatchObject({ secure: true, sessionCookie: 'plain' }),
  },

  // ---- What the clients receive: a spoofed x-lyren-meta, the Cookie header ------------------------
  {
    name: 'a space host gets the token hash, never the Cookie or a client-sent x-lyren-meta',
    method: 'PATCH',
    path: `/api/s/${SPACE}/tasks/12?x=1`,
    headers: { ...write, Cookie: `${SESSION}=${TOKEN}; other=2`, [META_HEADER]: 'spoofed' },
    body: '{}',
    status: 200,
    reaches: space('/tasks/12?x=1'),
    check: (g) => {
      const call = g.calls[0]!;
      expect(call.method).toBe('PATCH');
      expect(call.headers.cookie).toBeUndefined();
      expect(call.headers[META_HEADER]).not.toBe('spoofed');
      expect(call.headers[CSRF_HEADER.toLowerCase()]).toBe('1');
      expect(call.meta).toMatchObject(sessionMeta(g.secure));
    },
  },
  {
    name: 'the directory gets the request with its cookie and the gateway’s own meta',
    method: 'POST',
    path: '/api/auth/login',
    headers: { ...write, ...signedIn, [META_HEADER]: 'spoofed', 'User-Agent': 'test-agent' },
    body: '{}',
    status: 200,
    reaches: 'directory',
    check: (g) => {
      const call = g.calls[0]!;
      expect(call.headers.cookie).toBe(sessionCookie(g.secure));
      // What counts is the meta the directory acts on: on Node the gateway's argument (a client's header
      // goes on unread), on Cloudflare the x-lyren-meta the Worker writes in its place (§2.2).
      expect(call.meta).toMatchObject({ clientIp: CLIENT_IP, secure: g.secure, userAgent: 'test-agent', sessionTokenHash: null, sessionCookie: null });
      expect(call.meta.requestId).toMatch(/^[0-9a-f-]{36}$/);
    },
  },

  // ---- §7.1: Content-Length against the body limits ----------------------------------------------
  ...(
    [
      [`/api/s/${SPACE}/data/import/commit`, 400_000, space('/data/import/commit')],
      [`/api/s/${SPACE}/data/import/analyze`, 500_000, space('/data/import/analyze')],
      [`/api/s/${SPACE}/data/import/analyze`, 500_001, null],
      // The v1 import route is gone (P7): its path has the ordinary limit.
      [`/api/s/${SPACE}/data/import`, 400_000, null],
      [`/api/s/${SPACE}/tasks`, 100_000, space('/tasks')],
      [`/api/s/${SPACE}/tasks`, 100_001, null],
      ['/api/tasks', 100_001, null],
      ['/api/auth/login', AUTH_BODY_LIMIT, 'directory'],
      ['/api/auth/login', AUTH_BODY_LIMIT + 1, null],
      ['/api/auth/setup', AUTH_BODY_LIMIT + 1, null],
      ['/api/account/password', AUTH_BODY_LIMIT + 1, 'directory'],
      ['/api/account/password', 100_001, null],
      // The invitation page's endpoints are public, with the public limit (§7.1).
      ['/api/invitations/accept', AUTH_BODY_LIMIT, 'directory'],
      ['/api/invitations/accept', AUTH_BODY_LIMIT + 1, null],
      ['/api/invitations/inspect', AUTH_BODY_LIMIT + 1, null],
      ['/api/invitations/accept/passkey/options', AUTH_BODY_LIMIT + 1, null],
      ['/api/invitations/accept/passkey', AUTH_BODY_LIMIT, 'directory'],
      ['/api/invitations/accept/passkey', AUTH_BODY_LIMIT + 1, null],
      ['/api/invitations/7/accept', AUTH_BODY_LIMIT + 1, 'directory'],
      // Passkey sign-in is public; adding a passkey is the account's (§7.1).
      ['/api/auth/passkey/login', AUTH_BODY_LIMIT + 1, null],
      ['/api/account/passkeys', AUTH_BODY_LIMIT + 1, 'directory'],
    ] as const
  ).map(
    ([path, bytes, reaches]): GatewayCase => ({
      name: `Content-Length ${bytes} for POST ${path}`,
      method: 'POST',
      path,
      headers: { ...write, ...signedIn },
      body: { bytes },
      status: reaches === null ? 413 : 200,
      error: reaches === null ? TOO_LARGE : undefined,
      reaches: reaches ?? 'none',
    }),
  ),

  // ---- The space paths of the client before spaces: the directory's, as they are ----------------
  ...UNPREFIXED_SPACE_PATHS.map(
    (path): GatewayCase => ({
      name: `${path} goes to the directory as it is`,
      path,
      headers: signedIn,
      status: 200,
      reaches: 'directory',
      check: (g) => {
        expect(g.calls[0]!.path).toBe(path);
        expect(g.calls[0]!.headers.cookie).toBe(sessionCookie(g.secure));
      },
    }),
  ),
  ...(
    [
      [100_000, 'directory'],
      [100_001, null],
    ] as const
  ).map(
    ([bytes, reaches]): GatewayCase => ({
      name: `an unprefixed import of ${bytes} bytes has the directory's body limit`,
      method: 'POST',
      path: '/api/data/import',
      headers: { ...write, ...signedIn },
      body: { bytes },
      status: reaches === null ? 413 : 200,
      error: reaches === null ? TOO_LARGE : undefined,
      reaches: reaches ?? 'none',
    }),
  ),

  // ---- §10.2: what only the Worker does -----------------------------------------------------------
  ...[
    ['/api/auth/status', {}],
    ['/api/health', {}],
    [`/api/s/${SPACE}/bootstrap`, signedIn],
    ['/api/auth/login', { ...write, ...signedIn }],
  ].flatMap(([path, headers]): GatewayCase[] => {
    const request = {
      runtimes: ['cloudflare'],
      method: path === '/api/auth/login' ? 'POST' : 'GET',
      path: path as string,
      headers: headers as Record<string, string>,
      status: 421,
      error: WRONG_HOST,
      reaches: 'none',
    } as const;
    return [
      { ...request, name: `another host answers 421 for ${path}, before anything else`, host: 'lyren-plan.example.workers.dev' },
      // Plain HTTP to PUBLIC_URL's host (a zone without Always Use HTTPS): never a sign-in over cleartext.
      {
        ...request,
        name: `plain HTTP answers 421 for ${path}, before anything else`,
        secure: false,
        responseHeaders: { 'Strict-Transport-Security': null },
      },
    ];
  }),
  {
    name: 'the host check compares the port too',
    runtimes: ['cloudflare'],
    path: '/api/auth/status',
    host: `${PUBLIC_HOST}:8443`,
    status: 421,
    error: WRONG_HOST,
    reaches: 'none',
  },
  {
    name: 'HSTS on every answer to an HTTPS request',
    runtimes: ['cloudflare'],
    path: '/api/auth/status',
    secure: true,
    status: 200,
    reaches: 'directory',
    responseHeaders: { 'Strict-Transport-Security': HSTS },
  },
  {
    name: 'HSTS on the Worker’s own refusals over HTTPS too',
    runtimes: ['cloudflare'],
    path: `/api/s/${SPACE}/bootstrap`,
    secure: true,
    status: 401,
    error: NOT_SIGNED_IN,
    reaches: 'none',
    responseHeaders: { 'Strict-Transport-Security': HSTS },
  },
  {
    // §5.4.1: no session on Cloudflare was ever issued under the unprefixed name.
    name: 'over HTTPS, the Worker takes only the __Host- cookie',
    runtimes: ['cloudflare'],
    path: `/api/s/${SPACE}/bootstrap`,
    headers: { Cookie: COOKIE },
    secure: true,
    status: 401,
    error: NOT_SIGNED_IN,
    reaches: 'none',
  },
  {
    name: 'no HSTS over plain HTTP',
    runtimes: ['node'],
    path: '/api/auth/status',
    secure: false,
    status: 200,
    reaches: 'directory',
    responseHeaders: { 'Strict-Transport-Security': null },
  },
  {
    name: 'Node leaves HSTS to its reverse proxy',
    runtimes: ['node'],
    path: '/api/auth/status',
    secure: true,
    status: 200,
    reaches: 'directory',
    responseHeaders: { 'Strict-Transport-Security': null },
  },
  ...['/api/auth/status', `/api/s/${SPACE}/bootstrap`].map(
    (path): GatewayCase => ({
      name: `an object that cannot be reached answers 503 for ${path}`,
      runtimes: ['cloudflare'],
      path,
      headers: signedIn,
      unreachable: true,
      status: 503,
      error: { code: 'unavailable', message: 'Lyren Plan is temporarily unavailable. Try again in a minute.' },
      reaches: 'none',
    }),
  ),
  {
    // CF-Connecting-IP only: X-Forwarded-For can carry entries a client wrote (§10.6).
    name: 'the client address is CF-Connecting-IP, never X-Forwarded-For',
    runtimes: ['cloudflare'],
    path: '/api/auth/status',
    headers: { 'X-Forwarded-For': '203.0.113.9' },
    status: 200,
    reaches: 'directory',
    check: (g) => expect(g.calls[0]!.meta.clientIp).toBe(CLIENT_IP),
  },
  ...[`/api/s/${SPACE}/bootstrap`, '/api/spaces'].map(
    (path): GatewayCase => ({
      name: `no compression of ${path} on Cloudflare (§10.6)`,
      runtimes: ['cloudflare'],
      path,
      headers: signedIn,
      large: true,
      encoding: null,
      status: 200,
      reaches: path === '/api/spaces' ? 'directory' : space('/bootstrap'),
    }),
  ),

  // ---- §9.1: compression on Node, except downloads that are files ---------------------------------
  ...(
    [
      [`/api/s/${SPACE}/bootstrap`, 'gzip', space('/bootstrap')],
      ['/api/spaces', 'gzip', 'directory'],
      [`/api/s/${SPACE}/data/export`, null, space('/data/export')],
      ['/api/data/export', 'gzip', 'directory'],
      ['/api/admin/backup', null, 'directory'],
    ] as const
  ).map(
    ([path, encoding, reaches]): GatewayCase => ({
      name: `compression of ${path}: ${encoding ?? 'none'}`,
      runtimes: ['node'],
      path,
      headers: signedIn,
      large: true,
      encoding,
      status: 200,
      reaches,
    }),
  ),
];

/** The checks every case gets: its status and error, who it reached, the headers of every /api answer. */
export async function expectGatewayCase(c: GatewayCase, gateway: GatewayUnderTest, res: Response): Promise<void> {
  expect(res.status).toBe(c.status);
  // §7.1: every /api answer, the gateway's own and the clients', carries no-store and the security headers.
  expect(res.headers.get('Cache-Control')).toBe('no-store');
  expect(res.headers.get('X-Frame-Options')).toBe('DENY');
  expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'self'");
  for (const [name, value] of Object.entries(c.responseHeaders ?? {})) expect(res.headers.get(name), name).toBe(value);
  const encoding = res.headers.get('Content-Encoding');
  if (c.encoding !== undefined) expect(encoding).toBe(c.encoding);
  const text = await new Response(encoding === 'gzip' ? res.body!.pipeThrough(new DecompressionStream('gzip')) : res.body).text();
  if (c.error) expect(JSON.parse(text)).toEqual({ error: c.error });
  if (c.answer) expect(JSON.parse(text)).toMatchObject(c.answer);
  if (c.reaches === 'none') {
    expect(gateway.calls).toEqual([]);
  } else {
    expect(gateway.calls).toHaveLength(1);
    const [call] = gateway.calls;
    if (c.reaches === 'directory') expect(call!.to).toBe('directory');
    else expect({ to: call!.to, spaceId: call!.spaceId, path: call!.path }).toEqual({ to: 'space', ...c.reaches });
    expect(JSON.parse(text)).toEqual(c.large ? LARGE_BODY : { ok: true });
  }
  c.check?.(gateway);
}
