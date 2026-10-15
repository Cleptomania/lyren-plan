// Message boxes for the Windows app when it runs without a console window (tray mode): start
// failures, crashes, an address the browser could not be opened at, the result of a command. Shown by
// Windows PowerShell 5.1 running DIALOG_SCRIPT (scripts.ts; text and title as JSON on stdin).
// For `serve` PowerShell is a direct child of the app: a box for a fatal problem is waited for before
// the app exits, and an informational one goes away with the app. A command's result box (`outlive`)
// is started through cmd.exe, outside the app's job object (powershell.ts outsideJobLaunch): the
// command exits with its exit code as soon as the box is up, and the box stays until OK is clicked,
// so the command never waits for it (a scheduled task taken for a person, mode.ts commandMode); only a
// caller that waits for the whole process tree (Start-Process -Wait) still waits for the box. When no
// box can be shown (PowerShell missing or in ConstrainedLanguage mode), the caller falls back to a
// console window with the same text (relaunch.ts).

import fs from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { NO_TEST_HOOKS, type TestHooks } from './hooks';
import { directLaunch, jsonLine, lineSplitter, outsideJobLaunch, parseScriptLine, powershellExists, scriptInput, type Launch } from './powershell';
import { DIALOG_SCRIPT } from './scripts';
import type { HelperProcess } from './tray';

export type DialogIcon = 'Error' | 'Warning' | 'Information';

export interface DialogMessage {
  title: string;
  text: string;
  icon: DialogIcon;
}

/** A message box shows at most this many characters (the log file has everything). */
export const MAX_DIALOG_TEXT = 3000;
/** Longer texts than this many lines go to a console window where there is a choice (runtime.ts showOutput). */
export const MAX_DIALOG_LINES = 30;

/** How long PowerShell may take to put the box up before it counts as unavailable. */
const SHOW_TIMEOUT_MS = 30_000;

export interface DialogDeps {
  hooks: TestHooks;
  powershellExists: () => boolean;
  launch: (spec: Launch) => HelperProcess;
  /** Ends a process by id (the PowerShell of an `outlive` box, which killing cmd.exe does not end). */
  killPid: (pid: number) => void;
  /** Lets the app exit while the child runs on: its process and pipes no longer keep Node alive. */
  release: (child: HelperProcess) => void;
}

const defaultDeps: DialogDeps = {
  hooks: NO_TEST_HOOKS,
  powershellExists: () => powershellExists(),
  launch: (spec) =>
    spawn(spec.file, spec.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, windowsVerbatimArguments: spec.verbatim, cwd: spec.cwd }),
  killPid: (pid) => {
    try {
      process.kill(pid);
    } catch {
      /* already gone */
    }
  },
  release: (child) => {
    const real = child as unknown as ChildProcess;
    real.unref();
    for (const stream of [real.stdin, real.stdout, real.stderr]) stream?.destroy();
  },
};

/** `text` cut to MAX_DIALOG_TEXT characters, saying where the rest is. */
export function dialogText(text: string, logFile: string | null): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_DIALOG_TEXT) return trimmed;
  return `${trimmed.slice(0, MAX_DIALOG_TEXT)}…\n\n(${logFile ? `The rest is in ${logFile}.` : 'Shortened.'})`;
}

/**
 * Show a message box. `wait`: resolve once it was closed (else once it is up). `outlive`: the box stays
 * after the app has ended (started outside the app's job object, outsideJobLaunch); once it is up the
 * app lets go of it, so the app can exit while it is shown (only with `wait` false). Resolves 'shown',
 * or 'unavailable' when no box could be shown.
 */
export function showDialog(
  message: DialogMessage,
  { wait, outlive = false }: { wait: boolean; outlive?: boolean },
  deps: Partial<DialogDeps> = {},
): Promise<'shown' | 'unavailable'> {
  const { hooks, powershellExists: exists, launch, killPid, release } = { ...defaultDeps, ...deps };
  if (hooks.dialogLog) {
    try {
      fs.appendFileSync(hooks.dialogLog, `${JSON.stringify(message)}\n`);
      return Promise.resolve('shown');
    } catch {
      return Promise.resolve('unavailable');
    }
  }
  if (!exists()) return Promise.resolve('unavailable');
  return new Promise((resolve) => {
    let showing = false;
    let settled = false;
    let child: HelperProcess | null = null;
    /** The PowerShell process (its hello): for an `outlive` box not the child, which is cmd.exe. */
    let powershellPid: number | null = null;
    const end = () => {
      if (powershellPid !== null) killPid(powershellPid);
      try {
        child?.kill();
      } catch {
        /* gone */
      }
    };
    const timer = setTimeout(() => {
      if (showing) return;
      end();
      done('unavailable');
    }, SHOW_TIMEOUT_MS);
    timer.unref?.();
    const done = (result: 'shown' | 'unavailable') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (outlive && result === 'shown' && !wait && child) release(child);
      resolve(result);
    };
    try {
      child = launch(outlive ? outsideJobLaunch(hooks.powershellClm) : directLaunch(hooks.powershellClm));
    } catch {
      done('unavailable');
      return;
    }
    child.on('error', () => done('unavailable'));
    child.stdin?.on('error', () => undefined);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on(
      'data',
      lineSplitter((line) => {
        const msg = parseScriptLine(line);
        if (msg.type === 'boot' && (msg as { languageMode: string }).languageMode !== 'FullLanguage') {
          end();
          done('unavailable');
        } else if (msg.type === 'hello' && typeof msg.pid === 'number') {
          powershellPid = msg.pid;
        } else if (msg.type === 'showing') {
          showing = true;
          if (!wait) done('shown');
        } else if (msg.type === 'closed') {
          done('shown');
        }
      }),
    );
    child.on('exit', () => done(showing ? 'shown' : 'unavailable'));
    try {
      child.stdin?.write(scriptInput(DIALOG_SCRIPT) + jsonLine(message));
      child.stdin?.end();
    } catch {
      done('unavailable');
    }
  });
}

/**
 * Tell the user about a problem without a console: a message box (waited for), else `fallback`
 * (a console window with the text, relaunch.ts). Resolves how it was shown.
 */
export async function reportProblem(
  message: DialogMessage,
  fallback: (text: string) => Promise<boolean> | boolean,
  deps: Partial<DialogDeps> = {},
): Promise<'dialog' | 'console' | 'none'> {
  if ((await showDialog(message, { wait: true }, deps)) === 'shown') return 'dialog';
  return (await fallback(message.text)) ? 'console' : 'none';
}
