// `serve` of the desktop app: like the Node server (cli.ts startServer) plus what a double-clicked
// program needs. One server per database (instance.ts): a second start opens the browser at the
// running one. The port falls back when taken (listen.ts). The browser opens at the app, or at the
// setup page on a first start (with the setup code filled in on Windows). A banner says where
// everything is. The database is closed cleanly (WAL checkpointed) on Ctrl+C, Ctrl+Break,
// SIGTERM, when the console window is closed (SIGHUP on Windows, which allows a few seconds), on
// Quit in the notification area, on the `stop` command and when Windows ends the session.
//
// How it shows itself depends on the mode (mode.ts, runtime.ts). In tray and terminal mode the
// icon in the notification area (tray.ts) is started as soon as this run holds the database; if it
// can't be shown in tray mode, the app stops and starts again in a console window (with the same
// setup code, without opening the browser twice), so it can always be stopped.
//
// A start that fails releases everything it took (the instance name, the database) before it
// waits for Enter (or shows its message box), so the user can fix the cause and start again while
// the message is shown. A start that is asked to stop while it is still starting (the stop command,
// the end of the Windows session) stops there: no browser, no banner.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isSea } from 'node:sea';
import { inspect } from 'node:util';
import { createAdaptorServer } from '@hono/node-server';
import { checkOwner, exitWith, loadConfigOrExit, openStackOrExit } from '../cli';
import { APP_VERSION, envBool, type Config, type ConfigDefaults } from '../config';
import { diskSource, hasWebClient, type StaticSource } from '../http/static';
import { commandTargetOption, separateDbPath, type DesktopDeps } from '../runtime/node/desktop';
import type { NodeStack } from '../runtime/node/stack';
import { dbOpenFailureMessage, listenFailureMessage, missingWebClientMessage } from '../startupErrors';
import { MAX_EXPLORER_PATH, openBrowser, openFolder } from './browser';
import { bannerLines, bannerNotices, commandLine, howToRun, waitForEnter, type BannerInfo, type ShellCommand } from './console';
import { DESKTOP_PORT_SPAN } from './defaults';
import { desktopFiles, readStateOf } from './files';
import { checkExistingDataFolder, protectNewDataFolder } from './folder';
import { acquireInstanceLock, canonicalDbPath, instancePipeName, type InstanceMode, type OtherInstance } from './instance';
import { candidatePorts, connectProbe, isPortUnavailable, listenOnFirstAvailable, portToRemember } from './listen';
import { relaunchInConsole } from './relaunch';
import { consoleRuntime, type DesktopRuntime } from './runtime';
import { readDesktopState, writeDesktopState } from './state';
import { TrayHost, trayMenu, trayTooltip } from './tray';
import { appUrl, browserTarget, connectHost, lanUrls } from './urls';

/** Signals that stop the server cleanly. SIGHUP: the console window was closed (Windows) or the terminal hung up. */
const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'] as const;
/** In-flight requests get this long to finish; Windows ends the process ~5 s after the window is closed. */
const SHUTDOWN_GRACE_MS = 1500;
/**
 * How long the start waits for the icon before it opens the browser (it usually takes 0.4 s, up to
 * 1.4 s the first time after an update). A later failure still switches to a console window.
 */
const TRAY_SETTLE_MS = 3000;
/** How often the test hook LYREN_TEST_TRAY_CONTROL's file is read. */
const TRAY_CONTROL_POLL_MS = 250;

export interface DesktopServeOptions {
  defaults: ConfigDefaults;
  /** The web client embedded in the executable; null when running from source. */
  embedded: StaticSource | null;
  /** The program's file name, for the commands the web client shows (runtime/node/desktop.ts). Default: lyren-plan, as from source. */
  exe?: string;
  /** How this run shows itself (runtime.ts); default: in its console window. */
  runtime?: DesktopRuntime;
  /** The command line had --no-browser (not just OPEN_BROWSER in the environment), for the messages that say why no browser opens. */
  noBrowserOption?: boolean;
}

