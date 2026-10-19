// How the web client learns that the single-file desktop app serves it (runtime/node/desktop.ts), so the
// sign-in page and Administration → Overview show the app's commands; and the reset-password line (cli.ts
// lockoutAdvice). The Node build's and Docker's responses must not carry the desktop fields.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { AuthStatusDTO, BootstrapDTO } from '@shared/types';
import { lockoutAdvice } from '../src/cli';
import { loadConfig } from '../src/config';
import { desktopData, separateDbPath, type DesktopDeps } from '../src/runtime/node/desktop';
import { openNodeStack } from '../src/runtime/node/stack';
import { createTestContext } from './helpers';
import { directoryWithOwner, ownerPasswordHash } from './support/directoryFile';
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

/** The keys of the responses without the desktop app, in their order (§7.2, §7.3). */
const STATUS_KEYS = [
  'setupRequired',
  'setupCodeRequired',
  'user',
  'version',
  'instance',
  'spaces',
  'preferences',
  'reauthUntil',
  'notices',
  'legacySpaceId',
];
const BOOTSTRAP_KEYS = ['user', 'space', 'people', 'settings', 'version', 'statuses', 'tags', 'projects', 'milestones', 'epics', 'boards'];

const SETUP = { email: 'owner@example.com', password: 'correct horse battery', displayName: 'Owner', createSampleData: false };

const configFor = (dataDir: string, dbPath = path.join(dataDir, 'lyren.db')) =>
  loadConfig({ dataDir, dbPath, webDir: null, cookieSecure: false, logRequests: false, setupToken: null });

/**
 * A server like the desktop app's (NodeStackOptions.desktop) on in-memory databases, and a cookie-keeping
 * client. The folders it reports are its Config's, read for each response: those of a desktop app with
 * this data folder and DB_PATH, which are never opened.
 */
