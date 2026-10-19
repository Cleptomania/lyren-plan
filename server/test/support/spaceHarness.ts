// Test harness for one space alone (design §14.3): createSpaceHost over an in-memory NodeDb space (the
// portability checks are on under vitest), initialized by initSpaceDb, with a fake SpaceDirectoryPort
// (accounts, members and roles, sessions by token hash, the space's name, status and syncVersion, and a
// call log), fakes for the safety point, the read snapshot and the import gate, and clients that send
// requests through host.serve(request, meta) as the gateway does. Paths are written as the space app
// sees them ('/api/tags'); the client sends them as '/api/s/<id>/tags'. After each test the space's fold
// columns are checked (support/folds.ts).

import { CSRF_HEADER } from '@shared/constants';
import type { SpaceRole } from '@shared/roles';
import { parseAppConfig, type SpaceAppConfig } from '../../src/core/config';
import { randomToken, sha256Hex } from '../../src/core/crypto';
import type { BindValue, Db, RunResult, SqlParams } from '../../src/core/db';
import { isDeferringForeignKeys } from '../../src/core/migrate';
import type {
  ImportCandidateDTO,
  ImportReservation,
  SpaceAuthResult,
  SpaceDirectoryPort,
  SpaceSyncPayload,
  TrustedMeta,
} from '../../src/core/ports';
import type { RuntimeInfo } from '../../src/core/runtime';
import type { Deps } from '../../src/env';
import { unavailable } from '../../src/http/errors';
import { NodeDb } from '../../src/runtime/node/nodeDb';
import { createSpaceHost, type SpaceHostOptions } from '../../src/space/host';
import { initSpaceDb } from '../../src/space/init';
import type { SafetyPoint, SpaceSafety } from '../../src/space/safety';
import { createWriteState } from '../../src/space/writeState';
import { formBytes } from './archive';
import { fakeClock, testMeta, type FakeClock } from './directoryHarness';
import { checkFoldsAfterTest } from './folds';

export const SPACE_ID = '7k2m9q4w8x1c3v5b';
export const OTHER_SPACE_ID = '0123456789abcdef';
export const OWNER_ID = 1;

const HOUR_MS = 3_600_000;

// ---------------------------------------------------------------------------
// Fake directory
// ---------------------------------------------------------------------------

export interface FakeAccount {
  id: number;
  displayName: string;
  email: string | null;
  disabled?: boolean;
}

export interface FakeSession {
  userId: number;
  sessionId: number;
  /** ISO time of the last credential proof (SpaceIdentity.reauthAt). */
  reauthAt: string;
  /** ms epoch (SpaceAuthResult.cacheUntil). */
  expiresAt: number;
}

export interface DirectoryCall {
  op: keyof SpaceDirectoryPort;
  input: unknown;
}

/**
 * The directory as a space host sees it. Changes bump the space's syncVersion as the real directory's
 * do (§3.5): memberships, roles, profiles, deletions, the space's name and status.
 */
export class FakeDirectoryPort implements SpaceDirectoryPort {
  readonly calls: DirectoryCall[] = [];
  readonly accounts = new Map<number, FakeAccount>();
  readonly members = new Map<number, SpaceRole>();
  /** Sessions by token hash. */
  readonly sessions = new Map<string, FakeSession>();
  readonly space: { id: string; name: string; status: 'importing' | 'active'; syncVersion: number; deleted: boolean };
  /** When set, spaceSync answers this instead of the state above. */
  syncPayload: SpaceSyncPayload | null | undefined = undefined;
  /** When set, authorizeSpace waits for it (single-flight tests). */
  authorizeHold: Promise<void> | null = null;
  /** What reserveImport answers for a commit's rows (default: nothing reserved, no daily budget, as on Node). */
  rowsReservation: ImportReservation = { ok: true, reservationId: null, dailyLeft: null };
  /** When set, spaceSync reads the state and then waits for it before it answers (a sync in flight). */
  syncHold: Promise<void> | null = null;
  /** When set, the next calls of that operation throw it. */
  readonly failures: Partial<Record<keyof SpaceDirectoryPort, Error>> = {};
  private nextSessionId = 1;

