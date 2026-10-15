// Command line of the single-file desktop app (lyren-plan.exe): the same commands as the Node
// build plus `stop`, with desktop defaults (defaults.ts) and options (args.ts). Started without
// arguments, i.e. double-clicked, it runs `serve`, which on Windows shows itself as an icon in the
// notification area instead of a console window (mode.ts).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APP_VERSION, loadConfig, type ConfigDefaults } from '../config';
import { backup, CliExit, exitWith, loadConfigOrExit, resetPassword, type MaintenanceContext } from '../cli';
import type { StaticSource } from '../http/static';
import { separateDbPath } from '../routes/desktop';
import { parseDesktopArgs } from './args';
import { commandLine, commandName, commandShell, howToRun, waitForEnter } from './console';
import { DESKTOP_PORT, DESKTOP_PORT_SPAN, desktopDefaults } from './defaults';
import { testHooks } from './hooks';
import { desktopFiles, readStateOf } from './files';
import { canonicalDbPath, instancePipeName, requestStop } from './instance';
import { commandMode, decideMode, processImage, processSession, stdioState, windowsBuild, type DesktopMode } from './mode';
import { relaunchHidden, relaunchInConsole, takeRelaunchVariables } from './relaunch';
import { createRuntime, type RuntimeMode } from './runtime';
import { serveDesktop } from './serve';

export { commandName } from './console';

export function desktopHelp(exe: string, dataDir: string, platform: NodeJS.Platform = process.platform): string {
  const win = platform === 'win32';
  // Command Prompt would change a % in the program's name (commandShell): then PowerShell commands.
  const shell = commandShell([exe], platform);
  const run = commandName(exe, platform, shell);
  const pipe =
    shell === 'powershell'
      ? `stdin when piped, e.g. in PowerShell:
        'new-password' | ${run} reset-password owner
      (Windows PowerShell 5.1 turns letters outside ASCII into ?; PowerShell 7
      keeps them); otherwise generates and prints a random one.`
      : win
        ? `stdin when piped, e.g. in Command Prompt:
        echo new-password| ${run} reset-password owner
      (first run chcp 65001 if it has letters outside ASCII); otherwise generates
      and prints a random one.`
        : `stdin when piped:
        echo 'new password' | ${run} reset-password owner
      otherwise generates and prints a random one.`;
  const firewall = win
    ? `
                        Windows asks once whether to allow Lyren Plan through the
                        firewall: allow it on private networks only.`
    : '';
  const intro = win
    ? `Double-click ${exe} to start Lyren Plan.
It opens the app in your browser and keeps running without a window, as an icon in
the notification area at the right end of the taskbar (near the clock; Windows may
put it under the ^ arrow). To stop it, right-click the icon and choose Quit Lyren Plan,
or ${howToRun({ shell, text: `${run} stop` })}
Started in Command Prompt or PowerShell, it shows its messages there (and the icon);
Ctrl+C stops it then. Without a window its messages go to the log file
logs\\lyren-plan.log in the data folder (with --db-path: in a logs folder next to the
database, as <name>.log for a database not named lyren.db). If Lyren Plan is already
running, starting it again just opens the browser. Your data is not stored next to
the program, so you can move, rename or replace (update) the program file without
losing anything. Started without a window, for example from a shortcut, backup,
reset-password and stop show their result in a message box and end at once (help:
in a console window). Started by Task Scheduler or a Windows service they show
nothing: their output goes to that log file, and the exit code says whether they
succeeded.`
    : `Run ${exe} to start Lyren Plan.
It opens the app in your browser and keeps running in its own window: keep that window
open while you use Lyren Plan, and close it (or press Ctrl+C in it) to stop. If Lyren Plan
is already running, starting it again just opens the browser. Your data is not stored
next to the program, so you can move, rename or replace (update) the program file
without losing anything.`;
  const consoleOption = win
    ? `
  --console             Run in a console window, without the icon in the notification
                        area, also when started by double-click or from a shortcut.`
    : '';
  const usage =
    shell === 'powershell' ? 'Usage (in PowerShell: Command Prompt would change the % in the name of the program):' : 'Usage:';
  return `Lyren Plan ${APP_VERSION} - desktop app

${intro}

${usage}
  ${run} [serve] [options]
      Start Lyren Plan (the default).
  ${run} stop
      Stop the Lyren Plan that runs with this data folder (or with the given
      --data-dir or --db-path), as ${win ? 'Quit or Ctrl+C' : 'Ctrl+C'} would.
  ${run} backup <file>
      Write a consistent copy of the database to <file> (safe while Lyren Plan is
      running; sign-in sessions are left out).
  ${run} reset-password <user>
      Set a new password and sign the user out everywhere. Reads the password from
      ${pipe}
  ${run} help
      Show this help.

Options (each one sets the environment variable in brackets):${consoleOption}
  --no-browser          Don't open the browser.                    [OPEN_BROWSER=false]
  --lan                 Let other devices on your network (a phone, a tablet) connect.${firewall}
                                                                   [HOST=0.0.0.0]
  --port <number>       Use this port and no other.                [PORT]
  --data-dir <folder>   Keep the data in this folder.              [DATA_DIR]
  --db-path <file>      Use this database file instead of lyren.db in the data
                        folder.                                    [DB_PATH]

Defaults:
  Data folder   ${dataDir}
  Address       http://127.0.0.1:${DESKTOP_PORT}/ (this computer only). When the port is taken by
                another program, the next free one up to ${DESKTOP_PORT + DESKTOP_PORT_SPAN - 1} is used (and
                remembered when that happens on the first start).

The other settings (SESSION_TTL_DAYS, SNAPSHOT_KEEP, SETUP_TOKEN, COOKIE_SECURE,
TRUST_PROXY, LOG_REQUESTS, ...) are environment variables as in the Node version;
see the README.
`;
}

