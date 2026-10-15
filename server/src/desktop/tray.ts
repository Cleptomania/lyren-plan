// The icon in the notification area ("system tray") of the Windows app: a Windows PowerShell 5.1
// helper running TRAY_SCRIPT (scripts.ts) shows it with System.Windows.Forms.NotifyIcon and reports
// menu clicks over its stdout; the app answers over its stdin (powershell.ts has the launch and the
// line format, scripts.ts the protocol).
//
// The helper never outlives the app: it exits when the app tells it to, when its stdin closes
// (the app ended, even when killed: the helper runs outside the app's job object, see outsideJobLaunch)
// and when the app's process is gone. When the helper ends on its own, or does not report ready
// within READY_TIMEOUT_MS, the app starts it again, at most MAX_RESTARTS times in all (1, 2, 3 s
// apart); after that, or at once when PowerShell is missing or runs in ConstrainedLanguage mode, the
// tray "fails" (onFailed) and the caller decides what to do (serve.ts: a console window instead).
// Every OS effect (starting a process, killing one, timers) is injectable for the tests.

import { spawn } from 'node:child_process';
import { jsonLine, lineSplitter, parseScriptLine, powershellExists, powershellPath, scriptInput, outsideJobLaunch, type Launch } from './powershell';
import { TRAY_SCRIPT } from './scripts';

export const READY_TIMEOUT_MS = 15_000;
export const MAX_RESTARTS = 3;
/** How long close() waits for the helper to remove its icon before it kills it. */
export const CLOSE_TIMEOUT_MS = 3000;
/** NotifyIcon.Text takes at most 63 characters (.NET Framework). */
export const MAX_TOOLTIP = 63;

export type TrayMenuItem = { id: string; text: string; default?: boolean } | { separator: true };

/** The tray menu: Open (default, also on a left click), the data folder, with --lan the address for other devices, Quit. */
export function trayMenu({ lan }: { lan: boolean }): TrayMenuItem[] {
  return [
    { id: 'open', text: 'Open Lyren Plan', default: true },
    { id: 'folder', text: 'Open data folder' },
    ...(lan ? [{ id: 'copy-lan', text: 'Copy address for other devices' }] : []),
    { separator: true },
    { id: 'quit', text: 'Quit Lyren Plan' },
  ];
}

/** "Lyren Plan - <url>", shortened to NotifyIcon's limit. */
export function trayTooltip(url: string | null): string {
  const text = url ? `Lyren Plan - ${url}` : 'Lyren Plan (starting)';
  return text.length <= MAX_TOOLTIP ? text : `${text.slice(0, MAX_TOOLTIP - 1)}…`;
}

/** The parts of a child process the host uses (a ChildProcess, or a fake in the tests). */
export interface HelperProcess {
  readonly pid?: number | undefined;
  readonly stdin: { write(text: string): unknown; end(): unknown; on(event: 'error', fn: (err: Error) => void): unknown } | null;
  readonly stdout: { setEncoding(enc: 'utf8'): unknown; on(event: 'data', fn: (chunk: string) => void): unknown } | null;
  readonly stderr: { setEncoding(enc: 'utf8'): unknown; on(event: 'data', fn: (chunk: string) => void): unknown } | null;
  on(event: 'exit', fn: (code: number | null) => void): unknown;
  on(event: 'error', fn: (err: Error) => void): unknown;
  kill(): unknown;
}

export interface TrayDeps {
  launch: (spec: Launch) => HelperProcess;
  /** Ends a process by id (the PowerShell process, which killing cmd.exe does not end). */
  killPid: (pid: number) => void;
  powershellExists: () => boolean;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (timer: unknown) => void;
}

const defaultDeps: TrayDeps = {
  launch: (spec) =>
    spawn(spec.file, spec.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, windowsVerbatimArguments: spec.verbatim, cwd: spec.cwd }),
  killPid: (pid) => {
    try {
      process.kill(pid);
    } catch {
      /* already gone */
    }
  },
  powershellExists: () => powershellExists(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout),
};

export interface TrayOptions {
  tooltip: string;
  menu: TrayMenuItem[];
  /** The .ico to show; null shows Windows' stock application icon (from source). */
  icon: Buffer | null;
  /** The process the helper watches (the app). */
  parentPid: number;
  onAction: (id: string, via: string) => void;
  /** Windows is ending the session (sign-out, shutdown): quit now. */
  onSessionEnding: (reason: string) => void;
  /** No icon can be shown (any more); `reason` is for the log. Called at most once. */
  onFailed: (reason: string) => void;
  /** For the log file. */
  log: (line: string) => void;
  /** Accept test operations (LYREN_TEST_TRAY_CONTROL, hooks.ts). */
  testHooks?: boolean;
  /** LYREN_TEST_POWERSHELL_CLM (hooks.ts). */
  constrained?: boolean;
  readyTimeoutMs?: number;
  /** Delay before restart n (1-based). */
  backoffMs?: (attempt: number) => number;
  deps?: Partial<TrayDeps>;
}

