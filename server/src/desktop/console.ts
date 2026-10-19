// What the desktop app prints in its console window, written for someone who double-clicked it;
// in tray mode (mode.ts) the same goes to the log file, and the notices also to a message box.

/**
 * The shell a printed command is written for: Command Prompt, Windows PowerShell, or a POSIX shell
 * (Linux, macOS).
 */
export type CommandShell = 'cmd' | 'powershell' | 'posix';

/** A command line as the app prints it, and the shell it is written for. */
export interface ShellCommand {
  shell: CommandShell;
  text: string;
}

/**
 * The shell for a command that contains `values` (the program's file name, a folder, a file).
 * Command Prompt replaces %NAME% with that variable's value even inside double quotes, and its
 * command line has no way to prevent it (a folder "R&D 100%PATH%" would arrive with the PATH in
 * it), so on Windows a command with a % in it is written for PowerShell, whose single-quoted strings
 * take every character as it is. The same rule as the web client's commandShell.
 */
export function commandShell(values: readonly string[], platform: NodeJS.Platform = process.platform): CommandShell {
  if (platform !== 'win32') return 'posix';
  return values.some((value) => value.includes('%')) ? 'powershell' : 'cmd';
}

/**
 * A PowerShell single-quoted string. PowerShell ends such a string at any single quotation mark,
 * the typographic ones too (‘ ’ ‚ ‛, e.g. in a folder named "Dana’s Apps"), and each is kept by
 * doubling it. Nothing else is special in it ($, `, %, &, ^ ...).
 */
export function psQuote(value: string): string {
  return `'${value.replace(/['\u2018\u2019\u201A\u201B]/g, (q) => q + q)}'`;
}

/**
 * The characters for which Windows PowerShell 5.1 puts a program's argument in double quotes: .NET
 * Framework's char.IsWhiteSpace (measured on Windows 11 25H2: U+180E, U+200B and U+FEFF are not).
 */
