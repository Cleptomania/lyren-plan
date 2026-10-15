// How `serve` shows itself. The Windows app is a console program (so Command Prompt and PowerShell
// wait for its commands) whose manifest asks Windows not to give it a console window of its own
// (consoleAllocationPolicy "detached", scripts/lib/manifest.mjs; Windows 11 24H2 and later):
//
//   console   in its console window as before: Linux, macOS, from source, --console, and when the
//             output is redirected to a file or pipe (a script or service wrapper reads it)
//   tray      double-clicked (no console at all): an icon in the notification area, the output in
//             a log file, problems in message boxes (tray.ts, log.ts, dialog.ts)
//   terminal  started in Command Prompt, PowerShell or Windows Terminal: the output there as before
//             (Ctrl+C stops it), and the icon too, so Quit works either way
//   relaunch-console  --console without a console (a shortcut with --console): start again in a new
//             console window (relaunch.ts) and exit
//   relaunch-hidden   older Windows, which ignores the manifest and opens a console window for a
//             double-click: start again without one and exit, so the window shows only briefly
//
// The other commands (commandMode) started without a console show their output in a message box
// that does not keep them running (runtime.ts showOutput): any start may come from a person (a
// shortcut, another file manager, a launcher, Start-Process). Only where nobody can be at the
// screen do they run 'unattended' (nothing shown, the output in the log file, the exit code at once):
// in session 0 (services; no desktop), or started by Task Scheduler, a service or WMI.
//
// Older Windows can't tell "Windows made a console for a double-click" from "started in a terminal"
// by the console itself (isTTY either way), so it asks for the parent process: Explorer (a
// double-click, a shortcut) or none left means double-clicked. A marker variable stops a loop.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tty from 'node:tty';

export type DesktopMode = 'console' | 'tray' | 'terminal' | 'relaunch-console' | 'relaunch-hidden';

/** The first Windows build that honours consoleAllocationPolicy (Windows 11 24H2, Server 2025). */
export const DETACHED_CONSOLE_BUILD = 26100;

/** Set (to 1) for the copy started by 'relaunch-hidden'. */
export const RELAUNCHED_VAR = 'LYREN_DESKTOP_RELAUNCHED';

export interface ModeInput {
  /** The Windows app (a single executable on win32); anything else always runs in its console. */
  windowsApp: boolean;
  /** --console */
  forceConsole: boolean;
  /** stdin, stdout or stderr is a console. */
  hasConsole: boolean;
  /** stdout or stderr goes to a file or a pipe (neither a console nor NUL). */
  redirected: boolean;
  /** The Windows build number (10.0.<build>). */
  build: number;
  /** This is the copy a 'relaunch-hidden' started. */
  relaunched: boolean;
  /** The parent process's image name in lower case, null when it has exited; asked only on older Windows. */
  parentImage: () => string | null;
}

export function decideMode(input: ModeInput): DesktopMode {
  if (!input.windowsApp) return 'console';
  if (input.forceConsole) return input.hasConsole || input.redirected ? 'console' : 'relaunch-console';
  if (!input.hasConsole) return input.redirected ? 'console' : 'tray';
  if (input.build >= DETACHED_CONSOLE_BUILD || input.relaunched) return 'terminal';
  const parent = input.parentImage();
  return parent === null || parent === 'explorer.exe' ? 'relaunch-hidden' : 'terminal';
}

/**
 * Programs that start other programs with nobody necessarily at the screen: Task Scheduler (its
 * service runs in svchost.exe; taskhostw.exe, and taskhost.exe / taskhostex.exe / taskeng.exe on
 * older Windows, run its tasks), the service control manager (services.exe) and WMI (wmiprvse.exe).
 */
export const UNATTENDED_PARENTS: ReadonlySet<string> = new Set(['svchost.exe', 'taskhostw.exe', 'taskhost.exe', 'taskhostex.exe', 'taskeng.exe', 'services.exe', 'wmiprvse.exe']);

/** What commandMode asks, only when there is neither a console nor redirected output. */
export interface CommandStartInput {
  windowsApp: boolean;
  hasConsole: boolean;
  redirected: boolean;
  /** This process's Windows session (0: services, which has no interactive desktop), null when unknown. */
  session: () => number | null;
  /** The parent process's image name in lower case, null when it has exited ('unknown': tasklist failed). */
  parentImage: () => string | null;
}