  constructor(
    private readonly clock: FakeClock,
    spaceId: string,
    name: string,
  ) {
    this.space = { id: spaceId, name, status: 'active', syncVersion: 1, deleted: false };
  }

  /** Calls of one operation. */
  count(op: keyof SpaceDirectoryPort): number {
    return this.calls.filter((c) => c.op === op).length;
  }

  bump(): void {
    this.space.syncVersion += 1;
  }

  addAccount(account: FakeAccount): void {
    this.accounts.set(account.id, { ...account });
  }

  /** A new session of `userId`; returns its token (the cookie value). */
  signIn(userId: number, o: { reauthAt?: string; expiresAt?: number } = {}): string {
    const token = randomToken();
    this.sessions.set(sha256Hex(token), {
      userId,
      sessionId: this.nextSessionId++,
      reauthAt: o.reauthAt ?? new Date(this.clock.now()).toISOString(),
      expiresAt: o.expiresAt ?? this.clock.now() + 30 * 24 * HOUR_MS,
    });
    return token;
  }

  /** Move the session's re-auth time (default: now). */
  reauth(token: string, at = new Date(this.clock.now()).toISOString()): void {
    const session = this.sessions.get(sha256Hex(token));
    if (!session) throw new Error('unknown session');
    session.reauthAt = at;
  }

  signOut(token: string): void {
    this.sessions.delete(sha256Hex(token));
  }

  setRole(userId: number, role: SpaceRole): void {
    this.members.set(userId, role);
    this.bump();
  }

  removeMember(userId: number): void {
    this.members.delete(userId);
    this.bump();
  }

  updateAccount(userId: number, change: Partial<Omit<FakeAccount, 'id'>>): void {
    const account = this.accounts.get(userId);
    if (!account) throw new Error(`no account ${userId}`);
    Object.assign(account, change);
    this.bump();
  }

  /** The account and its sessions and membership are gone (account deletion bumps every listed space). */
  deleteAccount(userId: number): void {
    this.accounts.delete(userId);
    this.members.delete(userId);
    for (const [hash, session] of this.sessions) if (session.userId === userId) this.sessions.delete(hash);
    this.bump();
  }

  private record(op: keyof SpaceDirectoryPort, input: unknown): void {
    this.calls.push({ op, input });
    const err = this.failures[op];
    if (err) throw err;
  }

  async authorizeSpace(input: Parameters<SpaceDirectoryPort['authorizeSpace']>[0]): Promise<SpaceAuthResult> {
    this.record('authorizeSpace', input);
    if (this.authorizeHold) await this.authorizeHold;
    const session = this.sessions.get(input.tokenHash);
    const account = session && this.accounts.get(session.userId);
    if (!session || !account || account.disabled || session.expiresAt <= this.clock.now()) {
      return { ok: false, reason: 'unauthenticated' };
    }
    const role = this.members.get(account.id);
    if (input.spaceId !== this.space.id || this.space.deleted || role === undefined) return { ok: false, reason: 'not_found' };
    return {
      ok: true,
      identity: {
        userId: account.id,
        displayName: account.displayName,
        email: account.email,
        role,
        instanceAdmin: false,
        sessionId: session.sessionId,
        reauthAt: session.reauthAt,
        space: { id: this.space.id, name: this.space.name, status: this.space.status, syncVersion: this.space.syncVersion },
      },
      cacheUntil: session.expiresAt,
    };
  }

  async spaceSync(input: { spaceId: string; mirrorUserIds: number[] }): Promise<SpaceSyncPayload | null> {
    this.record('spaceSync', input);
    const payload = this.syncAnswer(input);
    if (this.syncHold) await this.syncHold;
    return payload;
  }