export type TrayState = 'idle' | 'starting' | 'ready' | 'failed' | 'closing' | 'closed';

export class TrayHost {
  state: TrayState = 'idle';
  private readonly deps: TrayDeps;
  private child: HelperProcess | null = null;
  /** The PowerShell process of the current helper (from its hello). */
  private helperPid: number | null = null;
  /** The current helper got its init (after its hello): it takes further messages from then on. */
  private initSent = false;
  private restarts = 0;
  private readyTimer: unknown = null;
  private restartTimer: unknown = null;
  private tooltip: string;
  private stderr = '';
  private settledWaiters: Array<(state: 'ready' | 'failed') => void> = [];
  private exitWaiters: Array<() => void> = [];

  constructor(private readonly options: TrayOptions) {
    this.deps = { ...defaultDeps, ...options.deps };
    this.tooltip = options.tooltip;
  }

  start(): void {
    if (this.state !== 'idle') return;
    if (!this.deps.powershellExists()) {
      this.fail(`Windows PowerShell was not found at ${powershellPath()}`);
      return;
    }
    this.spawnHelper();
  }

  /** Resolves once the icon is shown or will not be ('failed'), or after `maxMs` with the state then. */
  settled(maxMs: number): Promise<TrayState> {
    if (this.state !== 'starting' && this.state !== 'idle') return Promise.resolve(this.state);
    return new Promise((resolve) => {
      const timer = this.deps.setTimeout(() => resolve(this.state), maxMs);
      this.settledWaiters.push((state) => {
        this.deps.clearTimeout(timer);
        resolve(state);
      });
    });
  }

  /**
   * Show `text` when the mouse points at the icon. A helper that already got its init (it may not
   * be ready yet) gets it at once; a helper started later gets it with its init.
   */
  setTooltip(text: string): void {
    this.tooltip = text;
    if (this.state === 'ready' || (this.state === 'starting' && this.initSent)) this.send({ type: 'tooltip', text });
  }

  /** Put `text` on the clipboard (the address for other devices). */
  copy(text: string): void {
    if (this.state === 'ready') this.send({ type: 'copy', text });
  }

  /** A test operation (hooks.ts); the helper ignores it unless testHooks was set. */
  test(op: string): void {
    if (this.state === 'ready' && this.options.testHooks) this.send({ type: 'test', op });
  }

  /**
   * Remove the icon: tell the helper to exit and wait for it (at most `timeoutMs`), else kill it (the
   * icon may then stay until the mouse passes over it).
   */
  close(timeoutMs = CLOSE_TIMEOUT_MS): Promise<void> {
    if (this.state === 'closed' || this.state === 'closing') return this.state === 'closed' ? Promise.resolve() : this.whenExited();
    const wasFailed = this.state === 'failed';
    this.state = 'closing';
    this.clearTimers();
    this.notifySettled('failed');
    const child = this.child;
    if (!child || wasFailed) {
      this.state = 'closed';
      return Promise.resolve();
    }
    this.send({ type: 'exit' });
    try {
      child.stdin?.end();
    } catch {
      /* already closed */
    }
    const exited = this.whenExited();
    const timer = this.deps.setTimeout(() => {
      if (this.child !== child) return;
      this.options.log(`Tray: the icon helper did not exit within ${timeoutMs / 1000} s and was ended; its icon may stay until the mouse passes over it.`);
      this.kill(child);
      this.markExited();
    }, timeoutMs);
    return exited.then(() => this.deps.clearTimeout(timer));
  }

  // ---- Internals ------------------------------------------------------------------------------

