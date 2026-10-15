// The command line shared by both distributions: `serve` (default), `backup <file>`,
// `reset-password <user>` and `help`. index.ts runs it for the Node build and Docker
// (runServerCli); the single-file desktop app (desktop/main.ts) reuses the maintenance commands
// with its own defaults and its own `serve`.
//
// Fatal problems are printed as plain lines and end the command with CliExit(code) (2: bad
// usage or configuration, 1: anything else); the entry point turns that into the exit code.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { LIMITS } from '@shared/constants';
import { passwordSchema } from '@shared/schemas';
import { createApp } from './app';
import { hashPassword } from './auth/passwords';
import { purgeExpiredSessions } from './auth/sessions';
import { APP_VERSION, loadConfig, type Config, type ConfigDefaults } from './config';
import { openDb, stripSessions, type Db } from './db';
import { ensureDefaults } from './db/seed';
import { hasWebClient } from './http/static';
import {
  dbOpenFailureMessage,
  dbOpenProblem,
  listenFailureMessage,
  missingWebClientMessage,
  type Audience,
} from './startupErrors';

const HELP = `Lyren Plan ${APP_VERSION}

Usage:
  node dist/server.mjs                     Start the server (same as "serve")
  node dist/server.mjs serve               Start the server
  node dist/server.mjs backup <file>       Write a consistent database snapshot to <file>
                                           (safe while the server is running; sign-in
                                           sessions are left out)
  node dist/server.mjs reset-password <user>
                                           Set a new password and sign the user out everywhere.
                                           Reads the password from stdin when piped
                                           (echo 'new pass' | ... reset-password owner),
                                           otherwise generates and prints a random one.
  node dist/server.mjs help                Show this help

Environment (defaults):
  PORT=8080             HOST=0.0.0.0           DATA_DIR=./data       DB_PATH=<DATA_DIR>/lyren.db
  TRUST_PROXY=false     Set true behind a reverse proxy (uses X-Forwarded-For/-Proto)
  COOKIE_SECURE=auto    auto | true | false
  SESSION_TTL_DAYS=30   (max 400)
  SETUP_TOKEN=          First-run setup code; random (printed to the log) when unset
  BODY_LIMIT=2097152    Max request body in bytes
  IMPORT_BODY_LIMIT=52428800  Max size of a JSON import
  SNAPSHOT_KEEP=10      Automatic snapshots of each kind kept in backups/ (pre-import-*,
                        lyren-v*-before-upgrade-*); older ones are deleted. 0 = keep all
  WEB_DIR=<dist>/web    Built web client to serve (empty = API only)
  LOG_REQUESTS=false
`;

/** Ends a command with an exit code; its explanation has already been printed. */
export class CliExit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
    this.name = 'CliExit';
  }
}

export function exitWith(code: number): never {
  throw new CliExit(code);
}

/** The piped password is not UTF-8 text (parsePipedPassword). */
export class NotUtf8Error extends Error {
  constructor() {
    super('The piped password is not UTF-8 text');
    this.name = 'NotUtf8Error';
  }
}

/**
 * The password piped to `reset-password`: stdin as UTF-8 without a byte-order mark (PowerShell can
 * send one) and without ONE trailing line break (LF, or CRLF from Windows shells). Bytes that are
 * not UTF-8 throw NotUtf8Error instead of turning into U+FFFD: Command Prompt's `echo` writes in
 * the console code page (437 or 850 by default), so ä would otherwise silently become part of a
 * password nobody can type.
 */
export function parsePipedPassword(raw: Buffer | string): string {
  let text: string;
  if (typeof raw === 'string') {
    text = raw.replace(/^\uFEFF/, '');
  } else {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(raw); // also drops a leading BOM
    } catch {
      throw new NotUtf8Error();
    }
  }
  return text.replace(/\r?\n$/, '');
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return parsePipedPassword(Buffer.concat(chunks));
}

/** What to do about a piped password that is not UTF-8 (`platform` decides the advice). */
export function notUtf8Message(platform: NodeJS.Platform = process.platform): string[] {
  return [
    'The piped password is not UTF-8 text, so it would not be the password you typed. Nothing was changed.',
    platform === 'win32'
      ? 'In Command Prompt run `chcp 65001` first (or use PowerShell 7), or run reset-password without piping to get a random password.'
      : 'Pipe it as UTF-8 text, or run reset-password without piping to get a random password.',
  ];
}

/** The configuration from the environment, or exit with the offending variable named. */
export function loadConfigOrExit(defaults?: ConfigDefaults): Config {
  try {
    return loadConfig({}, defaults);
  } catch (err) {
    console.error((err as Error).message);
    return exitWith(2);
  }
}

