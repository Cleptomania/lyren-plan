// The package self-test's reading of a spawnSync result (scripts/lib/self-test.mjs).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  blockedByWindows,
  blockedExplanation,
  describeRun,
  describeStartError,
  parseStartProbe,
  POLICY_BLOCK_ERRORS,
  refusedToStart,
  runOutput,
  windowsStartError,
} from '../lib/self-test.mjs';

const dirs = [];
afterAll(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const spawnError = (code, errno) => Object.assign(new Error(`spawnSync C:\\dist\\app.exe ${code}`), { code, errno, syscall: 'spawnSync C:\\dist\\app.exe' });

describe('blockedByWindows', () => {
  it('recognises a program a policy refused to start, by its Win32 error', () => {
    // Smart App Control: ERROR_SYSTEM_INTEGRITY_POLICY_VIOLATION, which libuv reports as UNKNOWN.
    const sac = { error: spawnError('UNKNOWN', -4094), status: null, signal: null, stdout: null, stderr: null };
    expect(refusedToStart(sac, 'win32')).toBe(true);
    expect(blockedByWindows(sac, 'win32', { code: 4551, message: 'An Application Control policy has blocked this file' })).toBe(true);
    for (const code of POLICY_BLOCK_ERRORS) expect(blockedByWindows(sac, 'win32', { code })).toBe(true);
    expect(blockedByWindows({ error: spawnError('EACCES'), status: null }, 'win32', { code: 1260 })).toBe(true);
    // Through cmd.exe the block is a message instead.
    const viaCmd = { status: 1, stdout: '', stderr: "Program 'app.exe' failed to run: ... was blocked by your organization's Device Guard policy." };
    expect(blockedByWindows(viaCmd, 'win32')).toBe(true);
    expect(blockedByWindows({ status: 1, stdout: '', stderr: 'An Application Control policy has blocked this file.' }, 'win32')).toBe(true);
  });

  it('a spawn error alone is not a block: the same UNKNOWN hides a broken file (R6REV-2)', () => {
    const unknown = { error: spawnError('UNKNOWN', -4094), status: null, signal: null, stdout: null, stderr: null };
    expect(blockedByWindows(unknown, 'win32')).toBe(false);
    expect(blockedByWindows(unknown, 'win32', null)).toBe(false);
    // "not a valid application for this OS platform", "not a valid Win32 application", access denied.
    for (const code of [216, 193, 5]) expect(blockedByWindows(unknown, 'win32', { code, message: 'x' })).toBe(false);
    expect(blockedByWindows({ error: spawnError('EPERM'), status: null }, 'win32', { code: 5 })).toBe(false);
    // Unknown why (no PowerShell, say), or it started the second time: no block either.
    expect(blockedByWindows(unknown, 'win32', { code: null, message: 'spawnSync powershell.exe ENOENT' })).toBe(false);
    expect(blockedByWindows(unknown, 'win32', { code: null, started: true })).toBe(false);
  });

  it('is never a block elsewhere, or for an ordinary failure', () => {
    expect(blockedByWindows({ error: spawnError('UNKNOWN'), status: null }, 'linux', { code: 4551 })).toBe(false);
    expect(refusedToStart({ error: spawnError('UNKNOWN'), status: null }, 'linux')).toBe(false);
    expect(refusedToStart({ error: spawnError('ENOENT'), status: null }, 'win32')).toBe(false);
    expect(blockedByWindows({ error: spawnError('EACCES'), status: null }, 'darwin')).toBe(false);
    expect(blockedByWindows({ error: spawnError('ENOENT', -4058), status: null }, 'win32')).toBe(false);
    expect(blockedByWindows({ status: 1, stdout: '', stderr: 'TypeError: x is not a function' }, 'win32')).toBe(false);
    expect(blockedByWindows({ error: spawnError('ETIMEDOUT'), status: null, signal: 'SIGTERM' }, 'win32')).toBe(false);
    expect(blockedByWindows(undefined, 'win32')).toBe(false);
  });
});

describe('describeRun / runOutput', () => {
  it('names the spawn error, the signal or the exit code', () => {
    expect(describeRun({ error: spawnError('UNKNOWN', -4094), status: null })).toBe('spawnSync C:\\dist\\app.exe UNKNOWN (code UNKNOWN, errno -4094)');
    expect(describeRun({ status: null, signal: 'SIGKILL' })).toBe('killed by SIGKILL');
    expect(describeRun({ status: 3, signal: null })).toBe('exit code 3');
  });

  it('never prints "undefined" or "null" for missing output', () => {
    expect(runOutput({ stdout: null, stderr: null })).toBe('');
    expect(runOutput({})).toBe('');
    expect(runOutput({ stdout: ' out \n', stderr: Buffer.from('err\n') })).toBe('out\nerr');
  });

  it('explains a block: the build is fine, and signing is the fix', () => {
    const unsigned = blockedExplanation({ fileName: 'app.exe', outFile: 'C:\\dist\\app.exe', signed: false }).join('\n');
    expect(unsigned).toContain('Smart App Control');
    expect(unsigned).toContain('The build itself is fine and complete:\n    C:\\dist\\app.exe');
    expect(unsigned).toContain('LYREN_SIGN_CMD');
    expect(unsigned).toContain('event 3077');
    const signed = blockedExplanation({ fileName: 'app.exe', outFile: 'C:\\dist\\app.exe', signed: true }).join('\n');
    expect(signed).toContain('The exe is signed, but Windows does not trust the signature');
    expect(signed).not.toContain('LYREN_SIGN_CMD');
  });
});

describe('windowsStartError: the Win32 error behind a refused start', () => {
  it('reads the probe line PowerShell prints', () => {
    expect(parseStartProbe({ status: 0, stdout: 'noise\r\nlyren-start-probe: error 4551 An Application Control policy has blocked this file\r\n' })).toEqual({
      code: 4551,
      message: 'An Application Control policy has blocked this file',
    });
    expect(parseStartProbe({ status: 0, stdout: 'lyren-start-probe: error 216 The specified executable is not a valid application for this OS platform.' }).code).toBe(216);
    expect(parseStartProbe({ status: 0, stdout: 'Lyren Plan 0.1.0\nlyren-start-probe: started\n' })).toMatchObject({ code: null, started: true });
    expect(parseStartProbe({ status: 0, stdout: 'lyren-start-probe: unknown Cannot create type. Only core types are supported in this language mode.' })).toEqual({
      code: null,
      message: 'Cannot create type. Only core types are supported in this language mode.',
    });
    expect(parseStartProbe({ error: spawnError('ENOENT', -4058), status: null, stdout: null })).toMatchObject({ code: null, message: expect.stringContaining('ENOENT') });
    expect(parseStartProbe({ status: 1, stdout: '', stderr: 'boom' })).toEqual({ code: null, message: 'PowerShell gave no answer (exit code 1)' });
  });

  it('starts the exe again through Windows PowerShell and .NET, the path in an environment variable', () => {
    const calls = [];
    const run = (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return { status: 0, stdout: 'lyren-start-probe: error 4551 blocked\n' };
    };
    const file = 'C:\\R&D\\100% done\\Dana’s app.exe';
    expect(windowsStartError(file, { run, env: { SystemRoot: 'D:\\WINDOWS', PATH: 'x' } })).toEqual({ code: 4551, message: 'blocked' });
    const [{ cmd, args, opts }] = calls;
    expect(cmd).toBe('D:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand']);
    const script = Buffer.from(args[3], 'base64').toString('utf16le');
    expect(script).toContain('[System.Diagnostics.Process]::Start($si)');
    expect(script).toContain('$si.UseShellExecute = $false');
    expect(script).toContain('NativeErrorCode');
    // Never on the command line, where quoting could mangle it.
    expect(args.join(' ')).not.toContain('R&D');
    expect(opts.env).toMatchObject({ LYREN_START_PROBE_FILE: file, PATH: 'x' });
  });

  it('describes what it found for the failure message', () => {
    expect(describeStartError({ code: 216, message: 'not a valid application' })).toBe('Windows refused to start it: error 216 (not a valid application).');
    expect(describeStartError({ code: null, started: true })).toMatch(/started when tried again/);
    expect(describeStartError({ code: null, message: 'no PowerShell' })).toMatch(/could not be found out \(no PowerShell\).*event 3077/);
    expect(describeStartError(null)).toBe('');
    expect(blockedExplanation({ fileName: 'a.exe', outFile: 'C:\\a.exe', signed: false, start: { code: 4551, message: 'An Application Control policy has blocked this file' } })[1]).toBe(
      '  Smart App Control (or another application-control policy on this PC) blocked it (Windows error 4551: An Application Control policy has blocked this file).',
    );
  });

  // The real thing: Node's UNKNOWN for a file that is no program at all, and what Windows says.
  it.runIf(process.platform === 'win32')('Windows: a broken exe is a failure, not a block; a real program starts', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyren-selftest-'));
    dirs.push(dir);
    const broken = path.join(dir, 'R&D broken.exe');
    fs.writeFileSync(broken, 'MZ placeholder');
    const res = spawnSyncHelp(broken);
    expect(refusedToStart(res)).toBe(true);
    const start = windowsStartError(broken);
    expect(start.code).not.toBeNull();
    expect(POLICY_BLOCK_ERRORS.has(start.code)).toBe(false);
    expect(blockedByWindows(res, 'win32', start)).toBe(false);
    expect(windowsStartError(process.execPath)).toMatchObject({ started: true });
  }, 120_000);
});

/** The self-test's own spawn (scripts/package.mjs). */
function spawnSyncHelp(file) {
  return spawnSync(file, ['help'], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
}
