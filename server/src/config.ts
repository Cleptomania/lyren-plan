// Runtime configuration, read once from environment variables.
//
// The defaults for unset variables depend on the distribution: the Node build (dist/server.mjs)
// and Docker use SERVER_DEFAULTS; the single-file desktop app (desktop/) passes its own (a
// per-user data folder, 127.0.0.1, another port, the embedded web client).

import path from 'node:path';
import { DEFAULT_SNAPSHOT_KEEP } from './db/snapshots';

declare const __APP_VERSION__: string | undefined;

export const APP_VERSION: string =
  typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : (process.env.npm_package_version ?? 'dev');

export interface Config {
  /** Interface to bind (default 0.0.0.0). */
  host: string;
  port: number;
  /** Directory holding the SQLite database (default ./data). */
  dataDir: string;
  /** Full path of the database file; ':memory:' in tests. */
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
  /** Max body size for POST /api/data/import. */
  importBodyLimit: number;
  /** Log each request to stdout. */
  logRequests: boolean;
  /**
   * Automatic safety snapshots of each kind (backups/pre-import-*.db, backups/lyren-v*-before-upgrade-*.db)
   * to keep; older ones are deleted after a new one is written. 0 = keep all (never delete).
   */
  snapshotKeep: number;
  /**
   * Code required by first-run setup (POST /api/auth/setup) while no user exists.
   * From SETUP_TOKEN, else generated at startup and printed to the log. null = not required (tests).
   */
  setupToken: string | null;
}

/** A boolean variable: unset or empty -> `fallback`; else true only for 1, true, yes or on (any case). */
export function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function envInt(name: string, fallback: number, max = Number.MAX_SAFE_INTEGER, min = 1): number {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Invalid value for ${name}: ${v} (expected ${min}..${max})`);
  return n;
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

export function loadConfig(overrides: Partial<Config> = {}, defaults: ConfigDefaults = SERVER_DEFAULTS): Config {
  const dataDir = path.resolve(process.env.DATA_DIR ?? defaults.dataDir);
  const cookieSecureEnv = (process.env.COOKIE_SECURE ?? 'auto').toLowerCase();
  const base: Config = {
    host: process.env.HOST ?? defaults.host,
    port: envInt('PORT', defaults.port, 65535),
    dataDir,
    dbPath: process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(dataDir, 'lyren.db'),
    // WEB_DIR set (even empty = API only) wins over the default.
    webDir: process.env.WEB_DIR !== undefined ? process.env.WEB_DIR || null : defaults.webDir,
    cookieSecure: cookieSecureEnv === 'auto' ? 'auto' : envBool('COOKIE_SECURE', false),
    trustProxy: envBool('TRUST_PROXY', false),
    // Browsers cap cookie Max-Age at 400 days.
    sessionTtlDays: envInt('SESSION_TTL_DAYS', 30, 400),
    bodyLimit: envInt('BODY_LIMIT', 2 * 1024 * 1024),
    importBodyLimit: envInt('IMPORT_BODY_LIMIT', 50 * 1024 * 1024),
    logRequests: envBool('LOG_REQUESTS', false),
    snapshotKeep: envInt('SNAPSHOT_KEEP', DEFAULT_SNAPSHOT_KEEP, 100_000, 0),
    setupToken: process.env.SETUP_TOKEN?.trim() || null,
  };
  return { ...base, ...overrides };
}
