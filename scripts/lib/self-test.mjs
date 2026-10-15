// The package self-test (`<exe> help` after a build, scripts/package.mjs): how a run went, and
// whether Windows refused to start the program because of a policy. Unit-tested in
// scripts/test/self-test.test.mjs.
//
// Smart App Control (Windows 11) and application-control policies (App Control for Business /
// WDAC) refuse to start an unsigned program they don't know. CreateProcess then fails with
// ERROR_SYSTEM_INTEGRITY_POLICY_VIOLATION (4551) or a related code (POLICY_BLOCK_ERRORS); older
// policies (Software Restriction Policies) give ERROR_ACCESS_DISABLED_BY_POLICY (1260). The program
// never ran, so the exit status is null. Node reports all of these as a spawn error with code
// UNKNOWN (libuv names few Win32 errors), and so it reports a broken file: "not a valid
// application for this OS platform" (216) or "not a valid Win32 application" (193). So a spawn
// error alone doesn't tell a block from a broken build: windowsStartError() starts the exe again
// through .NET, which keeps the Win32 error number, and only a policy error counts as a block.
//
// When started through cmd.exe instead, a block shows up as text: "... was blocked by your
// organization's Device Guard policy" or "An Application Control policy has blocked this file".
// Code Integrity logs it as event 3077 (with 3033/3118) in Microsoft-Windows-CodeIntegrity/Operational.

import { spawnSync } from 'node:child_process';
import path from 'node:path';

/** Spawn errors behind which Windows may hide a policy block (and other reasons not to start). */
const REFUSED_CODES = new Set(['UNKNOWN', 'EACCES', 'EPERM']);
const BLOCK_TEXT = /Device Guard|Application Control policy|Smart App Control|blocked by group policy/i;

/**
 * Win32 errors with which Windows refuses a program because of a policy: 1260 (blocked by group
 * policy), 4551 (an Application Control policy has blocked this file) and 4556-4559 and 4580-4583
 * (the same with a reason: malicious, potentially unwanted, dangerous extension, reputation service
 * unreachable, unfriendly file, reputation infrastructure issue, explicitly denied, not WHQL).
 */
export const POLICY_BLOCK_ERRORS = new Set([1260, 4551, 4556, 4557, 4558, 4559, 4580, 4581, 4582, 4583]);

/** `res` (a spawnSync result) is a Windows start failure that may be a policy block (or a broken file). */
export function refusedToStart(res, platform = process.platform) {
  return platform === 'win32' && !!res?.error && res.status === null && REFUSED_CODES.has(res.error.code);
}

/**
 * True when `res` (a spawnSync result) means a policy did not let the program start: for a spawn
 * error, only when `startError` (windowsStartError) confirms it with a policy error; otherwise when
 * the output says so (a start through cmd.exe).
 */
export function blockedByWindows(res, platform = process.platform, startError = null) {
  if (platform !== 'win32' || !res) return false;
  if (refusedToStart(res, platform)) return startError?.code != null && POLICY_BLOCK_ERRORS.has(startError.code);
  return BLOCK_TEXT.test(`${res.error?.message ?? ''}\n${res.stdout ?? ''}\n${res.stderr ?? ''}`);
}

/** Marks the probe's answer line in PowerShell's output. */
const PROBE_TAG = 'lyren-start-probe:';

/**
 * Starts $env:LYREN_START_PROBE_FILE with `help` through .NET (UseShellExecute off: CreateProcess),
 * which reports the Win32 error number that Node loses. Prints one tagged line.
 */
const PROBE_SCRIPT = `
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
try {
  $si = New-Object System.Diagnostics.ProcessStartInfo
  $si.FileName = $env:LYREN_START_PROBE_FILE
  $si.Arguments = 'help'
  $si.UseShellExecute = $false
  $si.CreateNoWindow = $true
  $si.RedirectStandardOutput = $true
  $p = [System.Diagnostics.Process]::Start($si)
  $null = $p.StandardOutput.ReadToEnd()
  if (-not $p.WaitForExit(30000)) { $p.Kill() }
  '${PROBE_TAG} started'
} catch {
  $e = $_.Exception
  while ($e -ne $null -and -not ($e -is [System.ComponentModel.Win32Exception])) { $e = $e.InnerException }
  if ($e -eq $null) { '${PROBE_TAG} unknown ' + $_.Exception.Message }
  else { '${PROBE_TAG} error ' + $e.NativeErrorCode + ' ' + $e.Message }
}
`;