/** Whether the running server at `base` still waits for its first account. */
async function setupRequired(base: string): Promise<boolean> {
  try {
    const res = await fetch(new URL('/api/auth/status', base), { signal: AbortSignal.timeout(3000) });
    return ((await res.json()) as { setupRequired?: unknown }).setupRequired === true;
  } catch {
    return false;
  }
}

/** How to stop the copy that is already running, by how it runs (instance.ts InstanceMode). */
export function runningHint(mode: InstanceMode | undefined, stopCommand: ShellCommand): string {
  if (mode === 'tray') {
    return `It runs in the notification area (near the clock); to stop it, right-click its icon and choose Quit Lyren Plan, or ${howToRun(stopCommand)}`;
  }
  if (mode === 'terminal') {
    return 'It runs in another window; to stop it, press Ctrl+C there or choose Quit Lyren Plan from its icon in the notification area.';
  }
  return 'It runs in its other window; close that window to stop it.';
}

/**
 * The message box of a second start without a console whose running copy has not answered after 2 s
 * (tray mode). It promises the browser only when this start will open it. `browserOff`: why it
 * won't (`--no-browser`, or `OPEN_BROWSER=<value>` set in the environment: noBrowserReason), null
 * when it will.
 */
export function waitingMessage(where: string, browserOff: string | null): string {
  const lead = `Lyren Plan is already running with ${where}, but has not answered yet.`;
  return browserOff === null
    ? `${lead}\n\nIt opens in your browser as soon as it answers (this can take a while, e.g. after an update).`
    : `${lead}\n\nThis can take a while, e.g. after an update. This start opens no browser (${browserOff}), so nothing else happens once it answers.`;
}

/**
 * Why this start opens no browser, as the user set it: the option `--no-browser` (which sets
 * OPEN_BROWSER=false and wins over the variable), else the variable with its value; null when it
 * opens the browser.
 */
export function noBrowserReason(wantBrowser: boolean, noBrowserOption: boolean, env: Record<string, string | undefined> = process.env): string | null {
  if (wantBrowser) return null;
  return noBrowserOption ? '--no-browser' : `OPEN_BROWSER=${(env.OPEN_BROWSER ?? '').trim()}`;
}

/** Why a running copy can't be used (OtherInstance reason), as printed (and shown in tray mode). */
export function unusableInstanceMessage(reason: 'timeout' | 'unverified' | 'denied' | 'unreachable', where: string, platform: NodeJS.Platform = process.platform): string[] {
  const win = platform === 'win32';
  const quit = win
    ? 'Quit the other Lyren Plan (close its window, or choose Quit Lyren Plan from its icon in the notification area), or end it in Task Manager, and start Lyren Plan again.'
    : 'Close the other Lyren Plan window (or end it in Task Manager) and start Lyren Plan again.';
  const account = win ? 'Windows account' : 'user';
  switch (reason) {
    case 'timeout':
      return [`Lyren Plan is already running with ${where} but does not respond.`, quit];
    case 'unverified':
      return [`Another program claims to be Lyren Plan with ${where}, but could not prove it.`, quit];
    case 'denied':
      return [
        `Lyren Plan is already running with ${where}, started by another ${account}, which this one may not ask for its address.`,
        `Two ${account}s can't use one data folder: give each its own (--data-dir), or quit the other copy first.`,
      ];
    case 'unreachable':
      return [
        `Something holds the name Lyren Plan uses for ${where} but does not answer: another program, or Lyren Plan of another ${account}.`,
        `${win ? 'End that program in Task Manager (or sign the other account out) ' : 'End that program '}and start Lyren Plan again, or use another data folder (--data-dir).`,
      ];
  }
}

