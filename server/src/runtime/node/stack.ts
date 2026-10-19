// The Node composition (design §9.1): everything one Node process serves, for the server (cli.ts), the
// desktop app (desktop/serve.ts, after its single-instance lock) and the maintenance commands. In
// order, before anything is written:
//   0. the owner check (owner.ts, §9.2): root stops on another user's data folder (DataRefusal);
//   1. a serving start applies a staged restore (restore.ts, §9.6), then upgrades a 1.x database
//      (legacy.ts, §3.8); a maintenance command refuses both, and every start refuses a database from a
//      newer build (DataRefusal);
//   2. the directory database (DB_PATH, default DATA_DIR/lyren.db) is opened and migrated (a
//      directory-v<N>-before-upgrade snapshot first when it is older), user_version = 100 (§3.1);
//      expired sessions are removed, and when serving the stale backup temporaries;
//   3. the mail transport (SMTP through node:net and node:tls), the space store and its client, the directory app and service (with the
//      backup download, the desktop app's data and the origins for copied links), the directory
//      client, and the gateway with Node's extras (TRUST_PROXY and COOKIE_SECURE, compression, the
//      static site);
//   4. serving: the configuration's warnings are printed, the setup code is prepared when no account
//      exists (the caller shows it), and the hourly maintenance runs until close().
// close() writes the buffered throttle counts and closes every database (WAL checkpointed, -wal and
// -shm removed).

import fs from 'node:fs';
import path from 'node:path';
import type { Hono } from 'hono';
import type { Config } from '../../config';
import { migrate } from '../../core/migrate';
import { systemClock, type Clock, type RuntimeInfo } from '../../core/runtime';
import { APP_VERSION } from '../../core/version';
import { writeSnapshot } from '../../db/snapshots';
import { createDirectoryApp, type DirectoryDeps } from '../../directory/app';
import { DIRECTORY_MIGRATIONS } from '../../directory/schema';
import type { DirectoryService } from '../../directory/service';
import { purgeExpiredSessions } from '../../directory/sessions';
import { seedWarnings } from '../../directory/settings';
import { userCount } from '../../directory/users';
import { createGatewayApp } from '../../gateway/app';
import { staticSite, type StaticSource } from '../../http/static';
import { createMailTransport, type MailTransport } from '../../mail/transport';
import { backupDownload, removeStaleBackupTemps } from './backupSet';
import { nodeConnection } from './clientIp';
import { desktopApp, desktopData, type DesktopDeps } from './desktop';
import { forwardingPort, NodeDirectoryClient } from './directoryClient';
import {
  detectLegacy,
  LEGACY_NOT_UPGRADED,
  LegacyUpgradeStopped,
  stillOpen,
  upgradeLegacyIfNeeded,
  type LegacyUpgradeResult,
} from './legacy';
import { startMaintenance } from './maintenance';
import { isBusyError, NodeDb } from './nodeDb';
import { ownerRefusal } from './owner';
import { applyPendingRestore, isRestorePending, restoreWaitingMessage, RestoreStopped, type ApplyRestoreHooks } from './restore';
import { createNodeSmtpConnector } from './smtpConnector';
import { NodeSpaceClient } from './spaceClient';
import { NEW_FORMAT_USER_VERSION, NodeSpaceStore, spacesDirFor } from './spaceStore';

/**
 * The data cannot be used now: a 1.x database a maintenance command found, one from a newer version, an
 * upgrade (legacy.ts) or a restore (restore.ts) that had to stop, a staged restore a maintenance command
 * found, or root on another user's data folder (owner.ts). The data itself is unchanged.
 */
export class DataRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DataRefusal';
  }
}

/** The directory database could not be opened or migrated: `file` names it (startupErrors.ts explains it). */
export class DatabaseOpenError extends Error {
  constructor(
    readonly file: string,
    readonly reason: unknown,
  ) {
    super(`Could not open the database ${file}: ${(reason as Error)?.message ?? String(reason)}`);
    this.name = 'DatabaseOpenError';
  }
}

export interface NodeStackOptions {
  /**
   * 'serve' (default): the server and the desktop app; prints the configuration's warnings, prepares
   * the setup code and runs the hourly maintenance. 'maintenance': a CLI command, none of that.
   */
  mode?: 'serve' | 'maintenance';
  /** The web client to serve; default config.webDir (null: the API only). */
  web?: StaticSource | null;
  /** The desktop app (desktop/serve.ts): what the web client shows about its command line. */
  desktop?: DesktopDeps;
  /** Default: the transport MAIL_TRANSPORT names. */
  mail?: MailTransport;
  clock?: Clock;
  /** desktop --lan: the LAN origins its banner shows, for copied links when PUBLIC_URL is unset (§9.7). */
  lanUrls?: () => string[];
  /** Announces a setup code generated while serving (DirectoryDeps.onSetupCode; default: printed). */
  onSetupCode?: (code: string) => void;
  /** DirectoryDeps.sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
  /** The process's uid for the owner check (tests; default process.getuid()). */
  uid?: number;
  /** The apply of a staged restore (tests). */
  restoreHooks?: ApplyRestoreHooks;
}