/**
 * `stop`: ask the Lyren Plan that runs with this database to quit (instance.ts requestStop), and wait
 * until it has closed the database. Exit 1 with an explanation when nothing was stopped.
 */
export async function stopRunning(defaults: ConfigDefaults, platform: NodeJS.Platform = process.platform): Promise<void> {
  const config = loadConfigOrExit(defaults);
  const dbPath = separateDbPath(config, platform === 'win32');
  const where = dbPath ? `the database ${dbPath}` : `the data folder ${config.dataDir}`;
  const files = desktopFiles(config.dbPath, platform);
  const res = await requestStop({
    name: instancePipeName(canonicalDbPath(config.dbPath)),
    readSecret: () => readStateOf(files).secret ?? null,
  });
  switch (res.result) {
    case 'stopped':
      console.log(res.url ? `Lyren Plan (${res.url}) has stopped.` : `Lyren Plan (with ${where}) has stopped.`);
      return;
    case 'not-running':
      console.error(`Lyren Plan is not running with ${where}.`);
      break;
    case 'no-secret':
      console.error(`Lyren Plan runs with ${where}, but ${files.stateFile} could not be read, so it can't be asked to stop.`);
      console.error(`Run this as the ${platform === 'win32' ? 'Windows ' : ''}user who started it.`);
      break;
    case 'denied':
      console.error(`Lyren Plan runs with ${where}, but this ${platform === 'win32' ? 'Windows account' : 'user'} may not ask it to stop.`);
      console.error(`Run this as the ${platform === 'win32' ? 'Windows ' : ''}user who started it.`);
      break;
    case 'unverified':
      console.error(`Another program answers as Lyren Plan with ${where}, but could not prove it. Nothing was stopped.`);
      break;
    case 'old-version':
      console.error(`Lyren Plan (${res.url}) runs with ${where}, but it is an older version, which the stop command can't stop.`);
      console.error('Close its window (or press Ctrl+C in it) to stop it.');
      break;
    case 'no-answer':
      console.error(`Lyren Plan runs with ${where} but does not answer.${platform === 'win32' ? ' End it in Task Manager if it does not recover.' : ''}`);
      break;
    case 'refused':
      console.error(`Lyren Plan (${res.url}) did not accept the request to stop.`);
      break;
    case 'still-running':
      console.error(`Lyren Plan (${res.url}) was asked to stop but is still running.`);
      break;
  }
  exitWith(1);
}

