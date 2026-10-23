// The pinned Wrangler as scripts/cf/wrangler.mjs runs it (scripts/lib/wrangler-run.mjs, Appendix D 70): the
// checkout's own bin with this Node.js and no shell, from the checkout's root, with SIGINT, SIGTERM and SIGHUP
// left to Wrangler while it runs; the pin check; the clean-up of .wrangler; the run token, and the id and the place
// of a run's generated configuration. The runs use a fake node_modules/wrangler in a temporary folder, never the real one,
// and nothing reaches Cloudflare.

import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { checkWranglerPin, cleanTmp, newConfigId, newRunToken, runPlace, spawnWrangler, wranglerBin } from '../lib/wrangler-run.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const LIB = pathToFileURL(path.join(ROOT, 'scripts/lib/wrangler-run.mjs')).href;
const dirs = [];
afterAll(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lyren-wrangler-run-'));
  dirs.push(d);
  return d;
}

/** A checkout whose package.json pins `pinned` and whose node_modules holds `installed` with `bin` as its entry. */
function checkout({ pinned = '4.147.0', installed = pinned, bin = '' } = {}) {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'x', devDependencies: { wrangler: pinned } }));
  if (installed !== null) {
    fs.mkdirSync(path.join(root, 'node_modules', 'wrangler', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules', 'wrangler', 'package.json'), JSON.stringify({ name: 'wrangler', version: installed }));
    fs.writeFileSync(wranglerBin(root), bin);
  }
  return root;
}

/** A fake Wrangler that records its arguments, folder and LYREN_WRANGLER_RUN, then exits with FAKE_EXIT. */
const RECORDING_BIN = `const fs = require('node:fs');
fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), run: process.env.LYREN_WRANGLER_RUN ?? null }));
process.exit(Number(process.env.FAKE_EXIT ?? 0));
`;

// ---------------------------------------------------------------------------
// The pinned Wrangler
// ---------------------------------------------------------------------------

describe('the pinned Wrangler', () => {
  it('is the bin in node_modules of the checkout', () => {
    expect(wranglerBin('/repo')).toBe(path.join('/repo', 'node_modules', 'wrangler', 'bin', 'wrangler.js'));
  });

  it('refuses a node_modules Wrangler other than the pin, and a missing one, naming npm ci', () => {
    expect(checkWranglerPin(ROOT)).toBeNull();
    expect(checkWranglerPin(checkout())).toBeNull();
    expect(checkWranglerPin(checkout({ installed: '4.146.0' }))).toBe('node_modules holds Wrangler 4.146.0, but package.json pins 4.147.0: run npm ci');
    expect(checkWranglerPin(checkout({ installed: null }))).toBe('Wrangler is not installed (node_modules/wrangler; package.json pins 4.147.0): run npm ci');
    // A range is not a pin: the tests checked one version.
    expect(checkWranglerPin(checkout({ pinned: '^4.147.0', installed: '4.147.0' }))).toContain('package.json pins ^4.147.0: run npm ci');
    expect(checkWranglerPin(checkout({ pinned: '' }))).toBe('package.json pins no Wrangler (devDependencies.wrangler)');
    expect(checkWranglerPin(tmp())).toContain('package.json could not be read');
  });
});

// ---------------------------------------------------------------------------
// Running it
// ---------------------------------------------------------------------------

describe('spawnWrangler', () => {
  /** A child process as spawn returns it, which exits as `exit` says on the next turn. */
  function fakeSpawn(exit = { code: 0, signal: null }) {
    const calls = [];
    const spawn = (command, args, options) => {
      calls.push({ command, args, options });
      const child = new EventEmitter();
      setImmediate(() => (exit.error ? child.emit('error', exit.error) : child.emit('exit', exit.code, exit.signal)));
      return child;
    };
    return { calls, spawn };
  }

  it('runs the pinned bin with this Node.js, without a shell, from the root, with stdio inherited', async () => {
    const { calls, spawn } = fakeSpawn({ code: 3, signal: null });
    const env = { PATH: '/bin', LYREN_WRANGLER_RUN: 'a'.repeat(32) };
    const signals = new EventEmitter();
    const status = await spawnWrangler(['deploy', '--config=wrangler.deploy.0123abcd.jsonc'], { root: '/repo', env, spawn, execPath: '/node', signals });
    expect(status).toBe(3);
    expect(calls).toEqual([
      {
        command: '/node',
        args: [path.join('/repo', 'node_modules', 'wrangler', 'bin', 'wrangler.js'), 'deploy', '--config=wrangler.deploy.0123abcd.jsonc'],
        options: { cwd: '/repo', env, stdio: 'inherit', shell: false },
      },
    ]);
  });

  it('reports a signal that ended Wrangler as 128 + its number, and a failed start as an error', async () => {
    const signals = new EventEmitter();
    const ended = await spawnWrangler([], { root: '/repo', ...fakeSpawn({ code: null, signal: 'SIGINT' }), signals });
    expect(ended).toBe(128 + os.constants.signals.SIGINT);
    await expect(spawnWrangler([], { root: '/repo', ...fakeSpawn({ error: new Error('spawn EACCES') }), signals })).rejects.toThrow('spawn EACCES');
    const throwing = () => {
      throw new Error('spawn EINVAL');
    };
    await expect(spawnWrangler([], { root: '/repo', spawn: throwing, signals })).rejects.toThrow('spawn EINVAL');
    // Every outcome puts the handlers back.
    expect(['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'].map((signal) => signals.listenerCount(signal))).toEqual([0, 0, 0, 0]);
  });

  it('ignores SIGINT, SIGTERM and SIGHUP while Wrangler runs, and puts the handlers there were back afterwards', async () => {
    const signals = new EventEmitter();
    const heard = [];
    const own = (signal) => heard.push(signal);
    signals.on('SIGINT', own);
    signals.once('SIGTERM', own);
    let child;
    const spawn = () => {
      child = new EventEmitter();
      return child;
    };
    signals.on('SIGHUP', own);
    const running = spawnWrangler([], { root: '/repo', spawn, signals });
    expect(signals.listenerCount('SIGINT')).toBe(1);
    expect(signals.listenerCount('SIGHUP')).toBe(1);
    // Ctrl+Break, on Windows only.
    expect(signals.listenerCount('SIGBREAK')).toBe(process.platform === 'win32' ? 1 : 0);
    signals.emit('SIGINT', 'SIGINT');
    signals.emit('SIGTERM', 'SIGTERM');
    signals.emit('SIGHUP', 'SIGHUP');
    expect(heard).toEqual([]);
    child.emit('exit', 0, null);
    expect(await running).toBe(0);
    signals.emit('SIGINT', 'SIGINT');
    signals.emit('SIGTERM', 'SIGTERM');
    signals.emit('SIGTERM', 'SIGTERM');
    signals.emit('SIGHUP', 'SIGHUP');
    // The once listener stays a once listener.
    expect(heard).toEqual(['SIGINT', 'SIGTERM', 'SIGHUP']);
    expect(signals.listenerCount('SIGINT')).toBe(1);
    expect(signals.listenerCount('SIGTERM')).toBe(0);
    expect(signals.listenerCount('SIGHUP')).toBe(1);
  });

  it('runs a real bin and ends with its status', async () => {
    const root = checkout({ bin: RECORDING_BIN });
    const log = path.join(root, 'fake.log');
    const env = { ...process.env, FAKE_LOG: log, FAKE_EXIT: '4', LYREN_WRANGLER_RUN: 'b'.repeat(32) };
    const status = await spawnWrangler(['versions', 'upload', 'a b', '$(touch pwned)'], { root, env, signals: new EventEmitter() });
    expect(status).toBe(4);
    expect(JSON.parse(fs.readFileSync(log, 'utf8'))).toEqual({ argv: ['versions', 'upload', 'a b', '$(touch pwned)'], cwd: fs.realpathSync(root), run: 'b'.repeat(32) });
    expect(fs.existsSync(path.join(root, 'pwned'))).toBe(false);
  });

  // The wrapper's own process gets the signals here: a separate Node.js runs spawnWrangler.
  it.skipIf(process.platform === 'win32')('a Ctrl+C, SIGTERM or closed terminal (SIGHUP) during the run leaves the wrapper running to clean up after Wrangler', () => {
    const root = checkout({
      bin: `process.kill(process.ppid, 'SIGINT');
process.kill(process.ppid, 'SIGTERM');
process.kill(process.ppid, 'SIGHUP');
setTimeout(() => process.exit(7), 300);
`,
    });
    const driver = path.join(root, 'driver.mjs');
    fs.writeFileSync(
      driver,
      `import { spawnWrangler } from ${JSON.stringify(LIB)};
process.on('SIGINT', () => console.log('own SIGINT handler'));
const status = await spawnWrangler(['deploy'], { root: process.argv[2], env: process.env });
console.log('status ' + status + ', SIGINT listeners ' + process.listenerCount('SIGINT') + ', SIGTERM listeners ' + process.listenerCount('SIGTERM') + ', SIGHUP listeners ' + process.listenerCount('SIGHUP'));
process.kill(process.pid, 'SIGINT');
setTimeout(() => console.log('cleaned up'), 100);
`,
    );
    const result = spawnSync(process.execPath, [driver, root], { cwd: os.tmpdir(), encoding: 'utf8', timeout: 20_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('status 7, SIGINT listeners 1, SIGTERM listeners 0, SIGHUP listeners 0\nown SIGINT handler\ncleaned up\n');
  });

  it.skipIf(process.platform === 'win32')('a Wrangler ended by a signal ends with 128 + its number', async () => {
    const root = checkout({ bin: `process.kill(process.pid, 'SIGTERM');\nsetTimeout(() => {}, 5000);\n` });
    expect(await spawnWrangler([], { root, env: process.env, signals: new EventEmitter() })).toBe(143);
  });
});

// ---------------------------------------------------------------------------
// After a run
// ---------------------------------------------------------------------------

describe('after a run', () => {
  it('cleanTmp removes only empty folders: .wrangler/tmp, then .wrangler', () => {
    const empty = tmp();
    fs.mkdirSync(path.join(empty, '.wrangler', 'tmp'), { recursive: true });
    cleanTmp(empty);
    expect(fs.existsSync(path.join(empty, '.wrangler'))).toBe(false);
    // npm run dev:cf's local Durable Object data, and a bundle a wrangler dev is writing meanwhile, stay.
    const state = tmp();
    fs.mkdirSync(path.join(state, '.wrangler', 'tmp'), { recursive: true });
    fs.mkdirSync(path.join(state, '.wrangler', 'state'));
    cleanTmp(state);
    expect(fs.readdirSync(path.join(state, '.wrangler'))).toEqual(['state']);
    const busy = tmp();
    fs.mkdirSync(path.join(busy, '.wrangler', 'tmp', 'dev-x'), { recursive: true });
    cleanTmp(busy);
    expect(fs.existsSync(path.join(busy, '.wrangler', 'tmp', 'dev-x'))).toBe(true);
    // Nothing there: nothing to do.
    expect(() => cleanTmp(tmp())).not.toThrow();
  });

  it('a run token is 32 new hex characters each time, and the id of its generated configuration 8 others', () => {
    const tokens = new Set(Array.from({ length: 20 }, () => newRunToken()));
    expect(tokens.size).toBe(20);
    for (const token of tokens) expect(token).toMatch(/^[0-9a-f]{32}$/);
    const ids = new Set(Array.from({ length: 20 }, () => newConfigId()));
    expect(ids.size).toBe(20);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}$/);
  });

  it("a run's place is the host's name, with the pid namespace on Linux: the same for every run of this process's place", () => {
    const readlink = (link) => {
      expect(link).toBe('/proc/self/ns/pid');
      return 'pid:[4026531836]';
    };
    expect(runPlace({ hostname: 'host-a', platform: 'linux', readlink })).toBe('host-a pid:[4026531836]');
    // No /proc, or another system: the host's name alone.
    const none = () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    };
    expect(runPlace({ hostname: 'host-a', platform: 'linux', readlink: none })).toBe('host-a');
    expect(runPlace({ hostname: 'HOST-B', platform: 'win32', readlink })).toBe('HOST-B');
    // Never blank, and nothing that would end a header's parenthesis or line.
    expect(runPlace({ hostname: ' ', platform: 'darwin' })).toBe('?');
    expect(runPlace({ hostname: '(none)', platform: 'darwin' })).toBe('?none?');
    expect(runPlace({ hostname: 'a\nb\u2028c', platform: 'darwin' })).toBe('a?b?c');
    // This process's: the host's name first, and the same each time.
    expect(runPlace().startsWith(os.hostname().trim() || '?')).toBe(true);
    expect(runPlace()).toBe(runPlace());
    if (process.platform === 'linux') {
      let namespace = null;
      try {
        namespace = fs.readlinkSync('/proc/self/ns/pid');
      } catch {
        // No /proc here.
      }
      if (namespace !== null) expect(runPlace()).toMatch(/ pid:\[\d+\]$/);
    }
  });
});
