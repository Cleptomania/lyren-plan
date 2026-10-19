// The child process of validationBounds.test.ts: a Node server opened as the test harness opens it (an
// in-memory directory and spaces, a temporary DATA_DIR), whose owner sends the hostile requests named on the
// command line (support/hostileBodies.ts) and which prints one JSON line for each: its status, error and wall
// time. The test runs it with a capped V8 heap, so a request whose validation outgrows that heap ends the
// process (V8's fatal "heap limit" error), however much memory earlier requests used. Run with tsx
// (tsxNode.ts) from the repository root.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CSRF_HEADER } from '@shared/constants';
import type { AuthStatusDTO } from '@shared/types';
import { loadConfig } from '../../src/config';
import { openNodeStack } from '../../src/runtime/node/stack';
import { applySetCookies, OWNER_EMAIL, PASSWORD } from './directoryHarness';
import { formBytes } from './archive';
import { HOSTILE_REQUESTS, hostileBody, type HostileCase } from './hostileBodies';
import { createRecordingTransport } from './mail';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyren-bounds-'));
const loaded = loadConfig({
  dbPath: ':memory:',
  dataDir,
  webDir: null,
  cookieSecure: false,
  logRequests: false,
  setupToken: null,
});
const config = { ...loaded, directory: { ...loaded.directory, passwordScryptP: 1 } };
const stack = openNodeStack(config, { mode: 'maintenance', mail: createRecordingTransport(), onSetupCode: () => {} });
const jar = new Map<string, string>();

async function request(method: string, p: string, body?: string | Uint8Array | FormData, contentType = 'application/json') {
  const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
  const headers: Record<string, string> = { [CSRF_HEADER]: '1', Cookie: cookie };
  // A form goes as its multipart bytes, as a browser sends it.
  if (body instanceof FormData) ({ body, contentType } = await formBytes(body));
  if (body !== undefined) headers['Content-Type'] = contentType;
  const res = await stack.app.request(p, { method, headers, body });
  applySetCookies(jar, res.headers.getSetCookie());
  return { status: res.status, json: (await res.json()) as any };
}

try {
  const setupCode = stack.service.ensureSetupCode()?.code;
  const owner = { email: OWNER_EMAIL, password: PASSWORD, displayName: 'Owner', setupCode };
  const setup = await request('POST', '/api/auth/setup', JSON.stringify(owner));
  if (setup.status !== 201) throw new Error(`setup failed: ${setup.status}`);
  const spaceId = ((await request('GET', '/api/auth/status')).json as AuthStatusDTO).spaces[0]!.id;
  for (const name of process.argv.slice(2) as HostileCase[]) {
    // Every import counts on the owner's 10 an hour (im, Appendix D 62): each case starts afresh.
    stack.directoryDb.run("DELETE FROM auth_throttle WHERE substr(key, 1, 3) = 'im:'");
    const { body, contentType } = hostileBody(HOSTILE_REQUESTS[name]);
    const started = performance.now();
    const res = await request('POST', `/api/s/${spaceId}${HOSTILE_REQUESTS[name].path}`, body, contentType);
    const ms = Math.round(performance.now() - started);
    console.log(JSON.stringify({ name, status: res.status, error: res.json?.error ?? null, ms }));
  }
} finally {
  stack.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
