// The single-file desktop app (server/src/desktop, server/src/sea.ts).

import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { SETUP_CODE_FRAGMENT_PARAM } from '@shared/constants';
import { CliExit } from '../src/cli';
import { parseDesktopArgs } from '../src/desktop/args';
import { DamagedAppError, webSourceFromAssets, type AssetManifest } from '../src/desktop/assets';
import { browserCommand, canOpenBrowser } from '../src/desktop/browser';
import { bannerLines, type BannerInfo } from '../src/desktop/console';
import { DESKTOP_PORT, desktopDataDir, desktopDefaults } from '../src/desktop/defaults';
import {
  checkExistingDataFolder,
  icaclsPath,
  MAX_PATH,
  othersWithAccess,
  parseWhoamiSid,
  privateAclArgs,
  privateAclCommand,
  protectNewDataFolder,
  type Run,
} from '../src/desktop/folder';
import { acquireInstanceLock, canonicalDbPath, instancePipeName, instanceProof } from '../src/desktop/instance';
import { candidatePorts, connectProbe, isPortUnavailable, listenOnFirstAvailable, portToRemember } from '../src/desktop/listen';
import { installShutdown, serveDesktop } from '../src/desktop/serve';
import { parseDesktopState, readDesktopState, writeDesktopState } from '../src/desktop/state';
import { appUrl, browserHost, browserTarget, connectHost, lanUrls, setupUrl } from '../src/desktop/urls';
import { envBool, loadConfig, SERVER_DEFAULTS } from '../src/config';
import { commandName, desktopHelp } from '../src/desktop/main';
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

describe('parseDesktopArgs', () => {
  it('defaults to serve and maps options to environment variables', () => {
    expect(parseDesktopArgs([])).toEqual({ command: 'serve', args: [], env: {}, error: null, console: false });
    expect(parseDesktopArgs(['--no-browser', '--lan', '--port', '9000', '--data-dir=D:\\Lyren Data'])).toEqual({
      command: 'serve',
      args: [],
      env: { OPEN_BROWSER: 'false', HOST: '0.0.0.0', PORT: '9000', DATA_DIR: 'D:\\Lyren Data' },
      error: null,
      console: false,
    });
    // --console decides how this start shows itself (mode.ts); it sets no variable.
    expect(parseDesktopArgs(['--console', '--port', '9000'])).toEqual({ command: 'serve', args: [], env: { PORT: '9000' }, error: null, console: true });
    expect(parseDesktopArgs(['stop', '--data-dir', 'D:\\d'])).toMatchObject({ command: 'stop', args: [], env: { DATA_DIR: 'D:\\d' }, error: null });
    expect(parseDesktopArgs(['backup', 'C:\\x\\b.db', '--data-dir', 'D:\\d'])).toMatchObject({
      command: 'backup',
      args: ['C:\\x\\b.db'],
      env: { DATA_DIR: 'D:\\d' },
    });
    expect(parseDesktopArgs(['reset-password', 'owner'])).toMatchObject({ command: 'reset-password', args: ['owner'] });
    // --db-path: what Settings → Data appends when DB_PATH moved the database (R6REV-1).
    expect(parseDesktopArgs(['reset-password', 'owner', '--db-path', 'E:\\db\\plan.db'])).toMatchObject({
      command: 'reset-password',
      args: ['owner'],
      env: { DB_PATH: 'E:\\db\\plan.db' },
      error: null,
    });
    expect(parseDesktopArgs(['--db-path=/srv/plan.db']).env).toEqual({ DB_PATH: '/srv/plan.db' });
  });

  it('help, usage errors and the -- terminator', () => {
    expect(parseDesktopArgs(['--help']).command).toBe('help');
    expect(parseDesktopArgs(['/?']).command).toBe('help');
    expect(parseDesktopArgs(['--port']).error).toMatch(/--port needs a value/);
    expect(parseDesktopArgs(['--port=']).error).toMatch(/--port needs a value/);
    expect(parseDesktopArgs(['--data-dir']).error).toBe('--data-dir needs a value, e.g. --data-dir D:\\Lyren');
    expect(parseDesktopArgs(['--db-path']).error).toBe('--db-path needs a value, e.g. --db-path D:\\Lyren\\plan.db');
    expect(parseDesktopArgs(['--bogus']).error).toBe('Unknown option: --bogus');
    expect(parseDesktopArgs(['reset-password', 'owner', '--', '--weird-password'])).toMatchObject({
      command: 'reset-password',
      args: ['owner', '--weird-password'],
      error: null,
    });
  });
});

