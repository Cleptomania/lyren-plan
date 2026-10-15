// Windows PowerShell 5.1 for the notification-area icon (tray.ts) and message boxes (dialog.ts):
// Microsoft-signed and part of every Windows 10 and 11, so the app ships no native code of its
// own that Smart App Control could block.
//
// How a script is started (the "stdin bootstrap"): powershell.exe by absolute path with
// -NoProfile -NonInteractive and a short, fixed -Command (BOOTSTRAP) that prints a boot line with
// the session's language mode, reads the script as plain text from stdin up to an end marker, and
// runs it with the same reader, over which newline-delimited JSON follows. So:
//   - the scripts (scripts.ts) stay readable text, travel over the pipe, and are never written to
//     a file: no -ExecutionPolicy change, no -EncodedCommand (an antivirus red flag, and too long
//     for cmd.exe), no script in an environment variable;
//   - every value (addresses, folders, messages) travels as JSON data, never inside code;
//   - a ConstrainedLanguage session (an application-control policy) shows in the boot line at once.
// BOOTSTRAP contains no double quote, % or ! so that it passes through cmd.exe unchanged (the tray
// helper and a command's result box are started through cmd.exe, see outsideJobLaunch).

import fs from 'node:fs';
import path from 'node:path';

/** Windows PowerShell 5.1 by absolute path (never one found through PATH). */
export function powershellPath(env: Record<string, string | undefined> = process.env): string {
  return path.win32.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

export function cmdPath(env: Record<string, string | undefined> = process.env): string {
  return path.win32.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'cmd.exe');
}

/**
 * The working folder of the helpers: System32, not the app's. The app may run in a network folder
 * (\\server\share, started from there), where cmd.exe prints a warning about UNC paths to stderr
 * (which would end up in every reason the log gives for a helper that ended).
 */
export function helperCwd(env: Record<string, string | undefined> = process.env): string {
  return path.win32.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32');
}

/** The first line every script prints, followed by the language mode (FullLanguage, ConstrainedLanguage...). */
export const BOOT_TAG = 'lyren-ps-boot';

/** The line after a script's text on stdin. */
export const SCRIPT_END = '#lyren-script-end';

export const BOOTSTRAP = [
  `'${BOOT_TAG} ' + $ExecutionContext.SessionState.LanguageMode`,
  '$r = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), (New-Object System.Text.UTF8Encoding($false)))',
  '$s = New-Object System.Text.StringBuilder',
  `while (($l = $r.ReadLine()) -ne $null -and $l -ne '${SCRIPT_END}') { [void]$s.AppendLine($l) }`,
  '& ([ScriptBlock]::Create($s.ToString())) $r',
].join('; ');

/** LYREN_TEST_POWERSHELL_CLM (hooks.ts): the session as an application-control policy would leave it. */
const CLM_PREFIX = "$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'; ";

/** The -Command text: BOOTSTRAP, in ConstrainedLanguage for the test hook. */
export function bootstrapCommand(constrained = false): string {
  return (constrained ? CLM_PREFIX : '') + BOOTSTRAP;
}

/** What to write to the script's stdin first: the script's lines, then the end marker. */
export function scriptInput(script: string): string {
  const lines = script.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
  if (lines.includes(SCRIPT_END)) throw new Error('A script must not contain the end marker');
  return `${lines.join('\n')}\n${SCRIPT_END}\n`;
}

/** One message as a line for the script's stdin. */
export function jsonLine(message: object): string {
  return `${JSON.stringify(message)}\n`;
}

export interface Launch {
  file: string;
  args: string[];
  /** Pass `args` to CreateProcess unquoted (cmd.exe parses its own command line). */
  verbatim: boolean;
  /** The working folder (helperCwd). */
  cwd: string;
}

/**
 * powershell.exe started directly (the message boxes of `serve`: a child that ends with the app is
 * what they need).
 */
export function directLaunch(constrained = false, env: Record<string, string | undefined> = process.env): Launch {
  return { file: powershellPath(env), args: ['-NoProfile', '-NonInteractive', '-Command', bootstrapCommand(constrained)], verbatim: false, cwd: helperCwd(env) };
}

/**
 * powershell.exe started through `cmd.exe /d /s /c`, so that it is outside the app's job object (the
 * tray helper, and the result box of a command, which stays after the app has ended). Node puts every
 * child it starts into a job object that Windows ends together with the app, so a powershell.exe
 * child would be killed with the app (Task Manager) before it could remove its icon: a "ghost" icon
 * until the mouse passes over it. powershell.exe started by cmd.exe is outside that job (the job
 * lets the children of its processes break away); the tray helper sees its stdin close and removes
 * the icon. (A detached powershell.exe exits at once without running.)
 */
export function outsideJobLaunch(constrained = false, env: Record<string, string | undefined> = process.env): Launch {
  const command = bootstrapCommand(constrained);
  const ps = powershellPath(env);
  // cmd.exe would expand %...% (also inside quotes) and end a quoted part at a double quote.
  if (/["%!]/.test(command) || /["%!]/.test(ps)) throw new Error('The PowerShell command line must not contain ", % or !');
  // /s: cmd.exe removes the outer quotes and runs the rest as it is.
  return { file: cmdPath(env), args: ['/d', '/s', '/c', `""${ps}" -NoProfile -NonInteractive -Command "${command}""`], verbatim: true, cwd: helperCwd(env) };
}

export function powershellExists(env: Record<string, string | undefined> = process.env): boolean {
  try {
    return fs.statSync(powershellPath(env)).isFile();
  } catch {
    return false;
  }
}

// ---- Output of a script: lines of JSON -------------------------------------------------------

/** A message from a script: its boot line, a JSON object with a string `type`, or anything else. */
export type ScriptMessage =
  | { type: 'boot'; languageMode: string }
  | { type: string; [key: string]: unknown }
  | { type: 'noise'; line: string };

export function parseScriptLine(line: string): ScriptMessage {
  const text = line.trim();
  if (text.startsWith(`${BOOT_TAG} `)) return { type: 'boot', languageMode: text.slice(BOOT_TAG.length + 1).trim() };
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === 'object' && value !== null && !Array.isArray(value) && typeof (value as { type?: unknown }).type === 'string') {
      return value as { type: string };
    }
  } catch {
    /* not JSON */
  }
  return { type: 'noise', line: text.slice(0, 200) };
}

/** Longest line kept; anything longer (a runaway output) is dropped up to its line break. */
const MAX_LINE = 64 * 1024;

/**
 * Splits a stream's text into lines (LF or CRLF); a partial line waits for its end. Calls `onLine`
 * for each non-empty line.
 */
export function lineSplitter(onLine: (line: string) => void, maxLine = MAX_LINE): (chunk: string) => void {
  let buf = '';
  let skipping = false;
  return (chunk) => {
    buf += chunk;
    for (;;) {
      const nl = buf.indexOf('\n');
      if (nl < 0) break;
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (skipping) {
        skipping = false;
        continue;
      }
      if (line.trim()) onLine(line);
    }
    if (buf.length > maxLine) {
      buf = '';
      skipping = true;
    }
  };
}
