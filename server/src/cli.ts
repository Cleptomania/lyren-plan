// The command line shared by both distributions (design §9.6): `serve` (default), `backup <file>`,
// `restore <file|->`, `reset-password <email-or-username>`, `promote-admin <email-or-username>`,
// `policy [open|invite_only|closed]`, `spaces` and `help`. index.ts runs it for the Node build and Docker
// (runServerCli); the single-file desktop app (desktop/main.ts) reuses the maintenance commands
// with its own defaults and its own `serve`. Every command opens the data through openNodeStack
// (runtime/node/stack.ts): `serve` to run it, the others in maintenance mode; `restore` only stages
// (runtime/node/restore.ts) and opens nothing. Before it touches any file, every command but help runs
// the owner check (§9.2), and every maintenance command refuses while a restore is staged.
//
// Fatal problems are printed as plain lines and end the command with CliExit(code) (2: bad
// usage or configuration, 1: anything else); the entry point turns that into the exit code.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { LIMITS, SIGNUP_POLICIES, type SignupPolicy } from '@shared/constants';
import { APP_VERSION, loadConfig, type Config, type ConfigDefaults } from './config';
import { ConfigError } from './core/config';
import type { Db } from './core/db';
import { systemClock } from './core/runtime';
import { revokeDevices } from './directory/devices';
import { sendsTokens } from './directory/mailer';
import { PasswordHasher } from './directory/passwords';
import { recordEvent } from './directory/security';
import { getInstanceSettings, setSignupPolicy } from './directory/settings';
import { resolveIdentifier, userCount } from './directory/users';
import { HttpError } from './http/errors';
import { hasWebClient } from './http/static';
import { BACKUP_SET_NAME_NOTE, BackupError, writeBackupSet, writeLegacyBackup } from './runtime/node/backupSet';
import { detectLegacy, LEGACY_BACKUP_NOTE } from './runtime/node/legacy';
import { ownerRefusal } from './runtime/node/owner';
import {
  copyToTemp,
  isRestorePending,
  RestoreError,
  restoreNextStep,
  restoreWaitingMessage,
  stageRestore,
  type StagedRestore,
} from './runtime/node/restore';
import { DatabaseOpenError, DataRefusal, openNodeStack, spaceFileBytes, type NodeStack, type NodeStackOptions } from './runtime/node/stack';
import {
  dbOpenFailureMessage,
  dbOpenProblem,
  listenFailureMessage,
  missingWebClientMessage,
  type Audience,
} from './startupErrors';

export { BACKUP_TEMP_RE, removeStaleBackupTemps } from './runtime/node/backupSet';