/** Reads the probe's tagged line: {code, message}, {started: true} or {code: null, message: why unknown}. */
export function parseStartProbe(res) {
  const line = String(res?.stdout ?? '')
    .split(/\r?\n/)
    .find((l) => l.startsWith(PROBE_TAG));
  if (!line) {
    const why = res?.error ? res.error.message : `PowerShell gave no answer (${describeRun(res ?? {})})`;
    return { code: null, message: why };
  }
  const rest = line.slice(PROBE_TAG.length).trim();
  if (rest === 'started') return { code: null, started: true, message: 'it started when tried again' };
  const m = /^error (-?\d+) ?(.*)$/.exec(rest);
  if (m) return { code: Number(m[1]), message: m[2].trim() };
  return { code: null, message: rest.replace(/^unknown ?/, '') || 'no error number' };
}

/**
 * Windows: why CreateProcess refuses `file` (see the header), by starting it once more through
 * PowerShell and .NET. `run` and `env` are injectable for tests.
 */
export function windowsStartError(file, { run = spawnSync, env = process.env } = {}) {
  const powershell = path.win32.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const encoded = Buffer.from(PROBE_SCRIPT, 'utf16le').toString('base64');
  const res = run(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
    env: { ...env, LYREN_START_PROBE_FILE: file },
  });
  return parseStartProbe(res);
}

/** One line for a failed self-test about what windowsStartError found. */
export function describeStartError(start) {
  if (!start) return '';
  if (start.code != null) return `Windows refused to start it: error ${start.code}${start.message ? ` (${start.message})` : ''}.`;
  if (start.started) return 'It started when tried again, so the failure above is unexplained: build again.';
  return (
    `Why Windows refused to start it could not be found out (${start.message}). If Smart App Control or another ` +
    'application-control policy blocked it, Event Viewer shows event 3077 under Applications and Services Logs > ' +
    'Microsoft > Windows > CodeIntegrity > Operational.'
  );
}

/** "spawnSync x UNKNOWN (code UNKNOWN)", "exit code 3", "killed by SIGTERM (timed out)" ... */
export function describeRun(res) {
  if (res.error) {
    const code = res.error.code ? ` (code ${res.error.code}${res.error.errno !== undefined ? `, errno ${res.error.errno}` : ''})` : '';
    return `${res.error.message}${code}`;
  }
  if (res.signal) return `killed by ${res.signal}`;
  return `exit code ${res.status}`;
}

/** The program's output for an error message: stdout and stderr, trimmed, or '' when there was none. */
export function runOutput(res) {
  return [res.stdout, res.stderr]
    .map((s) => (typeof s === 'string' ? s : Buffer.isBuffer(s) ? s.toString('utf8') : ''))
    .map((s) => s.trim())
    .filter(Boolean)
    .join('\n');
}

/** The explanation printed when Windows blocked the self-test; `start` is windowsStartError's finding. */
export function blockedExplanation({ fileName, outFile, signed, start = null }) {
  const lines = [
    `Self-test skipped: Windows did not let ${fileName} start.`,
    `  Smart App Control (or another application-control policy on this PC) blocked it` +
      `${start?.code != null ? ` (Windows error ${start.code}${start.message ? `: ${start.message}` : ''})` : ''}.`,
    `  The build itself is fine and complete:`,
    `    ${outFile}`,
  ];
  if (signed) {
    lines.push(
      `  The exe is signed, but Windows does not trust the signature here, for example because the`,
      `  certificate is self-signed or a test certificate.`,
    );
  } else {
    lines.push(
      `  Windows may block unsigned programs it doesn't know, here and on other PCs with Smart App`,
      `  Control on. Signing the exe with a trusted code-signing certificate fixes that: set`,
      `  LYREN_SIGN_CMD (see "Signing the app" in README.md). Or test the exe on a PC without Smart`,
      `  App Control: run "${fileName} help" there.`,
    );
  }
  lines.push(
    `  Windows logs each block in Event Viewer: Applications and Services Logs > Microsoft > Windows >`,
    `  CodeIntegrity > Operational (event 3077).`,
  );
  return lines;
}
