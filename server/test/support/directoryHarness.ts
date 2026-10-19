// Test harness for the directory app alone (design §14.3): createDirectoryApp on an in-memory NodeDb
// migrated with DIRECTORY (the portability checks are on under vitest), a fake SpaceAdminClient that
// records its calls, a recording mail transport, a fake clock, and clients that send requests with
// app.fetch(request, { meta }) and keep one cookie per name (Headers#getSetCookie(), since a secure
// response sets two). A request body may be a stream (support/heldBody.ts), sent as it is.

import { randomUUID } from 'node:crypto';
import { CSRF_HEADER } from '@shared/constants';
import type { SpaceRole } from '@shared/roles';
import type { AuthStatusDTO, UserDTO } from '@shared/types';
import { parseAppConfig, type ConfigVars, type DirectoryConfig } from '../../src/core/config';
import { randomToken } from '../../src/core/crypto';
import type { Db } from '../../src/core/db';
import { normalizeEmail } from '../../src/core/email';
import { migrate } from '../../src/core/migrate';
import type { SpaceAdminClient, SpaceInit, TrustedMeta } from '../../src/core/ports';
import type { Clock, RuntimeInfo } from '../../src/core/runtime';
import { APP_VERSION } from '../../src/core/version';
import { createDirectoryApp, type DirectoryDeps } from '../../src/directory/app';
import { addMember } from '../../src/directory/members';
import { PasswordHasher } from '../../src/directory/passwords';
import { DIRECTORY_MIGRATIONS } from '../../src/directory/schema';
import { findSpace } from '../../src/directory/spaces';
import type { MailTransport } from '../../src/mail/transport';
import { NodeDb } from '../../src/runtime/node/nodeDb';
import { createRecordingTransport } from './mail';

export const PASSWORD = 'correct horse battery';
export const OWNER_EMAIL = 'owner@example.com';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

export interface FakeClock extends Clock {
  set(ms: number): void;
  advance(ms: number): void;
  /** DirectoryDeps.sleep: records the wait and moves the clock instead of waiting. */
  sleep(ms: number): Promise<void>;
  readonly sleeps: number[];
}

export function fakeClock(start = Date.parse('2026-10-17T12:00:00.000Z')): FakeClock {
  let now = start;
  const sleeps: number[] = [];
  return {
    now: () => now,
    set: (ms) => {
      now = ms;
    },
    advance: (ms) => {
      now += ms;
    },
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    sleeps,
  };
}

export interface SpaceAdminCall {
  op: 'init' | 'invalidate' | 'destroy' | 'stats';
  spaceId: string;
  init?: SpaceInit;
}

/** A SpaceAdminClient that only records what the directory asked of it. */
export class FakeSpaceAdmin implements SpaceAdminClient {
  readonly calls: SpaceAdminCall[] = [];
  /** Spaces that were initialized and not destroyed. */
  readonly spaces = new Map<string, SpaceInit>();
  /** Make the next init calls fail. */
  failInit = false;
  failDestroy = false;
  /** When set, destroy waits for it (after recording the call). */
  destroyHold: Promise<void> | null = null;

  async init(init: SpaceInit): Promise<void> {
    this.calls.push({ op: 'init', spaceId: init.spaceId, init });
    if (this.failInit) throw new Error('init failed (test)');
    this.spaces.set(init.spaceId, init);
  }

  async invalidate(spaceId: string): Promise<void> {
    this.calls.push({ op: 'invalidate', spaceId });
  }

  async destroy(spaceId: string): Promise<void> {
    this.calls.push({ op: 'destroy', spaceId });
    if (this.destroyHold) await this.destroyHold;
    if (this.failDestroy) throw new Error('destroy failed (test)');
    this.spaces.delete(spaceId);
  }

  async stats(spaceId: string): Promise<{ bytes: number; tasks: number } | null> {
    this.calls.push({ op: 'stats', spaceId });
    return this.spaces.has(spaceId) ? { bytes: 4096, tasks: 0 } : null;
  }

  /** The ids of the calls of one kind, in order. */
  ids(op: SpaceAdminCall['op']): string[] {
    return this.calls.filter((c) => c.op === op).map((c) => c.spaceId);
  }
}