describe('desktop defaults', () => {
  it('per-user data folder: %LOCALAPPDATA% on Windows, XDG on Linux', () => {
    expect(desktopDataDir('win32', { LOCALAPPDATA: 'C:\\Users\\ann\\AppData\\Local' }, 'C:\\Users\\ann')).toBe(
      'C:\\Users\\ann\\AppData\\Local\\Lyren Plan',
    );
    expect(desktopDataDir('win32', {}, 'C:\\Users\\ann')).toBe('C:\\Users\\ann\\AppData\\Local\\Lyren Plan');
    expect(desktopDataDir('win32', { LOCALAPPDATA: 'relative' }, 'C:\\Users\\ann')).toBe('C:\\Users\\ann\\AppData\\Local\\Lyren Plan');
    expect(desktopDataDir('linux', {}, '/home/ann')).toBe('/home/ann/.local/share/lyren-plan');
    expect(desktopDataDir('linux', { XDG_DATA_HOME: '/data/ann' }, '/home/ann')).toBe('/data/ann/lyren-plan');
    expect(desktopDataDir('linux', { XDG_DATA_HOME: 'rel' }, '/home/ann')).toBe('/home/ann/.local/share/lyren-plan');
    expect(desktopDataDir('darwin', {}, '/Users/ann')).toBe('/Users/ann/Library/Application Support/Lyren Plan');
  });

  it('private (127.0.0.1) on a fixed port; environment variables still win', () => {
    const d = desktopDefaults('linux', {}, '/home/ann');
    expect(d).toEqual({ host: '127.0.0.1', port: DESKTOP_PORT, dataDir: '/home/ann/.local/share/lyren-plan', webDir: null });
    expect(DESKTOP_PORT).toBeLessThan(49152); // below the ephemeral / Hyper-V reserved range
    expect(DESKTOP_PORT).not.toBe(SERVER_DEFAULTS.port);
    const saved = { ...process.env };
    try {
      for (const k of ['HOST', 'PORT', 'DATA_DIR', 'DB_PATH', 'WEB_DIR']) delete process.env[k];
      const c = loadConfig({}, d);
      // loadConfig resolves the data folder on this host (C:\home\ann\... on Windows).
      expect([c.host, c.port, c.dataDir, c.webDir]).toEqual(['127.0.0.1', DESKTOP_PORT, path.resolve('/home/ann/.local/share/lyren-plan'), null]);
      Object.assign(process.env, { HOST: '0.0.0.0', PORT: '9000', DATA_DIR: '/srv/x', WEB_DIR: '/srv/web' });
      const e = loadConfig({}, d);
      expect([e.host, e.port, e.dataDir, e.webDir]).toEqual(['0.0.0.0', 9000, path.resolve('/srv/x'), '/srv/web']);
      // The Node build's defaults are unchanged.
      for (const k of ['HOST', 'PORT', 'DATA_DIR', 'WEB_DIR']) delete process.env[k];
      const n = loadConfig();
      expect([n.host, n.port, n.dataDir]).toEqual(['0.0.0.0', 8080, path.resolve('data')]);
    } finally {
      process.env = saved;
    }
  });

  it('help explains desktop mode', () => {
    const win = desktopHelp('lyren-plan.exe', 'C:\\Users\\ann\\AppData\\Local\\Lyren Plan', 'win32');
    expect(win).toContain('Double-click lyren-plan.exe to start Lyren Plan.');
    // Windows: the icon in the notification area, Quit, the stop command, a terminal start, the log.
    expect(win).toContain('keeps running without a window, as an icon in\nthe notification area');
    expect(win).toContain('right-click the icon and choose Quit Lyren Plan,\nor run: lyren-plan.exe stop');
    expect(win).toContain('Started in Command Prompt or PowerShell, it shows its messages there (and the icon);\nCtrl+C stops it then.');
    expect(win).toContain('logs\\lyren-plan.log in the data folder (with --db-path: in a logs folder next to the\ndatabase, as <name>.log for a database not named lyren.db).');
    expect(win).toContain('--data-dir or --db-path), as Quit or Ctrl+C would.');
    expect(win).toMatch(/lyren-plan\.exe stop\n +Stop the Lyren Plan that runs with this data folder/);
    expect(win).toMatch(/--console +Run in a console window, without the icon in the notification\n +area, also when started by double-click or from a shortcut\./);
    expect(win).not.toContain('keep that window');
    expect(win).toContain('Data folder   C:\\Users\\ann\\AppData\\Local\\Lyren Plan');
    expect(win).toContain(`http://127.0.0.1:${DESKTOP_PORT}/`);
    expect(win).toMatch(/--lan[\s\S]*firewall/);
    expect(win).toContain('echo new-password| lyren-plan.exe reset-password owner');
    expect(win).toContain('chcp 65001');
    expect(win).toMatch(/--db-path <file> +Use this database file instead of lyren\.db in the data\s+folder\.\s+\[DB_PATH\]/);
    const linux = desktopHelp('lyren-plan', '/home/ann/.local/share/lyren-plan', 'linux');
    expect(linux).toContain('./lyren-plan backup <file>');
    expect(linux).not.toContain('firewall');
    // Linux keeps its console window; only the stop command is new.
    expect(linux).toContain('keeps running in its own window: keep that window\nopen while you use Lyren Plan, and close it (or press Ctrl+C in it) to stop.');
    expect(linux).toContain('./lyren-plan stop\n      Stop the Lyren Plan that runs with this data folder');
    // There is no Quit on Linux.
    expect(linux).toContain('--data-dir or --db-path), as Ctrl+C would.');
    expect(linux).not.toContain('Quit');
    expect(linux).not.toMatch(/--console|notification area/);
  });

  it('help quotes a program name Command Prompt would split (a renamed copy)', () => {
    expect(commandName('lyren-plan-0.1.0-win-x64.exe', 'win32')).toBe('lyren-plan-0.1.0-win-x64.exe');
    expect(commandName('Lyren Plan.exe', 'win32')).toBe('"Lyren Plan.exe"');
    expect(commandName('Lyren&Co.exe', 'win32')).toBe('"Lyren&Co.exe"');
    expect(commandName('lyren-plan', 'linux')).toBe('./lyren-plan');
    expect(commandName('lyren plan', 'linux')).toBe("'./lyren plan'");
    const win = desktopHelp('Lyren Plan.exe', 'C:\\x', 'win32');
    expect(win).toContain('echo new-password| "Lyren Plan.exe" reset-password owner');
    expect(win).toContain('"Lyren Plan.exe" backup <file>');
    expect(win).toContain('Double-click Lyren Plan.exe to start Lyren Plan.');
    // A % in the name: Command Prompt would expand it even in quotes, so the commands are for PowerShell (RCK-1).
    expect(commandName('Lyren 100%PATH%.exe', 'win32')).toBe("& '.\\Lyren 100%PATH%.exe'");
    const pct = desktopHelp('Lyren 100%PATH%.exe', 'C:\\x', 'win32');
    expect(pct).toContain('Usage (in PowerShell: Command Prompt would change the % in the name of the program):');
    expect(pct).toContain("or run in PowerShell: & '.\\Lyren 100%PATH%.exe' stop");
    expect(pct).toContain("& '.\\Lyren 100%PATH%.exe' backup <file>");
    expect(pct).toContain("'new-password' | & '.\\Lyren 100%PATH%.exe' reset-password owner");
    expect(pct).not.toContain('echo new-password|');
  });

  it('help: a command without a window shows its result in a box and ends; from Task Scheduler or a service it only logs (RCK-2, FV-3)', () => {
    const win = desktopHelp('lyren-plan.exe', 'C:\\x', 'win32');
    expect(win).toContain(
      'Started without a window, for example from a shortcut, backup,\nreset-password and stop show their result in a message box and end at once (help:\nin a console window). Started by Task Scheduler or a Windows service they show\nnothing: their output goes to that log file, and the exit code says whether they\nsucceeded.',
    );
    // The log file of a database not named lyren.db (FV-2).
    expect(win).toContain('(with --db-path: in a logs folder next to the\ndatabase, as <name>.log for a database not named lyren.db)');
    expect(desktopHelp('lyren-plan', '/x', 'linux')).not.toContain('Task');
  });

  it('OPEN_BROWSER follows the rule of every boolean variable', () => {
    const saved = process.env.OPEN_BROWSER;
    try {
      for (const [value, expected] of [[undefined, true], ['', true], ['1', true], ['yes', true], ['TRUE', true], ['n', false], ['never', false], ['false', false], ['0', false]] as const) {
        if (value === undefined) delete process.env.OPEN_BROWSER;
        else process.env.OPEN_BROWSER = value;
        expect(envBool('OPEN_BROWSER', true), String(value)).toBe(expected);
      }
    } finally {
      if (saved === undefined) delete process.env.OPEN_BROWSER;
      else process.env.OPEN_BROWSER = saved;
    }
  });
});