const HELP = `Lyren Plan ${APP_VERSION}

Usage:
  node dist/server.mjs                     Start the server (same as "serve")
  node dist/server.mjs serve               Start the server
  node dist/server.mjs backup <file>       Write a backup set (.tar) of the accounts and every space
                                           to <file> (safe while the server is running; sign-in
                                           sessions and tokens are left out)
  node dist/server.mjs restore <file|->    Restore a backup set (.tar), one space's database (.db,
                                           such as backups/spaces/<id>/pre-import-<time>.db) or an
                                           old single-file backup (.db) when the server next starts:
                                           restart it then. The current data is moved to
                                           backups/before-restore-<time>/. "-" reads the file from
                                           standard input
  node dist/server.mjs reset-password <email-or-username>
                                           Set a new password, sign the account out everywhere and
                                           clear any lock-out from failed sign-ins. Reads the
                                           password from stdin when piped
                                           (echo 'new pass' | ... reset-password you@example.com),
                                           otherwise generates and prints a random one.
  node dist/server.mjs promote-admin <email-or-username>
                                           Make the account an instance admin (when no admin can
                                           sign in)
  node dist/server.mjs policy [open|invite_only|closed]
                                           Show or set who can create accounts (open needs mail)
  node dist/server.mjs spaces              List the spaces: id, status, name, owners and size
  node dist/server.mjs help                Show this help

Run the commands as the user that owns the data folder (as root on another user's data folder,
they refuse to run), with the same DATA_DIR or DB_PATH as the server.

Environment (defaults):
 Server
  PORT=8080             HOST=0.0.0.0           DATA_DIR=./data       DB_PATH=<DATA_DIR>/lyren.db
  WEB_DIR=<dist>/web    Built web client to serve (empty = API only)
  TRUST_PROXY=false     Set true behind a reverse proxy (uses X-Forwarded-For/-Proto)
  COOKIE_SECURE=auto    auto | true | false
  PUBLIC_URL=           The address people open, e.g. https://plan.example.com: links in
                        mail and copied links use it, and passkeys need it
  WEBAUTHN_RP_ID=       Passkey RP ID (default: the host name of PUBLIC_URL)
  INSTANCE_NAME=Lyren Plan
  BODY_LIMIT=2097152    Max request body in bytes
  LOG_REQUESTS=false
 Accounts and sign-in
  SETUP_TOKEN=          First-run setup code; random (printed to the log) when unset
  SIGNUP_POLICY=invite_only   open | invite_only | closed, the first value (then: policy)
  PASSWORD_MIN_LENGTH=8 For new passwords (8-64), the first value
  PASSWORD_KDF=scrypt   scrypt | pbkdf2     PASSWORD_SCRYPT_P=5
  SESSION_TTL_DAYS=30   (max 400)           SESSION_MAX_DAYS=0 (0 = no absolute limit)
  REAUTH_MINUTES=10     How long a password confirmation lasts for sensitive actions
  INVITATION_TTL_DAYS=7 RECOVERY_TOKEN= (break-glass recovery, at least 32 characters)
 Mail
  MAIL_TRANSPORT=log    log (nothing is sent, a line is logged) | smtp | resend
  MAIL_FROM=            MAIL_FROM_NAME=<INSTANCE_NAME>   MAIL_REPLY_TO=   MAIL_DAILY_CAP=200
                        MAIL_FROM and PUBLIC_URL are required for smtp and resend
  SMTP_HOST=            SMTP_SECURITY=tls (tls | starttls | none: a mail server on this machine)
  SMTP_PORT=465         (587 with starttls, 25 with none)   SMTP_USER=   SMTP_PASS=
  SMTP_EHLO_NAME=<the host of PUBLIC_URL>                   RESEND_API_KEY=
  MAIL_LOG_BODIES=false Development only: print whole messages, links included
 Spaces and limits (0 = no limit)
  SPACES_OPEN_MAX=32    Space databases kept open
  SPACE_DELETE_GRACE_DAYS=7   Restore window of a deleted space (0 = removed at once)
  MAX_SPACES_PER_USER=0 SPACES_CREATED_PER_DAY=0   MAX_MEMBERS_PER_SPACE=0
  MAX_OPEN_INVITATIONS_PER_SPACE=50       INVITATIONS_PER_DAY=20
  IMPORT_BODY_LIMIT=52428800  Max size of an import    IMPORT_MAX_JSON_VALUES=1000000
  IMPORT_MAX_ROW_WRITES=0     IMPORT_DAILY_ROW_WRITES=0  SPACE_MAX_BYTES=0
 Backups
  SNAPSHOT_KEEP=10      Automatic snapshots of each kind kept in backups/ (pre-import-*,
                        *-before-upgrade-*); older ones are deleted. 0 = keep all
  ALLOW_ADMIN_BACKUP_DOWNLOAD=true        The backup download for instance admins

See README → Configuration.
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

/**
 * Open the data (openNodeStack), or exit with an explanation instead of a stack trace: data this build
 * refuses (a 1.x database, a newer one) and a mail configuration it cannot send with exit before
 * anything is written.
 */
export function openStackOrExit(config: Config, options: NodeStackOptions = {}, audience: Audience = 'server'): NodeStack {
  try {
    return openNodeStack(config, options);
  } catch (err) {
    if (err instanceof DataRefusal) {
      console.error(err.message);
      return exitWith(1);
    }
    if (err instanceof ConfigError) {
      console.error(err.message);
      return exitWith(2);
    }
    const file = err instanceof DatabaseOpenError ? err.file : config.dbPath;
    const reason = err instanceof DatabaseOpenError ? err.reason : err;
    for (const line of dbOpenFailureMessage(file, reason, process.getuid?.(), audience)) console.error(line);
    // Anything else (a failed migration, a corrupt file) keeps its stack for the bug report.
    if (dbOpenProblem(file, reason) === null) console.error(reason);
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
  /** The process's uid for the owner check (tests; default process.getuid()). */
  uid?: number;
}

const SERVER_MAINTENANCE: MaintenanceContext = {
  noDatabaseHint: 'Run this with the same DATA_DIR (or DB_PATH) as the server, e.g. DATA_DIR=/srv/lyren/data.',
};

/** The folder of DB_PATH: the data folder (backups/, the temporaries and a staged restore are there). */
const dataFolderOf = (config: Config) => (config.dbPath === ':memory:' ? config.dataDir : path.dirname(config.dbPath));

/** The owner check (§9.2), before a command touches any file: exit 1 when root runs it on another user's data. */
export function checkOwner(config: Config, o: { uid?: number } = {}): void {
  const refusal = ownerRefusal(dataFolderOf(config), 'uid' in o ? { uid: o.uid } : {});
  if (refusal) {
    console.error(refusal);
    exitWith(1);
  }
}

/** What every maintenance command checks first: the owner (§9.2), then a staged restore (§9.6). */
function beforeMaintenance(config: Config, ctx: MaintenanceContext): void {
  checkOwner(config, ctx);
  if (config.dbPath !== ':memory:' && isRestorePending(config.dbPath)) {
    console.error(restoreWaitingMessage(config.dbPath));
    exitWith(1);
  }
}

/** A maintenance command needs existing data: it never creates an empty database. */
function requireDatabase(config: Config, ctx: MaintenanceContext): void {
  if (!fs.existsSync(config.dbPath)) {
    console.error(`No database at ${config.dbPath}.`);
    console.error(ctx.noDatabaseHint);
    exitWith(1);
  }
}

/** Open the existing data for a maintenance command. */
function openExistingStack(config: Config, ctx: MaintenanceContext): NodeStack {
  beforeMaintenance(config, ctx);
  requireDatabase(config, ctx);
  return openStackOrExit(config, { mode: 'maintenance', ...('uid' in ctx ? { uid: ctx.uid } : {}) }, ctx.audience);
}

/** A 1.x database at DB_PATH (§3.8). A file that cannot be read is left to openStackOrExit to explain. */
function isLegacyFile(file: string): boolean {
  try {
    return detectLegacy(file).kind === 'legacy';
  } catch {
    return false;
  }
}

/**
 * `backup <file>`: a backup set (backupSet.ts, design §9.5) of the directory and every space, safe while
 * the server runs; sign-in sessions and tokens are left out. A name ending in .db still works (old cron
 * jobs) and gets a note. On a 1.x database that was not upgraded yet, the old single-file backup (§3.8).
 */
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
  beforeMaintenance(config, ctx);
  requireDatabase(config, ctx);
  if (isLegacyFile(config.dbPath)) {
    try {
      writeLegacyBackup(config.dbPath, file);
    } catch (err) {
      console.error(`Backup failed: ${(err as Error).message}`);
      exitWith(1);
    }
    console.log(`Backup written to ${file}`);
    console.log(LEGACY_BACKUP_NOTE);
    return;
  }
  const stack = openStackOrExit(config, { mode: 'maintenance', ...('uid' in ctx ? { uid: ctx.uid } : {}) }, ctx.audience);
  let count: number;
  try {
    count = writeBackupSet({
      directoryDb: stack.directoryDb,
      store: stack.spaces,
      dataDir: path.dirname(config.dbPath),
      target: file,
      nowMs: Date.now(),
    }).spaces.length;
  } catch (err) {
    console.error(`Backup failed: ${(err as Error).message}`);
    exitWith(1);
  } finally {
    stack.close();
  }
  console.log(`Backup written to ${file} (${count} space${count === 1 ? '' : 's'})`);
  if (/\.db$/i.test(file)) console.log(BACKUP_SET_NAME_NOTE);
}

/**
 * The last line of reset-password. Failed sign-ins are counted in the directory (directory/throttle.ts),
 * and reset-password deletes the account's counters and those of every address, so nobody has to wait
 * or restart anything.
 */
export function lockoutAdvice(): string {
  return 'Any lock-out from failed sign-ins has been cleared.';
}

/** How many accounts the "not found" message names. */
const LISTED_ACCOUNTS = 20;

/** How the commands name an account: its email address, else its username (a 1.x account), else its id. */
const accountName = (user: { id: number; email: string | null; username: string | null }) => user.email ?? user.username ?? `#${user.id}`;

