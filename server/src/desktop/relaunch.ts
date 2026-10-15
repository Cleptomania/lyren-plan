// Starting the Windows app again, differently (mode.ts):
//
//   in a console window: --console without one (a shortcut with --console), the fallback when the
//     notification-area icon can't be shown, a message box that can't be shown, and the long output
//     of a command started without a console (main.ts). Windows does not give the app a console of
//     its own (consoleAllocationPolicy "detached" outranks CREATE_NEW_CONSOLE), and Node can't start
//     conhost.exe with working standard handles, so it is
//     `cmd.exe /d /v:off /c start "Lyren Plan" "<System32>\conhost.exe" "%LYREN_RELAUNCH_REF%"`: a
//     classic console window that Ctrl+C and closing it stop as before. Nothing of the user's is
//     written into a command line: cmd.exe reads % ^ & ! and quotes, and conhost.exe rebuilds the
//     command line of the program it starts and expands %VARIABLES% in it (a data folder named
//     "D:\100%PATH%" arrived as "D:\100C:\Windows\system32;..."). So the line names a variable
//     whose value is the text %LYREN_RELAUNCH_EXE%: cmd.exe expands it once (to that text), conhost.exe
//     expands that once (to the program's path) and does not look into the result, so a path with %
//     in it arrives as it is. The arguments go as JSON in LYREN_RELAUNCH_ARGS, which the new copy takes
//     as its command line (takeRelaunchVariables).
//   without a console: older Windows (before 24H2) ignores the manifest and opens a console window
//     for a double-click; the app starts itself again with DETACHED_PROCESS (no console, no window)
//     and exits, so the window shows for a moment only. Node quotes these arguments itself (no shell).

import { spawn } from 'node:child_process';
import path from 'node:path';
import { RELAUNCHED_VAR } from './mode';

/** The program a console relaunch starts (its path; conhost.exe expands it). */
export const EXE_VAR = 'LYREN_RELAUNCH_EXE';
/** Named in cmd.exe's command line; its value is the text `%LYREN_RELAUNCH_EXE%` (see above). */
export const REF_VAR = 'LYREN_RELAUNCH_REF';
/** The arguments of a console relaunch, as a JSON array of strings. */
export const ARGS_VAR = 'LYREN_RELAUNCH_ARGS';

/** Set for a copy started only to show a message in a console window (main.ts shows it and waits for Enter). */
export const MESSAGE_VAR = 'LYREN_DESKTOP_MESSAGE';

export interface ConsoleRelaunch {
  file: string;
  args: string[];
  /** Variables to add to the environment. */
  env: Record<string, string>;
}

/**
 * The cmd.exe command that starts `exe` with `args` in a new console window. Throws for a program
 * path with a double quote (Windows file names can't contain one) and an unusual Windows folder.
 */
export function consoleRelaunchCommand(exe: string, args: readonly string[], env: Record<string, string | undefined> = process.env): ConsoleRelaunch {
  const system32 = path.win32.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32');
  const conhost = path.win32.join(system32, 'conhost.exe');
  if (/["%!^&]/.test(conhost)) throw new Error(`Unexpected Windows folder: ${conhost}`);
  if (exe.includes('"')) throw new Error('The program path contains a double quote');
  return {
    file: path.win32.join(system32, 'cmd.exe'),
    args: ['/d', '/v:off', '/c', `start "Lyren Plan" "${conhost}" "%${REF_VAR}%"`],
    env: { [REF_VAR]: `%${EXE_VAR}%`, [EXE_VAR]: exe, [ARGS_VAR]: JSON.stringify(args) },
  };
}

/** Starts a program, resolves its exit code (null: it could not start). Injectable for tests. */
export type RunToExit = (file: string, args: string[], options: { env: NodeJS.ProcessEnv; verbatim: boolean }) => Promise<number | null>;

const runToExit: RunToExit = (file, args, { env, verbatim }) =>
  new Promise((resolve) => {
    try {
      const child = spawn(file, args, { env, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: verbatim });
      child.once('error', () => resolve(null));
      child.once('exit', (code) => resolve(code));
    } catch {
      resolve(null);
    }
  });

/**
 * The variables meant only for the copy a relaunch started, removed from this process's environment
 * (so they reach no further program): whether it was started hidden, a message to show, and the
 * arguments of a console relaunch (null when there are none or they are not a list of strings).
 */
export function takeRelaunchVariables(env: NodeJS.ProcessEnv = process.env): { relaunched: boolean; message: string | null; args: string[] | null } {
  const relaunched = env[RELAUNCHED_VAR] === '1';
  const message = env[MESSAGE_VAR] ?? null;
  let args: string[] | null = null;
  try {
    const parsed: unknown = JSON.parse(env[ARGS_VAR] ?? 'null');
    if (Array.isArray(parsed) && parsed.every((a) => typeof a === 'string')) args = parsed as string[];
  } catch {
    /* not ours */
  }
  for (const name of [RELAUNCHED_VAR, MESSAGE_VAR, ARGS_VAR, EXE_VAR, REF_VAR]) delete env[name];
  return { relaunched, message, args };
}

/**
 * Start `exe args` in a new console window; resolves whether cmd.exe started it. `extraEnv` adds
 * variables (e.g. SETUP_TOKEN, MESSAGE_VAR). cmd.exe is waited for: it is in this app's job and would
 * be ended with it; the console window it starts is not.
 */
export async function relaunchInConsole(
  exe: string,
  args: readonly string[],
  extraEnv: Record<string, string> = {},
  run: RunToExit = runToExit,
): Promise<boolean> {
  let command: ConsoleRelaunch;
  try {
    command = consoleRelaunchCommand(exe, args);
  } catch {
    return false;
  }
  const env = { ...process.env, ...extraEnv, ...command.env };
  return (await run(command.file, command.args, { env, verbatim: true })) === 0;
}

/** Start this program again without a console (older Windows, double-clicked). Resolves whether it started. */
export function relaunchHidden(exe: string, args: readonly string[]): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn(exe, args, {
        detached: true,
        windowsHide: true,
        stdio: 'ignore',
        env: { ...process.env, [RELAUNCHED_VAR]: '1' },
      });
      child.once('error', () => resolve(false));
      child.once('spawn', () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}