describe('addresses', () => {
  it('browser URLs', () => {
    expect(browserHost('0.0.0.0')).toBe('127.0.0.1');
    expect(browserHost('::')).toBe('127.0.0.1');
    expect(browserHost('')).toBe('127.0.0.1');
    expect(browserHost('::1')).toBe('[::1]');
    expect(browserHost('192.168.1.5')).toBe('192.168.1.5');
    expect(appUrl('127.0.0.1', 43770)).toBe('http://127.0.0.1:43770/');
    expect(appUrl('0.0.0.0', 43770)).toBe('http://127.0.0.1:43770/');
  });

  it('what the browser opens: the setup page while no account exists, the code filled in on Windows only', () => {
    const url = 'http://127.0.0.1:43770/';
    expect(browserTarget({ platform: 'win32', url, setupRequired: true, setupCode: 'abc' })).toEqual({
      url: `http://127.0.0.1:43770/setup#${SETUP_CODE_FRAGMENT_PARAM}=abc`,
      codeFilledIn: true,
    });
    // Linux / macOS: every local user can read xdg-open's (and a new browser's) command line.
    for (const platform of ['linux', 'darwin'] as const) {
      expect(browserTarget({ platform, url, setupRequired: true, setupCode: 'abc' })).toEqual({ url: 'http://127.0.0.1:43770/setup', codeFilledIn: false });
    }
    // Once the account exists (e.g. created in the running copy), the app, never a stale setup link.
    expect(browserTarget({ platform: 'win32', url, setupRequired: false, setupCode: 'abc' })).toEqual({ url, codeFilledIn: false });
    expect(browserTarget({ platform: 'win32', url, setupRequired: true, setupCode: null }).url).toBe('http://127.0.0.1:43770/setup');
    expect(connectHost('0.0.0.0')).toBe('127.0.0.1');
    expect(connectHost('::1')).toBe('::1');
    expect(connectHost('192.168.1.5')).toBe('192.168.1.5');
  });

  it('the setup code goes in the fragment, never the query', () => {
    const url = setupUrl('http://127.0.0.1:43770/', 'a1b2 c3&d');
    expect(url).toBe(`http://127.0.0.1:43770/setup#${SETUP_CODE_FRAGMENT_PARAM}=a1b2%20c3%26d`);
    expect(new URL(url).search).toBe('');
  });

  it('LAN addresses only for a wildcard HOST, private IPv4 only', () => {
    const ifaces = {
      lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      eth0: [
        { address: '192.168.1.20', family: 'IPv4', internal: false },
        { address: 'fe80::1', family: 'IPv6', internal: false },
      ],
      wifi: [{ address: '169.254.3.4', family: 4, internal: false }],
    };
    expect(lanUrls('0.0.0.0', 43770, ifaces)).toEqual(['http://192.168.1.20:43770/']);
    expect(lanUrls('127.0.0.1', 43770, ifaces)).toEqual([]);
  });

  it('opens the browser without a shell, rundll32 by absolute path on Windows', () => {
    expect(browserCommand('http://127.0.0.1:43770/setup#code=abc', 'win32', { SystemRoot: 'C:\\Windows' })).toEqual({
      file: 'C:\\Windows\\System32\\rundll32.exe',
      args: ['url.dll,FileProtocolHandler', 'http://127.0.0.1:43770/setup#code=abc'],
    });
    expect(browserCommand('http://127.0.0.1:1/', 'darwin').file).toBe('/usr/bin/open');
    expect(browserCommand('http://127.0.0.1:1/', 'linux')).toEqual({ file: 'xdg-open', args: ['http://127.0.0.1:1/'] });
    // Never anything but a web address (FileProtocolHandler would open files and programs).
    for (const bad of ['file:///C:/Windows/System32/calc.exe', 'C:\\Windows\\System32\\calc.exe', 'javascript:alert(1)']) {
      expect(() => browserCommand(bad, 'win32', {}), bad).toThrow();
    }
    expect(canOpenBrowser('linux', {})).toBe(false);
    expect(canOpenBrowser('linux', { DISPLAY: ':0' })).toBe(true);
    expect(canOpenBrowser('win32', {})).toBe(true);
  });
});

describe('desktop.json', () => {
  it('keeps valid fields only and survives damage', () => {
    expect(parseDesktopState('{"port":43771,"secret":"' + 'a'.repeat(64) + '","setupCode":"x1"}')).toEqual({
      port: 43771,
      secret: 'a'.repeat(64),
      setupCode: 'x1',
    });
    expect(parseDesktopState('{"port":0,"secret":"short","setupCode":""}')).toEqual({});
    expect(parseDesktopState('{"port":"43770"}')).toEqual({});
    expect(parseDesktopState('not json')).toEqual({});
    expect(parseDesktopState('null')).toEqual({});
    const dir = tmp('lyren-state-');
    const file = path.join(dir, 'desktop.json');
    expect(readDesktopState(file)).toEqual({});
    expect(writeDesktopState(file, { port: 43772 })).toBe(true);
    expect(readDesktopState(file)).toEqual({ port: 43772 });
  });
});