export interface NodeStack {
  /** The gateway: cli.ts serve() and the desktop app's createAdaptorServer() run app.fetch. */
  app: Hono;
  config: Config;
  directoryDb: NodeDb;
  /** The directory service: authorizeSpace, maintenance, the setup code, … */
  service: DirectoryService;
  /** The in-process directory client the gateway and the space hosts use. */
  directory: NodeDirectoryClient;
  spaces: NodeSpaceStore;
  /** The mail transport the directory sends with (the CLI's `policy` asks whether it delivers mail). */
  mail: MailTransport;
  /** No account exists. */
  firstRun: boolean;
  /** Serving with no account: the setup code to show (SETUP_TOKEN, or generated). Else null. */
  setupCode: string | null;
  /** The hourly upkeep (§9.8); serving runs it on a timer. */
  maintenance(): Promise<void>;
  /** Closes every database. */
  close(): void;
}

/** An escape sequence of the colors Hono's logger gives the status. */
const ANSI_SGR = /\x1b\[[\d;]*m/g;

/**
 * LOG_REQUESTS on Node: the lines go to stdout, colored only on a terminal and without NO_COLOR. Hono's
 * logger looks at NO_COLOR alone, so journald, `docker logs` and log files got its escape codes.
 */
export function requestLogPrinter(out: { isTTY?: boolean } = process.stdout, env: NodeJS.ProcessEnv = process.env): (line: string) => void {
  const plain = out.isTTY !== true || (env.NO_COLOR ?? '') !== '';
  return (line) => console.log(plain ? line.replace(ANSI_SGR, '') : line);
}

const NODE_RUNTIME = (config: Config): RuntimeInfo => ({
  kind: 'node',
  capabilities: { backupDownload: config.allowAdminBackupDownload, fileSnapshots: true },
});

/** The directory file's folder: backups/ and the backup temporaries go there. */
function dataFolder(config: Config): string {
  return config.dbPath === ':memory:' ? config.dataDir : path.dirname(config.dbPath);
}

/** A serving start: the staged restore (§9.6 step 5), when there is one. */
function runPendingRestore(config: Config, hooks: ApplyRestoreHooks | undefined): void {
  try {
    applyPendingRestore({ dbPath: config.dbPath, hooks });
  } catch (err) {
    if (err instanceof RestoreStopped) throw new DataRefusal(err.message);
    throw new DatabaseOpenError(config.dbPath, err);
  }
}

/** A serving start: the legacy upgrade (§3.8) when DB_PATH holds a 1.x database. */
function runLegacyUpgrade(config: Config, clock: Clock): LegacyUpgradeResult | null {
  try {
    return upgradeLegacyIfNeeded({ dbPath: config.dbPath, snapshotKeep: config.snapshotKeep, directory: config.directory, clock });
  } catch (err) {
    if (err instanceof LegacyUpgradeStopped) throw new DataRefusal(err.message);
    throw new DatabaseOpenError(config.dbPath, err);
  }
}

/** Open the directory database, refusing data this build cannot use (see the header). */
function openDirectory(config: Config): NodeDb {
  const file = config.dbPath;
  let legacy: ReturnType<typeof detectLegacy>;
  try {
    legacy = detectLegacy(file);
  } catch (err) {
    // Another start holds it exclusively (its upgrade, or the switch of a restored file to WAL); likewise below,
    // once the busy timeout has passed.
    if (isBusyError(err)) throw new DataRefusal(stillOpen(file));
    throw new DatabaseOpenError(file, err);
  }
  if (legacy.kind === 'legacy') throw new DataRefusal(LEGACY_NOT_UPGRADED);
  if (legacy.kind === 'newer') {
    const n = DIRECTORY_MIGRATIONS.migrations.length;
    throw new DataRefusal(`Database schema version ${legacy.userVersion} is newer than this build supports (${n}). Upgrade the app.`);
  }
  let db: NodeDb;
  try {
    db = new NodeDb(file);
  } catch (err) {
    if (isBusyError(err)) throw new DataRefusal(stillOpen(file));
    throw new DatabaseOpenError(file, err);
  }
  try {
    const backups = path.join(dataFolder(config), 'backups');
    migrate(db, DIRECTORY_MIGRATIONS, {
      appVersion: APP_VERSION,
      beforeUpgrade: (from) => writeSnapshot(db, backups, 'directory-before-upgrade', { keep: config.snapshotKeep, from }),
    });
    db.raw.exec(`PRAGMA user_version = ${NEW_FORMAT_USER_VERSION}`);
  } catch (err) {
    db.close();
    // §3.7: a database from a newer build (and not compatible with this one) is refused as it is.
    if (/is newer than this build supports/.test((err as Error)?.message ?? '')) throw new DataRefusal((err as Error).message);
    if (isBusyError(err)) throw new DataRefusal(stillOpen(file));
    throw new DatabaseOpenError(file, err);
  }
  return db;
}

/**
 * The size of a space's database for the admin list (DirectoryDeps.spaceBytes) and the CLI's `spaces`:
 * `<id>.db` and its `-wal`, whose pages an open database has not checkpointed yet; read from the file
 * system, never opened for this. null without a file (in memory, or a space whose file is missing).
 */
export function spaceFileBytes(file: string | null): number | null {
  if (file === null) return null;
  const db = fs.statSync(file, { throwIfNoEntry: false });
  if (!db) return null;
  return db.size + (fs.statSync(`${file}-wal`, { throwIfNoEntry: false })?.size ?? 0);
}

export function openNodeStack(config: Config, options: NodeStackOptions = {}): NodeStack {
  const mode = options.mode ?? 'serve';
  const clock = options.clock ?? systemClock;
  const folder = dataFolder(config);
  const refusal = ownerRefusal(folder, 'uid' in options ? { uid: options.uid } : {});
  if (refusal) throw new DataRefusal(refusal);
  if (config.dbPath !== ':memory:') {
    if (mode === 'serve') runPendingRestore(config, options.restoreHooks);
    else if (isRestorePending(config.dbPath)) throw new DataRefusal(restoreWaitingMessage(config.dbPath));
  }
  const upgraded = mode === 'serve' ? runLegacyUpgrade(config, clock) : null;
  const directoryDb = openDirectory(config);
  const runtime = NODE_RUNTIME(config);
  // The store and the directory need each other: the directory app creates spaces through the store's
  // client, and the store's hosts authorize through the directory client, created after the app.
  let directory: NodeDirectoryClient | null = null;
  const directoryPort = forwardingPort(() => {
    if (!directory) throw new Error('The directory is not ready yet');
    return directory;
  });
  const spaces = new NodeSpaceStore({
    dir: config.dbPath === ':memory:' ? ':memory:' : spacesDirFor(config.dbPath),
    dataDir: folder,
    directory: directoryPort,
    config: config.space,
    runtime,
    maxOpen: config.spacesOpenMax,
    clock,
    audience: options.desktop ? 'desktop' : 'server',
  });
  try {
    purgeExpiredSessions(directoryDb, clock.now());
    // Not in maintenance mode: a command may run beside a backup that is writing its temporaries.
    if (mode === 'serve') removeStaleBackupTemps(folder);
    const mail = options.mail ?? createMailTransport(config.directory.mail, { smtp: createNodeSmtpConnector() });
    const spaceClient = new NodeSpaceClient(spaces, directoryPort);

    const desktop = options.desktop;
    const deps: DirectoryDeps = {
      db: directoryDb,
      config: config.directory,
      spaces: spaceClient,
      mail,
      defer: (task) => {
        task.catch((err: unknown) => console.error('[lyren] A background task failed:', err));
      },
      clock,
      runtime,
      backup: {
        create: () => backupDownload({ directoryDb, store: spaces, dataDir: folder, nowMs: clock.now() }),
      },
      spaceBytes: (spaceId) => spaceFileBytes(config.dbPath === ':memory:' ? null : spaces.file(spaceId)),
      desktop: desktop
        ? {
            // A getter: the tray icon's stopMode can change while the app runs.
            get app() {
              return desktopApp(desktop);
            },
            data: () => desktopData(desktop, config),
          }
        : undefined,
      shareOrigins: () => (config.publicUrl ? [config.publicUrl] : (options.lanUrls?.() ?? [])),
      onSetupCode: options.onSetupCode,
      sleep: options.sleep,
    };
    const { app: directoryApp, service } = createDirectoryApp(deps);
    directory = new NodeDirectoryClient(directoryApp, service);

    const web = options.web !== undefined ? options.web : config.webDir;
    const app = createGatewayApp({
      limits: config,
      runtime: 'node',
      directory,
      spaces: spaceClient,
      connection: nodeConnection(config),
      requestLog: config.logRequests ? requestLogPrinter() : null,
      compress: true,
      web: web ? staticSite(web) : null,
    });

    const firstRun = userCount(directoryDb) === 0;
    let setupCode: string | null = null;
    let stopMaintenance: (() => void) | null = null;
    const maintenance = async () => {
      await service.maintenance();
      spaces.closeIdle(clock.now());
    };
    if (mode === 'serve') {
      // The upgrade seeded the instance settings: the SIGNUP_POLICY warning is this start's.
      const warnings = new Set([...service.startupWarnings, ...(upgraded?.seededPolicy ? seedWarnings(config.directory, true) : [])]);
      for (const warning of warnings) console.warn(`Warning: ${warning}`);
      if (firstRun) setupCode = service.ensureSetupCode()?.code ?? null;
      stopMaintenance = startMaintenance(maintenance);
    }

    let closed = false;
    return {
      app,
      config,
      directoryDb,
      service,
      directory,
      spaces,
      mail,
      firstRun,
      setupCode,
      maintenance,
      close() {
        if (closed) return;
        closed = true;
        stopMaintenance?.();
        try {
          service.flush();
        } catch (err) {
          console.error('[lyren] Could not write the sign-in throttle counts:', err);
        }
        spaces.closeAll();
        directoryDb.close();
      },
    };
  } catch (err) {
    spaces.closeAll();
    directoryDb.close();
    throw err;
  }
}
