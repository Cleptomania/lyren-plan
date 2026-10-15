// `npm run <script>` from the build scripts (dev.mjs, package.mjs) without a shell where possible,
// on Linux, macOS and Windows. Unit-tested in scripts/test/npm-run.test.mjs.
//
// Under npm (`npm run dev`, `npm run package:win`), npm_execpath is npm's own JavaScript entry
// (npm-cli.js), so `node <npm_execpath> run <script>` needs no shell and no npm.cmd. Started
// directly (`node scripts/dev.mjs`), npm is looked up on PATH: plain `npm` elsewhere, but on Windows
// that is npm.cmd, which only a shell can run; then ONE command string goes to the shell (the script
// names are fixed text), since Node deprecates an argument list together with `shell` (DEP0190).

import { spawnSync } from 'node:child_process';
import path from 'node:path';

/** {command, args, shell} for `npm run <script>`; the parameters exist for tests. */
export function npmRunInvocation(script, { env = process.env, platform = process.platform, execPath = process.execPath } = {}) {
  if (!/^[\w:.-]+$/.test(script)) throw new Error(`Unexpected npm script name ${script}`);
  const npmCli = env.npm_execpath;
  if (npmCli && /\.[cm]?js$/i.test(npmCli)) return { command: execPath, args: [npmCli, 'run', script], shell: false };
  if (platform === 'win32') return { command: `npm run ${script}`, args: [], shell: true };
  return { command: 'npm', args: ['run', script], shell: false };
}

/**
 * Stop a child process and everything it started. On Windows child.kill() is TerminateProcess of
 * that one process (npm), which would leave its children (tsx, vite) running: taskkill /T ends the
 * tree, by process id.
 */
export function killTree(child, { platform = process.platform, env = process.env, run = spawnSync } = {}) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  if (platform === 'win32') {
    const taskkill = path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
    run(taskkill, ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    child.kill('SIGTERM');
  }
}