describe('port fallback', () => {
  it('candidate ports: explicit only, else remembered, default, and the next ones', () => {
    expect(candidatePorts({ port: 9000, explicit: true, remembered: 43771, span: 10 })).toEqual([9000]);
    expect(candidatePorts({ port: 43770, explicit: false, span: 3 })).toEqual([43770, 43771, 43772]);
    expect(candidatePorts({ port: 43770, explicit: false, remembered: 43771, span: 3 })).toEqual([43771, 43770, 43772]);
    expect(candidatePorts({ port: 65534, explicit: false, span: 5 })).toEqual([65534, 65535]);
    expect(isPortUnavailable({ code: 'EADDRINUSE' })).toBe(true);
    expect(isPortUnavailable({ code: 'EACCES' })).toBe(true); // Windows excluded port ranges
    expect(isPortUnavailable({ code: 'EADDRNOTAVAIL' })).toBe(false);
  });

  it('skips ports in use and reports them', async () => {
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
    const busy = (blocker.address() as net.AddressInfo).port;
    const server = net.createServer();
    try {
      const { port, skipped } = await listenOnFirstAvailable(server, '127.0.0.1', [busy, 0]);
      expect(skipped).toEqual([{ port: busy, code: 'EADDRINUSE' }]);
      expect(port).toBe(0);
      expect((server.address() as net.AddressInfo).port).not.toBe(busy);
      await new Promise((r) => server.close(r));
      await expect(listenOnFirstAvailable(net.createServer(), '127.0.0.1', [busy])).rejects.toMatchObject({ code: 'EADDRINUSE' });
    } finally {
      await new Promise((r) => blocker.close(r));
    }
  });

  it('which port is remembered: a remembered port stays, even when it was taken this time', () => {
    // First start: where it fell back to is remembered.
    expect(portToRemember({ explicit: false, remembered: undefined, used: 43771 })).toEqual({ remember: 43771, usual: null });
    expect(portToRemember({ explicit: false, remembered: 43771, used: 43771 })).toEqual({ remember: 43771, usual: null });
    // Later start, the remembered port taken: run elsewhere this time, keep the usual address.
    expect(portToRemember({ explicit: false, remembered: 43771, used: 43772 })).toEqual({ remember: 43771, usual: 43771 });
    expect(portToRemember({ explicit: false, remembered: 43771, used: 43770 })).toEqual({ remember: 43771, usual: 43771 });
    // --port changes nothing.
    expect(portToRemember({ explicit: true, remembered: 43771, used: 9000 })).toEqual({ remember: 43771, usual: null });
    expect(portToRemember({ explicit: true, remembered: undefined, used: 9000 })).toEqual({ remember: undefined, usual: null });
  });

  it('with a probe (Windows), a port another program answers on counts as in use', async () => {
    // Windows lets 127.0.0.1:P be bound while another program listens on 0.0.0.0:P; the probe
    // (a connection to the browser's address) is what notices. Here it is simulated.
    const taken = new Set([50001]);
    const probe = vi.fn(async (port: number) => taken.has(port));
    const server = net.createServer();
    try {
      const { port, skipped } = await listenOnFirstAvailable(server, '127.0.0.1', [50001, 0], probe);
      expect(port).toBe(0);
      expect(skipped).toEqual([{ port: 50001, code: 'EADDRINUSE' }]);
      expect(probe).toHaveBeenCalledTimes(2);
    } finally {
      await new Promise((r) => server.close(r));
    }
    // An explicit port: refused like a failed listen ("already in use").
    await expect(listenOnFirstAvailable(net.createServer(), '127.0.0.1', [50001], probe)).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });

  it('connectProbe: true when something accepts connections, false when refused', async () => {
    const other = net.createServer((s) => s.destroy());
    await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
    const busy = (other.address() as net.AddressInfo).port;
    await new Promise((r) => other.close(r));
    const listening = net.createServer((s) => s.destroy());
    await new Promise<void>((r) => listening.listen(0, '127.0.0.1', r));
    const used = (listening.address() as net.AddressInfo).port;
    try {
      expect(await connectProbe('127.0.0.1')(used)).toBe(true);
      expect(await connectProbe('127.0.0.1')(busy)).toBe(false);
    } finally {
      await new Promise((r) => listening.close(r));
    }
  });
});

describe('banner', () => {
  const base: BannerInfo = {
    version: '1.2.3',
    url: 'http://127.0.0.1:43770/',
    lanUrls: [],
    lan: false,
    dataDir: 'C:\\Users\\ann\\AppData\\Local\\Lyren Plan',
    dbPath: null,
    setupCode: null,
    setupCodeFilledIn: false,
    browserOpened: true,
    skippedPorts: [],
    usualPort: null,
    warnings: [],
  };

  it('says where it runs, where the data is, and how to stop', () => {
    const text = bannerLines(base).join('\n');
    expect(text).toContain('Lyren Plan 1.2.3 is running.');
    expect(text).toContain('Open it at:      http://127.0.0.1:43770/');
    expect(text).toContain('Data folder:     C:\\Users\\ann\\AppData\\Local\\Lyren Plan');
    expect(text).toContain('Keep this window open while you use Lyren Plan. To stop it, close this window or press Ctrl+C.');
    expect(text).not.toMatch(/Setup code|Other devices|Note: port/);
  });

  it('first start, LAN, fallback port', () => {
    const text = bannerLines({
      ...base,
      url: 'http://127.0.0.1:43771/',
      lan: true,
      lanUrls: ['http://192.168.1.20:43771/'],
      setupCode: 'abc123',
      setupCodeFilledIn: true,
      skippedPorts: [{ port: 43770, code: 'EADDRINUSE' }],
    }).join('\n');
    expect(text).toContain('Other devices:   http://192.168.1.20:43771/');
    expect(text).toContain('Setup code:      abc123  (already filled in on the page that opened)');
    expect(bannerLines({ ...base, setupCode: 'abc123' }).join('\n')).toContain('Setup code:      abc123  (enter it on the page that opened)');
    expect(text).toContain('Note: port 43770 is used by another program, so Lyren Plan uses port 43771 instead');
    expect(bannerLines({ ...base, browserOpened: false, setupCode: 'abc123' }).join('\n')).toContain('Open the address above in your browser.');
    expect(bannerLines({ ...base, lan: true }).join('\n')).toContain('no network address found');
  });

  it('the usual (remembered) address is taken: a warning, not a new address to get used to', () => {
    const text = bannerLines({ ...base, url: 'http://127.0.0.1:43772/', usualPort: 43771, skippedPorts: [{ port: 43771, code: 'EADDRINUSE' }] }).join('\n');
    expect(text).toContain("Warning: Lyren Plan's usual address http://127.0.0.1:43771/ is used by another program,");
    expect(text).toContain('so this time it runs at http://127.0.0.1:43772/');
    expect(text).toContain('now reach that other program:\n  do not sign in there.');
    expect(text).toContain('returns to its usual address once that is free again');
    expect(text).not.toContain('will try it');
    const reserved = bannerLines({ ...base, url: 'http://127.0.0.1:43770/', usualPort: 43771, skippedPorts: [{ port: 43771, code: 'EACCES' }] }).join('\n');
    expect(reserved).toContain('is reserved by Windows');
    expect(reserved).not.toContain('other program:');
    expect(bannerLines({ ...base, warnings: ['Warning: the folder', 'is open'] }).join('\n')).toContain('  Warning: the folder\n  is open');
  });
});