/**
 * The account `identifier` names (an email address or a username), or exit 1 listing up to 20 of the
 * accounts that exist ("…and N more").
 */
function accountOrExit(db: Db, identifier: string): NonNullable<ReturnType<typeof resolveIdentifier>['user']> {
  const { user } = resolveIdentifier(db, identifier.trim());
  if (user) return user;
  const names = db
    .all<{ id: number; email: string | null; username: string | null }>('SELECT id, email, username FROM users ORDER BY id LIMIT :n', {
      n: LISTED_ACCOUNTS,
    })
    .map(accountName);
  const more = userCount(db) - names.length;
  const listed = names.length > 0 ? `${names.join(', ')}${more > 0 ? ` …and ${more} more` : ''}` : '(none)';
  console.error(`No account with the email address or username "${identifier.trim()}". Accounts: ${listed}`);
  return exitWith(1);
}

/** Throttle keys that hold the account's failed sign-ins (directory/throttle.ts, design §9.6). */
function accountThrottleKeys(user: { id: number; email_key: string | null; username: string | null }): string[] {
  const keys = [`lid:a:${user.id}`, `lda:${user.id}`];
  if (user.email_key !== null) keys.push(`lid:i:${user.email_key}`);
  if (user.username !== null) keys.push(`lid:i:${user.username.toLowerCase()}`);
  return keys;
}