function desktopApp(desktop: DesktopDeps, dataDir: string, dbPath = path.join(dataDir, 'lyren.db')) {
  const ctx = createTestContext({ desktop });
  Object.assign(ctx.config, { dataDir, dbPath });
  let client = ctx.client();
  async function call(method: string, url: string, body?: unknown) {
    const res = await client.request(method, url, body);
    return { status: res.status, text: JSON.stringify(res.body), body: res.body };
  }
  /** First-run setup (ctx.signedIn: it throws unless it succeeds); later calls are signed in. */
  async function setup() {
    client = (await ctx.signedIn(SETUP)).client;
  }
  return { call, setup, ctx };
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

  // §7.3, Appendix D 25: the folders moved from bootstrap to the auth status (desktopData), which only
  // instance admins get.
  it('signed in: the data folder and the program folder, for instance admins only', async () => {
    const { call, setup, ctx } = desktopApp(WIN, WIN.defaultDataDir);
    await setup();
    const status = await call('GET', '/api/auth/status');
    expect(Object.keys(status.body)).toEqual([...STATUS_KEYS, 'desktop', 'desktopData']);
    expect(status.body.desktop).toEqual({ exe: 'lyren-plan-0.1.0-win-x64.exe', windows: true });
    expect(status.body.desktopData).toEqual({
      exe: 'lyren-plan-0.1.0-win-x64.exe',
      windows: true,
      dataDir: WIN.defaultDataDir,
      dbPath: null,
      customDataDir: false,
      exeFolder: WIN.exeFolder,
    });
    const boot = await call('GET', '/api/bootstrap');
    expect(Object.keys(boot.body)).toEqual(BOOTSTRAP_KEYS);
    expect(JSON.stringify(boot.body)).not.toContain('dana');
    // Another member of the space sees the program's name only.
    const { client: member } = await ctx.addUser({ email: 'member@example.com' });
    const theirs = await member.get<AuthStatusDTO>('/api/auth/status');
    expect(Object.keys(theirs.body)).toEqual([...STATUS_KEYS, 'desktop']);
    expect(JSON.stringify(theirs.body)).not.toContain('dana');
  });

  it('a data folder of its own (--data-dir) and DB_PATH are reported', async () => {
    const own = desktopApp(WIN, '/media/usb/Lyren');
    await own.setup();
    expect((await own.call('GET', '/api/auth/status')).body.desktopData).toMatchObject({ dataDir: '/media/usb/Lyren', customDataDir: true });
    // Windows compares folders without case.
    const sameFolder = desktopApp(WIN, path.join(HOME, 'appdata', 'local', 'lyren plan'));
    await sameFolder.setup();
    expect((await sameFolder.call('GET', '/api/auth/status')).body.desktopData.customDataDir).toBe(false);
    const linux = desktopApp({ ...WIN, windows: false }, path.join(HOME, 'appdata', 'local', 'lyren plan'), '/srv/db/plan.db');
    await linux.setup();
    expect((await linux.call('GET', '/api/auth/status')).body.desktopData).toMatchObject({
      windows: false,
      customDataDir: true,
      dbPath: '/srv/db/plan.db',
    });
  });

  it('tray and terminal mode: stopMode tells the client how Lyren Plan is stopped; still no path signed out', async () => {
    const tray: DesktopDeps = { ...WIN, stopMode: 'tray' };
    const { call, setup } = desktopApp(tray, WIN.defaultDataDir);
    const anon = await call('GET', '/api/auth/status');
    expect(Object.keys(anon.body)).toEqual([...STATUS_KEYS, 'desktop']);
    expect(anon.body.desktop).toEqual({ exe: 'lyren-plan-0.1.0-win-x64.exe', windows: true, stopMode: 'tray' });
    expect(anon.text).not.toContain('dana');
    await setup();
    const signedIn = await call('GET', '/api/auth/status');
    expect(signedIn.body.desktopData).toMatchObject({ stopMode: 'tray', dataDir: WIN.defaultDataDir });
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

// §9.6: reset-password clears the lock-outs itself (in the directory's throttle rows), so neither the
// server nor the desktop app needs a restart or a wait, and the last line is the same for both.
describe('reset-password: how to lift a lock-out', () => {
  it('the command lifts it itself, for the server and the desktop app alike', () => {
    expect(lockoutAdvice()).toBe('Any lock-out from failed sign-ins has been cleared.');
    expect(lockoutAdvice()).not.toContain('restart');
  });

  /** A data folder whose directory holds one account from before the upgrade, `owner` (§14.3). */
  async function dataDirWithOwner() {
    const dataDir = path.join(tmp('lyren-guide-cli-'), 'data');
    await directoryWithOwner(path.join(dataDir, 'lyren.db'));
    return dataDir;
  }

  it.each([
    ['server/src/index.ts', 'Any lock-out from failed sign-ins has been cleared.'],
    ['server/src/sea.ts', 'Any lock-out from failed sign-ins has been cleared.'],
  ])('%s reset-password ends with the lock-out line', async (entry, ending) => {
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
    const hashOf = ownerPasswordHash;
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

describe('the desktop app\'s maintenance commands (§9.7)', () => {
  /** The desktop app from source (sea.ts) with this data folder. */
  function desktop(dataDir: string, args: string[]) {
    const [cmd, argv] = tsxCommand('server/src/sea.ts', args);
    const res = spawnSync(cmd, argv, { cwd: ROOT, input: '', env: tsxEnv({ ...process.env, DATA_DIR: dataDir, DB_PATH: '' }), encoding: 'utf8', timeout: 60_000 });
    return { status: res.status, stdout: res.stdout, stderr: res.stderr };
  }

  it('restore stages a backup and says to start the app again; promote-admin, policy and spaces work as in the Node build', async () => {
    const dataDir = path.join(tmp('lyren-desktop-cmds-'), 'data');
    await directoryWithOwner(path.join(dataDir, 'lyren.db'));
    const backupFile = path.join(path.dirname(dataDir), 'lyren-2026-10-17.tar');
    const written = desktop(dataDir, ['backup', backupFile]);
    expect(written.status, written.stderr).toBe(0);
    expect(desktop(dataDir, ['spaces']).stdout.trim()).toBe('No spaces yet.');
    expect(desktop(dataDir, ['policy']).stdout.trim()).toBe('Sign-up policy: invite_only (accounts are created through invitations only).');
    expect(desktop(dataDir, ['promote-admin', 'owner']).stdout.trim()).toBe('owner is already an instance admin.');
    const res = desktop(dataDir, ['restore', backupFile]);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout.trim().split('\n')).toEqual([
      `Staged the restore of the backup set made ${JSON.parse(fs.readFileSync(path.join(dataDir, '.restore-pending', 'READY'), 'utf8')).manifest.createdAt} (0 spaces) from ${backupFile}.`,
      'Quit Lyren Plan and start it again to complete the restore.',
    ]);
  }, 120_000);
});

describe('--lan: copied links name the address other devices can open (§9.7)', () => {
  it('the LAN origins become shareOrigins while PUBLIC_URL is unset; PUBLIC_URL wins', async () => {
    const config = loadConfig({ dataDir: tmp('lyren-lan-'), dbPath: ':memory:', webDir: null, cookieSecure: false, logRequests: false, setupToken: null });
    const lan = ['http://192.168.1.20:43770'];
    const stack = openNodeStack(config, { mode: 'maintenance', lanUrls: () => lan });
    try {
      const status = (await (await stack.app.request('/api/auth/status')).json()) as AuthStatusDTO;
      expect(status.instance.shareOrigins).toEqual(lan);
    } finally {
      stack.close();
    }
    const withUrl = openNodeStack({ ...config, publicUrl: 'https://plan.example.com' }, { mode: 'maintenance', lanUrls: () => lan });
    try {
      const status = (await (await withUrl.app.request('/api/auth/status')).json()) as AuthStatusDTO;
      expect(status.instance.shareOrigins).toEqual(['https://plan.example.com']);
    } finally {
      withUrl.close();
    }
  });
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