/** Open and migrate the database, or exit with an explanation instead of a stack trace. */
export function openDbOrExit(config: Config, audience: Audience = 'server'): Db {
  try {
    return openDb(config.dbPath, { snapshotKeep: config.snapshotKeep });
  } catch (err) {
    for (const line of dbOpenFailureMessage(config.dbPath, err, process.getuid?.(), audience)) console.error(line);
    // Anything else (a failed migration, a corrupt file) keeps its stack for the bug report.
    if (dbOpenProblem(config.dbPath, err) === null) console.error(err);
    return exitWith(1);
  }
}

/** Where a maintenance command looks for the database, and how to point it elsewhere. */
export interface MaintenanceContext {
  defaults?: ConfigDefaults;
  /** Printed when there is no database yet. */
  noDatabaseHint: string;
  audience?: Audience;
  /**
   * reset-password without a password (piped or given) prints a new random one. Set when nobody can
   * read it (the desktop app started without a window by Task Scheduler or a service, or in session
   * 0): these lines are printed instead, nothing is changed, exit 2.
   */
  noRandomPassword?: string[];
}

const SERVER_MAINTENANCE: MaintenanceContext = {
  noDatabaseHint: 'Run this with the same DATA_DIR (or DB_PATH) as the server, e.g. DATA_DIR=/srv/lyren/data.',
};

/** Open the existing database for a maintenance command; never create an empty one. */
function openExistingDb(config: Config, ctx: MaintenanceContext): Db {
  if (!fs.existsSync(config.dbPath)) {
    console.error(`No database at ${config.dbPath}.`);
    console.error(ctx.noDatabaseHint);
    exitWith(1);
  }
  return openDbOrExit(config, ctx.audience);
}

export function backup(file: string | undefined, ctx: MaintenanceContext = SERVER_MAINTENANCE): void {
  if (!file) {
    console.error('Usage: backup <file>');
    exitWith(2);
  }
  if (fs.existsSync(file)) {
    console.error(`${file} already exists; choose a new file name.`);
    exitWith(1);
  }
  const config = loadConfigOrExit(ctx.defaults);
  const db = openExistingDb(config, ctx);
  try {
    db.backupTo(file);
    stripSessions(file);
  } catch (err) {
    console.error(`Backup failed: ${(err as Error).message}`);
    exitWith(1);
  } finally {
    db.close();
  }
  console.log(`Backup written to ${file}`);
}

/**
 * The last line of reset-password. Failed sign-ins are counted in the server's memory (auth/rateLimit.ts),
 * so a restart clears them: of the server (Node build, Docker), or of the app (desktop). The Windows
 * app may run in a console window or as an icon in the notification area (desktop/mode.ts); the
 * command can't tell which, so it names both.
 */
export function lockoutAdvice(audience: Audience = 'server', platform: NodeJS.Platform = process.platform): string {
  if (audience !== 'desktop') return 'If you were locked out by too many attempts, wait 15 minutes or restart the server.';
  return platform === 'win32'
    ? 'If you were locked out by too many attempts, wait 15 minutes, or quit Lyren Plan (choose Quit Lyren Plan from its icon in the notification area, or close its window) and start it again.'
    : 'If you were locked out by too many attempts, wait 15 minutes, or close the Lyren Plan window and start Lyren Plan again.';
}

export async function resetPassword(
  username: string | undefined,
  positionalPassword: string | undefined,
  ctx: MaintenanceContext = SERVER_MAINTENANCE,
): Promise<void> {
  if (!username) {
    console.error('Usage: reset-password <username>');
    exitWith(2);
  }
  if (positionalPassword) {
    console.warn('Warning: passing the password as an argument leaves it in your shell history; pipe it via stdin instead.');
  }
  let password = positionalPassword;
  if (password === undefined && !process.stdin.isTTY) {
    try {
      password = (await readStdin()) || undefined;
    } catch (err) {
      if (!(err instanceof NotUtf8Error)) throw err;
      for (const line of notUtf8Message()) console.error(line);
      exitWith(2);
    }
  }
  if (password === undefined && ctx.noRandomPassword) {
    for (const line of ctx.noRandomPassword) console.error(line);
    exitWith(2);
  }
  // The same rule as sign-in (LIMITS.passwordMin..passwordMax): a password the login form
  // rejects would lock the owner out.
  if (password !== undefined && !passwordSchema.safeParse(password).success) {
    console.error(
      `Password must be ${LIMITS.passwordMin} to ${LIMITS.passwordMax} characters (got ${password.length}). Nothing was changed.`,
    );
    exitWith(2);
  }
  const config = loadConfigOrExit(ctx.defaults);
  const db = openExistingDb(config, ctx);
  try {
    const user = db.get<{ id: number; username: string }>('SELECT id, username FROM users WHERE username = :u', { u: username });
    if (!user) {
      const names = db.all<{ username: string }>('SELECT username FROM users').map((u) => u.username);
      console.error(`No user named "${username}". Existing users: ${names.join(', ') || '(none)'}`);
      exitWith(1);
    }
    const newPassword = password ?? randomBytes(12).toString('base64url');
    const hash = await hashPassword(newPassword);
    db.tx(() => {
      db.run('UPDATE users SET password_hash = :hash, updated_at = :now WHERE id = :id', {
        hash,
        now: new Date().toISOString(),
        id: user.id,
      });
      db.run('DELETE FROM sessions WHERE user_id = :id', { id: user.id });
    });
    console.log(password ? `Password updated for ${user.username}.` : `New password for ${user.username}: ${newPassword}`);
    if (password && !positionalPassword && process.platform === 'win32' && password.includes('?')) {
      // Windows PowerShell 5.1 pipes letters outside ASCII as '?', which can't be detected otherwise.
      console.warn(
        "Note: the new password contains '?'. Windows PowerShell 5.1 turns letters such as ä or é into '?' when it pipes text;",
      );
      console.warn('if you did not type a "?", run the command again in PowerShell 7 or Command Prompt (after chcp 65001).');
    }
    console.log(lockoutAdvice(ctx.audience));
  } finally {
    db.close();
  }
}

