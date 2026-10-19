// Runtime configuration on Node, read once from environment variables: the settings both runtimes
// share (core/config.ts, AppConfig) plus the Node-only ones (where the data is, how to listen).
// Runtime-neutral code never imports this module (it reads process.env and imports node:path).
//
// The defaults for unset variables depend on the distribution: the Node build (dist/server.mjs)
// and Docker use SERVER_DEFAULTS; the single-file desktop app (desktop/) passes its own (a
// per-user data folder, 127.0.0.1, another port, the embedded web client).

import path from 'node:path';
import { parseAppConfig, readBool, readInt, type AppConfig } from './core/config';

declare const __APP_VERSION__: string | undefined;

export const APP_VERSION: string =
  typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : (process.env.npm_package_version ?? 'dev');

/**
 * The Node configuration. The AppConfig part (runtime 'node', publicUrl, logRequests, bodyLimit,
 * importBodyLimit, directory, space) is what the directory and space apps get; the fields below are
 * Node's own. sessionTtlDays, setupToken and snapshotKeep repeat directory.sessionTtlDays,
 * directory.setupToken and space.snapshotKeep (loadConfig keeps overrides of them in step).
 */
export interface Config extends AppConfig {
  runtime: 'node';
  /** Interface to bind (default 0.0.0.0). */
  host: string;
  port: number;
  /** The data folder (default ./data). */
  dataDir: string;
  /** Full path of the directory database (the spaces are next to it, §3.1); ':memory:' in tests. */
  dbPath: string;
  /** Directory with the built web client (index.html + assets). null = don't serve the UI. */
  webDir: string | null;
  /**
   * 'auto' (default): Secure cookie when the request arrived over HTTPS (directly or,
   * with trustProxy, via X-Forwarded-Proto). 'true'/'false' force it.
   */
  cookieSecure: 'auto' | boolean;
  /** Honour X-Forwarded-For / X-Forwarded-Proto (set when behind a reverse proxy). */
  trustProxy: boolean;
  /** Session lifetime in days (sliding). */
  sessionTtlDays: number;
  /** Max JSON body size in bytes for normal requests. */
  bodyLimit: number;
  /** Max body size of a space import. */
  importBodyLimit: number;
  /** Log each request to stdout. */
  logRequests: boolean;
  /**
   * Automatic safety snapshots of each kind and folder (pre-import-*.db, *-before-upgrade-*.db; db/snapshots.ts)
   * to keep; older ones are deleted after a new one is written. 0 = keep all (never delete).
   */
  snapshotKeep: number;
  /**
   * Code required by first-run setup (POST /api/auth/setup) while no user exists: SETUP_TOKEN, or null,
   * and the directory generates one (printed to the log, §5.8.1).
   */
  setupToken: string | null;
  /** SPACES_OPEN_MAX (default 32): space databases kept open at once. */
  spacesOpenMax: number;
  /** ALLOW_ADMIN_BACKUP_DOWNLOAD (default true): instance admins can download a backup set. */
  allowAdminBackupDownload: boolean;
}

/** A boolean variable: unset or empty -> `fallback`; else true only for 1, true, yes or on (any case). */
export function envBool(name: string, fallback: boolean): boolean {
  return readBool(process.env, name, fallback);
}

function envInt(name: string, fallback: number, max = Number.MAX_SAFE_INTEGER, min = 1): number {
  return readInt(process.env, name, fallback, max, min);
}

/** Values used for unset environment variables. */
export interface ConfigDefaults {
  /** HOST */
  host: string;
  /** PORT */
  port: number;
  /** DATA_DIR (resolved against the working directory when relative). */
  dataDir: string;
  /** The web client folder when WEB_DIR is unset; null = none on disk. */
  webDir: string | null;
}

/**
 * The Node build and Docker: every interface, port 8080, ./data. The entry module (index.ts) adds
 * the web client next to the bundle (bundledWebDir).
 */
export const SERVER_DEFAULTS: ConfigDefaults = { host: '0.0.0.0', port: 8080, dataDir: 'data', webDir: null };

/**
 * The built web client next to the server entry module in `entryDir`: dist/server.mjs -> dist/web;
 * in development (tsx) server/src/index.ts -> <repo>/dist/web.
 */
export function bundledWebDir(entryDir: string): string {
  return path.basename(entryDir) === 'src' ? path.resolve(entryDir, '../../dist/web') : path.join(entryDir, 'web');
}

/**
 * The flat fields that the AppConfig sub-objects repeat: an override of one (tests set them) reaches
 * the sub-object too, so the flat field and the apps' configuration never disagree.
 */
function withOverrides(base: Config, overrides: Partial<Config>): Config {
  const config: Config = { ...base, ...overrides };
  const has = (key: keyof Config) => Object.hasOwn(overrides, key);
  const directory = { ...config.directory, quotas: { ...config.directory.quotas } };
  const space = { ...config.space };
  if (has('sessionTtlDays')) directory.sessionTtlDays = config.sessionTtlDays;
  if (has('setupToken')) directory.setupToken = config.setupToken;
  if (has('bodyLimit')) {
    space.bodyLimit = config.bodyLimit;
    directory.bodyLimit = config.bodyLimit;
  }
  if (has('importBodyLimit')) {
    space.importBodyLimit = config.importBodyLimit;
    directory.quotas.importMaxBytes = config.importBodyLimit;
  }
  if (has('snapshotKeep')) space.snapshotKeep = config.snapshotKeep;
  return { ...config, directory, space };
}

export function loadConfig(overrides: Partial<Config> = {}, defaults: ConfigDefaults = SERVER_DEFAULTS): Config {
  const app = parseAppConfig(process.env, 'node');
  // HOST, DATA_DIR, WEB_DIR and COOKIE_SECURE keep today's meaning of an empty value (every
  // interface, the working directory, API only, false); every other variable treats it as unset.
  const dataDir = path.resolve(process.env.DATA_DIR ?? defaults.dataDir);
  const cookieSecureEnv = (process.env.COOKIE_SECURE ?? 'auto').toLowerCase();
  const base: Config = {
    ...app,
    runtime: 'node',
    host: process.env.HOST ?? defaults.host,
    port: envInt('PORT', defaults.port, 65535),
    dataDir,
    dbPath: process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(dataDir, 'lyren.db'),
    // WEB_DIR set (even empty = API only) wins over the default.
    webDir: process.env.WEB_DIR !== undefined ? process.env.WEB_DIR || null : defaults.webDir,
    cookieSecure: cookieSecureEnv === 'auto' ? 'auto' : envBool('COOKIE_SECURE', false),
    trustProxy: envBool('TRUST_PROXY', false),
    sessionTtlDays: app.directory.sessionTtlDays,
    snapshotKeep: app.space.snapshotKeep,
    setupToken: app.directory.setupToken,
    spacesOpenMax: envInt('SPACES_OPEN_MAX', 32, 10_000),
    allowAdminBackupDownload: envBool('ALLOW_ADMIN_BACKUP_DOWNLOAD', true),
  };
  return withOverrides(base, overrides);
}