export async function resetPassword(
  identifier: string | undefined,
  positionalPassword: string | undefined,
  ctx: MaintenanceContext = SERVER_MAINTENANCE,
): Promise<void> {
  if (!identifier?.trim()) {
    console.error('Usage: reset-password <email-or-username>');
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
  const config = loadConfigOrExit(ctx.defaults);
  const stack = openExistingStack(config, ctx);
  try {
    const db = stack.directoryDb;
    // The rule of the instance for new passwords: one the sign-in form rejects would lock the owner out.
    const min = getInstanceSettings(db, config.directory).passwordMinLength;
    if (password !== undefined && (password.length < min || password.length > LIMITS.passwordMax)) {
      console.error(`Password must be ${min} to ${LIMITS.passwordMax} characters (got ${password.length}). Nothing was changed.`);
      exitWith(2);
    }
    const user = accountOrExit(db, identifier);
    const name = accountName(user);
    // Random passwords are base64url: 16 characters, or the instance's minimum when that is longer.
    const newPassword = password ?? randomBytes(Math.ceil((Math.max(16, min) * 3) / 4)).toString('base64url');
    const { passwordKdf: kdf, passwordScryptP: scryptP } = config.directory;
    const hash = await new PasswordHasher({ target: { kdf, scryptP }, clock: systemClock }).hash(newPassword);
    const now = new Date().toISOString();
    db.tx(() => {
      // auth_epoch + 1: a sign-in whose password check was under way fails (directory/routes/auth.ts).
      db.run(
        `UPDATE users SET password_hash = :hash, password_changed_at = :now, auth_epoch = auth_epoch + 1, updated_at = :now
         WHERE id = :id`,
        { hash, now, id: user.id },
      );
      db.run('DELETE FROM sessions WHERE user_id = :id', { id: user.id });
      revokeDevices(db, user.id);
      db.run(
        `DELETE FROM auth_throttle WHERE key IN (SELECT value FROM json_each(:keys)) OR key = 'lg'
           OR substr(key, 1, 3) IN ('li:', 'ln:')`,
        { keys: JSON.stringify(accountThrottleKeys(user)) },
      );
    });
    console.log(password ? `Password updated for ${name}.` : `New password for ${name}: ${newPassword}`);
    if (password && !positionalPassword && process.platform === 'win32' && password.includes('?')) {
      // Windows PowerShell 5.1 pipes letters outside ASCII as '?', which can't be detected otherwise.
      console.warn(
        "Note: the new password contains '?'. Windows PowerShell 5.1 turns letters such as ä or é into '?' when it pipes text;",
      );
      console.warn('if you did not type a "?", run the command again in PowerShell 7 or Command Prompt (after chcp 65001).');
    }
    console.log(lockoutAdvice());
  } finally {
    stack.close();
  }
}

/** This process's user, as the hint about a file it cannot read names it. */
function thisUser(): string {
  try {
    return os.userInfo().username;
  } catch {
    // A uid without a passwd entry (a container): its number, which sudo -u also takes.
    return `#${process.getuid?.() ?? '?'}`;
  }
}

/** `file` cannot be read by this process's user: how to restore it anyway. Exit 1. */
function unreadableSource(file: string, audience: Audience = 'server'): never {
  console.error(
    audience === 'desktop'
      ? `${file} cannot be read as this user (${thisUser()}): copy it to a folder you can read, then run restore again.`
      : `${file} cannot be read as this user (${thisUser()}): pipe it in with \`restore -\` (see the README).`,
  );
  return exitWith(1);
}

const isAccessError = (err: unknown) => ['EACCES', 'EPERM'].includes((err as NodeJS.ErrnoException).code ?? '');

/**
 * The file `restore` was given: as typed (relative to the working folder), else, for a relative name that
 * is not there, relative to the data folder, so the command an import's result names (`restore
 * "backups/spaces/<id>/pre-import-<time>.db"`) works from any folder, one this user cannot search included
 * (`sudo -u lyren` keeps the admin's working folder). Exit 1 when neither is a file this user can reach.
 */
function restoreSource(file: string, dataFolder: string, audience: Audience | undefined): string {
  const candidates = path.isAbsolute(file) ? [file] : [path.resolve(file), path.resolve(dataFolder, file)];
  let denied = false;
  for (const candidate of candidates) {
    let stats: fs.Stats | undefined;
    try {
      stats = fs.statSync(candidate, { throwIfNoEntry: false });
    } catch (err) {
      // A folder on the way that this user cannot search (EACCES), or that is a file (ENOTDIR): not here.
      if ((err as NodeJS.ErrnoException).code === undefined) throw err;
      denied ||= isAccessError(err);
      continue;
    }
    if (stats?.isFile()) return candidate;
  }
  if (denied) return unreadableSource(file, audience);
  console.error(`No file ${file}.`);
  return exitWith(1);
}

/**
 * `restore <file|->` (design §9.6): stage a backup set, one space's database or an old single-file backup
 * for the next start (runtime/node/restore.ts), which moves the current data to
 * backups/before-restore-<time>/ first. Works while the server runs; nothing changes until it restarts.
 * `-` reads the file from standard input.
 */
export async function restore(file: string | undefined, ctx: MaintenanceContext = SERVER_MAINTENANCE): Promise<void> {
  if (!file) {
    console.error('Usage: restore <file|->');
    exitWith(2);
  }
  const config = loadConfigOrExit(ctx.defaults);
  if (config.dbPath === ':memory:') {
    console.error('DB_PATH is :memory:, which keeps nothing to restore into.');
    exitWith(2);
  }
  beforeMaintenance(config, ctx);
  const folder = dataFolderOf(config);
  let source: string;
  let temp: string | null = null;
  if (file === '-') {
    if (process.stdin.isTTY) {
      console.error('restore - reads the backup from standard input: pipe it in, for example cat lyren-backup.tar | … restore -');
      exitWith(2);
    }
    try {
      source = temp = await copyToTemp(process.stdin, folder);
    } catch (err) {
      console.error(`Could not read the backup from standard input: ${(err as Error).message}`);
      return exitWith(1);
    }
  } else {
    source = restoreSource(file, folder, ctx.audience);
  }
  let staged: StagedRestore;
  try {
    staged = stageRestore({ dbPath: config.dbPath, source, stdin: temp !== null, nowMs: Date.now() });
  } catch (err) {
    if (temp === null && isAccessError(err) && (err as { path?: string }).path === source) return unreadableSource(file, ctx.audience);
    console.error(err instanceof RestoreError || err instanceof BackupError ? err.message : `Restore failed: ${(err as Error).message}`);
    return exitWith(1);
  } finally {
    if (temp) fs.rmSync(temp, { force: true });
  }
  console.log(`Staged the restore of ${staged.description}${temp ? ' from standard input' : ` from ${source}`}.`);
  console.log(restoreNextStep(ctx.audience ?? 'server', staged));
}

/**
 * `promote-admin <email-or-username>` (§9.6): make the account an instance admin, the way back in when no
 * admin can sign in. A running server sees it at the account's next request. Recorded as admin_granted
 * without an actor (`via: 'cli'`), so every admin sees it in Administration → Overview (§5.8.18).
 */
export function promoteAdmin(identifier: string | undefined, ctx: MaintenanceContext = SERVER_MAINTENANCE): void {
  if (!identifier?.trim()) {
    console.error('Usage: promote-admin <email-or-username>');
    exitWith(2);
  }
  const config = loadConfigOrExit(ctx.defaults);
  const stack = openExistingStack(config, ctx);
  try {
    const db = stack.directoryDb;
    const user = accountOrExit(db, identifier);
    const name = accountName(user);
    if (user.is_instance_admin === 1) {
      console.log(`${name} is already an instance admin.`);
    } else {
      const nowMs = Date.now();
      db.tx(() => {
        db.run('UPDATE users SET is_instance_admin = 1, updated_at = :now WHERE id = :id', { id: user.id, now: new Date(nowMs).toISOString() });
        recordEvent(db, { type: 'admin_granted', userId: user.id, meta: null, data: { ...CLI_EVENT, displayName: user.display_name }, nowMs });
      });
      console.log(`${name} is now an instance admin.`);
    }
    if (user.status === 'disabled') console.log('Note: the account is disabled, so it cannot sign in until an admin enables it.');
  } finally {
    stack.close();
  }
}

/** What the maintenance commands' security events carry instead of an actor and a request. */
const CLI_EVENT = { via: 'cli' } as const;

const POLICY_TEXT: Record<SignupPolicy, string> = {
  open: 'anyone can create an account, with a verified email address',
  invite_only: 'accounts are created through invitations only',
  closed: "only administrators' invitations create accounts",
};

/**
 * `policy [open|invite_only|closed]` (§9.6): show or set who can create accounts. `open` needs mail. A change
 * is recorded as admin_settings_changed without an actor (`via: 'cli'`), as promote-admin's.
 */
export function policy(value: string | undefined, ctx: MaintenanceContext = SERVER_MAINTENANCE): void {
  if (value !== undefined && !(SIGNUP_POLICIES as readonly string[]).includes(value)) {
    console.error(`Usage: policy [${SIGNUP_POLICIES.join('|')}]`);
    exitWith(2);
  }
  const config = loadConfigOrExit(ctx.defaults);
  const stack = openExistingStack(config, ctx);
  try {
    const db = stack.directoryDb;
    const current = getInstanceSettings(db, config.directory).signupPolicy;
    const wanted = value as SignupPolicy | undefined;
    if (wanted === undefined || wanted === current) {
      console.log(`Sign-up policy: ${current} (${POLICY_TEXT[current]}).`);
      return;
    }
    try {
      db.tx(() => {
        setSignupPolicy(db, wanted, sendsTokens(stack.mail, config.directory.mail));
        const data = { signupPolicy: { from: current, to: wanted }, ...CLI_EVENT };
        recordEvent(db, { type: 'admin_settings_changed', userId: null, meta: null, data, nowMs: Date.now() });
      });
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      console.error(`${err.message}: the policy stays ${current}.`);
      exitWith(1);
    }
    console.log(`Sign-up policy set to ${wanted} (${POLICY_TEXT[wanted]}); it was ${current}.`);
  } finally {
    stack.close();
  }
}

/** A file size as `spaces` prints it (1024-based). */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * `spaces` (§9.6): one line per space: id, status, name, its owners' emails or usernames, and the size of its
 * database with the -wal (a running server's last writes are there), as Administration → Spaces shows it.
 */
export function spaces(ctx: MaintenanceContext = SERVER_MAINTENANCE): void {
  const config = loadConfigOrExit(ctx.defaults);
  const stack = openExistingStack(config, ctx);
  try {
    const db = stack.directoryDb;
    const rows = db.all<{ id: number; public_id: string; name: string; status: string; deleted_at: string | null; purge_after: string | null }>(
      'SELECT id, public_id, name, status, deleted_at, purge_after FROM spaces ORDER BY id',
    );
    if (rows.length === 0) {
      console.log('No spaces yet.');
      return;
    }
    const owners = new Map<number, string[]>();
    for (const o of db.all<{ space_id: number; id: number; email: string | null; username: string | null }>(
      `SELECT m.space_id, u.id, u.email, u.username FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.role = 'owner' ORDER BY m.space_id, u.id`,
    )) {
      owners.set(o.space_id, [...(owners.get(o.space_id) ?? []), accountName(o)]);
    }
    const now = new Date().toISOString();
    const table = rows.map((r) => {
      const size = spaceFileBytes(stack.spaces.file(r.public_id));
      const status =
        r.deleted_at === null
          ? r.status
          : r.purge_after !== null && r.purge_after > now
            ? `deleted (restorable until ${r.purge_after.slice(0, 10)})`
            : 'deleted (being removed)';
      return [r.public_id, status, r.name, (owners.get(r.id) ?? []).join(', ') || '-', size === null ? 'no file' : formatSize(size)];
    });
    const header = ['ID', 'STATUS', 'NAME', 'OWNERS', 'SIZE'];
    const widths = header.map((h, i) => Math.max(h.length, ...table.map((row) => row[i]!.length)));
    for (const row of [header, ...table]) {
      console.log(
        row
          .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i]!)))
          .join('  ')
          .trimEnd(),
      );
    }
  } finally {
    stack.close();
  }
}