/** A second start: open the browser at the running server and say so. */
async function openRunning(
  other: OtherInstance,
  where: string,
  stateOf: () => { setupCode?: string },
  wantBrowser: boolean,
  runtime: DesktopRuntime,
  stopCommand: ShellCommand,
): Promise<void> {
  if (other.url === null) {
    for (const line of unusableInstanceMessage(other.reason, where)) console.error(line);
    return exitWith(1);
  }
  let opened = false;
  if (wantBrowser) {
    // Before the first account exists, open the setup page (with the code filled in again).
    const target = browserTarget({
      platform: process.platform,
      url: other.url,
      setupRequired: await setupRequired(other.url),
      setupCode: stateOf().setupCode ?? null,
    });
    opened = await openBrowser(target.url, runtime.hooks);
  }
  console.log(`Lyren Plan is already running at ${other.url}${opened ? ' and has been opened in your browser' : ''}.`);
  console.log(runningHint(other.mode, stopCommand));
  if (wantBrowser && !opened) {
    await runtime.notify(`Lyren Plan is already running at ${other.url}\n\nThe browser could not be opened: open that address in your browser.`, 'Information', {
      wait: true,
    });
  }
  // Leave the message readable for a moment when this window closes by itself.
  if (process.stdout.isTTY) await new Promise((r) => setTimeout(r, 3000));
}

/**
 * Create the folder that holds the database, or exit with an explanation (a drive that isn't
 * there, a file in the way, no permission). Returns warnings about who else can read it (Windows).
 */
function prepareDataFolder(config: Config): string[] {
  const dir = path.dirname(config.dbPath);
  let created: string | undefined;
  try {
    created = fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    for (const line of dbOpenFailureMessage(config.dbPath, err, process.getuid?.(), 'desktop')) console.error(line);
    return exitWith(1);
  }
  if (process.platform !== 'win32') return []; // created 0700 (umask 077, see sea.ts)
  return created !== undefined ? protectNewDataFolder(dir) : checkExistingDataFolder(dir);
}

const isWildcard = (host: string) => ['0.0.0.0', '::', ''].includes(host.trim());

