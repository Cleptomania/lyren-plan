// The single-file desktop app's commands as the sign-in page and Administration → Overview show them
// (AuthStatusDTO.desktop / BootstrapDTO.desktop): for Command Prompt on Windows (for PowerShell
// when Command Prompt would change them, see commandShell), for a POSIX shell on Linux and macOS,
// run in the folder that holds the program.

import type { DesktopAppDTO, DesktopDataDTO } from '@shared/types';

const POSIX_PLAIN = /^[\w@%+=:,./-]+$/;

function posixQuote(value: string): string {
  return POSIX_PLAIN.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * A PowerShell single-quoted string. PowerShell ends such a string at any single quotation mark,
 * the typographic ones too (‘ ’ ‚ ‛, e.g. in a folder named "Dana’s Apps"), and each is kept by
 * doubling it. Nothing else is special in it ($, `, %, &, ^ ...).
 */
export const psQuote = (s: string) => `'${s.replace(/['\u2018\u2019\u201A\u201B]/g, (q) => q + q)}'`;

/**
 * The characters for which Windows PowerShell 5.1 puts a program's argument in double quotes: .NET
 * Framework's char.IsWhiteSpace (measured on Windows 11 25H2: U+180E, U+200B and U+FEFF are not).
 */
const PS51_QUOTES_ARG = /[\t\n\v\f\r \u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/;

/**
 * The text of a program's argument as PowerShell must be given it so that the program receives
 * `value`: Windows PowerShell 5.1 wraps an argument with whitespace in double quotes without escaping
 * the backslashes before the closing quote, so `\\nas\Lyren 100%\` (the root of a share keeps its
 * backslash) would arrive as `\\nas\Lyren 100%"`; there a trailing run of backslashes is doubled.
 * (PowerShell 7 passes the doubled backslashes on, which a path does not mind.) The same rule as the
 * app's own texts (server/src/desktop/console.ts ps51ArgText).
 */
export function ps51ArgText(value: string): string {
  return PS51_QUOTES_ARG.test(value) ? value.replace(/\\+$/, (s) => s + s) : value;
}

/** The shell the commands are written for: Command Prompt, Windows PowerShell, or a POSIX shell. */
export type CommandShell = 'cmd' | 'powershell' | 'posix';

/**
 * Which database the maintenance commands must open, as the running app was told: `dbPath` when
 * DB_PATH chose the file (`--db-path`), else `dataDir` when the data folder isn't the default
 * (`--data-dir`). Both null: the default, lyren.db in the per-user data folder.
 */
export interface CommandTarget {
  dataDir: string | null;
  dbPath: string | null;
}

export const DEFAULT_TARGET: CommandTarget = { dataDir: null, dbPath: null };

/**
 * The database the running app opened, as its commands must name it: a command prompt opened later knows
 * nothing of the DATA_DIR or DB_PATH this copy was started with.
 */
export function dataTarget(app: DesktopDataDTO): CommandTarget {
  return { dataDir: app.customDataDir ? app.dataDir : null, dbPath: app.dbPath };
}

/** The option that points a command at `target`'s database (`--db-path` wins), or null for the default. */
export function targetOption(target: CommandTarget): { name: '--db-path' | '--data-dir'; value: string } | null {
  if (target.dbPath !== null) return { name: '--db-path', value: target.dbPath };
  if (target.dataDir !== null) return { name: '--data-dir', value: target.dataDir };
  return null;
}

/**
 * The shell for the commands of `app` with `target`. Command Prompt replaces %NAME% with that
 * variable's value even inside double quotes, and its command line has no way to prevent it (a
 * folder "R&D 100%PATH%" would arrive with the PATH in it), so on Windows the commands are written
 * for PowerShell when the program's name or the folder / file they name has a %. The same rule as
 * the app's own texts (server/src/desktop/console.ts commandShell).
 */
export function commandShell(app: DesktopAppDTO, target: CommandTarget = DEFAULT_TARGET): CommandShell {
  if (!app.windows) return 'posix';
  const option = targetOption(target);
  return [app.exe, option?.value ?? ''].some((value) => value.includes('%')) ? 'powershell' : 'cmd';
}

/**
 * One argument for `shell`. Command Prompt: in double quotes, with a trailing backslash doubled
 * (`"D:\"` would hand the program `D:"`); Windows names can't contain `"`. PowerShell: single-quoted
 * (psQuote), a trailing backslash doubled where Windows PowerShell 5.1 needs it (ps51ArgText). POSIX:
 * single quotes when needed.
 */
export function shellArg(value: string, shell: CommandShell): string {
  if (shell === 'cmd') return `"${value.replaceAll('"', '').replace(/\\+$/, (s) => s + s)}"`;
  if (shell === 'powershell') return psQuote(ps51ArgText(value));
  return posixQuote(value);
}

/**
 * How to start the program from its own folder: `"lyren-plan-0.1.0-win-x64.exe"` (always quoted,
 * so a copy renamed to "Lyren Plan.exe" works too), `& '.\lyren-plan-0.1.0-win-x64.exe'` in
 * PowerShell, or `./lyren-plan-0.1.0-linux-x64`.
 */
export function programCommand(app: DesktopAppDTO, shell: CommandShell = commandShell(app)): string {
  if (shell === 'powershell') return `& ${psQuote(`.\\${app.exe}`)}`;
  return shell === 'cmd' ? shellArg(app.exe, 'cmd') : posixQuote(`./${app.exe}`);
}

/** Where to type the commands: Command Prompt or PowerShell (commandShell) on Windows, else a terminal. */
export function shellName(shell: CommandShell): string {
  return shell === 'cmd' ? 'Command Prompt' : shell === 'powershell' ? 'PowerShell' : 'a terminal';
}

/** Windows: what to type in a folder's address bar in File Explorer to open `shell` there. */
export function shellProgram(shell: CommandShell): string {
  return shell === 'powershell' ? 'powershell' : 'cmd';
}

/**
 * `<program> <command> [args] [--db-path <file> | --data-dir <folder>]` for commandShell(app,
 * target): an option only when it isn't the default. `args` must be written for that shell.
 */
export function desktopCommand(app: DesktopAppDTO, args: string, target: CommandTarget = DEFAULT_TARGET): string {
  const shell = commandShell(app, target);
  const option = targetOption(target);
  return `${programCommand(app, shell)} ${args}${option ? ` ${option.name} ${shellArg(option.value, shell)}` : ''}`;
}

// ---------------------------------------------------------------------------
// Stopping the app, as it runs now (DesktopAppDTO.stopMode)
// ---------------------------------------------------------------------------

const QUIT_FROM_ICON = 'right-click its icon in the notification area (near the clock) and choose Quit Lyren Plan';

/** The first step of a restore: stop Lyren Plan the way it runs. */
export function stopStep({ stopMode }: DesktopAppDTO): string {
  if (stopMode === 'tray') return `Quit Lyren Plan: ${QUIT_FROM_ICON}.`;
  if (stopMode === 'terminal') return `Stop Lyren Plan: press Ctrl+C in its window, or ${QUIT_FROM_ICON}.`;
  return 'Close the Lyren Plan window.';
}

/** "Stop Lyren Plan" in Administration → Overview: the usual way, before the stop command. */
export function stopHow({ stopMode }: DesktopAppDTO): string {
  if (stopMode === 'tray') {
    return 'Right-click the Lyren Plan icon in the notification area (near the clock; Windows may put it under the ^ arrow) and choose Quit Lyren Plan.';
  }
  if (stopMode === 'terminal') return `Press Ctrl+C in the window it runs in, or ${QUIT_FROM_ICON}.`;
  return 'Close the Lyren Plan window, or press Ctrl+C in it.';
}
