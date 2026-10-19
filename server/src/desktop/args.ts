// Command-line options of the desktop app. Each one is a shorthand for an environment variable
// (handy in a Windows shortcut, where variables can't be set), and wins over it.

export interface DesktopArgs {
  /** serve (default), backup, restore, reset-password, promote-admin, policy, spaces, stop, help */
  command: string;
  /** Positional arguments after the command. */
  args: string[];
  /** Environment variables the options set. */
  env: Record<string, string>;
  /** A usage error to report (exit 2), or null. */
  error: string | null;
  /**
   * --console (Windows): run in a console window as before the notification-area icon existed,
   * also when double-clicked (mode.ts). Not a variable: it only decides how this start shows itself.
   */
  console: boolean;
}

const VALUE_OPTIONS: Record<string, string> = { '--port': 'PORT', '--data-dir': 'DATA_DIR', '--db-path': 'DB_PATH' };

/** The example in "--x needs a value, e.g. ...". */
const VALUE_EXAMPLES: Record<string, string> = {
  '--port': '--port 8090',
  '--data-dir': '--data-dir D:\\Lyren',
  '--db-path': '--db-path D:\\Lyren\\plan.db',
};

export function parseDesktopArgs(argv: readonly string[]): DesktopArgs {
  const env: Record<string, string> = {};
  const positional: string[] = [];
  let error: string | null = null;
  let help = false;
  let inConsole = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg === '--help' || arg === '-h' || arg === '/?') {
      help = true;
      continue;
    }
    if (arg === '--no-browser') {
      env.OPEN_BROWSER = 'false';
      continue;
    }
    if (arg === '--lan') {
      env.HOST = '0.0.0.0';
      continue;
    }
    if (arg === '--console') {
      inConsole = true;
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    const variable = VALUE_OPTIONS[name];
    if (variable) {
      const value = eq > 0 ? arg.slice(eq + 1) : argv[++i];
      if (value === undefined || value === '') error ??= `${name} needs a value, e.g. ${VALUE_EXAMPLES[name]}`;
      else env[variable] = value;
      continue;
    }
    if (arg.startsWith('--')) {
      error ??= `Unknown option: ${arg}`;
      continue;
    }
    positional.push(arg);
  }
  const [command = 'serve', ...args] = positional;
  return { command: help ? 'help' : command, args, env, error, console: inConsole };
}
