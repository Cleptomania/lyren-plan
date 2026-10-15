// How the web client learns that the single-file desktop app serves it (routes/desktop.ts), so the
// sign-in page and Settings → Data show the app's commands; and the reset-password line for each
// audience (cli.ts lockoutAdvice). The Node build's and Docker's responses must not change.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CSRF_HEADER } from '@shared/constants';
import type { AuthStatusDTO, BootstrapDTO } from '@shared/types';
import { createApp } from '../src/app';
import { hashPassword } from '../src/auth/passwords';
import { lockoutAdvice } from '../src/cli';
import { loadConfig } from '../src/config';
import { openDb } from '../src/db';
import { ensureDefaults } from '../src/db/seed';
import type { DesktopDeps } from '../src/env';
import { desktopData, separateDbPath } from '../src/routes/desktop';
import { createTestContext } from './helpers';
import { ROOT, tsxCommand, tsxEnv } from './tsxNode';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
function tmp(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** The keys of the responses before the desktop app existed, in their order. */
const STATUS_KEYS = ['setupRequired', 'setupCodeRequired', 'user', 'version'];
const BOOTSTRAP_KEYS = ['user', 'settings', 'version', 'statuses', 'tags', 'projects', 'milestones', 'epics', 'boards'];

const SETUP = { username: 'owner', password: 'correct horse battery', displayName: 'Owner', createSampleData: false };

const configFor = (dataDir: string, dbPath = path.join(dataDir, 'lyren.db')) =>
  loadConfig({ dataDir, dbPath, webDir: null, cookieSecure: false, logRequests: false, setupToken: null });

/** An app like the desktop app's (Deps.desktop) on an in-memory database, and a cookie-keeping fetch. */
function desktopApp(desktop: DesktopDeps, dataDir: string, dbPath = path.join(dataDir, 'lyren.db')) {
  const db = openDb(':memory:');
  ensureDefaults(db);
  const config = configFor(dataDir, dbPath);
  const app = createApp({ db, config, desktop });
  let cookie: string | null = null;
  async function call(method: string, url: string, body?: unknown) {
    const headers: Record<string, string> = { [CSRF_HEADER]: '1' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (cookie) headers.Cookie = cookie;
    const res = await app.request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0]!;
    const text = await res.text();
    return { status: res.status, text, body: text ? JSON.parse(text) : null };
  }
  return { call, db };
}

describe('Node build and Docker: responses unchanged', () => {
  it('GET /api/auth/status and /api/bootstrap have no desktop field, signed out or in', async () => {
    const ctx = createTestContext();
    const anon = await ctx.client().get<AuthStatusDTO>('/api/auth/status');
    expect(Object.keys(anon.body)).toEqual(STATUS_KEYS);
    const { client } = await ctx.signedIn();
    const status = await client.get<AuthStatusDTO>('/api/auth/status');
    expect(Object.keys(status.body)).toEqual(STATUS_KEYS);
    const boot = await client.get<BootstrapDTO>('/api/bootstrap');
    expect(boot.status).toBe(200);
    expect(Object.keys(boot.body)).toEqual(BOOTSTRAP_KEYS);
  });
});

describe('desktop app: what the client is told', () => {
  // Absolute on this host (C:\home\dana on Windows), as the app's own paths always are.
  const HOME = path.resolve('/home/dana');
  const WIN: DesktopDeps = {
    exe: 'lyren-plan-0.1.0-win-x64.exe',
    exeFolder: path.join(HOME, 'Apps'),
    windows: true,
    defaultDataDir: path.join(HOME, 'AppData', 'Local', 'Lyren Plan'),
  };

  it('signed out: the program name and shell only, no folder', async () => {
    const { call } = desktopApp(WIN, WIN.defaultDataDir);
    const res = await call('GET', '/api/auth/status');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual([...STATUS_KEYS, 'desktop']);
    expect(res.body.desktop).toEqual({ exe: 'lyren-plan-0.1.0-win-x64.exe', windows: true });
    // No path of this computer reaches a signed-out client (the sign-in page is public, also with --lan).
    expect(res.text).not.toContain('dana');
    expect((await call('GET', '/api/bootstrap')).status).toBe(401);
  });

  it('signed in: the data folder and the program folder, in bootstrap only', async () => {
    const { call } = desktopApp(WIN, WIN.defaultDataDir);
    expect((await call('POST', '/api/auth/setup', SETUP)).status).toBe(201);
    const status = await call('GET', '/api/auth/status');
    expect(status.body.desktop).toEqual({ exe: 'lyren-plan-0.1.0-win-x64.exe', windows: true });
    expect(status.text).not.toContain('dana');
    const boot = await call('GET', '/api/bootstrap');
    expect(Object.keys(boot.body)).toEqual([...BOOTSTRAP_KEYS, 'desktop']);
    expect(boot.body.desktop).toEqual({
      exe: 'lyren-plan-0.1.0-win-x64.exe',
      windows: true,
      dataDir: WIN.defaultDataDir,
      dbPath: null,
      customDataDir: false,
      exeFolder: WIN.exeFolder,
    });
  });

  it('a data folder of its own (--data-dir) and DB_PATH are reported', async () => {
    const own = desktopApp(WIN, '/media/usb/Lyren');
    await own.call('POST', '/api/auth/setup', SETUP);
    expect((await own.call('GET', '/api/bootstrap')).body.desktop).toMatchObject({ dataDir: '/media/usb/Lyren', customDataDir: true });
    // Windows compares folders without case.
    const sameFolder = desktopApp(WIN, path.join(HOME, 'appdata', 'local', 'lyren plan'));
    await sameFolder.call('POST', '/api/auth/setup', SETUP);
    expect((await sameFolder.call('GET', '/api/bootstrap')).body.desktop.customDataDir).toBe(false);
    const linux = desktopApp({ ...WIN, windows: false }, path.join(HOME, 'appdata', 'local', 'lyren plan'), '/srv/db/plan.db');
    await linux.call('POST', '/api/auth/setup', SETUP);
    expect((await linux.call('GET', '/api/bootstrap')).body.desktop).toMatchObject({
      windows: false,
      customDataDir: true,
      dbPath: '/srv/db/plan.db',
    });
  });

  it('tray and terminal mode: stopMode tells the client how Lyren Plan is stopped; still no path signed out', async () => {
    const tray: DesktopDeps = { ...WIN, stopMode: 'tray' };
    const { call } = desktopApp(tray, WIN.defaultDataDir);
    const anon = await call('GET', '/api/auth/status');
    expect(Object.keys(anon.body)).toEqual([...STATUS_KEYS, 'desktop']);
    expect(anon.body.desktop).toEqual({ exe: 'lyren-plan-0.1.0-win-x64.exe', windows: true, stopMode: 'tray' });
    expect(anon.text).not.toContain('dana');
    await call('POST', '/api/auth/setup', SETUP);
    const boot = await call('GET', '/api/bootstrap');
    expect(boot.body.desktop).toMatchObject({ stopMode: 'tray', dataDir: WIN.defaultDataDir });
    // Read for each response: when the icon fails in terminal mode the field goes away.
    tray.stopMode = 'terminal';
    expect((await call('GET', '/api/auth/status')).body.desktop).toEqual({ exe: 'lyren-plan-0.1.0-win-x64.exe', windows: true, stopMode: 'terminal' });
    delete tray.stopMode;
    const after = await call('GET', '/api/auth/status');
    expect(after.body.desktop).toEqual({ exe: 'lyren-plan-0.1.0-win-x64.exe', windows: true });
    expect(after.text).not.toContain('stopMode');
    // A console window (and Linux): no field, as before.
    const windowed = desktopApp(WIN, WIN.defaultDataDir);
    expect((await windowed.call('GET', '/api/auth/status')).text).not.toContain('stopMode');
  });

  it('DB_PATH: any file but lyren.db in the data folder is reported, also another name in that folder (W6-1)', () => {
    const dataDir = WIN.defaultDataDir;
    const dbPathOf = (dbPath: string, windows = true) => desktopData({ ...WIN, windows }, { ...configFor(dataDir), dbPath }).dbPath;
    expect(dbPathOf(path.join(dataDir, 'lyren.db'))).toBeNull();
    // Same folder, another file: the commands and the restore steps must name it.
    expect(dbPathOf(path.join(dataDir, 'plan.db'))).toBe(path.join(dataDir, 'plan.db'));
    expect(dbPathOf(path.join(dataDir, 'sub', 'lyren.db'))).toBe(path.join(dataDir, 'sub', 'lyren.db'));
    // Windows names are case-insensitive: the same file in other letters is still the usual one.
    expect(dbPathOf(path.join(dataDir.toUpperCase(), 'LYREN.DB'))).toBeNull();
    expect(dbPathOf(path.join(dataDir.toUpperCase(), 'LYREN.DB'), false)).toBe(path.join(dataDir.toUpperCase(), 'LYREN.DB'));
    expect(separateDbPath({ dataDir, dbPath: path.join(dataDir, 'lyren.db') }, true)).toBeNull();
  });
});

describe('reset-password: how to lift a lock-out', () => {
  it('server: restart the server; desktop: close the window and start the app again', () => {
    expect(lockoutAdvice()).toBe('If you were locked out by too many attempts, wait 15 minutes or restart the server.');
    expect(lockoutAdvice('server')).toBe(lockoutAdvice());
    // Windows: the app may run as an icon in the notification area (desktopTray.test.ts).
    const desktop = lockoutAdvice('desktop', 'linux');
    expect(desktop).toBe(
      'If you were locked out by too many attempts, wait 15 minutes, or close the Lyren Plan window and start Lyren Plan again.',
    );
    expect(desktop).not.toContain('server');
  });

  async function dataDirWithOwner() {
    const dataDir = path.join(tmp('lyren-guide-cli-'), 'data');
    const db = openDb(path.join(dataDir, 'lyren.db'));
    const t = new Date().toISOString();
    db.run(
      `INSERT INTO users (username, display_name, password_hash, created_at, updated_at) VALUES ('owner', 'Owner', :h, :t, :t)`,
      { h: await hashPassword('original-password'), t },
    );
    db.close();
    return dataDir;
  }

  it.each([
    ['server/src/index.ts', 'restart the server.'],
    [
      'server/src/sea.ts',
      process.platform === 'win32'
        ? 'choose Quit Lyren Plan from its icon in the notification area, or close its window) and start it again.'
        : 'close the Lyren Plan window and start Lyren Plan again.',
    ],
  ])('%s reset-password ends with its own advice', async (entry, ending) => {
    const dataDir = await dataDirWithOwner();
    const [cmd, args] = tsxCommand(entry, ['reset-password', 'owner']);
    const res = spawnSync(cmd, args, {
      cwd: ROOT,
      input: '',
      env: tsxEnv({ ...process.env, DATA_DIR: dataDir, DB_PATH: '' }),
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toMatch(/^New password for owner: \S+\n/);
    expect(res.stdout.trimEnd().split('\n').at(-1)).toMatch(new RegExp(`${ending.replace(/[.]/g, '\\.')}$`));
  }, 90_000);

  it('desktop: --db-path points the commands at a DB_PATH database, not lyren.db in the data folder (R6REV-1)', async () => {
    // The default data folder holds another database (an older one), as in the review's repro.
    const dataDir = await dataDirWithOwner();
    const other = await dataDirWithOwner();
    const dbFile = path.join(path.dirname(other), 'elsewhere', 'plan.db');
    fs.mkdirSync(path.dirname(dbFile));
    fs.renameSync(path.join(other, 'lyren.db'), dbFile);
    const hashOf = (file: string) => {
      const db = openDb(file);
      try {
        return db.get<{ h: string }>(`SELECT password_hash AS h FROM users WHERE username = 'owner'`)!.h;
      } finally {
        db.close();
      }
    };
    const before = { usual: hashOf(path.join(dataDir, 'lyren.db')), moved: hashOf(dbFile) };
    const run = (args: string[]) => {
      const [cmd, argv] = tsxCommand('server/src/sea.ts', args);
      // A command prompt opened later: no DB_PATH, the data folder is the default one.
      return spawnSync(cmd, argv, { cwd: ROOT, input: '', env: tsxEnv({ ...process.env, DATA_DIR: dataDir, DB_PATH: '' }), encoding: 'utf8', timeout: 60_000 });
    };
    const res = run(['reset-password', 'owner', '--db-path', dbFile]);
    expect(res.status, res.stderr).toBe(0);
    expect(hashOf(dbFile)).not.toBe(before.moved);
    expect(hashOf(path.join(dataDir, 'lyren.db'))).toBe(before.usual);
    // No database there: the hint names both ways to point at one.
    const missing = run(['backup', path.join(path.dirname(other), 'b.db'), '--db-path', path.join(path.dirname(other), 'nope.db')]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('--db-path <file> (or DB_PATH)');
  }, 90_000);
});

describe('the running servers, started from source', () => {
  async function freePort() {
    const probe = net.createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const { port } = probe.address() as net.AddressInfo;
    await new Promise((r) => probe.close(r));
    return port;
  }

  async function statusOf(entry: string, ready: string): Promise<AuthStatusDTO> {
    const dir = tmp('lyren-guide-serve-');
    const port = await freePort();
    const env = tsxEnv({
      ...process.env,
      DATA_DIR: path.join(dir, 'data'),
      WEB_DIR: '',
      OPEN_BROWSER: 'false',
      DB_PATH: '',
      HOST: '127.0.0.1',
      PORT: String(port),
    });
    const [cmd, args] = tsxCommand(entry);
    const child = spawn(cmd, args, { cwd: ROOT, env });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    try {
      const deadline = Date.now() + 30_000;
      while (!out.includes(ready) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      expect(out).toContain(ready);
      return (await (await fetch(`http://127.0.0.1:${port}/api/auth/status`)).json()) as AuthStatusDTO;
    } finally {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    }
  }

  it('the Node server leaves the field out; the desktop app names its program', async () => {
    const node = await statusOf('server/src/index.ts', 'listening on');
    expect(Object.keys(node)).toEqual(STATUS_KEYS);
    const desktop = await statusOf('server/src/sea.ts', 'Keep this window open');
    // From source the program is called lyren-plan (sea.ts); in the executable it is the file's name.
    expect(desktop.desktop).toEqual({ exe: 'lyren-plan', windows: process.platform === 'win32' });
  }, 90_000);
});
