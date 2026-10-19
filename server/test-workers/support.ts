// What the workers tests that go through the real Worker share (design §14.5): a client that sends
// requests to https://plan.example.com with SELF.fetch (the Worker's fetch handler, Durable Objects and
// all) and keeps one cookie per name, first-run setup, and accounts added straight into the directory's
// storage, since invitations and signup arrive with later phases.

import { runInDurableObject, SELF } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { CSRF_HEADER } from '@shared/constants';
import type { SpaceRole } from '@shared/roles';
import type { AuthStatusDTO, UserDTO } from '@shared/types';
import { randomToken } from '../src/core/crypto';
import { normalizeEmail } from '../src/core/email';
import { systemClock } from '../src/core/runtime';
import { addMember } from '../src/directory/members';
import { PasswordHasher } from '../src/directory/passwords';
import { findSpace } from '../src/directory/spaces';
import { DIRECTORY_NAME } from '../src/runtime/cloudflare/clients';
import { DoDb } from '../src/runtime/cloudflare/doDb';

export const ORIGIN = 'https://plan.example.com';
export const PASSWORD = 'correct horse battery';
export const OWNER_EMAIL = 'owner@example.com';

export interface WorkerResponse<T = any> {
  status: number;
  headers: Headers;
  body: T;
}

/** A browser: cookies by name, the CSRF header on writes, its address in CF-Connecting-IP. */
export class WorkerClient {
  readonly jar = new Map<string, string>();

  constructor(public ip = '192.0.2.10') {}

  cookieHeader(): string {
    return [...this.jar].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  async request<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<WorkerResponse<T>> {
    const res = await this.raw(method, path, body, headers);
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // Not JSON (the SPA's index.html).
    }
    return { status: res.status, headers: res.headers, body: parsed as T };
  }

  /** The request as `request` sends it (a form, an import's, as it is; anything else as JSON), its Response unread. */
  async raw(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
    const sent: Record<string, string> = { 'CF-Connecting-IP': this.ip };
    if (this.jar.size > 0) sent.Cookie = this.cookieHeader();
    const form = body instanceof FormData;
    if (body !== undefined && !form) sent['Content-Type'] = 'application/json';
    if (method !== 'GET' && method !== 'HEAD') sent[CSRF_HEADER] = '1';
    const res = await SELF.fetch(`${ORIGIN}${path}`, {
      method,
      headers: { ...sent, ...headers },
      body: body === undefined ? undefined : form ? body : JSON.stringify(body),
    });
    for (const cookie of res.headers.getSetCookie()) {
      const [pair = ''] = cookie.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq);
      if (/Max-Age=0/i.test(cookie)) this.jar.delete(name);
      else this.jar.set(name, pair.slice(eq + 1));
    }
    return res;
  }

  get<T = any>(path: string, headers?: Record<string, string>) {
    return this.request<T>('GET', path, undefined, headers);
  }

  post<T = any>(path: string, body?: unknown) {
    return this.request<T>('POST', path, body);
  }

  patch<T = any>(path: string, body: unknown) {
    return this.request<T>('PATCH', path, body);
  }

  delete<T = any>(path: string, body?: unknown) {
    return this.request<T>('DELETE', path, body);
  }
}

/** First-run setup with SETUP_TOKEN (wrangler.test.jsonc); the owner's client and default space. */
export async function setupOwner(): Promise<{ client: WorkerClient; user: UserDTO; spaceId: string }> {
  const client = new WorkerClient();
  const res = await client.post<{ user: UserDTO }>('/api/auth/setup', {
    email: OWNER_EMAIL,
    password: PASSWORD,
    displayName: 'Owner',
    setupCode: 'test',
  });
  if (res.status !== 201) throw new Error(`setup failed: ${res.status} ${JSON.stringify(res.body)}`);
  const status = await client.get<AuthStatusDTO>('/api/auth/status');
  return { client, user: res.body.user, spaceId: status.body.spaces[0]!.id };
}

/** Runs `fn` on the directory's database, inside the DirectoryDO. */
export function inDirectory<T>(fn: (db: DoDb) => T | Promise<T>): Promise<T> {
  return runInDurableObject(env.DIRECTORY.getByName(DIRECTORY_NAME), (_instance, state) => fn(new DoDb(state.storage)));
}

const hasher = new PasswordHasher({ target: { kdf: 'scrypt', scryptP: 1 }, clock: systemClock });

/** Another account, a member of `spaceId` with `role` when given, signed in through POST /api/auth/login. */
export async function addAccount(o: {
  email: string;
  displayName?: string;
  role?: SpaceRole;
  spaceId?: string;
  ip?: string;
}): Promise<{ client: WorkerClient; user: UserDTO }> {
  const email = normalizeEmail(o.email);
  if (!email.ok) throw new Error(`invalid test address ${o.email}`);
  const hash = await hasher.hash(PASSWORD);
  await inDirectory((db) => {
    const now = new Date().toISOString();
    const { id } = db.get<{ id: number }>(
      `INSERT INTO users (email, email_key, display_name, password_hash, password_changed_at, webauthn_user_id, created_at, updated_at)
       VALUES (:email, :key, :name, :hash, :now, :handle, :now, :now) RETURNING id`,
      { email: email.address, key: email.key, name: o.displayName ?? o.email.split('@')[0], hash, now, handle: randomToken(32) },
    )!;
    if (o.spaceId) {
      const space = findSpace(db, o.spaceId);
      if (!space) throw new Error(`no space ${o.spaceId}`);
      addMember(db, { spaceId: space.id, userId: id, role: o.role ?? 'member', addedBy: null, nowMs: Date.now() });
    }
  });
  const client = new WorkerClient(o.ip);
  const res = await client.post<{ user: UserDTO }>('/api/auth/login', { identifier: o.email, password: PASSWORD });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { client, user: res.body.user };
}

/** Polls `check` until it returns true, for at most `ms`; returns how long it took. */
export async function within(ms: number, check: () => Promise<boolean>): Promise<number> {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > ms) throw new Error(`not within ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return Date.now() - started;
}