export async function serveDesktop({ defaults, embedded, exe = 'lyren-plan', runtime = consoleRuntime(), noBrowserOption = false }: DesktopServeOptions): Promise<void> {
  const config = loadConfigOrExit(defaults);
  // Root on another user's data folder stops before it writes anything there (§9.2; not on Windows).
  checkOwner(config);
  const explicitPort = Boolean(process.env.PORT?.trim());
  // Like every boolean variable: unset means the default, set means true only for 1/true/yes/on.
  const wantBrowser = envBool('OPEN_BROWSER', true);
  const files = desktopFiles(config.dbPath);
  const stateFile = files.stateFile;
  const windows = process.platform === 'win32';
  const dbPathShown = separateDbPath(config, windows);
  const where = dbPathShown ? `the database ${dbPathShown}` : `the data folder ${config.dataDir}`;
  // The stop command for a Command Prompt opened later: with the option that reaches this database.
  const stopCommand = commandLine(exe, 'stop', commandTargetOption(config, defaults.dataDir, windows));

  // ---- One server per database ---------------------------------------------------------------
  const secret = randomBytes(32).toString('hex');
  const instance = await acquireInstanceLock({
    name: instancePipeName(canonicalDbPath(config.dbPath)),
    secret,
    readSecret: () => readStateOf(files).secret ?? null,
    onWaiting: () => {
      console.log(`Waiting for the Lyren Plan that is already running with ${dbPathShown ? 'this database' : 'this data folder'} to answer...`);
      // Without a console: say so, else nothing would happen on the screen for up to 15 s.
      void runtime.notify(waitingMessage(where, noBrowserReason(wantBrowser, noBrowserOption)), 'Information');
    },
  });
  if (!instance.held) return openRunning(instance.other, where, () => readStateOf(files), wantBrowser, runtime, stopCommand);
  const lock = instance.lock;

  // ---- The icon in the notification area (tray and terminal mode) ----------------------------
  const iconMode = runtime.mode === 'tray' || runtime.mode === 'terminal' ? runtime.mode : null;
  const desktop: DesktopDeps = {
    exe,
    exeFolder: isSea() ? path.dirname(process.execPath) : null,
    windows: process.platform === 'win32',
    defaultDataDir: defaults.dataDir,
    ...(iconMode ? { stopMode: iconMode } : {}),
  };
  const running: {
    stop: ((reason: string) => void) | null;
    /** A stop (or a crash) has begun: the start must not go on (open the browser, print the banner). */
    stopping: boolean;
    onAction: ((id: string) => void) | null;
    trayFailure: string | null;
    afterStop: (() => Promise<void>) | null;
  } = { stop: null, stopping: false, onAction: null, trayFailure: null, afterStop: null };
  const tray =
    iconMode === null
      ? null
      : new TrayHost({
          tooltip: trayTooltip(null),
          menu: trayMenu({ lan: isWildcard(config.host) }),
          icon: runtime.trayIcon(),
          parentPid: process.pid,
          onAction: (id) => running.onAction?.(id),
          onSessionEnding: () => running.stop?.('Windows is ending the session'),
          onFailed: (reason) => {
            running.trayFailure = reason;
            if (running.stop) trayFailed(reason);
          },
          log: (line) => runtime.log?.note(line),
          testHooks: runtime.hooks.trayControl !== null,
          constrained: runtime.hooks.powershellClm,
        });
  tray?.start();
  runtime.beforeFatal = async () => {
    await tray?.close();
  };

  const opened: { stack: NodeStack | null } = { stack: null };
  /** The port listened on, once known (the LAN origins of copied links need it). */
  let listening: number | null = null;
  /** The setup code while no account exists: shown, in the setup link and in desktop.json. */
  let setupCode: string | null = null;
  // The setup code goes to the page the browser opens (and desktop.json), never into the log file,
  // which users attach to bug reports. Starting the app again opens the page with it once more.
  const showSetupCode = (code: string) => {
    runtime.log?.redact(code);
    setupCode = code;
  };
  let started: Awaited<ReturnType<typeof start>>;
  try {
    started = await start();
  } catch (err) {
    // Release the instance name and the databases before runDesktopCli waits for Enter.
    try {
      opened.stack?.close();
    } catch {
      /* already closed */
    }
    lock.close();
    throw err;
  }
  const { stack, server, web, port, skipped, usualPort, folderWarnings } = started;

  async function start() {
    const folderWarnings = prepareDataFolder(config);
    // The log file goes next to desktop.json, in the folder just made private.
    runtime.log?.open(files.logDir, files.logName);
    const state = readStateOf(files);
    writeDesktopState(stateFile, { port: state.port, secret });

    // ---- Data and app (after the instance lock: only this run may upgrade or restore the data) ----
    let web: StaticSource | null = null;
    if (config.webDir) web = diskSource(config.webDir);
    else if (process.env.WEB_DIR === undefined) web = embedded;
    const stack = openStackOrExit(
      config,
      {
        mode: 'serve',
        web,
        desktop,
        // Copied invitation and reset links name an address other devices can open (§9.7).
        lanUrls: () => (listening === null ? [] : lanUrls(config.host, listening, os.networkInterfaces())),
        // A code generated while running (§5.8.1): shown like the first one, and printed.
        onSetupCode: (code) => {
          showSetupCode(code);
          writeDesktopState(stateFile, { ...readDesktopState(stateFile), secret, setupCode: code });
          console.log(`  Setup code: ${code}`);
        },
      },
      'desktop',
    );
    opened.stack = stack;
    if (stack.setupCode) showSetupCode(stack.setupCode);

    // ---- Listen --------------------------------------------------------------------------------
    const server = createAdaptorServer({ fetch: stack.app.fetch });
    const ports = candidatePorts({ port: config.port, explicit: explicitPort, remembered: state.port, span: DESKTOP_PORT_SPAN });
    // Windows lets two programs listen on one port (127.0.0.1 and 0.0.0.0): ask the port first.
    const probe = process.platform === 'win32' ? connectProbe(connectHost(config.host)) : undefined;
    let port: number;
    let skipped: Array<{ port: number; code: string }>;
    try {
      ({ port, skipped } = await listenOnFirstAvailable(server, config.host, ports, probe));
    } catch (err) {
      if (ports.length > 1 && isPortUnavailable(err)) {
        console.error(`Lyren Plan found no free port: ${ports.join(', ')} are all taken.`);
        console.error('Start it with another port, e.g. --port 8090 (or set PORT), or close the programs that use them.');
      } else {
        const lines = listenFailureMessage(err, config.host, ports[0]!, 'desktop');
        if (lines) for (const line of lines) console.error(line);
        else console.error(err);
      }
      return exitWith(1);
    }
    // A remembered port that was taken this time stays remembered (see portToRemember).
    const { remember, usual: usualPort } = portToRemember({ explicit: explicitPort, remembered: state.port, used: port });
    listening = port;
    writeDesktopState(stateFile, { port: remember, secret, ...(setupCode ? { setupCode } : {}) });
    return { stack, server, web, port, skipped, usualPort, folderWarnings };
  }

  const url = appUrl(config.host, port);
  // The stack runs the hourly maintenance; closing it closes every database.
  const stop = installShutdown({
    server,
    db: stack,
    lock,
    // A crash: show its own message, not everything printed to stderr since the start.
    waitForEnter: (message) => runtime.fatal(message),
    onStopping: () => {
      running.stopping = true;
    },
    beforeExit: async () => {
      await tray?.close();
      await running.afterStop?.();
      runtime.log?.close();
    },
  });
  running.stop = stop;
  lock.ready(url, { mode: desktop.stopMode, onStop: () => stop('stop command') });
  let browserOpened = false;

  /**
   * The icon can't be shown. Tray mode: stop, and start again in a console window, which can be
   * stopped. Terminal mode: keep running in the terminal.
   */
  let trayFailureHandled = false;
  function trayFailed(reason: string): void {
    if (trayFailureHandled) return;
    trayFailureHandled = true;
    if (runtime.mode === 'terminal') {
      console.error(`Note: the Lyren Plan icon could not be shown in the notification area (${reason}).`);
      console.error('Press Ctrl+C here (or close this window) to stop Lyren Plan.');
      delete desktop.stopMode;
      return;
    }
    console.error(`The Lyren Plan icon could not be shown in the notification area (${reason}).`);
    console.error('Lyren Plan stops and starts again in a console window.');
    running.afterStop = async () => {
      const args = [...runtime.args.filter((a) => a !== '--console'), '--console', ...(browserOpened ? ['--no-browser'] : [])];
      // The same setup code as the page the browser may already show.
      const env: Record<string, string> = setupCode ? { SETUP_TOKEN: setupCode } : {};
      if (await relaunchInConsole(runtime.exePath, args, env)) {
        runtime.log?.note('Lyren Plan continues in a console window.');
        return;
      }
      const text =
        `The Lyren Plan icon could not be shown in the notification area (${reason}), and a console window could not be opened either, so Lyren Plan has stopped.\n\n` +
        'Start it from Command Prompt or PowerShell instead: it then runs in that window.';
      runtime.log?.note(text.replace(/\n+/g, ' '));
      await runtime.notify(text, 'Error', { wait: true });
    };
    stop('the icon could not be shown');
  }

  // ---- The menu of the icon ------------------------------------------------------------------
  const dataFolder = fs.existsSync(config.dataDir) ? config.dataDir : path.dirname(config.dbPath);
  const lanAddresses = () => lanUrls(config.host, port, os.networkInterfaces());
  running.onAction = (id) => {
    if (id === 'open') {
      // Before the first account exists: the setup page with the code, like the first start.
      const users = Number(stack.directoryDb.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')?.n ?? 0);
      const target = browserTarget({ platform: process.platform, url, setupRequired: setupCode !== null && users === 0, setupCode });
      void openBrowser(target.url, runtime.hooks).then((ok) => {
        if (!ok) void runtime.notify(`The browser could not be opened. Open this address in your browser:\n\n${url}`, 'Information');
      });
    } else if (id === 'folder') {
      void openFolder(dataFolder).then((result) => {
        if (result === 'too-long') {
          void runtime.notify(
            `File Explorer can't open the data folder: its path is longer than ${MAX_EXPLORER_PATH} characters. It is:\n\n${dataFolder}`,
            'Information',
          );
        } else if (result === 'failed') {
          void runtime.notify(`The data folder could not be opened. It is:\n\n${dataFolder}`, 'Information');
        }
      });
    } else if (id === 'copy-lan') {
      const lanUrl = lanAddresses()[0];
      if (lanUrl) tray?.copy(lanUrl);
      else void runtime.notify('No network address found for other devices (is this computer connected to a network?).', 'Information');
    } else if (id === 'quit') {
      stop('Quit in the notification area');
    }
  };
  if (tray) {
    tray.setTooltip(trayTooltip(url));
    if (runtime.hooks.trayControl) pollTrayControl(runtime.hooks.trayControl, tray);
    // Without the icon in tray mode nothing could stop this run: switch to a console window
    // before the browser opens (the new run opens it).
    await tray.settled(TRAY_SETTLE_MS);
    if (running.stopping) return;
    if (running.trayFailure !== null) {
      trayFailed(running.trayFailure);
      if (runtime.mode === 'tray') return;
    }
  }

  // ---- Tell the user ---------------------------------------------------------------------------
  if (running.stopping) return;
  if (process.platform === 'win32') process.title = `Lyren Plan - ${url}`;
  const clientMissing = config.webDir !== null && !hasWebClient(config.webDir);
  const target = browserTarget({ platform: process.platform, url, setupRequired: setupCode !== null && !clientMissing, setupCode });
  browserOpened = wantBrowser && web !== null && (await openBrowser(target.url, runtime.hooks));
  if (running.stopping) return;
  const lan = isWildcard(config.host);
  const info: BannerInfo = {
    version: APP_VERSION,
    url,
    lan,
    lanUrls: lanAddresses(),
    dataDir: config.dataDir,
    dbPath: separateDbPath(config, process.platform === 'win32'),
    setupCode,
    setupCodeFilledIn: target.codeFilledIn,
    browserOpened,
    skippedPorts: skipped,
    usualPort,
    warnings: folderWarnings,
    stopVia: iconMode ?? 'window',
    stopCommand,
  };
  for (const line of bannerLines(info)) console.log(line);
  if (config.webDir) console.log(`  Web client from ${config.webDir}`);
  if (!web) console.log(process.env.WEB_DIR === undefined ? '  Web UI: not served (no embedded client; set WEB_DIR)' : '  Web UI: not served (WEB_DIR empty)');
  if (clientMissing) for (const line of missingWebClientMessage(config.webDir!)) console.warn(line);

  // Without a console, what the banner says beyond the usual goes into message boxes.
  if (runtime.mode === 'tray') {
    if (wantBrowser && web !== null && !browserOpened) {
      const code = setupCode ? `\n\nFirst start: create your account there with the setup code ${setupCode}` : '';
      void runtime.notify(`Lyren Plan is running at ${url}\n\nThe browser could not be opened: open that address in your browser.${code}`, 'Information');
    }
    const notices = bannerNotices(info)
      .map((line) => line.replace(/^ {2}/, ''))
      .join('\n')
      .trim();
    if (notices) void runtime.notify(`Lyren Plan is running at ${url}\n\n${notices}`, 'Warning');
  }
}

/** LYREN_TEST_TRAY_CONTROL (hooks.ts): pass each line of `file` to the helper as a test operation. */
function pollTrayControl(file: string, tray: TrayHost): void {
  const timer = setInterval(() => {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
      fs.rmSync(file, { force: true });
    } catch {
      return;
    }
    for (const op of text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) tray.test(op);
  }, TRAY_CONTROL_POLL_MS);
  timer.unref();
}

