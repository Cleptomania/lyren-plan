// First-run setup through the whole Node stack (design §5.8.1, §5.8.17, §14.3): a running stack whose last
// account disappeared (its users row deleted by hand) asks for a setup code again, prints the new one,
// and takes it. Covered elsewhere, and not repeated here: the last account cannot be deleted
// (server/test/directory/account.test.ts, "DELETE /api/account (§5.8.17)": "the last account can never be
// deleted: 409 last_admin"), and the same 403 on the directory app alone (server/test/directory/auth.test.ts,
// "POST /api/auth/setup": "with the users row removed under a running app, setup without a code answers 403
// and a new code is printed").

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CSRF_HEADER } from '@shared/constants';
import { loadConfig } from '../src/config';
import { openNodeStack } from '../src/runtime/node/stack';

afterEach(() => {
  vi.restoreAllMocks();
});

const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { [CSRF_HEADER]: '1', 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('setup under a running stack', () => {
  it('with the users row removed, setup without a code answers 403, and the code it prints then works', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyren-setup-'));
    const stack = openNodeStack(loadConfig({ dataDir, dbPath: ':memory:', webDir: null, setupToken: null, logRequests: false }), {
      mode: 'maintenance',
    });
    const printed: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void printed.push(a.join(' ')));
    try {
      const account = { email: 'owner@example.com', password: 'correct horse battery', displayName: 'Owner', createSampleData: false };
      const first = stack.service.ensureSetupCode()!.code;
      expect((await stack.app.request('/api/auth/setup', post({ ...account, setupCode: first }))).status).toBe(201);
      expect(stack.service.ensureSetupCode()).toBeNull();
      stack.directoryDb.run('DELETE FROM users');
      const refused = await stack.app.request('/api/auth/setup', post(account));
      expect(refused.status).toBe(403);
      const lines = printed.filter((l) => /^ {2}Setup code: [0-9a-f]{12}$/.test(l));
      expect(lines).toHaveLength(1);
      const code = lines[0]!.trim().slice('Setup code: '.length);
      expect(code).not.toBe(first);
      expect((await stack.app.request('/api/auth/setup', post({ ...account, setupCode: code }))).status).toBe(201);
    } finally {
      stack.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
