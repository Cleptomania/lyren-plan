// What the web client learns about the single-file desktop app (Deps.desktop), so that the sign-in
// page and Settings → Data explain the app's own commands instead of `node dist/server.mjs` and
// Docker. Only the desktop app sets Deps.desktop; the Node build's and Docker's responses stay as
// they were (no `desktop` key at all).
//
// GET /api/auth/status is public, so desktopApp() names the program file but no folder; the paths
// (data folder, program folder) only go to signed-in users, in GET /api/bootstrap.

import path from 'node:path';
import type { DesktopAppDTO, DesktopDataDTO } from '@shared/types';
import type { Config } from '../config';
import type { DesktopDeps } from '../env';

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

/** BootstrapDTO.desktop: signed in only. */
export function desktopData(desktop: DesktopDeps, config: Config): DesktopDataDTO {
  return {
    ...desktopApp(desktop),
    dataDir: config.dataDir,
    dbPath: separateDbPath(config, desktop.windows),
    customDataDir: !samePath(config.dataDir, path.resolve(desktop.defaultDataDir), desktop.windows),
    exeFolder: desktop.exeFolder,
  };
}