  private syncAnswer(input: { spaceId: string; mirrorUserIds: number[] }): SpaceSyncPayload | null {
    if (this.syncPayload !== undefined) return this.syncPayload;
    if (input.spaceId !== this.space.id || this.space.deleted) return null;
    const members = [...this.members.keys()]
      .sort((a, b) => a - b)
      .map((id) => {
        const account = this.accounts.get(id)!;
        return { userId: id, displayName: account.displayName, email: account.email };
      });
    const others = [...new Set(input.mirrorUserIds)]
      .filter((id) => !this.members.has(id))
      .map((userId) => {
        const account = this.accounts.get(userId);
        return account ? { userId, displayName: account.displayName } : { userId, deleted: true as const };
      });
    const { name, status, syncVersion } = this.space;
    return { name, status, syncVersion, members, others };
  }

  /** The importer and the space's other members, as the real directory answers a non-admin (§8.5). */
  async importCandidates(input: { spaceId: string; userId: number; emailKeys: string[] }): Promise<ImportCandidateDTO[]> {
    this.record('importCandidates', input);
    return [...this.members.keys()]
      .map((id) => this.accounts.get(id)!)
      .filter((account) => !account.disabled)
      .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.id - b.id)
      .map((a) => ({ userId: a.id, displayName: a.displayName, email: a.email, isYou: a.id === input.userId }));
  }

  async reserveImport(input: {
    spaceId: string;
    userId: number;
    step: 'start' | 'rows';
    rowWrites: number;
  }): Promise<ImportReservation> {
    this.record('reserveImport', input);
    return input.step === 'rows' ? this.rowsReservation : { ok: true, reservationId: null, dailyLeft: null };
  }

  async refundImport(input: { reservationId: string; spentRows?: number }): Promise<void> {
    this.record('refundImport', input);
  }

  async importCommitted(input: {
    spaceId: string;
    userId: number;
    mode: 'new' | 'replace';
    mappedUserIds: number[];
  }): Promise<void> {
    this.record('importCommitted', input);
    this.space.status = 'active';
    this.bump();
  }
}

// ---------------------------------------------------------------------------
// Other fakes
// ---------------------------------------------------------------------------

/** Records beforeReplace calls; answers `point` (default a file under backups/spaces/<id>/) or throws `fail`. */
export class FakeSafety implements SpaceSafety {
  calls = 0;
  fail: Error | null = null;

  constructor(public point: SafetyPoint | null) {}

  async beforeReplace(): Promise<SafetyPoint | null> {
    this.calls += 1;
    if (this.fail) throw this.fail;
    return this.point;
  }
}

/** Node's import gate: one run at a time, a second one is refused at once (503), as spaceStore's. */
export class FakeImportGate {
  runs = 0;
  busy = false;

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.busy) throw unavailable('Another import is running. Try again in a minute.');
    this.busy = true;
    this.runs += 1;
    try {
      return await fn();
    } finally {
      this.busy = false;
    }
  }
}

/**
 * A Db with a fake meter, as DoDb bills: rows returned count as read, run()'s changes as written (tests
 * can also move `meter` themselves).
 */
export class MeteredDb implements Db {
  readonly kind = 'node' as const;
  readonly meter = { rowsRead: 0, rowsWritten: 0 };

  constructor(readonly inner: NodeDb) {}

  all<T = Record<string, unknown>>(sql: string, params?: SqlParams): T[] {
    const rows = this.inner.all<T>(sql, params);
    this.meter.rowsRead += rows.length;
    return rows;
  }

  get<T = Record<string, unknown>>(sql: string, params?: SqlParams): T | undefined {
    const row = this.inner.get<T>(sql, params);
    if (row !== undefined) this.meter.rowsRead += 1;
    return row;
  }

  run(sql: string, params?: SqlParams): RunResult {
    // withDeferredForeignKeys(this) sets its pragma through this wrapper, which the database's own check cannot see.
    if (isDeferringForeignKeys(this) && /^PRAGMA defer_foreign_keys = (?:ON|OFF)$/.test(sql)) {
      this.inner.raw.exec(sql);
      return { changes: 0, lastInsertRowid: 0 };
    }
    const result = this.inner.run(sql, params);
    this.meter.rowsWritten += result.changes;
    return result;
  }

  exec(sql: string): void {
    this.inner.exec(sql);
  }

  tx<T>(fn: () => T): T {
    return this.inner.tx(fn);
  }

