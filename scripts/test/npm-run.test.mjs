// npm run from the build scripts on every platform (scripts/lib/npm-run.mjs).
import { describe, expect, it } from 'vitest';
import { killTree, npmRunInvocation } from '../lib/npm-run.mjs';

describe('npmRunInvocation', () => {
  it('runs npm-cli.js with this node under npm: no shell, no npm.cmd', () => {
    const env = { npm_execpath: 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js' };
    expect(npmRunInvocation('dev:server', { env, platform: 'win32', execPath: 'C:\\node\\node.exe' })).toEqual({
      command: 'C:\\node\\node.exe',
      args: [env.npm_execpath, 'run', 'dev:server'],
      shell: false,
    });
    expect(npmRunInvocation('build', { env: { npm_execpath: '/usr/lib/node_modules/npm/bin/npm-cli.js' }, platform: 'linux', execPath: '/usr/bin/node' }).shell).toBe(false);
  });

  it('started without npm: npm on PATH, through the shell (one string, no DEP0190) only on Windows', () => {
    expect(npmRunInvocation('build', { env: {}, platform: 'linux' })).toEqual({ command: 'npm', args: ['run', 'build'], shell: false });
    expect(npmRunInvocation('build', { env: {}, platform: 'win32' })).toEqual({ command: 'npm run build', args: [], shell: true });
    // npm_execpath of a non-JavaScript launcher is not run with node.
    expect(npmRunInvocation('build', { env: { npm_execpath: 'C:\\tools\\npm.exe' }, platform: 'win32' }).shell).toBe(true);
    expect(() => npmRunInvocation('build & calc', { env: {}, platform: 'win32' })).toThrow(/Unexpected npm script name/);
  });
});

describe('killTree', () => {
  const child = (over = {}) => {
    const calls = [];
    return { calls, pid: 4242, exitCode: null, signalCode: null, kill: (sig) => calls.push(['kill', sig]), ...over };
  };

  it('ends the whole tree by process id on Windows, sends SIGTERM elsewhere', () => {
    const runs = [];
    const c = child();
    killTree(c, { platform: 'win32', env: { SystemRoot: 'C:\\WINDOWS' }, run: (...a) => runs.push(a) });
    expect(runs).toEqual([['C:\\WINDOWS\\System32\\taskkill.exe', ['/pid', '4242', '/T', '/F'], { stdio: 'ignore', windowsHide: true }]]);
    expect(c.calls).toEqual([]);
    const l = child();
    killTree(l, { platform: 'linux', run: () => runs.push('no') });
    expect(l.calls).toEqual([['kill', 'SIGTERM']]);
  });

  it('leaves processes alone that have ended or never started', () => {
    const runs = [];
    for (const c of [child({ exitCode: 0 }), child({ signalCode: 'SIGTERM' }), child({ pid: undefined })]) {
      killTree(c, { platform: 'win32', run: (...a) => runs.push(a) });
      expect(c.calls).toEqual([]);
    }
    expect(runs).toEqual([]);
  });
});