describe('single instance', () => {
  it('names: per database, case-insensitive on Windows', () => {
    const a = instancePipeName('C:\\Users\\Ann\\AppData\\Local\\Lyren Plan\\lyren.db', 'win32');
    expect(a).toMatch(/^\\\\\.\\pipe\\lyren-plan-[0-9a-f]{32}$/);
    expect(instancePipeName('c:\\users\\ann\\appdata\\local\\lyren plan\\LYREN.DB', 'win32')).toBe(a);
    expect(instancePipeName('/home/ann/.local/share/lyren-plan/lyren.db', 'linux')).toMatch(/^\0lyren-plan-[0-9a-f]{32}$/);
    expect(instancePipeName('/a/lyren.db', 'linux')).not.toBe(instancePipeName('/A/lyren.db', 'linux'));
    // A socket file in the temp folder; joined with this host's separator (only ever used on its own platform).
    const sock = instancePipeName('/a/lyren.db', 'darwin', '/tmp');
    expect(path.basename(sock)).toMatch(/^lyren-plan-[0-9a-f]{32}\.sock$/);
    expect(sock).toBe(path.join('/tmp', path.basename(sock)));
  });

  it('canonicalDbPath resolves symlinked folders', () => {
    const dir = tmp('lyren-canon-');
    fs.mkdirSync(path.join(dir, 'real'));
    // A junction on Windows: a symbolic link needs Developer Mode or administrator rights there.
    fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'link'), process.platform === 'win32' ? 'junction' : undefined);
    expect(canonicalDbPath(path.join(dir, 'link', 'lyren.db'))).toBe(path.join(fs.realpathSync(dir), 'real', 'lyren.db'));
    // A data folder that does not exist yet still resolves through its existing parents.
    expect(canonicalDbPath(path.join(dir, 'link', 'new', 'deeper', 'lyren.db'))).toBe(
      path.join(fs.realpathSync(dir), 'real', 'new', 'deeper', 'lyren.db'),
    );
  });

  const uniqueName = () =>
    process.platform === 'win32'
      ? `\\\\.\\pipe\\lyren-test-${randomBytes(8).toString('hex')}`
      : process.platform === 'linux'
        ? `\0lyren-test-${randomBytes(8).toString('hex')}`
        : path.join(tmp('lyren-sock-'), 's.sock');

  it('the second start gets the verified address of the first', async () => {
    const name = uniqueName();
    const secret = randomBytes(32).toString('hex');
    const first = await acquireInstanceLock({ name, secret, readSecret: () => secret });
    expect(first.held).toBe(true);
    if (!first.held) return;
    // Asked before the first is ready: the answer waits for ready().
    const second = acquireInstanceLock({ name, secret: 'unused', readSecret: () => secret, waitMs: 5000 });
    await new Promise((r) => setTimeout(r, 100));
    first.lock.ready('http://127.0.0.1:43770/');
    expect(await second).toEqual({ held: false, other: { url: 'http://127.0.0.1:43770/' } });
    // Answers keep coming after ready().
    expect(await acquireInstanceLock({ name, secret: 'x', readSecret: () => secret })).toEqual({
      held: false,
      other: { url: 'http://127.0.0.1:43770/' },
    });
    first.lock.close();
    await new Promise((r) => setTimeout(r, 50));
    // Released: the next start becomes the server.
    const third = await acquireInstanceLock({ name, secret, readSecret: () => secret });
    expect(third.held).toBe(true);
    if (third.held) third.lock.close();
  });

  it('an answer without the secret (an impostor holding the name) is not trusted', async () => {
    const name = uniqueName();
    const impostor = await acquireInstanceLock({ name, secret: 'f'.repeat(64), readSecret: () => null });
    if (!impostor.held) throw new Error('expected to hold the name');
    impostor.lock.ready('http://127.0.0.1:9999/');
    const realSecret = randomBytes(32).toString('hex');
    expect(await acquireInstanceLock({ name, secret: realSecret, readSecret: () => realSecret })).toEqual({
      held: false,
      other: { url: null, reason: 'unverified' },
    });
    impostor.lock.close();
  });

  it('an instance that never becomes ready times out', async () => {
    const name = uniqueName();
    const secret = randomBytes(32).toString('hex');
    const stuck = await acquireInstanceLock({ name, secret, readSecret: () => secret });
    if (!stuck.held) throw new Error('expected to hold the name');
    expect(await acquireInstanceLock({ name, secret, readSecret: () => secret, waitMs: 300 })).toEqual({
      held: false,
      other: { url: null, reason: 'timeout' },
    });
    stuck.lock.close();
  });

  it('a start that fails before it is ready releases the name: the next start takes it at once', async () => {
    const name = uniqueName();
    const secret = randomBytes(32).toString('hex');
    const failing = await acquireInstanceLock({ name, secret, readSecret: () => secret });
    if (!failing.held) throw new Error('expected to hold the name');
    const waited = vi.fn();
    const t0 = Date.now();
    // Already waiting for the failing start's address when it gives up...
    const next = acquireInstanceLock({ name, secret, readSecret: () => secret, waitMs: 20_000, onWaiting: waited, noticeMs: 100 });
    await new Promise((r) => setTimeout(r, 300));
    expect(waited).toHaveBeenCalledTimes(1); // "Waiting for the Lyren Plan that is already running..."
    failing.lock.close();
    const result = await next;
    expect(result.held).toBe(true);
    expect(Date.now() - t0).toBeLessThan(5000);
    if (result.held) result.lock.close();
  });

  it('instanceProof binds the challenge and the URL', () => {
    const p = instanceProof('s', 'c', 'http://a/');
    expect(p).toMatch(/^[0-9a-f]{64}$/);
    expect(instanceProof('s', 'c', 'http://b/')).not.toBe(p);
    expect(instanceProof('s', 'd', 'http://a/')).not.toBe(p);
    expect(instanceProof('t', 'c', 'http://a/')).not.toBe(p);
  });
});

