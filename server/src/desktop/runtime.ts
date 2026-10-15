// How this run of the desktop app reaches its user (mode.ts): a console window (messages printed,
// a fatal one waits for Enter), the notification area without a console (output in the log file,
// problems in message boxes, a console window as the last resort), or both (terminal mode).
//
// A command other than serve started without a console where a person may be at the screen (a
// shortcut or Win+R with `reset-password`, `backup`, `stop` or `help`, another file manager or
// launcher, Start-Process: mode.ts commandMode) runs in 'tray' mode too, without a log file: what it
// printed is shown when it ends (showOutput), in a message box, or in a console window when it is
// long (help). Neither keeps the command running: it exits with its exit code once the box (or the
// console window, a new process) is up, and the box stays until OK is clicked. Started by Task
// Scheduler, a service or WMI, or in session 0, it runs 'unattended': nothing is shown; what it
// printed goes to the log file next to the database (main.ts opens it), and it exits at once.

import { waitForEnter } from './console';
import { dialogText, MAX_DIALOG_LINES, MAX_DIALOG_TEXT, reportProblem, showDialog, type DialogDeps, type DialogIcon } from './dialog';
import { NO_TEST_HOOKS, type TestHooks } from './hooks';
import { captureOutput, LogFile, type OutputCapture } from './log';
import { MESSAGE_VAR, relaunchInConsole } from './relaunch';

export type RuntimeMode = 'console' | 'tray' | 'terminal' | 'unattended';

export interface DesktopRuntime {
  mode: RuntimeMode;
  /** The program file, for relaunches. */
  exePath: string;
  /** The command line arguments this run was started with, for relaunches. */
  args: readonly string[];
  hooks: TestHooks;
  /** The log file (tray, terminal and unattended mode; opened once the data folder exists), else null. */
  log: LogFile | null;
  /** The notification-area icon (.ico), or null for a stock icon. */
  trayIcon: () => Buffer | null;
  /** Runs before a fatal problem is shown (serve.ts: remove the icon). */
  beforeFatal: (() => Promise<void>) | null;
  /**
   * Show the fatal problem just printed (a failed start, a crash) and resolve once the user has seen
   * it; the caller exits then. Console and terminal: wait for Enter. Tray: a message box, else a
   * console window with the text. Unattended: nothing (it is in the log file). `text`: what to show
   * (a crash's own message); default: everything this run printed to stderr (a failed start's lines).
   */
  fatal(text?: string): Promise<void>;
  /** Tell the user something without a console (tray mode: a message box); elsewhere it was printed. */
  notify(text: string, icon: DialogIcon, options?: { wait?: boolean }): Promise<void>;
  /**
   * Tray mode, a command other than serve: show everything it printed (stdout and stderr) and resolve
   * as soon as it is on the screen, never waiting for the user: a short text in a message box (`icon`)
   * that stays after the app has exited, else (or when no box can be shown) in a console window of a
   * new process, which waits for Enter. Elsewhere it was printed: nothing to do. `boxNote` is added at
   * the end when it is shown in a message box.
   */
  showOutput(icon: DialogIcon, boxNote?: string): Promise<void>;
  /** Stop sending stdout and stderr to the log (tests). */
  restoreOutput(): void;
}

export const DIALOG_TITLE = 'Lyren Plan';

/** The console's runtime: as before the notification-area icon (Linux, macOS, --console, from source). */
export function consoleRuntime(): DesktopRuntime {
  return {
    mode: 'console',
    exePath: process.execPath,
    args: [],
    hooks: NO_TEST_HOOKS,
    log: null,
    trayIcon: () => null,
    beforeFatal: null,
    fatal: () => waitForEnter(),
    notify: () => Promise.resolve(),
    showOutput: () => Promise.resolve(),
    restoreOutput: () => undefined,
  };
}

/** Whether `text` fits a message box (else a console window shows it). */
export function fitsMessageBox(text: string): boolean {
  return text.length <= MAX_DIALOG_TEXT && text.split('\n').length <= MAX_DIALOG_LINES;
}

export interface RuntimeOptions {
  mode: RuntimeMode;
  exePath: string;
  args: readonly string[];
  hooks: TestHooks;
  trayIcon: () => Buffer | null;
  /** Starts the program again in a console window (relaunch.ts); a parameter for the tests. */
  relaunch?: typeof relaunchInConsole;
  /** How message boxes are started (dialog.ts); a parameter for the tests. The hooks come from `hooks`. */
  dialog?: Partial<Omit<DialogDeps, 'hooks'>>;
}

/**
 * The runtime for `mode`. Tray, terminal and unattended mode send everything printed to the log file
 * (terminal mode also to the console, as before).
 */
export function createRuntime({ mode, exePath, args, hooks, trayIcon, relaunch = relaunchInConsole, dialog = {} }: RuntimeOptions): DesktopRuntime {
  if (mode === 'console') return { ...consoleRuntime(), exePath, args, hooks, trayIcon };
  const log = new LogFile();
  const output: OutputCapture = captureOutput(log, { echo: mode === 'terminal' });
  const runtime: DesktopRuntime = {
    mode,
    exePath,
    args,
    hooks,
    log,
    trayIcon,
    beforeFatal: null,
    async fatal(fatalText) {
      await runtime.beforeFatal?.().catch(() => undefined);
      if (mode === 'terminal') return waitForEnter();
      // Nobody is there to close a box (a scheduled task): the log file has it, the exit code says it.
      if (mode === 'unattended') return;
      const text = (fatalText ?? output.stderrText()).trim();
      if (!text) return;
      const shown = await reportProblem(
        { title: DIALOG_TITLE, text: dialogText(text, log.file), icon: 'Error' },
        (message) => relaunch(exePath, ['--console'], { [MESSAGE_VAR]: message }),
        { ...dialog, hooks },
      );
      if (shown === 'none') log.note('The message above could not be shown: no message box and no console window could be opened.');
    },
    async showOutput(icon, boxNote) {
      if (mode !== 'tray') return;
      const text = output.allText().trim();
      if (!text) return;
      // A console window: a new copy of the app shows the text and waits for Enter; this one goes on.
      const inConsole = () => relaunch(exePath, ['--console'], { [MESSAGE_VAR]: text });
      // Long (help): a console window, which scrolls; a box only when that can't be opened.
      const fits = fitsMessageBox(text);
      if (!fits && (await inConsole())) return;
      const boxText = dialogText(boxNote ? `${text}\n\n${boxNote}` : text, null);
      // Resolved once the box is up; it outlives this process, so a scheduled start taken for a person's does not wait.
      const shown = await showDialog({ title: DIALOG_TITLE, text: boxText, icon }, { wait: false, outlive: true }, { ...dialog, hooks });
      if (shown === 'shown' || !fits) return;
      await inConsole();
    },
    restoreOutput: () => output.restore(),
    async notify(text, icon, { wait = false } = {}) {
      if (mode !== 'tray') return;
      const shown = await showDialog({ title: DIALOG_TITLE, text: dialogText(text, log.file), icon }, { wait }, { ...dialog, hooks });
      if (shown === 'unavailable') log.note('A message box could not be shown (see above).');
    },
  };
  return runtime;
}