  get inTransaction(): boolean {
    return this.inner.inTransaction;
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface SpaceTestResponse<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

export type RequestBody = unknown;

export interface SpaceTestClient {
  /** The session cookie's value; null = no session (the gateway would answer 401). */
  token: string | null;
  request<T = any>(method: string, path: string, body?: RequestBody, headers?: Record<string, string>): Promise<SpaceTestResponse<T>>;
  /** The request as `request` sends it (a FormData as its multipart bytes), the Response unread (the archive). */
  raw(method: string, path: string, body?: RequestBody, headers?: Record<string, string>): Promise<Response>;
  get<T = any>(path: string, headers?: Record<string, string>): Promise<SpaceTestResponse<T>>;
  head(path: string, headers?: Record<string, string>): Promise<SpaceTestResponse<null>>;
  post<T = any>(path: string, body?: RequestBody, headers?: Record<string, string>): Promise<SpaceTestResponse<T>>;
  patch<T = any>(path: string, body?: RequestBody): Promise<SpaceTestResponse<T>>;
  delete<T = any>(path: string, body?: RequestBody): Promise<SpaceTestResponse<T>>;
}

/** A request body as fetch takes it: strings, bytes and streams as they are, anything else as JSON. */
function encodeBody(body: RequestBody): { body: RequestInit['body']; json: boolean } {
  if (body === undefined) return { body: undefined, json: false };
  if (typeof body === 'string' || body instanceof Uint8Array || body instanceof ReadableStream) {
    return { body: body as RequestInit['body'], json: false };
  }
  return { body: JSON.stringify(body), json: true };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

export interface SpaceHarnessOptions {
  spaceId?: string;
  name?: string;
  /** 0 (the default) as on Node; > 0 as on Cloudflare. */
  authCacheTtlMs?: number;
  /** Overrides of the parsed Node SpaceAppConfig. */
  config?: Partial<SpaceAppConfig>;
  clock?: FakeClock;
  /** Use a MeteredDb (DoDb-like billing) instead of the plain NodeDb. */
  meter?: boolean;
  storageBytes?: () => number;
  /** Default: a FakeSafety with a file point. */
  safety?: FakeSafety;
  runtime?: RuntimeInfo['kind'];
  /** The space app to serve (SpaceHostOptions.app); tests pass a spy. */
  app?: SpaceHostOptions['app'];
  /** Create sample data in init (authored by the owner). */
  sampleData?: boolean;
}

export type SpaceHarness = ReturnType<typeof createSpaceHarness>;

export function createSpaceHarness(options: SpaceHarnessOptions = {}) {
  const spaceId = options.spaceId ?? SPACE_ID;
  const name = options.name ?? 'Test space';
  const clock = options.clock ?? fakeClock(Date.now());
  const config: SpaceAppConfig = { ...parseAppConfig({}, 'node').space, ...options.config };
  const raw = new NodeDb(':memory:');
  const db: Db = options.meter ? new MeteredDb(raw) : raw;
  const owner = { userId: OWNER_ID, displayName: 'Owner', email: 'owner@example.com' };
  initSpaceDb(db, { spaceId, name, owner, syncVersion: 1, sampleData: options.sampleData ? {} : null });
  checkFoldsAfterTest(db);

  const directory = new FakeDirectoryPort(clock, spaceId, name);
  directory.addAccount({ id: OWNER_ID, displayName: owner.displayName, email: owner.email });
  directory.members.set(OWNER_ID, 'owner');
  const safetyPath = `backups/spaces/${spaceId}/pre-import-test.db`;
  const safety = options.safety ?? new FakeSafety({ kind: 'file', path: safetyPath, restoreCommand: `restore "${safetyPath}"` });
  const importGate = new FakeImportGate();
  const snapshots = { calls: 0 };
  const runtimeKind = options.runtime ?? 'node';
  const writeState = createWriteState(db, { dailyRowWrites: config.spaceDailyRowWrites, clock });
  const deps: Deps = {
    db,
    config,
    space: {
      id: spaceId,
      directory,
      safety,
      runtime: { kind: runtimeKind, capabilities: { backupDownload: false, fileSnapshots: runtimeKind === 'node' } },
      readSnapshot: async (fn) => {
        snapshots.calls += 1;
        return fn(db);
      },
      writeState,
      importGate,
      storageBytes: options.storageBytes,
      clock,
    },
  };
  const host = createSpaceHost({ deps, authCacheTtlMs: options.authCacheTtlMs ?? 0, app: options.app });

  /** What the gateway hands the host for a request with this session token. */
  function meta(token: string | null, o: Partial<TrustedMeta> = {}): TrustedMeta {
    return testMeta({
      sessionTokenHash: token === null ? null : sha256Hex(token),
      sessionCookie: token === null ? null : 'plain',
      ...o,
    });
  }

  /** '/api/tags' → '/api/s/<id>/tags'; paths under /api/s/ are sent as they are. */
  const spacePath = (path: string) => (path.startsWith('/api/s/') ? path : `/api/s/${spaceId}${path.replace(/^\/api/, '')}`);

  function client(token: string | null): SpaceTestClient {
    const c: SpaceTestClient = {
      token,
      async raw(method, path, body, headers = {}) {
        const h: Record<string, string> = { [CSRF_HEADER]: '1', ...headers };
        // A form (an import's file) as the multipart bytes a browser sends.
        if (body instanceof FormData) ({ body, contentType: h['Content-Type'] } = await formBytes(body));
        const encoded = encodeBody(body);
        if (encoded.json) h['Content-Type'] = 'application/json';
        const init: RequestInit & { duplex?: 'half' } = { method, headers: h, body: encoded.body };
        if (encoded.body instanceof ReadableStream) init.duplex = 'half';
        const request = new Request(`http://127.0.0.1:19620${spacePath(path)}`, init);
        return host.serve(request, meta(c.token));
      },
      async request(method, path, body, headers = {}) {
        const res = await c.raw(method, path, body, headers);
        const text = await res.text();
        let parsed: unknown = text;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          // not JSON
        }
        return { status: res.status, body: parsed as any, headers: res.headers };
      },
      get: (path, headers) => c.request('GET', path, undefined, headers),
      head: (path, headers) => c.request('HEAD', path, undefined, headers),
      post: (path, body, headers) => c.request('POST', path, body ?? {}, headers),
      patch: (path, body) => c.request('PATCH', path, body ?? {}),
      delete: (path, body) => c.request('DELETE', path, body),
    };
    return c;
  }

  let nextUserId = OWNER_ID + 1;

  /** Another account, a member with `role` (default member), signed in. */
  function addUser(o: { displayName?: string; email?: string | null; role?: SpaceRole; id?: number } = {}) {
    const userId = o.id ?? nextUserId++;
    const displayName = o.displayName ?? `User ${userId}`;
    directory.addAccount({ id: userId, displayName, email: o.email === undefined ? `user${userId}@example.com` : o.email });
    directory.setRole(userId, o.role ?? 'member');
    const token = directory.signIn(userId);
    return { userId, token, client: client(token) };
  }

  /** `rows` row writes billed during a write request, counted as the gate counts them (needs `meter`). */
  function spendBudget(rows: number): void {
    if (!db.meter) throw new Error('spendBudget needs a harness with meter: true');
    const since = db.meter.rowsWritten;
    db.meter.rowsWritten += rows;
    writeState.bump(since);
  }

  const ownerToken = directory.signIn(OWNER_ID);

  return {
    spaceId,
    clock,
    config,
    /** The Db the space uses (the MeteredDb when `meter`). */
    db,
    /** The NodeDb under it. */
    raw,
    directory,
    safety,
    importGate,
    snapshots,
    writeState,
    deps,
    host,
    meta,
    spacePath,
    client,
    addUser,
    spendBudget,
    owner: { userId: OWNER_ID, token: ownerToken, client: client(ownerToken) },
  };
}

/** A mirror row as SELECT * returns it, for assertions. */
export function mirrorRows(db: Db): Array<Record<string, BindValue>> {
  return db.all('SELECT id, kind, display_name, email, is_member, deleted FROM users ORDER BY id');
}