describe('data folder permissions (Windows)', () => {
  const USER = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
  const whoami = `"desktop-1\\ann","${USER}"\r\n`;
  // `icacls <dir> /save <file>`: the name, then the SDDL (written as UTF-16LE).
  const INHERITED_FROM_DRIVE_ROOT = `Lyren\r\nD:AI(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIID;0x1200a9;;;BU)(A;OICIIOID;0x1301bf;;;AU)(A;ID;0x4;;;AU)(A;OICIID;FA;;;${USER})\r\n`;
  const PRIVATE = `Lyren Plan\r\nD:PAI(A;OICI;FA;;;${USER})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)\r\n`;

  it('reads the SDDL: who else may read or change the folder (or what is created in it)', () => {
    expect(othersWithAccess(INHERITED_FROM_DRIVE_ROOT)).toEqual(['Users', 'Authenticated Users']);
    expect(othersWithAccess(PRIVATE)).toEqual([]);
    // Append-data only (create subfolders) and deny entries are not access to the files.
    expect(othersWithAccess('x\r\nD:(A;;0x4;;;AU)(D;OICI;FA;;;WD)')).toEqual([]);
    expect(othersWithAccess('x\r\nD:(A;OICI;GR;;;WD)(A;;FA;;;S-1-5-21-1-2-3-513)')).toEqual(['Everyone', 'Domain Users']);
    expect(parseWhoamiSid(whoami)).toBe(USER);
    expect(parseWhoamiSid('')).toBeNull();
  });

  function fakeRun(sddl: string | null, calls: string[][]): Run {
    return (file, args) => {
      calls.push([path.win32.basename(file), ...args]);
      if (file.endsWith('whoami.exe')) return { status: 0, stdout: whoami };
      if (args[1] === '/save') {
        if (sddl === null) return { status: 5, stdout: '' };
        fs.writeFileSync(args[2]!, Buffer.from(sddl, 'utf16le'));
      }
      return { status: 0, stdout: '' };
    };
  }

  it('a folder the app creates is made private to the user, SYSTEM and Administrators', () => {
    const calls: string[][] = [];
    expect(protectNewDataFolder('D:\\Lyren', fakeRun(null, calls))).toEqual([]);
    expect(calls).toEqual([
      ['whoami.exe', '/user', '/fo', 'csv', '/nh'],
      ['icacls.exe', ...privateAclArgs('D:\\Lyren', USER)],
    ]);
    expect(privateAclArgs('D:\\Lyren', USER)).toEqual([
      'D:\\Lyren',
      '/inheritance:r',
      '/grant:r',
      `*${USER}:(OI)(CI)F`,
      '*S-1-5-18:(OI)(CI)F',
      '*S-1-5-32-544:(OI)(CI)F',
    ]);
    // A file system without permissions (FAT USB drive): a warning instead.
    const failing: Run = (file) => ({ status: file.endsWith('whoami.exe') ? 0 : 1332, stdout: whoami });
    expect(protectNewDataFolder('E:\\Lyren', failing).join(' ')).toContain('could not make the data folder E:\\Lyren private');
  });

  it('an existing folder others can open is left alone, with a warning and the command to fix it', () => {
    const calls: string[][] = [];
    const lines = checkExistingDataFolder('D:\\Lyren', fakeRun(INHERITED_FROM_DRIVE_ROOT, calls));
    expect(lines.join('\n')).toContain('other Windows accounts on this computer can open the data folder D:\\Lyren');
    expect(lines.join('\n')).toContain('(it gives access to Users, Authenticated Users)');
    expect(lines.at(-2)).toBe('To make it private to you, run this once in Command Prompt:');
    expect(lines.at(-1)).toBe(`  ${privateAclCommand('D:\\Lyren', USER).text}`);
    expect(privateAclCommand('D:\\Lyren', USER)).toEqual({
      shell: 'cmd',
      text: `icacls "D:\\Lyren" /inheritance:r /grant:r "*${USER}:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F"`,
    });
    expect(calls.some((c) => c.includes('/inheritance:r'))).toBe(false); // nothing changed
    expect(checkExistingDataFolder('C:\\Users\\ann\\AppData\\Local\\Lyren Plan', fakeRun(PRIVATE, []))).toEqual([]);
    expect(checkExistingDataFolder('X:\\Lyren', fakeRun(null, []))).toEqual([]); // can't tell: no warning
    // icacls /save that "succeeds" without writing anything (a path it can't handle): no verdict either.
    expect(checkExistingDataFolder('X:\\Lyren', fakeRun('', []))).toEqual([]);
  });

  it('the printed icacls command works when typed: a drive root keeps its backslash, a % goes to PowerShell (RCK-1)', () => {
    // "D:\" in Command Prompt would hand icacls D:" (the backslash escapes the quote).
    expect(privateAclCommand('D:\\', USER).text).toBe(`icacls "D:\\\\" /inheritance:r /grant:r "*${USER}:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F"`);
    // Without the SID: %USERNAME%, which Command Prompt expands (on purpose).
    expect(privateAclCommand('D:\\Lyren', null).text).toContain('"%USERNAME%:(OI)(CI)F"');
    // Command Prompt would expand %PATH% even inside the quotes: PowerShell, single-quoted.
    const ps = privateAclCommand("D:\\R&D 100%PATH% Dana’s 'x'", USER);
    expect(ps).toEqual({
      shell: 'powershell',
      text: `icacls 'D:\\R&D 100%PATH% Dana’’s ''x''' /inheritance:r /grant:r '*${USER}:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F'`,
    });
    expect(privateAclCommand('D:\\100%', null).text).toContain('"${env:USERNAME}:(OI)(CI)F"');
    const lines = checkExistingDataFolder('D:\\100%PATH%', fakeRun(INHERITED_FROM_DRIVE_ROOT, []));
    expect(lines.at(-2)).toBe('To make it private to you, run this once in PowerShell:');
    expect(lines.at(-1)).toBe(`  ${privateAclCommand('D:\\100%PATH%', USER).text}`);
  });

  it('the icacls command for PowerShell keeps a share root\'s trailing backslash through Windows PowerShell 5.1 (FV-1)', () => {
    const grants = `'*${USER}:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F'`;
    // With a space 5.1 quotes the argument: "\\nas\Lyren 100%\\" reaches icacls as \\nas\Lyren 100%\ (measured).
    expect(privateAclCommand('\\\\nas\\Lyren 100%\\', USER)).toEqual({
      shell: 'powershell',
      text: `icacls '\\\\nas\\Lyren 100%\\\\' /inheritance:r /grant:r ${grants}`,
    });
    // Without whitespace it goes as it is.
    expect(privateAclCommand('\\\\nas\\Lyren100%\\', USER).text).toBe(`icacls '\\\\nas\\Lyren100%\\' /inheritance:r /grant:r ${grants}`);
    // Command Prompt (no %): doubled always, as before.
    expect(privateAclCommand('\\\\nas\\Lyren 1\\', USER).text).toBe(
      `icacls "\\\\nas\\Lyren 1\\\\" /inheritance:r /grant:r "*${USER}:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F"`,
    );
  });

  it('a long folder path (MAX_PATH or more) reaches icacls as \\\\?\\<path>, which it can handle (RCK-4)', () => {
    const long = `C:\\Users\\ann\\${'a'.repeat(60)}\\${'b'.repeat(60)}\\${'c'.repeat(60)}\\${'d'.repeat(60)}\\Lyren`;
    expect(long.length).toBeGreaterThanOrEqual(MAX_PATH);
    expect(icaclsPath(long)).toBe(`\\\\?\\${long}`);
    expect(icaclsPath('D:\\Lyren')).toBe('D:\\Lyren'); // short paths as they are
    const short = `C:\\${'x'.repeat(MAX_PATH - 4)}`;
    expect(short).toHaveLength(MAX_PATH - 1);
    expect(icaclsPath(short)).toBe(short); // 259 characters work as they are (measured)
    expect(icaclsPath(`${short}y`)).toBe(`\\\\?\\${short}y`);
    const unc = `\\\\nas\\share\\${'u'.repeat(MAX_PATH)}`;
    expect(icaclsPath(unc)).toBe(`\\\\?\\UNC\\nas\\share\\${'u'.repeat(MAX_PATH)}`);
    expect(icaclsPath(icaclsPath(long))).toBe(icaclsPath(long)); // never twice
    // A new folder: made private through the prefixed path, no false warning.
    const calls: string[][] = [];
    expect(protectNewDataFolder(long, fakeRun(null, calls))).toEqual([]);
    expect(calls[1]).toEqual(['icacls.exe', `\\\\?\\${long}`, '/inheritance:r', '/grant:r', `*${USER}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F']);
    // An existing one: read through the prefixed path too; the warning names the folder, the command the form icacls needs.
    const read: string[][] = [];
    const lines = checkExistingDataFolder(long, fakeRun(INHERITED_FROM_DRIVE_ROOT, read));
    expect(read.find((c) => c[2] === '/save')?.[1]).toBe(`\\\\?\\${long}`);
    expect(lines.join('\n')).toContain(`can open the data folder ${long}`);
    expect(lines.at(-1)).toContain(`icacls "\\\\?\\${long}" /inheritance:r`);
  });
});

describe('shutdown and crashes', () => {
  function fakes() {
    const events = new Map<string, (arg?: unknown) => void>();
    const log: string[] = [];
    let release!: () => void;
    const entered = new Promise<void>((r) => (release = r));
    const deps = {
      server: { close: vi.fn((cb?: () => void) => cb && setTimeout(cb, 0)), closeIdleConnections: vi.fn(), closeAllConnections: vi.fn() },
      db: { close: vi.fn() },
      lock: { close: vi.fn() },
      timer: setInterval(() => undefined, 1_000_000),
      proc: { on: (event: string, fn: (arg?: unknown) => void) => events.set(event, fn), exit: vi.fn((code: number) => log.push(`exit ${code}`)) },
      waitForEnter: vi.fn(() => entered),
    };
    return { deps, emit: (event: string, arg?: unknown) => events.get(event)!(arg), log, pressEnter: release };
  }

  it('Ctrl+C (and the other stop signals) close the server, then the database: exit 0', async () => {
    const { deps, emit, log } = fakes();
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      installShutdown(deps);
      emit('SIGINT');
      emit('SIGTERM'); // a second signal while stopping changes nothing
      await new Promise((r) => setTimeout(r, 20));
      expect(deps.server.close).toHaveBeenCalledTimes(1);
      expect(deps.db.close).toHaveBeenCalled();
      expect(deps.lock.close).toHaveBeenCalled();
      expect(log).toEqual(['exit 0']);
    } finally {
      out.mockRestore();
      clearInterval(deps.timer);
    }
  });

  it('an unexpected error stops serving and answering other starts at once; Ctrl+C then ends it', async () => {
    const { deps, emit, log, pressEnter } = fakes();
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      installShutdown(deps);
      emit('uncaughtException', new Error('SQLITE_BUSY in purgeExpiredSessions'));
      // No web server (no 500s for every request) and no instance name (a second start must not
      // open the browser here); the database is closed.
      expect(deps.server.close).toHaveBeenCalled();
      expect(deps.server.closeAllConnections).toHaveBeenCalled();
      expect(deps.lock.close).toHaveBeenCalled();
      expect(deps.db.close).toHaveBeenCalled();
      expect(deps.waitForEnter).toHaveBeenCalled();
      expect(log).toEqual([]); // waiting for Enter
      emit('SIGINT'); // Ctrl+C, or the window being closed (SIGHUP)
      expect(log).toEqual(['exit 1']);
      pressEnter();
      await new Promise((r) => setTimeout(r, 0));
      expect(log).toEqual(['exit 1', 'exit 1']);
    } finally {
      err.mockRestore();
      clearInterval(deps.timer);
    }
  });
});

describe('embedded web client', () => {
  const file = (p: string, body: string) => {
    const buf = Buffer.from(body);
    const sha256 = createHash('sha256').update(buf).digest('hex');
    return { entry: { path: p, key: `web${p}`, size: buf.length, sha256, etag: sha256.slice(0, 32) }, buf };
  };

  it('serves the manifest files and checks them', async () => {
    const files = [file('/index.html', '<title>Lyren</title>'), file('/assets/a-1.js', 'x')];
    const manifest: AssetManifest = { format: 1, version: '1', builtAt: '2026-01-01T00:00:00.000Z', files: files.map((f) => f.entry) };
    const read = (key: string) => files.find((f) => f.entry.key === key)!.buf;
    const { source } = webSourceFromAssets(manifest, read);
    expect(Buffer.from(source.load('/index.html')!.body).toString()).toBe('<title>Lyren</title>');
    expect(source.load('/index.html')!.etag).toBe(files[0]!.entry.etag);
    expect(() => webSourceFromAssets(manifest, (key) => Buffer.concat([read(key), Buffer.from('!')]))).toThrow(DamagedAppError);
    expect(() => webSourceFromAssets({ ...manifest, files: [files[1]!.entry] }, read)).toThrow(/no index.html/);
    expect(() => webSourceFromAssets({ ...manifest, format: 2 as 1 }, read)).toThrow(DamagedAppError);
  });
});

describe('a start that fails', () => {
  async function busyPort() {
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
    return { blocker, port: (blocker.address() as net.AddressInfo).port };
  }

  /** serveDesktop in this process with `env`; resolves to what it printed and the error it ended with. */
  async function serveWith(env: Record<string, string>) {
    const saved = { ...process.env };
    const printed: string[] = [];
    const spies = (['log', 'warn', 'error'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => void printed.push(args.map(String).join(' '))),
    );
    try {
      Object.assign(process.env, { OPEN_BROWSER: 'false', WEB_DIR: '', HOST: '127.0.0.1', ...env });
      delete process.env.DB_PATH;
      const err = await serveDesktop({ defaults: desktopDefaults(process.platform, {}, os.homedir()), embedded: null }).then(
        () => null,
        (e: unknown) => e,
      );
      return { err, out: printed.join('\n') };
    } finally {
      process.env = saved;
      for (const spy of spies) spy.mockRestore();
    }
  }

  async function nameIsFree(dbPath: string) {
    const name = instancePipeName(canonicalDbPath(dbPath));
    const next = await acquireInstanceLock({ name, secret: 'f'.repeat(64), readSecret: () => null, waitMs: 3000 });
    if (next.held) next.lock.close();
    return next.held;
  }

  it('releases the instance name and the database before it waits for Enter (port in use)', async () => {
    const dataDir = path.join(tmp('lyren-fail-'), 'data');
    const { blocker, port } = await busyPort();
    try {
      const { err, out } = await serveWith({ DATA_DIR: dataDir, PORT: String(port) });
      expect(err).toBeInstanceOf(CliExit);
      expect((err as CliExit).code).toBe(1);
      expect(out).toContain(`Port ${port} is already in use by another program.`);
      // The next start (the user fixed the cause) is not told "already running".
      expect(await nameIsFree(path.join(dataDir, 'lyren.db'))).toBe(true);
      // The database was closed (WAL checkpointed into lyren.db).
      expect(fs.readdirSync(dataDir).sort()).toEqual(['desktop.json', 'lyren.db']);
    } finally {
      await new Promise((r) => blocker.close(r));
    }
  });

  it('a data folder that is a file (or below one): a plain explanation, no stack trace', async () => {
    const dir = tmp('lyren-notdir-');
    const file = path.join(dir, 'afile.txt');
    fs.writeFileSync(file, 'x');
    for (const dataDir of [file, path.join(file, 'sub')]) {
      const { err, out } = await serveWith({ DATA_DIR: dataDir, PORT: '1' });
      expect((err as CliExit).code, out).toBe(1);
      expect(out).toContain(`${file} is a file, not a folder.`);
      expect(out).toContain('Choose another data folder with --data-dir <folder>');
      expect(out).not.toMatch(/\n\s+at /);
      expect(await nameIsFree(path.join(dataDir, 'lyren.db'))).toBe(true);
    }
  });

  it.runIf(process.platform !== 'win32' && process.getuid?.() !== 0)('a data folder that cannot be created (no permission)', async () => {
    const dir = tmp('lyren-ro-');
    const ro = path.join(dir, 'ro');
    fs.mkdirSync(ro, { mode: 0o555 });
    try {
      const { err, out } = await serveWith({ DATA_DIR: path.join(ro, 'Lyren'), PORT: '1' });
      expect((err as CliExit).code, out).toBe(1);
      expect(out).toContain(`The folder ${path.join(ro, 'Lyren')} and the files in it must be writable by you.`);
      expect(out).not.toMatch(/\n\s+at /);
    } finally {
      fs.chmodSync(ro, 0o700);
    }
  });
});

describe('desktop app from source (tsx server/src/sea.ts)', () => {
  async function freePort() {
    const probe = net.createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const { port } = probe.address() as net.AddressInfo;
    await new Promise((r) => probe.close(r));
    return port;
  }

  it('runs one server per data folder, opens nothing, stops cleanly on SIGTERM', async () => {
    const dir = tmp('lyren-desk-');
    const dataDir = path.join(dir, 'data');
    const webDir = path.join(dir, 'web');
    fs.mkdirSync(webDir);
    fs.writeFileSync(path.join(webDir, 'index.html'), '<title>Lyren</title>');
    const port = await freePort();
    const env = tsxEnv({ ...process.env, DATA_DIR: dataDir, WEB_DIR: webDir, OPEN_BROWSER: 'false', DB_PATH: '', HOST: '' });
    const child = spawn(...tsxCommand('server/src/sea.ts', ['--port', String(port)]), { cwd: ROOT, env });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    try {
      const deadline = Date.now() + 30_000;
      while (!out.includes('Keep this window open') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      expect(out).toContain(`Open it at:      http://127.0.0.1:${port}/`);
      expect(out).toContain(`Data folder:     ${dataDir}`);
      expect(out).toMatch(/Setup code:\s+[0-9a-f]{12}\n/);
      expect(out).toContain('Open the address above in your browser.');
      expect((await fetch(`http://127.0.0.1:${port}/projects/1`)).status).toBe(200);
      // An empty HOST counts as unset in the desktop app: still 127.0.0.1 only.
      // Second start with the same data folder: points to the first, exits 0, never opens the DB.
      const second = spawnSync(...tsxCommand('server/src/sea.ts', ['--no-browser', '--port', String(port + 1)]), {
        cwd: ROOT,
        env,
        encoding: 'utf8',
        timeout: 60_000,
      });
      expect(second.status, second.stderr).toBe(0);
      expect(second.stdout).toContain(`Lyren Plan is already running at http://127.0.0.1:${port}/`);
      const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'desktop.json'), 'utf8'));
      expect(state.port).toBeUndefined(); // an explicit --port is not remembered
      expect(state.setupCode).toMatch(/^[0-9a-f]{12}$/);
    } finally {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    }
    // On Windows child.kill() is TerminateProcess: no signal handler runs there. (Ctrl+C and closing
    // the console window are handled; they can't be sent from a test.)
    if (process.platform === 'win32') return;
    expect(out).toContain('Stopping Lyren Plan (SIGTERM)...');
    // Closed cleanly: the WAL was checkpointed into lyren.db.
    expect(fs.readdirSync(dataDir).sort()).toEqual(['desktop.json', 'lyren.db']);
  }, 90_000);

  it.runIf(process.platform === 'linux')('what a start opens in the browser (a stand-in xdg-open records it)', async () => {
    const dir = tmp('lyren-open-');
    const dataDir = path.join(dir, 'data');
    const webDir = path.join(dir, 'web');
    const bin = path.join(dir, 'bin');
    const opened = path.join(dir, 'opened.txt');
    fs.mkdirSync(webDir);
    fs.writeFileSync(path.join(webDir, 'index.html'), '<title>Lyren</title>');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'xdg-open'), `#!/bin/sh\necho "$@" >> '${opened}'\n`, { mode: 0o755 });
    const port = await freePort();
    const env = tsxEnv({
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      DISPLAY: ':99',
      DATA_DIR: dataDir,
      WEB_DIR: webDir,
      SETUP_TOKEN: 'tok-open-1',
      OPEN_BROWSER: undefined,
      DB_PATH: '',
      HOST: '',
    });
    const readOpened = () => (fs.existsSync(opened) ? fs.readFileSync(opened, 'utf8').trim().split('\n') : []);
    const again = (extra: Record<string, string> = {}) =>
      spawnSync(...tsxCommand('server/src/sea.ts', ['--port', String(port + 1)]), { cwd: ROOT, env: { ...env, ...extra }, encoding: 'utf8', timeout: 60_000 });
    const child = spawn(...tsxCommand('server/src/sea.ts', ['--port', String(port)]), { cwd: ROOT, env });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    try {
      const deadline = Date.now() + 30_000;
      while (!out.includes('Keep this window open') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      // Linux: the setup page, but never the code on a command line other users can read.
      expect(readOpened()).toEqual([`http://127.0.0.1:${port}/setup`]);
      expect(out).toContain('Setup code:      tok-open-1  (enter it on the page that opened)');
      // A second start before the account exists: the setup page again.
      expect(again().status).toBe(0);
      expect(readOpened().at(-1)).toBe(`http://127.0.0.1:${port}/setup`);
      const setup = await fetch(`http://127.0.0.1:${port}/api/auth/setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Lyren-Request': '1' },
        body: JSON.stringify({ username: 'owner', password: 'correct horse battery', displayName: 'Owner', setupCode: 'tok-open-1' }),
      });
      expect(setup.status).toBe(201);
      // After the account was created in the running copy: the app, not a stale setup link.
      const third = again();
      expect(third.status).toBe(0);
      expect(third.stdout).toContain('and has been opened in your browser');
      expect(readOpened().at(-1)).toBe(`http://127.0.0.1:${port}/`);
      // OPEN_BROWSER uses the same rule as every boolean variable: n / never mean no.
      const count = readOpened().length;
      for (const value of ['n', 'never']) {
        const res = again({ OPEN_BROWSER: value });
        expect(res.status).toBe(0);
        expect(res.stdout).not.toContain('opened in your browser');
      }
      expect(readOpened().length).toBe(count);
      expect(readOpened().join('\n')).not.toContain('tok-open-1');
    } finally {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    }
  }, 120_000);
});
