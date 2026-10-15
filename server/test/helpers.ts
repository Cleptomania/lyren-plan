// Test harness: in-memory database + app, and a tiny API client that adds the
// CSRF header and session cookie automatically.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CSRF_HEADER } from '@shared/constants';
import type { UserDTO } from '@shared/types';
import { createApp } from '../src/app';
import { loadConfig, type Config } from '../src/config';
import { openDb, type Db } from '../src/db';
import { ensureDefaults } from '../src/db/seed';

export interface TestResponse<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

export interface TestClient {
  cookie: string | null;
  request<T = any>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<TestResponse<T>>;
  get<T = any>(path: string): Promise<TestResponse<T>>;
  post<T = any>(path: string, body?: unknown): Promise<TestResponse<T>>;
  patch<T = any>(path: string, body?: unknown): Promise<TestResponse<T>>;
  put<T = any>(path: string, body?: unknown): Promise<TestResponse<T>>;
  delete<T = any>(path: string): Promise<TestResponse<T>>;
}

/** Fresh in-memory database + app. `overrides` adjust the Config (e.g. { trustProxy: true }). */
export function createTestContext(overrides: Partial<Config> = {}) {
  const db: Db = openDb(':memory:');
  ensureDefaults(db);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyren-test-'));
  const config = loadConfig({
    dbPath: ':memory:',
    dataDir,
    webDir: null,
    cookieSecure: false,
    logRequests: false,
    setupToken: null,
    ...overrides,
  });
  const app = createApp({ db, config });

  function client(cookie: string | null = null): TestClient {
    const c: TestClient = {
      cookie,
      async request(method, path, body, headers = {}) {
        const h: Record<string, string> = { [CSRF_HEADER]: '1', ...headers };
        if (body !== undefined) h['Content-Type'] = 'application/json';
        if (c.cookie) h['Cookie'] = c.cookie;
        const res = await app.request(path, {
          method,
          headers: h,
          body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
        });
        const setCookie = res.headers.get('set-cookie');
        if (setCookie) {
          const first = setCookie.split(';')[0]!;
          c.cookie = /=$/.test(first) || /Max-Age=0/i.test(setCookie) ? null : first;
        }
        const text = await res.text();
        let parsed: unknown = text;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          /* non-JSON */
        }
        return { status: res.status, body: parsed as any, headers: res.headers };
      },
      get: (path) => c.request('GET', path),
      post: (path, body) => c.request('POST', path, body ?? {}),
      patch: (path, body) => c.request('PATCH', path, body ?? {}),
      put: (path, body) => c.request('PUT', path, body ?? {}),
      delete: (path) => c.request('DELETE', path),
    };
    return c;
  }

  /** Complete first-run setup and return a signed-in client. */
  async function signedIn(opts: { username?: string; password?: string; createSampleData?: boolean; setupCode?: string } = {}) {
    const c = client();
    const res = await c.post<{ user: UserDTO }>('/api/auth/setup', {
      username: opts.username ?? 'owner',
      password: opts.password ?? 'correct horse battery',
      displayName: 'Owner',
      createSampleData: opts.createSampleData ?? false,
      setupCode: opts.setupCode ?? config.setupToken ?? undefined,
    });
    if (res.status !== 201) throw new Error(`setup failed: ${res.status} ${JSON.stringify(res.body)}`);
    return { client: c, user: res.body.user };
  }

  return { db, config, app, client, signedIn };
}