function startServer(defaults: ConfigDefaults) {
  const config = loadConfigOrExit(defaults);
  const stack = openStackOrExit(config);

  const server = serve({ fetch: stack.app.fetch, port: config.port, hostname: config.host }, (info) => {
    console.log(`Lyren Plan ${APP_VERSION} listening on http://${info.address}:${info.port}`);
    console.log(`Database: ${config.dbPath}`);
    if (!config.webDir) console.log('Web UI: not served (WEB_DIR empty)');
    const clientMissing = config.webDir !== null && !hasWebClient(config.webDir);
    if (clientMissing) {
      console.warn('');
      for (const line of missingWebClientMessage(config.webDir!)) console.warn(line);
    }
    if (stack.firstRun && stack.setupCode) {
      console.log('');
      console.log(
        clientMissing
          ? '  First run: once the web client is built, open the app in your browser and create your account.'
          : '  First run: open the app in your browser and create your account.',
      );
      console.log(`  Setup code: ${stack.setupCode}`);
      console.log('');
    }
  });
  server.once('error', (err) => {
    const lines = listenFailureMessage(err, config.host, config.port);
    if (lines) for (const line of lines) console.error(line);
    else console.error(err);
    stack.close();
    process.exit(1);
  });

  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    console.log(`Received ${signal}, shutting down...`);
    // Every database is closed (WAL checkpointed), also when requests do not end in time.
    server.close(() => {
      stack.close();
      process.exit(0);
    });
    setTimeout(() => {
      stack.close();
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
      case 'restore':
        await restore(args[0], { ...SERVER_MAINTENANCE, defaults });
        break;
      case 'promote-admin':
        promoteAdmin(args[0], { ...SERVER_MAINTENANCE, defaults });
        break;
      case 'policy':
        policy(args[0], { ...SERVER_MAINTENANCE, defaults });
        break;
      case 'spaces':
        spaces({ ...SERVER_MAINTENANCE, defaults });
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
