// Runs the pinned Wrangler for scripts/cf/wrangler.mjs (npm run deploy:cf, check:cf and cf; design Appendix D 70;
// docs/cloudflare.md, "Your instance configuration"): the checkout's node_modules/wrangler/bin/wrangler.js with
// this Node.js and no shell. That keeps the guarantee of `npx --no` (only the installed Wrangler, never a
// download) and needs no shell on Windows either, where Node refuses to spawn a .cmd without one since
// CVE-2024-27980. Also the token that tells scripts/cf/build-web.mjs a run is the wrapper's, the id that names a
// run's generated configuration and the place its header records, and the clean-up of what a run leaves in
// .wrangler (once npm's postcheck:cf, now part of every run). Unit-tested in scripts/test/wrangler-run.test.mjs.

import { spawn as spawnChild } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Wrangler's own entry point in the checkout at `root`. */
export const wranglerBin = (root) => path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

/**
 * What is wrong with the Wrangler in `root`'s node_modules, or null when it is the version package.json pins:
 * a run uses only the Wrangler the tests checked (the WRANGLER_COMMAND it hands the build command among them).
 * The caller prints it after `::error::`; it names versions, never a setting.
 */
export function checkWranglerPin(root) {
  const json = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  let pinned;
  try {
    pinned = json('package.json').devDependencies?.wrangler;
  } catch {
    return 'package.json could not be read: run this from a checkout of Lyren Plan';
  }
  if (typeof pinned !== 'string' || pinned === '') return 'package.json pins no Wrangler (devDependencies.wrangler)';
  let installed;
  try {
    installed = json('node_modules/wrangler/package.json').version;
  } catch {
    return `Wrangler is not installed (node_modules/wrangler; package.json pins ${pinned}): run npm ci`;
  }
  if (installed !== pinned) {
    return `node_modules holds Wrangler ${installed}, but package.json pins ${pinned}: run npm ci`;
  }
  return null;
}

/**
 * The signals that end a run from the terminal: Ctrl+C, a kill, a closed terminal, WSL window or SSH session
 * (SIGHUP; Node maps a closed Windows console to it too), and Ctrl+Break on Windows.
 */
const IGNORED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', ...(process.platform === 'win32' ? ['SIGBREAK'] : [])];

/**
 * Runs Wrangler with `args` from `root` and resolves to its exit status, 128 + the signal's number when a signal
 * ended it (as a shell reports it). stdio is inherited, so Wrangler's own prompts work. SIGINT, SIGTERM and SIGHUP
 * (and SIGBREAK on Windows) are ignored here while it runs, and the handlers there were are put back afterwards:
 * the terminal sends them to Wrangler as well, which stops as it decides, and the caller still removes its
 * generated configuration before it exits. `spawn`, `execPath` and `signals` (the emitter of the signals, process)
 * exist for tests.
 */
export function spawnWrangler(
  args,
  { root, env = process.env, spawn = spawnChild, execPath = process.execPath, signals = process } = {},
) {
  return new Promise((resolve, reject) => {
    const ignore = () => {};
    const saved = IGNORED_SIGNALS.map((signal) => [signal, signals.rawListeners(signal)]);
    for (const [signal, listeners] of saved) {
      for (const listener of listeners) signals.removeListener(signal, listener);
      signals.on(signal, ignore);
    }
    let restored = false;
    const restore = () => {
      if (restored) return;
      restored = true;
      for (const [signal, listeners] of saved) {
        signals.removeListener(signal, ignore);
        for (const listener of listeners) signals.on(signal, listener);
      }
    };
    let child;
    try {
      child = spawn(execPath, [wranglerBin(root), ...args], { cwd: root, env, stdio: 'inherit', shell: false });
    } catch (error) {
      restore();
      reject(error);
      return;
    }
    child.once('error', (error) => {
      restore();
      reject(error);
    });
    child.once('exit', (code, signal) => {
      restore();
      resolve(code ?? 128 + (os.constants.signals[signal] ?? 0));
    });
  });
}

/**
 * Removes .wrangler/tmp, then .wrangler, when they are empty: Wrangler bundles the Worker inside .wrangler/tmp
 * next to its configuration, and a run leaves that folder behind, empty. Only empty folders go, so a wrangler
 * dev running meanwhile keeps its own, and .wrangler/state (the local Durable Object data of npm run dev:cf) is
 * never touched.
 */
export function cleanTmp(root) {
  for (const dir of ['.wrangler/tmp', '.wrangler']) {
    try {
      fs.rmdirSync(path.join(root, dir));
    } catch {
      // Not there, or not empty: left as it is.
    }
  }
}

/** A new run token, 32 hex characters: in the generated build command (--run=) and in LYREN_WRANGLER_RUN. */
export const newRunToken = () => crypto.randomBytes(16).toString('hex');

/**
 * A new id for a run's generated configuration (scripts/lib/cloudflare.mjs#deployConfigName), 8 hex characters,
 * apart from the run token, which stays out of the file's name.
 */
export const newConfigId = () => crypto.randomBytes(4).toString('hex');

/**
 * Where this process runs, as a generated configuration's header records it next to its process ID: the host's
 * name, and on Linux, when it can be read, the pid namespace (`pid:[<inode>]`). A run in a container, another WSL
 * distribution or another machine that shares the checkout has other process IDs, so a file of another place is
 * never judged by its pid here. No parenthesis or line break (`?` instead), never blank.
 */
export function runPlace({ hostname = os.hostname(), platform = process.platform, readlink = fs.readlinkSync } = {}) {
  let place = hostname.trim() === '' ? '?' : hostname.trim();
  if (platform === 'linux') {
    try {
      place += ` ${readlink('/proc/self/ns/pid')}`;
    } catch {
      // No /proc: the host's name alone.
    }
  }
  return place.replace(/[()\p{Cc}\p{Zl}\p{Zp}]/gu, '?');
}