const PS51_QUOTES_ARG = /[\t\n\v\f\r \u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/;

/**
 * The text of a program's argument as PowerShell must be given it so that the program receives
 * `value`. Windows PowerShell 5.1 wraps an argument with whitespace in double quotes without
 * escaping the backslashes before the closing quote, so `\\nas\Lyren 100%\` (the root of a share
 * keeps its backslash) would reach the program as `\\nas\Lyren 100%"`. There, a trailing run of
 * backslashes is doubled (`"\\nas\Lyren 100%\\"` then reaches it as meant); without whitespace 5.1
 * passes the text as it is. (PowerShell 7 escapes correctly and so passes the doubled backslashes
 * on, which a path does not mind: config.ts resolves it, and icacls accepts it, measured.)
 */
export function ps51ArgText(value: string): string {
  return PS51_QUOTES_ARG.test(value) ? value.replace(/\\+$/, (s) => s + s) : value;
}

/** A program's argument in PowerShell: single-quoted (psQuote), as ps51ArgText needs it. */
export function psArg(value: string): string {
  return psQuote(ps51ArgText(value));
}

/**
 * How to type the program's name in a command line: in Command Prompt quoted when it contains a
 * space or a character cmd treats specially (e.g. after renaming it to "Lyren Plan.exe"); in
 * PowerShell (see commandShell) as `& '.\<name>'`; on Linux / macOS with ./ and single quotes when
 * needed.
 */
export function commandName(exe: string, platform: NodeJS.Platform = process.platform, shell: CommandShell = commandShell([exe], platform)): string {
  if (shell === 'powershell') return `& ${psQuote(`.\\${exe}`)}`;
  if (shell === 'cmd') return /[\s&()^%!;,=<>|"'`@[\]{}+~]/.test(exe) ? `"${exe.replaceAll('"', '')}"` : exe;
  const run = `./${exe}`;
  return /^[\w@%+=:,./-]+$/.test(run) ? run : `'${run.replaceAll("'", `'\\''`)}'`;
}

/**
 * One argument as typed in Command Prompt (always in double quotes, a trailing backslash doubled so
 * that `"D:\"` does not hand the program `D:"`; Windows names can't contain a double quote), in
 * PowerShell (single-quoted, a trailing backslash doubled where Windows PowerShell 5.1 needs it:
 * psArg) or in a POSIX shell (single quotes when needed). The same rule as the web client's shellArg.
 */
export function shellArg(value: string, shell: CommandShell): string {
  if (shell === 'cmd') return `"${value.replaceAll('"', '').replace(/\\+$/, (s) => s + s)}"`;
  if (shell === 'powershell') return psArg(value);
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The option that points a command at the running database (runtime/node/desktop.ts commandTargetOption). */
export interface TargetOption {
  name: '--db-path' | '--data-dir';
  value: string;
}

/**
 * `<program> <command> [--db-path <file> | --data-dir <folder>]`, as typed in Command Prompt, in
 * PowerShell when Command Prompt would change it (a % in it, see commandShell), or in a terminal.
 */
export function commandLine(exe: string, command: string, option: TargetOption | null, platform: NodeJS.Platform = process.platform): ShellCommand {
  const shell = commandShell(option ? [exe, option.value] : [exe], platform);
  const text = `${commandName(exe, platform, shell)} ${command}${option ? ` ${option.name} ${shellArg(option.value, shell)}` : ''}`;
  return { shell, text };
}

/** "run: <command>", or "run in PowerShell: <command>" for a command that must not go to Command Prompt. */
export function howToRun(command: ShellCommand): string {
  return command.shell === 'powershell' ? `run in PowerShell: ${command.text}` : `run: ${command.text}`;
}

export interface BannerInfo {
  version: string;
  /** The app's address on this computer. */
  url: string;
  /** Addresses for other devices (HOST=0.0.0.0), empty otherwise. */
  lanUrls: string[];
  /** Whether the server accepts connections from other devices at all. */
  lan: boolean;
  dataDir: string;
  /** Printed when the database is not in dataDir (DB_PATH). */
  dbPath: string | null;
  /** First start: the setup code, else null. */
  setupCode: string | null;
  /** Whether the page the browser opened has the setup code filled in (Windows, see browserTarget). */
  setupCodeFilledIn: boolean;
  browserOpened: boolean;
  /** Ports that were tried and found taken before the one in `url`. */
  skippedPorts: Array<{ port: number; code: string }>;
  /**
   * The port remembered from earlier starts when it was taken this time (it stays remembered, so
   * the address returns to it once it is free), else null.
   */
  usualPort: number | null;
  /** Warnings to show, e.g. about the data folder's permissions. */
  warnings: string[];
  /**
   * How it is stopped (mode.ts): 'window' (its console window, the default), 'terminal' (the
   * terminal it was started in, and its icon in the notification area) or 'tray' (the icon only;
   * the banner goes to the log file).
   */
  stopVia?: 'window' | 'terminal' | 'tray';
  /** The stop command, e.g. `lyren-plan.exe stop` (tray; commandLine). */
  stopCommand?: ShellCommand;
}

/**
 * The port notes and warnings of the banner, indented: what a user without a console must also be
 * told (serve.ts shows them in a message box in tray mode).
 */
export function bannerNotices(info: BannerInfo): string[] {
  const lines: string[] = [];
  const port = new URL(info.url).port;
  if (info.usualPort !== null) {
    const reserved = info.skippedPorts.find((p) => p.port === info.usualPort)?.code === 'EACCES';
    const usual = new URL(info.url);
    usual.port = String(info.usualPort);
    lines.push(
      '',
      `  Warning: Lyren Plan's usual address ${usual.href} ${reserved ? 'is reserved by Windows' : 'is used by another program'},`,
      `  so this time it runs at ${info.url} (its data is the same).`,
      ...(reserved
        ? ['  Bookmarks and an installed app made for the usual address do not reach it now.']
        : ['  Bookmarks and an installed app made for the usual address now reach that other program:', '  do not sign in there.']),
      '  Lyren Plan returns to its usual address once that is free again (close the other program',
      '  and start Lyren Plan again). To choose the port yourself, start it with --port <number>.',
    );
  } else if (info.skippedPorts.length > 0) {
    const first = info.skippedPorts[0]!;
    const why = first.code === 'EACCES' ? 'is reserved by Windows' : 'is used by another program';
    lines.push(
      '',
      `  Note: port ${first.port} ${why}, so Lyren Plan uses port ${port} instead and will try it`,
      '  first next time. Bookmarks or an installed app made for the old address do not reach it;',
      '  to choose the port yourself, start Lyren Plan with --port <number>.',
    );
  }
  if (info.warnings.length > 0) lines.push('', ...info.warnings.map((w) => `  ${w}`));
  return lines;
}

/** The banner's last line(s): how to keep Lyren Plan running and how to stop it. */
export function stopLines(stopVia: BannerInfo['stopVia'] = 'window', stopCommand: ShellCommand = { shell: 'cmd', text: 'lyren-plan stop' }): string[] {
  if (stopVia === 'tray') {
    return [
      '  Lyren Plan keeps running in the notification area (near the clock). To stop it, right-click',
      `  its icon and choose Quit Lyren Plan, or ${howToRun(stopCommand)}`,
    ];
  }
  if (stopVia === 'terminal') {
    return [
      '  Keep this window open while you use Lyren Plan. To stop it, press Ctrl+C or close this window,',
      '  or right-click the Lyren Plan icon in the notification area (near the clock) and choose Quit Lyren Plan.',
    ];
  }
  return ['  Keep this window open while you use Lyren Plan. To stop it, close this window or press Ctrl+C.'];
}

export function bannerLines(info: BannerInfo): string[] {
  const lines = ['', `  Lyren Plan ${info.version} is running.`, ''];
  lines.push(`  Open it at:      ${info.url}`);
  if (info.lan) {
    if (info.lanUrls.length > 0) {
      lines.push(`  Other devices:   ${info.lanUrls[0]}${info.lanUrls.length > 1 ? '' : '  (phones, tablets, other computers)'}`);
      for (const u of info.lanUrls.slice(1)) lines.push(`                   ${u}`);
    } else {
      lines.push('  Other devices:   no network address found (is this computer connected to a network?)');
    }
  }
  lines.push(`  Data folder:     ${info.dataDir}`);
  if (info.dbPath) lines.push(`  Database:        ${info.dbPath}`);
  lines.push(...bannerNotices(info));
  if (info.setupCode) {
    const hint = !info.browserOpened ? '' : info.setupCodeFilledIn ? '  (already filled in on the page that opened)' : '  (enter it on the page that opened)';
    lines.push('', '  First start: create your account in the browser.', `  Setup code:      ${info.setupCode}${hint}`);
  }
  lines.push(
    '',
    info.browserOpened ? '  The app has been opened in your browser.' : '  Open the address above in your browser.',
    ...stopLines(info.stopVia, info.stopCommand),
    '',
  );
  return lines;
}

/**
 * When the window would otherwise close at once (an error at start-up of a double-clicked app),
 * wait for Enter so the message can be read. Returns at once when stdin is not a terminal.
 */
export function waitForEnter(prompt = 'Press Enter to close this window.'): Promise<void> {
  if (!process.stdin.isTTY) return Promise.resolve();
  process.stdout.write(`\n${prompt}\n`);
  return new Promise((resolve) => {
    const done = () => {
      process.stdin.pause();
      resolve();
    };
    process.stdin.once('data', done);
    process.stdin.once('end', done);
    process.stdin.resume();
  });
}