/** What installShutdown needs; a parameter so that tests can pass fakes. */
export interface ShutdownDeps {
  server: { close(callback?: (err?: Error) => void): unknown; closeIdleConnections?(): void; closeAllConnections?(): void };
  /** What holds the databases (the Node stack): closed before exit. */
  db: { close(): void };
  lock: { close(): void };
  /** A timer to stop with the server. */
  timer?: NodeJS.Timeout;
  proc?: { on(event: string, listener: (arg?: unknown) => void): unknown; exit(code: number): void };
  /**
   * Shows a crash and resolves once the user has seen it (console: Enter; tray: a message box).
   * `message`: the crash's text as printed ("Lyren Plan stopped because of an unexpected error:" and
   * the error).
   */
  waitForEnter?: (message: string) => Promise<void>;
  /** Called once when a stop or a crash begins (serve.ts: the start must not go on). */
  onStopping?: () => void;
  /** Runs after the database and the instance name are closed, before exit 0 (e.g. removing the tray icon). */
  beforeExit?: () => Promise<void>;
}

/**
 * Stop signals close the server and then the database (exit 0); the returned function does the
 * same for other reasons (Quit in the notification area, the stop command, the end of the Windows
 * session). An unexpected error closes the server, the instance name and the database at once (so
 * a second start doesn't open the browser at a broken server), shows the error and waits for
 * Enter; a stop signal then ends it at once.
 */
