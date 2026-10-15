// Shared server types: dependencies passed to route factories and Hono context variables.

import type { Config } from './config';
import type { Db } from './db';
import type { SessionRow, UserRow } from './auth/sessions';
import type { StaticSource } from './http/static';

export interface Deps {
  db: Db;
  config: Config;
  /**
   * Where the web client comes from. Omitted: config.webDir on disk (null = API only). The desktop
   * app passes its embedded client here.
   */
  web?: StaticSource | null;
  /**
   * Set only by the single-file desktop app (desktop/serve.ts): the client then shows the app's
   * commands instead of the Node build's and Docker's (AuthStatusDTO.desktop, BootstrapDTO.desktop).
   * Omitted, every response is the same as before the desktop app existed.
   */
  desktop?: DesktopDeps;
}

/** What the client needs to explain the desktop app's command line (routes/desktop.ts). */
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

export interface AppEnv {
  Variables: {
    user: UserRow | null;
    session: SessionRow | null;
  };
}
