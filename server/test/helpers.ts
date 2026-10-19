// Test harness for the whole Node server (design §14.3): openNodeStack on an in-memory directory and
// in-memory spaces, with a temporary DATA_DIR (snapshots and backups land there), a recording mail
// transport, and a tiny API client that adds the CSRF header, keeps one cookie per name (a secure
// response sets two, and every sign-in sets the device cookie) and rewrites today's unprefixed space
// paths to the signed-in owner's space: '/api/tasks' is sent as '/api/s/<spaceId>/tasks'.
//
// After each test every space's fold columns, tag lists and task counts are checked (assertFoldsConsistent,
// §3.4; assertTagListsConsistent, Appendix D 42; assertTaskCountsConsistent, Appendix D 46), then every stack
// the test opened is closed and its temporary folder removed.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';
import { CSRF_HEADER, SESSION_COOKIE, SESSION_COOKIE_SECURE } from '@shared/constants';
import type { SpaceRole } from '@shared/roles';
import type { AuthStatusDTO, UserDTO } from '@shared/types';
import { loadConfig, type Config } from '../src/config';
import type { Clock } from '../src/core/runtime';
import { PasswordHasher } from '../src/directory/passwords';
import type { MailMessage } from '../src/mail/transport';
import type { DesktopDeps } from '../src/runtime/node/desktop';
import type { NodeDb } from '../src/runtime/node/nodeDb';
import { openNodeStack, type NodeStack } from '../src/runtime/node/stack';
import { addMembership, applySetCookies, insertAccount, OWNER_EMAIL, PASSWORD } from './support/directoryHarness';
import { assertFoldsConsistent, assertTagListsConsistent, assertTaskCountsConsistent } from './support/folds';
import { formBytes } from './support/archive';
import { createRecordingTransport } from './support/mail';

export interface TestResponse<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