/** Name of the temporary copy behind a backup download (routes/data.ts). */
export const BACKUP_TEMP_RE = /^\.backup-[0-9a-f]{16}\.db(?:-journal)?$/;

/**
 * Delete temporary backup-download copies left in `dataDir` by a server that was killed while it
 * was writing one. (Normally the copy is deleted as soon as it is opened for streaming; on
 * Windows a file that another program, e.g. a virus scanner, holds open can't be deleted then.)
 */
export function removeStaleBackupTemps(dataDir: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(dataDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!BACKUP_TEMP_RE.test(name)) continue;
    try {
      fs.rmSync(path.join(dataDir, name), { force: true });
    } catch {
      // Still held open by another program: try again at the next start.
    }
  }
}

/** First start without an account: the setup code (generated unless SETUP_TOKEN is set), else null. */
export function prepareDatabase(db: Db, config: Config): { firstRun: boolean } {
  ensureDefaults(db);
  purgeExpiredSessions(db);
  removeStaleBackupTemps(config.dataDir);
  const hasUsers = Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')!.n) > 0;
  if (!hasUsers && config.setupToken === null) config.setupToken = randomBytes(6).toString('hex');
  return { firstRun: !hasUsers };
}

function startServer(defaults: ConfigDefaults) {
  const config = loadConfigOrExit(defaults);
  const db = openDbOrExit(config);
  const hasUsers = !prepareDatabase(db, config).firstRun;
  const app = createApp({ db, config });

  const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
    console.log(`Lyren Plan ${APP_VERSION} listening on http://${info.address}:${info.port}`);
    console.log(`Database: ${config.dbPath}`);
    if (!config.webDir) console.log('Web UI: not served (WEB_DIR empty)');
    const clientMissing = config.webDir !== null && !hasWebClient(config.webDir);
    if (clientMissing) {
      console.warn('');
      for (const line of missingWebClientMessage(config.webDir!)) console.warn(line);
    }
    if (!hasUsers && config.setupToken) {
      console.log('');
      console.log(
        clientMissing
          ? '  First run: once the web client is built, open the app in your browser and create your account.'
          : '  First run: open the app in your browser and create your account.',
      );
      console.log(`  Setup code: ${config.setupToken}`);
      console.log('');
    }
  });
  server.once('error', (err) => {
    const lines = listenFailureMessage(err, config.host, config.port);
    if (lines) for (const line of lines) console.error(line);
    else console.error(err);
    db.close();
    process.exit(1);
  });

  const timer = setInterval(() => purgeExpiredSessions(db), 60 * 60 * 1000);
  timer.unref();

  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    console.log(`Received ${signal}, shutting down...`);
    clearInterval(timer);
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => {
      try {
        db.close();
      } catch {
        /* already closed */
      }
      process.exit(0);
    }, 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

/** `node dist/server.mjs [command]`: the Node build and Docker. */
export async function runServerCli(argv: string[], defaults: ConfigDefaults): Promise<void> {
  const [cmd = 'serve', ...args] = argv;
  try {
    switch (cmd) {
      case 'serve':
        startServer(defaults);
        break;
      case 'reset-password':
        await resetPassword(args[0], args[1], { ...SERVER_MAINTENANCE, defaults });
        break;
      case 'backup':
        backup(args[0], { ...SERVER_MAINTENANCE, defaults });
        break;
      case 'help':
      case '--help':
      case '-h':
        console.log(HELP);
        break;
      default:
        console.error(`Unknown command: ${cmd}\n`);
        console.log(HELP);
        exitWith(2);
    }
  } catch (err) {
    if (err instanceof CliExit) process.exit(err.code);
    throw err;
  }
}
