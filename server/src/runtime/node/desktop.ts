// What the web client learns about the single-file desktop app, so that the sign-in page and Settings →
// Data explain the app's own commands instead of `node dist/server.mjs` and Docker (moved from
// routes/desktop.ts: it needs the Node Config, which the runtime-neutral apps never see). Only the
// desktop app passes DesktopDeps to openNodeStack (stack.ts), which hands the directory app
// DirectoryDeps.desktop; the Node build's and Docker's responses have neither key.
//
// GET /api/auth/status is public, so desktopApp() names the program file but no folder; the paths
// (data folder, program folder) only go to instance admins, in AuthStatusDTO.desktopData.

import path from 'node:path';
import type { DesktopAppDTO, DesktopDataDTO } from '@shared/types';
import type { Config } from '../../config';

/** What the client needs to explain the desktop app's command line. */
export interface DesktopDeps {
  /** The program's file name, e.g. lyren-plan-0.1.0-win-x64.exe (lyren-plan when run from source). */
  exe: string;
  /** The folder that holds the program; null when run from source. */
  exeFolder: string | null;
  /** Commands for Command Prompt (Windows) rather than a POSIX shell. */
  windows: boolean;
  /** The data folder used when neither --data-dir nor DATA_DIR is given (desktopDataDir). */
  defaultDataDir: string;
  /**
   * Windows, while the icon in the notification area is shown (desktop/mode.ts): 'tray' without a
   * console window, 'terminal' when started in a terminal. Unset: it runs in its console window.
   * Read for every response (it is dropped when the icon fails in terminal mode).
   */
  stopMode?: 'tray' | 'terminal';
}

/** AuthStatusDTO.desktop: public, no paths. stopMode only while the notification-area icon is in use. */
export function desktopApp(desktop: DesktopDeps): DesktopAppDTO {
  return { exe: desktop.exe, windows: desktop.windows, ...(desktop.stopMode ? { stopMode: desktop.stopMode } : {}) };
}

/** Two absolute paths name the same file or folder (Windows: without case). */
const samePath = (a: string, b: string, windows: boolean) => (windows ? a.toLowerCase() === b.toLowerCase() : a === b);

/**
 * The database file when DB_PATH makes it anything but lyren.db in the data folder (another folder
 * or another name), else null. The maintenance commands then need `--db-path <file>`, and a
 * restore replaces that file. Also the console banner's "Database:" line (desktop/serve.ts).
 */
export function separateDbPath(config: Pick<Config, 'dataDir' | 'dbPath'>, windows: boolean): string | null {
  return samePath(config.dbPath, path.join(config.dataDir, 'lyren.db'), windows) ? null : config.dbPath;
}

/**
 * The option a maintenance command (stop, backup, reset-password) needs to reach this database, by the
 * web client's rule (targetOption): `--db-path` when DB_PATH makes the database a separate file, else
 * `--data-dir` when the data folder is not the per-user default, else none. For the desktop app's own
 * texts (the banner, a second start).
 */
export function commandTargetOption(
  config: Pick<Config, 'dataDir' | 'dbPath'>,
  defaultDataDir: string,
  windows: boolean,
): { name: '--db-path' | '--data-dir'; value: string } | null {
  const dbPath = separateDbPath(config, windows);
  if (dbPath !== null) return { name: '--db-path', value: dbPath };
  if (!samePath(config.dataDir, path.resolve(defaultDataDir), windows)) return { name: '--data-dir', value: config.dataDir };
  return null;
}

/** AuthStatusDTO.desktopData: instance admins only. */
export function desktopData(desktop: DesktopDeps, config: Pick<Config, 'dataDir' | 'dbPath'>): DesktopDataDTO {
  return {
    ...desktopApp(desktop),
    dataDir: config.dataDir,
    dbPath: separateDbPath(config, desktop.windows),
    customDataDir: !samePath(config.dataDir, path.resolve(desktop.defaultDataDir), desktop.windows),
    exeFolder: desktop.exeFolder,
  };
}