export interface DesktopOptions {
  /** The program's file name, for the help text and the web client's instructions (e.g. lyren-plan.exe). */
  exe: string;
  /** The web client embedded in the executable; null when running from source. */
  embedded: StaticSource | null;
  /** Why the embedded web client can't be used ("This copy of Lyren Plan is damaged ..."), else null. */
  damaged?: string | null;
  /** The Windows app (a single executable on win32): no console window when double-clicked (mode.ts). */
  windowsApp?: boolean;
  /** The notification-area icon (.ico) embedded in the executable, or null. */
  trayIcon?: () => Buffer | null;
}

/**
 * Unattended mode (mode.ts commandMode): the log file next to the database the command uses, when
 * the folder that holds it exists (a command never creates a data folder); else null.
 */
function commandLogFile(defaults: ConfigDefaults): { dir: string; name: string } | null {
  try {
    const config = loadConfig({}, defaults);
    if (!fs.existsSync(path.dirname(config.dbPath))) return null;
    const files = desktopFiles(config.dbPath);
    return { dir: files.logDir, name: files.logName };
  } catch {
    return null; // an invalid variable: the command itself says so (in the output)
  }
}

/**
 * The mode of `serve` (mode.ts), after any relaunch it asks for; 'console' unless it is the Windows
 * app. `note` is for the log: why a relaunch it asked for did not happen.
 */
async function serveMode(
  argv: string[],
  forceConsole: boolean,
  windowsApp: boolean,
  relaunched: boolean,
  note: (line: string) => void,
): Promise<Exclude<DesktopMode, `relaunch-${string}`>> {
  if (!windowsApp) return 'console';
  const { hasConsole, redirected } = stdioState();
  const mode = decideMode({
    windowsApp,
    forceConsole,
    hasConsole,
    redirected,
    build: windowsBuild(),
    relaunched,
    parentImage: () => processImage(process.ppid),
  });
  if (mode === 'relaunch-console') {
    // A console window could not be opened: the notification area at least.
    if (await relaunchInConsole(process.execPath, argv)) process.exit(0);
    note('--console: a console window could not be opened, so Lyren Plan runs with its icon in the notification area instead.');
    return 'tray';
  }
  if (mode === 'relaunch-hidden') {
    if (await relaunchHidden(process.execPath, argv)) process.exit(0);
    note('The console window could not be left (starting again without one failed), so Lyren Plan runs in it.');
    return 'terminal';
  }
  return mode;
}