  private spawnHelper(): void {
    this.state = 'starting';
    this.helperPid = null;
    this.initSent = false;
    this.stderr = '';
    let child: HelperProcess;
    try {
      child = this.deps.launch(outsideJobLaunch(this.options.constrained));
    } catch (err) {
      this.helperEnded(null, `could not start Windows PowerShell (${(err as Error).message})`);
      return;
    }
    this.child = child;
    child.on('error', (err) => {
      if (this.child === child) this.helperEnded(child, `could not start Windows PowerShell (${err.message})`);
    });
    child.stdin?.on('error', () => undefined); // writing after the helper ended
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', lineSplitter((line) => this.onLine(child, line)));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (text: string) => {
      this.stderr = (this.stderr + text).slice(-2000);
    });
    child.on('exit', (code) => {
      if (this.child !== child) return;
      const why = this.stderr.trim() ? `: ${this.stderr.trim().split(/\r?\n/).slice(0, 3).join(' ')}` : '';
      this.helperEnded(child, `the icon helper exited (code ${code})${why}`);
    });
    this.write(child, scriptInput(TRAY_SCRIPT));
    const timeout = this.options.readyTimeoutMs ?? READY_TIMEOUT_MS;
    this.readyTimer = this.deps.setTimeout(() => {
      if (this.child !== child || this.state !== 'starting') return;
      this.kill(child);
      this.helperEnded(child, `the icon helper did not report ready within ${timeout / 1000} s`);
    }, timeout);
  }

  private onLine(child: HelperProcess, line: string): void {
    if (this.child !== child) return;
    const msg = parseScriptLine(line);
    switch (msg.type) {
      case 'boot': {
        const mode = (msg as { languageMode: string }).languageMode;
        if (mode !== 'FullLanguage') {
          // Nothing can fix this by trying again (an application-control policy).
          this.write(child, null);
          this.fail(`Windows PowerShell runs in ${mode} mode here (an application control policy), which cannot show the icon`);
        }
        break;
      }
      case 'hello': {
        const pid = Number(msg.pid);
        this.helperPid = Number.isInteger(pid) && pid > 0 ? pid : null;
        this.options.log(`Tray: icon helper started (Windows PowerShell ${String(msg.ps)}, process ${String(msg.pid)}).`);
        // Closed meanwhile (a stop during the start): its exit message is already on the way.
        if (this.state !== 'starting') break;
        this.send({
          type: 'init',
          parentPid: this.options.parentPid,
          tooltip: this.tooltip,
          icon: this.options.icon ? this.options.icon.toString('base64') : null,
          menu: this.options.menu,
          testHooks: this.options.testHooks === true,
        });
        this.initSent = true;
        break;
      }
      case 'ready':
        if (this.state !== 'starting') break;
        this.deps.clearTimeout(this.readyTimer);
        this.state = 'ready';
        this.options.log(`Tray: icon shown (${String(msg.iconSize)} px at ${String(msg.dpi)} dpi).`);
        this.notifySettled('ready');
        break;
      case 'action':
        if (typeof msg.id === 'string' && this.state === 'ready') {
          this.options.log(`Tray: ${msg.id} (${String(msg.via ?? 'menu')}).`);
          this.options.onAction(msg.id, String(msg.via ?? 'menu'));
        }
        break;
      case 'session-ending':
        this.options.log(`Tray: Windows is ending the session (${String(msg.reason)}).`);
        this.options.onSessionEnding(String(msg.reason ?? ''));
        break;
      case 'described':
        this.options.log(`Tray: ${JSON.stringify({ menu: msg.menu, tooltip: msg.tooltip, iconSize: msg.iconSize })}`);
        break;
      case 'error':
        this.options.log(`Tray: the icon helper reported an error: ${String(msg.message)}`);
        break;
      case 'bye':
        this.options.log(`Tray: icon removed (${String(msg.reason)}).`);
        break;
      default:
        // pong, copied, noise and messages of a newer helper: nothing to do.
        break;
    }
  }

  private helperEnded(child: HelperProcess | null, reason: string): void {
    if (child && this.child !== child) return;
    this.child = null;
    this.helperPid = null;
    this.initSent = false;
    this.deps.clearTimeout(this.readyTimer);
    if (this.state === 'closing') {
      this.markExited();
      return;
    }
    if (this.state === 'failed' || this.state === 'closed') return;
    if (this.restarts >= MAX_RESTARTS) {
      this.fail(`${reason}; gave up after ${MAX_RESTARTS} restarts`);
      return;
    }
    this.restarts++;
    const delay = (this.options.backoffMs ?? ((n) => n * 1000))(this.restarts);
    this.options.log(`Tray: ${reason}; starting it again (${this.restarts} of ${MAX_RESTARTS}).`);
    this.state = 'starting';
    this.restartTimer = this.deps.setTimeout(() => {
      if (this.state === 'starting' && this.child === null) this.spawnHelper();
    }, delay);
  }

  private fail(reason: string): void {
    if (this.state === 'failed' || this.state === 'closing' || this.state === 'closed') return;
    this.state = 'failed';
    this.clearTimers();
    this.options.log(`Tray: the icon cannot be shown: ${reason}.`);
    this.notifySettled('failed');
    this.options.onFailed(reason);
  }

  private notifySettled(state: 'ready' | 'failed'): void {
    for (const fn of this.settledWaiters.splice(0)) fn(state);
  }

  private whenExited(): Promise<void> {
    return new Promise((resolve) => this.exitWaiters.push(resolve));
  }

  private markExited(): void {
    this.child = null;
    this.state = 'closed';
    for (const fn of this.exitWaiters.splice(0)) fn();
  }

  private clearTimers(): void {
    this.deps.clearTimeout(this.readyTimer);
    this.deps.clearTimeout(this.restartTimer);
  }

  private kill(child: HelperProcess): void {
    // Killing cmd.exe does not end PowerShell: end the process the helper named in its hello.
    if (this.helperPid !== null) this.deps.killPid(this.helperPid);
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }

  private send(message: object): void {
    if (this.child) this.write(this.child, jsonLine(message));
  }

  /** Write to the helper's stdin; null closes it. */
  private write(child: HelperProcess, text: string | null): void {
    try {
      if (text === null) child.stdin?.end();
      else child.stdin?.write(text);
    } catch {
      /* the helper has gone; its exit event follows */
    }
  }
}
