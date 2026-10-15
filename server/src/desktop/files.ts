// The files the desktop app keeps next to its database: desktop.json (state.ts: the remembered port,
// the instance secret, the setup code of a first start) and the log file (log.ts). For lyren.db, the
// usual case, they are desktop.json and logs\lyren-plan.log. A database with another name
// (--db-path D:\Plans\work.db) gets files named after it, work.db.desktop.json and logs\work.db.log,
// so that two databases in one folder never share an instance secret (each copy could otherwise
// neither be stopped nor found by a second start), a remembered port or a log.
//
// Versions before this kept desktop.json for any database name. While a database's own file does not
// exist yet, that desktop.json is still read, unless lyren.db lives in the same folder (it is then
// lyren.db's): its remembered port moves to the new file at the next start, and a copy of the older
// version that is still running can be found and stopped.

import fs from 'node:fs';
import path from 'node:path';
import { LOG_FILE_NAME } from './log';
import { readDesktopState, type DesktopState } from './state';

export const STATE_FILE_NAME = 'desktop.json';
const DEFAULT_DB_NAME = 'lyren.db';

export interface DesktopFiles {
  /** desktop.json, or <database file name>.desktop.json. */
  stateFile: string;
  /** desktop.json of an older version, read while stateFile does not exist; null for lyren.db. */
  legacyStateFile: string | null;
  /** The folder of the log file (logs next to the database). */
  logDir: string;
  /** lyren-plan.log, or <database file name>.log. */
  logName: string;
}

/** Whether `name` is lyren.db (Windows and macOS compare file names without case). */
function isDefaultName(name: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' || platform === 'darwin' ? name.toLowerCase() === DEFAULT_DB_NAME : name === DEFAULT_DB_NAME;
}

export function desktopFiles(dbPath: string, platform: NodeJS.Platform = process.platform): DesktopFiles {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const dir = p.dirname(dbPath);
  const name = p.basename(dbPath);
  const usual = isDefaultName(name, platform);
  return {
    stateFile: p.join(dir, usual ? STATE_FILE_NAME : `${name}.${STATE_FILE_NAME}`),
    legacyStateFile: usual ? null : p.join(dir, STATE_FILE_NAME),
    logDir: p.join(dir, 'logs'),
    logName: usual ? LOG_FILE_NAME : `${name}.log`,
  };
}

/** The state of this database's copy (desktop.json; see above for an older version's file). */
export function readStateOf(files: DesktopFiles): DesktopState {
  const legacy = files.legacyStateFile;
  if (legacy === null || fs.existsSync(files.stateFile)) return readDesktopState(files.stateFile);
  if (fs.existsSync(path.join(path.dirname(legacy), DEFAULT_DB_NAME))) return {};
  return readDesktopState(legacy);
}