export interface TestClient {
  /** Cookies by name (one value each, as a browser keeps them). */
  readonly jar: Map<string, string>;
  /** The session cookie as a Cookie pair ('lyren_session=…'), or null when signed out. */
  readonly cookie: string | null;
  /** Every cookie in the jar, as a Cookie header. */
  cookieHeader(): string;
  request<T = any>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<TestResponse<T>>;
  /** The request as `request` sends it (a FormData or bytes body as it is), its Response unread (the archive). */
  raw(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Response>;
  get<T = any>(path: string): Promise<TestResponse<T>>;
  post<T = any>(path: string, body?: unknown): Promise<TestResponse<T>>;
  patch<T = any>(path: string, body?: unknown): Promise<TestResponse<T>>;
  put<T = any>(path: string, body?: unknown): Promise<TestResponse<T>>;
  delete<T = any>(path: string): Promise<TestResponse<T>>;
}

export interface TestContextOptions {
  /** Config overrides (e.g. { trustProxy: true }); the flat fields reach the apps' sub-configs. */
  config?: Partial<Config>;
  clock?: Clock;
  /** Serve as the desktop app does (NodeStackOptions.desktop). */
  desktop?: DesktopDeps;
  /** 'configured': the transport MAIL_TRANSPORT names, as the server builds it (default: the recording transport). */
  mail?: 'configured';
}

export type TestContext = ReturnType<typeof createTestContext>;

/** A valid space id that names no space: unprefixed paths go there before signedIn(). */
export const NO_SPACE_ID = '0000000000000000';

// The first path segments of the space endpoints (§14.3): the test client puts them under /api/s/<id>/, so
// tests keep today's paths.
const SPACE_SEGMENTS: ReadonlySet<string> = new Set(
  'bootstrap projects milestones epics tasks comments worklogs activity boards tags statuses settings data dashboard search people'.split(' '),
);

/** '/api/tasks?x=1' → '/api/s/<spaceId>/tasks?x=1'; directory paths and paths under /api/s/ stay as they are. */
export function spacePath(spaceId: string, p: string): string {
  const segment = /^\/api\/([^/?#]+)/.exec(p)?.[1];
  return segment !== undefined && SPACE_SEGMENTS.has(segment) ? `/api/s/${spaceId}${p.slice('/api'.length)}` : p;
}

/** Stacks opened by the running test, closed after it (with their temporary folders). */
const opened: Array<{ stack: NodeStack; dataDir: string }> = [];

/** The fold and tag-list checks of every space of every stack the running test opened (after each test). */
export function checkOpenedStacks(): void {
  for (const { stack } of opened) {
    for (const spaceId of stack.spaces.list()) {
      const db = stack.spaces.database(spaceId);
      if (db) {
        assertFoldsConsistent(db);
        assertTagListsConsistent(db);
        assertTaskCountsConsistent(db);
      }
    }
  }
}

afterEach(() => {
  try {
    checkOpenedStacks();
  } finally {
    for (const { stack, dataDir } of opened.splice(0)) {
      stack.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }
});

function isOptions(o: Partial<Config> | TestContextOptions): o is TestContextOptions {
  return 'config' in o || 'clock' in o || 'desktop' in o || 'mail' in o;
}

/** Parse a Cookie header ('a=1; b=2') into a jar. */
function jarOf(cookie: string | null): Map<string, string> {
  const jar = new Map<string, string>();
  for (const pair of (cookie ?? '').split(';')) {
    const eq = pair.indexOf('=');
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  return jar;
}

/**
 * A fresh server: an in-memory directory, in-memory spaces, a temporary DATA_DIR. `options` are
 * Config overrides, or TestContextOptions. The setup code stays required (signedIn() sends it) unless
 * the config disables it; passwords hash with scrypt p = 1, for speed.
 */
export function createTestContext(options: Partial<Config> | TestContextOptions = {}) {
  const { config: overrides = {}, clock, desktop, mail } = isOptions(options) ? options : { config: options };
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyren-test-'));
  const loaded = loadConfig({
    dbPath: ':memory:',
    dataDir,
    webDir: null,
    cookieSecure: false,
    logRequests: false,
    setupToken: null,
    ...overrides,
  });
  const config: Config = overrides.directory ? loaded : { ...loaded, directory: { ...loaded.directory, passwordScryptP: 1 } };
  const recording = createRecordingTransport();
  const setupCodes: string[] = [];
  let stack: NodeStack;
  try {
    stack = openNodeStack(config, {
      mode: 'maintenance',
      // The recording transport delivers mail; a config that names the log transport gets that one.
      mail: mail === 'configured' || overrides.directory?.mail?.transport === 'log' ? undefined : recording,
      clock,
      desktop,
      onSetupCode: (code) => {
        setupCodes.push(code);
      },
    });
  } catch (err) {
    fs.rmSync(dataDir, { recursive: true, force: true });
    throw err;
  }
  opened.push({ stack, dataDir });
  const { app, directoryDb } = stack;
  const now = () => (clock ?? Date).now();
  const hasher = new PasswordHasher({
    target: { kdf: config.directory.passwordKdf, scryptP: config.directory.passwordScryptP },
    clock: { now },
  });

  let ownerSpaceId: string | null = null;
  /** The path a client sends for `p` (spacePath with the owner's space, or NO_SPACE_ID before signedIn()). */
  const rewrite = (p: string) => spacePath(ownerSpaceId ?? NO_SPACE_ID, p);

  function client(cookie: string | null = null): TestClient {
    const jar = jarOf(cookie);
    const c: TestClient = {
      jar,
      get cookie() {
        for (const name of [SESSION_COOKIE_SECURE, SESSION_COOKIE]) {
          const value = jar.get(name);
          if (value !== undefined) return `${name}=${value}`;
        }
        return null;
      },
      cookieHeader: () => [...jar].map(([name, value]) => `${name}=${value}`).join('; '),
      async request(method, p, body, headers = {}) {
        const res = await c.raw(method, p, body, headers);
        const text = await res.text();
        let parsed: unknown = text;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          /* non-JSON */
        }
        return { status: res.status, body: parsed as any, headers: res.headers };
      },
      async raw(method, p, body, headers = {}) {
        const h: Record<string, string> = { [CSRF_HEADER]: '1', ...headers };
        // A form (an import's file) goes as its multipart bytes (undici's own form stream fails when a refusal
        // leaves it unread), bytes as they are; anything else as JSON.
        if (body instanceof FormData) ({ body, contentType: h['Content-Type'] } = await formBytes(body));
        const form = body instanceof Uint8Array || body instanceof ReadableStream;
        if (body !== undefined && !form && h['Content-Type'] === undefined) h['Content-Type'] = 'application/json';
        if (jar.size > 0) h.Cookie = c.cookieHeader();
        const res = await app.request(rewrite(p), {
          method,
          headers: h,
          body: body === undefined ? undefined : form || typeof body === 'string' ? (body as string | Uint8Array) : JSON.stringify(body),
        });
        applySetCookies(jar, res.headers.getSetCookie());
        return res;
      },
      get: (p) => c.request('GET', p),
      post: (p, body) => c.request('POST', p, body ?? {}),
      patch: (p, body) => c.request('PATCH', p, body ?? {}),
      put: (p, body) => c.request('PUT', p, body ?? {}),
      delete: (p) => c.request('DELETE', p),
    };
    return c;
  }

  /** The setup code POST /api/auth/setup needs (undefined when the config disables it). */
  function setupCode(): string | undefined {
    if (config.directory.setupCodeDisabled) return undefined;
    return stack.service.ensureSetupCode()?.code;
  }

  /** Complete first-run setup as the instance admin; returns the signed-in client and the default space. */
  async function signedIn(
    opts: { email?: string; password?: string; displayName?: string; createSampleData?: boolean; setupCode?: string } = {},
  ) {
    const c = client();
    const res = await c.post<{ user: UserDTO }>('/api/auth/setup', {
      email: opts.email ?? OWNER_EMAIL,
      password: opts.password ?? PASSWORD,
      displayName: opts.displayName ?? 'Owner',
      createSampleData: opts.createSampleData ?? false,
      setupCode: opts.setupCode ?? setupCode(),
    });
    if (res.status !== 201) throw new Error(`setup failed: ${res.status} ${JSON.stringify(res.body)}`);
    const status = await c.get<AuthStatusDTO>('/api/auth/status');
    const spaceId = status.body.spaces[0]!.id;
    ownerSpaceId ??= spaceId;
    return { client: c, user: res.body.user, spaceId };
  }

  /**
   * Another account (no default space of its own), a member of `spaceId` (default: the owner's space;
   * null: of none) with `role` (default member), signed in through POST /api/auth/login.
   */
  async function addUser(o: { email: string; displayName?: string; role?: SpaceRole; spaceId?: string | null; password?: string }) {
    const userId = await insertAccount(directoryDb, hasher, o, now());
    const spaceId = o.spaceId === undefined ? ctx.spaceId : o.spaceId;
    if (spaceId !== null) addMembership(directoryDb, { spaceId, userId, role: o.role ?? 'member', nowMs: now() });
    const c = client();
    const res = await c.post<{ user: UserDTO }>('/api/auth/login', { identifier: o.email, password: o.password ?? PASSWORD });
    if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
    return { client: c, user: res.body.user };
  }

  const ctx = {
    stack,
    app,
    config,
    directoryDb,
    /** Mail the recording transport received. */
    outbox: recording.outbox as MailMessage[],
    /** The recording transport (make it fail or wait). */
    recording,
    /** Setup codes the directory announced while serving. */
    setupCodes,
    client,
    /** The path client.request sends for `p`, for requests made with app.request. */
    path: rewrite,
    setupCode,
    signedIn,
    addUser,
    /** The signed-in owner's default space; throws before signedIn(). */
    get spaceId(): string {
      if (ownerSpaceId === null) throw new Error('ctx.spaceId: call signedIn() first');
      return ownerSpaceId;
    },
    /** That space's database (in memory, the same NodeDb for the whole test). */
    get db(): NodeDb {
      const db = stack.spaces.database(ctx.spaceId);
      if (!db) throw new Error(`ctx.db: no space ${ctx.spaceId}`);
      return db;
    },
  };
  return ctx;
}