export async function runDesktopCli(cliArgs: string[], { exe, embedded, damaged = null, windowsApp = false, trayIcon = () => null }: DesktopOptions): Promise<void> {
  const { relaunched, message, args: relaunchArgs } = takeRelaunchVariables();
  // A console relaunch (relaunch.ts) passes the original arguments this way, not on the command line.
  const argv = cliArgs.length === 0 && relaunchArgs ? relaunchArgs : cliArgs;
  if (message !== null) {
    // A message box could not be shown: this console window shows the message instead (runtime.ts).
    console.log(message);
    await waitForEnter();
    process.exit(1);
  }
  const parsed = parseDesktopArgs(argv);
  // Options win over the environment. Empty values count as unset: an empty HOST would mean
  // "every interface" and an empty DATA_DIR "the current folder", neither what a user means.
  Object.assign(process.env, parsed.env);
  for (const name of ['HOST', 'PORT', 'DATA_DIR', 'DB_PATH']) if (process.env[name]?.trim() === '') delete process.env[name];
  const defaults = desktopDefaults(process.platform, process.env, os.homedir());
  const help = desktopHelp(exe, defaults.dataDir);
  const serving = parsed.command === 'serve' && !parsed.error;
  // Without a console nobody would see what a command prints. Wherever a person may be at the screen
  // (a shortcut, Win+R, another file manager or launcher, Start-Process) it is shown when the command
  // ends, in a message box that does not keep it running (runtime.showOutput); in session 0 or started
  // by Task Scheduler, a service or WMI it goes to the log file (commandMode).
  let mode: RuntimeMode = 'console';
  const start: { session?: number | null; parent?: string | null } = {};
  const notes: string[] = [];
  if (serving) mode = await serveMode(argv, parsed.console, windowsApp, relaunched, (line) => notes.push(line));
  else if (windowsApp) {
    mode = commandMode({
      windowsApp,
      ...stdioState(),
      session: () => (start.session = processSession(process.pid)),
      parentImage: () => (start.parent = processImage(process.ppid)),
    });
  }
  const maintenance: MaintenanceContext = {
    defaults,
    audience: 'desktop',
    noDatabaseHint:
      'Start Lyren Plan once to create it, or point to the folder that holds lyren.db with --data-dir <folder> (or DATA_DIR),' +
      ' or to the database file with --db-path <file> (or DB_PATH).',
    // Nobody could read a new random password: refuse instead (the password is never logged).
    ...(mode === 'unattended'
      ? {
          noRandomPassword: [
            'reset-password was started without a window by Task Scheduler or a service, so nobody would see a new random password. Nothing was changed.',
            'Run it in Command Prompt or PowerShell, or pipe the new password to it.',
          ],
        }
      : {}),
  };
  const runtime = createRuntime({ mode, exePath: process.execPath, args: argv, hooks: testHooks(), trayIcon });
  if (mode === 'unattended' && parsed.command !== 'help') {
    const logFile = commandLogFile(defaults);
    if (logFile) runtime.log?.open(logFile.dir, logFile.name);
  }
  runtime.log?.note(`Lyren Plan ${APP_VERSION} started (${mode} mode, process ${process.pid}, Windows build ${windowsBuild()}).`);
  if (mode === 'unattended') {
    const by = start.session === 0 ? 'in session 0 (Windows services, no desktop)' : `by ${start.parent}`;
    runtime.log?.note(`Command: ${parsed.command}, started without a window ${by}: nothing is shown, its output follows.`);
  }
  for (const line of notes) runtime.log?.note(line);
  const ended = (code: number) => {
    if (mode === 'unattended') runtime.log?.note(`${parsed.command} ended with exit code ${code}.`);
  };
  try {
    if (damaged) {
      console.error(damaged);
      exitWith(1);
    }
    if (parsed.error) {
      console.error(parsed.error);
      console.error(`To see the options, ${howToRun(commandLine(exe, 'help', null))}`);
      exitWith(2);
    }
    switch (parsed.command) {
      case 'serve':
        await serveDesktop({ defaults, embedded, exe, runtime, noBrowserOption: parsed.env.OPEN_BROWSER === 'false' });
        break;
      case 'stop':
        await stopRunning(defaults);
        break;
      case 'backup':
        backup(parsed.args[0], maintenance);
        break;
      case 'reset-password':
        await resetPassword(parsed.args[0], parsed.args[1], maintenance);
        break;
      case 'help':
        console.log(help);
        break;
      default:
        console.error(`Unknown command: ${parsed.command}\n`);
        console.log(help);
        exitWith(2);
    }
    // Without a console a new password appears in a message box, whose text Ctrl+C copies.
    if (!serving) await runtime.showOutput('Information', parsed.command === 'reset-password' ? '(Ctrl+C copies the text of this message.)' : undefined);
    ended(0);
    // The box stays without this process: exit now (exit code 0), whatever handle might still be open.
    if (mode === 'tray' && !serving) process.exit(0);
  } catch (err) {
    const code = err instanceof CliExit ? err.code : 1;
    if (!(err instanceof CliExit)) console.error(err);
    ended(code);
    // Started by double-click, the window would close before the message could be read (or, without
    // a window, nobody would see it at all). A command without a console shows all it printed, in a
    // box that does not wait (runtime.showOutput); serve (and a damaged exe in a console) waits.
    if (mode === 'tray' && !serving) await runtime.showOutput('Error');
    else if (serving || damaged) await runtime.fatal();
    process.exit(code);
  }
}