/** A TrustedMeta as the gateway builds it for a directory request. */
export function testMeta(o: Partial<TrustedMeta> = {}): TrustedMeta {
  return {
    clientIp: '192.0.2.10',
    secure: false,
    requestId: randomUUID(),
    userAgent: 'vitest',
    sessionTokenHash: null,
    sessionCookie: null,
    ...o,
  };
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

/** Insert an account with a password (no default space, no session); returns its id. */
export async function insertAccount(
  db: Db,
  hasher: PasswordHasher,
  o: { email: string; displayName?: string; password?: string; isInstanceAdmin?: boolean },
  nowMs: number,
): Promise<number> {
  const email = normalizeEmail(o.email);
  if (!email.ok) throw new Error(`invalid test address ${o.email}`);
  const now = new Date(nowMs).toISOString();
  const hash = await hasher.hash(o.password ?? PASSWORD);
  return db.get<{ id: number }>(
    `INSERT INTO users (email, email_key, display_name, password_hash, password_changed_at, webauthn_user_id,
       is_instance_admin, created_at, updated_at)
     VALUES (:email, :key, :name, :hash, :now, :handle, :admin, :now, :now) RETURNING id`,
    { email: email.address, key: email.key, name: o.displayName ?? o.email.split('@')[0], hash, now, handle: randomToken(32), admin: o.isInstanceAdmin ?? false },
  )!.id;
}

/** Make `userId` a member of the space with public id `spaceId` (bumps its sync_version, §3.5). */
export function addMembership(db: Db, o: { spaceId: string; userId: number; role: SpaceRole; nowMs: number }): void {
  const space = findSpace(db, o.spaceId);
  if (!space) throw new Error(`no space ${o.spaceId}`);
  addMember(db, { spaceId: space.id, userId: o.userId, role: o.role, addedBy: null, nowMs: o.nowMs });
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface TestResponse<T = any> {
  status: number;
  body: T;
  headers: Headers;
  /** The response's Set-Cookie values. */
  setCookies: string[];
}

export interface DirectoryTestClient {
  /** Cookies by name (one value each, as a browser keeps them). */
  readonly jar: Map<string, string>;
  readonly secure: boolean;
  ip: string;
  cookieHeader(): string;
  request<T = any>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<TestResponse<T>>;
  get<T = any>(path: string): Promise<TestResponse<T>>;
  head(path: string): Promise<TestResponse<null>>;
  post<T = any>(path: string, body?: unknown): Promise<TestResponse<T>>;
  patch<T = any>(path: string, body?: unknown): Promise<TestResponse<T>>;
  delete<T = any>(path: string, body?: unknown): Promise<TestResponse<T>>;
}

export interface ClientOptions {
  /** HTTPS (meta.secure; cookies get the __Host- names). Default false. */
  secure?: boolean;
  ip?: string;
  userAgent?: string;
}

/** Apply Set-Cookie values to a jar: an empty value or Max-Age=0 removes the cookie. */
export function applySetCookies(jar: Map<string, string>, values: string[]): void {
  for (const value of values) {
    const [pair = '', ...attributes] = value.split(';');
    const eq = pair.indexOf('=');
    const name = pair.slice(0, eq).trim();
    const cookie = pair.slice(eq + 1).trim();
    const expired = attributes.some((a) => /^\s*max-age=0\s*$/i.test(a));
    if (cookie === '' || expired) jar.delete(name);
    else jar.set(name, cookie);
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

export interface DirectoryHarnessOptions {
  /** Environment variables for parseAppConfig (then `config` on top). */
  vars?: ConfigVars;
  /** Overrides of the parsed DirectoryConfig (shallow; quotas merge). Default passwordScryptP 1, for speed. */
  config?: Partial<Omit<DirectoryConfig, 'quotas'>> & { quotas?: Partial<DirectoryConfig['quotas']> };
  runtime?: RuntimeInfo['kind'];
  capabilities?: Partial<RuntimeInfo['capabilities']>;
  clock?: FakeClock;
  /** Default: a recording transport that delivers mail. */
  mail?: MailTransport;
  backup?: DirectoryDeps['backup'];
  spaceBytes?: DirectoryDeps['spaceBytes'];
  desktop?: DirectoryDeps['desktop'];
  shareOrigins?: string[];
  /** Reuse a directory database (a "restart": the app's memory is gone, the rows stay). */
  db?: NodeDb;
  spaces?: FakeSpaceAdmin;
}

export type DirectoryHarness = ReturnType<typeof createDirectoryHarness>;

export function createDirectoryHarness(options: DirectoryHarnessOptions = {}) {
  const runtimeKind = options.runtime ?? 'node';
  const parsed = parseAppConfig(options.vars ?? {}, runtimeKind).directory;
  const config: DirectoryConfig = {
    ...parsed,
    passwordScryptP: 1,
    ...options.config,
    quotas: { ...parsed.quotas, ...options.config?.quotas },
  };
  const db = options.db ?? new NodeDb(':memory:');
  if (!options.db) migrate(db, DIRECTORY_MIGRATIONS, { appVersion: APP_VERSION });
  const clock = options.clock ?? fakeClock();
  const spaces = options.spaces ?? new FakeSpaceAdmin();
  const recording = createRecordingTransport();
  const mail = options.mail ?? recording;
  const deferred: Array<Promise<unknown>> = [];
  const setupCodes: string[] = [];
  const runtime: RuntimeInfo = {
    kind: runtimeKind,
    capabilities: { backupDownload: runtimeKind === 'node', fileSnapshots: runtimeKind === 'node', ...options.capabilities },
  };
  const deps: DirectoryDeps = {
    db,
    config,
    spaces,
    mail,
    defer: (task) => {
      deferred.push(task.catch((err) => console.error('[test] deferred task failed:', err)));
    },
    clock,
    runtime,
    backup: options.backup,
    spaceBytes: options.spaceBytes,
    desktop: options.desktop,
    shareOrigins: () => options.shareOrigins ?? [],
    onSetupCode: (code) => {
      setupCodes.push(code);
    },
    sleep: clock.sleep,
  };
  const { app, service, ctx } = createDirectoryApp(deps);

  function client(o: ClientOptions = {}): DirectoryTestClient {
    const secure = o.secure ?? false;
    const origin = secure ? 'https://plan.example.com' : 'http://127.0.0.1:19610';
    const jar = new Map<string, string>();
    const c: DirectoryTestClient = {
      jar,
      secure,
      ip: o.ip ?? '192.0.2.10',
      cookieHeader: () => [...jar].map(([name, value]) => `${name}=${value}`).join('; '),
      async request(method, path, body, headers = {}) {
        const h: Record<string, string> = { [CSRF_HEADER]: '1', ...headers };
        if (body !== undefined) h['Content-Type'] = 'application/json';
        if (jar.size > 0) h.Cookie = c.cookieHeader();
        const init: RequestInit & { duplex?: 'half' } = { method, headers: h };
        if (body instanceof ReadableStream) {
          init.body = body;
          init.duplex = 'half';
        } else if (body !== undefined) {
          init.body = typeof body === 'string' ? body : JSON.stringify(body);
        }
        const request = new Request(`${origin}${path}`, init);
        const meta = testMeta({ clientIp: c.ip, secure, userAgent: o.userAgent ?? 'vitest' });
        const res = await app.fetch(request, { meta });
        const setCookies = res.headers.getSetCookie();
        applySetCookies(jar, setCookies);
        const text = await res.text();
        let parsedBody: unknown = text;
        try {
          parsedBody = text ? JSON.parse(text) : null;
        } catch {
          // not JSON
        }
        return { status: res.status, body: parsedBody as any, headers: res.headers, setCookies };
      },
      get: (path) => c.request('GET', path),
      head: (path) => c.request('HEAD', path),
      post: (path, body) => c.request('POST', path, body ?? {}),
      patch: (path, body) => c.request('PATCH', path, body ?? {}),
      delete: (path, body) => c.request('DELETE', path, body),
    };
    return c;
  }

  /** Wait for everything handed to defer (pushes, mail) so far. */
  async function settle(): Promise<void> {
    while (deferred.length > 0) await Promise.all(deferred.splice(0));
  }

  /** First-run setup as the instance admin; returns the signed-in client and the default space. */
  async function setup(o: { email?: string; password?: string; displayName?: string; createSampleData?: boolean } & ClientOptions = {}) {
    const c = client(o);
    const res = await c.post<{ user: UserDTO }>('/api/auth/setup', {
      email: o.email ?? OWNER_EMAIL,
      password: o.password ?? PASSWORD,
      displayName: o.displayName ?? 'Owner',
      createSampleData: o.createSampleData ?? false,
      setupCode: config.setupCodeDisabled ? undefined : service.ensureSetupCode()?.code,
    });
    if (res.status !== 201) throw new Error(`setup failed: ${res.status} ${JSON.stringify(res.body)}`);
    const status = await c.get<AuthStatusDTO>('/api/auth/status');
    return { client: c, user: res.body.user, spaceId: status.body.spaces[0]!.id };
  }

  const hasher = new PasswordHasher({ target: { kdf: config.passwordKdf, scryptP: config.passwordScryptP }, clock });

  /**
   * Another account (no default space), a member of `spaceId` with `role` when given, signed in through
   * POST /api/auth/login.
   */
  async function addUser(
    o: { email: string; displayName?: string; password?: string; role?: SpaceRole; spaceId?: string; isInstanceAdmin?: boolean } & ClientOptions,
  ) {
    const id = await insertAccount(db, hasher, o, clock.now());
    if (o.spaceId) addMembership(db, { spaceId: o.spaceId, userId: id, role: o.role ?? 'member', nowMs: clock.now() });
    const c = client(o);
    const res = await c.post<{ user: UserDTO }>('/api/auth/login', { identifier: o.email, password: o.password ?? PASSWORD });
    if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
    return { client: c, user: res.body.user };
  }

  /** The same database and clock with a new app: what a restart (or an evicted object) keeps. */
  function restart(o: Omit<DirectoryHarnessOptions, 'db' | 'clock'> = {}) {
    return createDirectoryHarness({ ...options, ...o, db, clock, spaces });
  }

  return {
    db,
    config,
    deps,
    app,
    service,
    /** What the directory's routes share, for calling its services directly. */
    ctx,
    clock,
    spaces,
    outbox: recording.outbox,
    /** The recording transport (make it fail or wait); unused when `mail` was given. */
    recording,
    setupCodes,
    meta: testMeta,
    client,
    settle,
    setup,
    addUser,
    restart,
  };
}