export function installShutdown({
  server,
  db,
  lock,
  timer,
  proc = process,
  waitForEnter: wait = () => waitForEnter(),
  onStopping,
  beforeExit,
}: ShutdownDeps): (reason: string) => void {
  let closing = false;
  let crashed = false;
  let finished = false;
  const closeDb = () => {
    try {
      db.close(); // checkpoints the WAL into lyren.db and removes lyren.db-wal / -shm
    } catch {
      /* already closed */
    }
  };
  const finish = (code: number) => {
    if (finished) return;
    finished = true;
    closeDb();
    lock.close();
    if (!beforeExit) return proc.exit(code);
    void beforeExit()
      .catch(() => undefined)
      .then(() => proc.exit(code));
  };
  const shutdown = (reason: string) => {
    if (closing) {
      if (crashed) proc.exit(1);
      return;
    }
    closing = true;
    onStopping?.();
    console.log(`Stopping Lyren Plan (${reason})...`);
    clearInterval(timer);
    server.close(() => finish(0));
    server.closeIdleConnections?.();
    setTimeout(() => finish(0), SHUTDOWN_GRACE_MS).unref();
  };
  for (const signal of STOP_SIGNALS) proc.on(signal, () => shutdown(signal));

  // A crash must not close the window before the message can be read.
  const crash = (err: unknown) => {
    if (closing) return;
    closing = true;
    crashed = true;
    onStopping?.();
    const intro = 'Lyren Plan stopped because of an unexpected error:';
    console.error(intro);
    console.error(err);
    clearInterval(timer);
    try {
      server.close();
      server.closeAllConnections?.();
    } catch {
      /* not listening */
    }
    lock.close();
    closeDb();
    void wait(`${intro}\n${inspect(err)}`).then(() => proc.exit(1));
  };
  proc.on('uncaughtException', crash);
  proc.on('unhandledRejection', crash);
  return shutdown;
}