/**
 * How a command other than serve (backup, reset-password, stop, help) shows what it prints. With a
 * console or redirected output: as always ('console'). Without either it is 'unattended' only where
 * nobody can be at the screen: the process runs in session 0 (services: no desktop, e.g. a task that
 * runs "whether user is logged on or not"), or its parent is Task Scheduler, a service or WMI
 * (UNATTENDED_PARENTS). Then nothing is shown, the output goes to the log file and it exits at once
 * with its exit code. Every other start ('tray': Explorer, another file manager or launcher,
 * Start-Process from a PowerShell window, a parent that has ended, an unknown session or parent)
 * may be a person's, who sees the output in a message box (runtime.showOutput); the box does not
 * keep the command running, so a start taken for a person's does not wait for it either (unless its
 * caller waits for the whole process tree, as Start-Process -Wait does). The session is asked
 * first, the parent only when it is not 0.
 */
export function commandMode(input: CommandStartInput): 'console' | 'tray' | 'unattended' {
  if (!input.windowsApp || input.hasConsole || input.redirected) return 'console';
  if (input.session() === 0) return 'unattended';
  const parent = input.parentImage();
  return parent !== null && UNATTENDED_PARENTS.has(parent) ? 'unattended' : 'tray';
}

/** The build number in os.release() ("10.0.26200" -> 26200), 0 when unknown. */
export function windowsBuild(release: string = os.release()): number {
  const build = Number(release.split('.')[2]);
  return Number.isInteger(build) && build > 0 ? build : 0;
}

/**
 * Whether a standard handle that is not a console goes somewhere: a file or a pipe. Without a
 * console Node opens NUL, a character device, for the standard handles. (On Windows a pipe has no
 * isFIFO(): its mode is 0o010000, but fs.constants lacks S_IFIFO there; so: anything but a
 * character device.)
 */
export function isRedirected(st: { isCharacterDevice(): boolean } | null): boolean {
  return st !== null && !st.isCharacterDevice();
}

/** Whether the process has a console, and whether its output goes to a file or pipe. */
export function stdioState(): { hasConsole: boolean; redirected: boolean } {
  const hasConsole = [0, 1, 2].some((fd) => tty.isatty(fd));
  const redirected = [1, 2].some((fd) => {
    if (tty.isatty(fd)) return false;
    try {
      return isRedirected(fs.fstatSync(fd));
    } catch {
      return false;
    }
  });
  return { hasConsole, redirected };
}

/** The quoted fields of the first process line of `tasklist /FO CSV /NH` output, null when there is none. */
function tasklistRow(stdout: string): string[] | null {
  const line = stdout.split(/\r?\n/).find((l) => l.startsWith('"'));
  return line ? [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1]!) : null;
}

/**
 * The image name in `tasklist /FO CSV /NH` output ("explorer.exe","1234","Console","1","9 K"), lower
 * case, or null when there is no such line (the process has exited: tasklist prints a localized INFO
 * line).
 */
export function parseTasklist(stdout: string): string | null {
  const name = tasklistRow(stdout)?.[0];
  return name ? name.toLowerCase() : null;
}

/** The session number (Session#, the fourth field) in `tasklist /FO CSV /NH` output, or null. */
export function parseTasklistSession(stdout: string): number | null {
  const session = tasklistRow(stdout)?.[3];
  return session !== undefined && /^\d+$/.test(session) ? Number(session) : null;
}

/** Runs a program and returns its exit status and output (injectable for tests). */
export type RunSync = (file: string, args: string[]) => { status: number | null; stdout: string };

const runHidden: RunSync = (file, args) => {
  const res = spawnSync(file, args, { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  return { status: res.status, stdout: res.stdout ?? '' };
};

/** `tasklist /FI "PID eq <pid>" /FO CSV /NH` (hidden, by absolute path). */
function tasklistOf(pid: number, run: RunSync, env: Record<string, string | undefined>) {
  const tasklist = path.win32.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'tasklist.exe');
  return run(tasklist, ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
}

/** The image name of process `pid` (by tasklist.exe), null when it has exited, 'unknown' when tasklist fails. */
export function processImage(pid: number, run: RunSync = runHidden, env: Record<string, string | undefined> = process.env): string | null {
  const res = tasklistOf(pid, run, env);
  // A tasklist that fails says nothing about the parent: treat it as a terminal (keep the console).
  if (res.status !== 0) return 'unknown';
  return parseTasklist(res.stdout);
}

/** The Windows session of process `pid` (by tasklist.exe), or null when unknown. */
export function processSession(pid: number, run: RunSync = runHidden, env: Record<string, string | undefined> = process.env): number | null {
  const res = tasklistOf(pid, run, env);
  return res.status === 0 ? parseTasklistSession(res.stdout) : null;
}
