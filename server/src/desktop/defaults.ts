// Defaults of the single-file desktop app (lyren-plan.exe), used for environment variables that
// are not set. The Node build and Docker keep SERVER_DEFAULTS (config.ts).

import path from 'node:path';
import type { ConfigDefaults } from '../config';

/**
 * The desktop app's port. Not 8080, so it never collides with a Node or Docker Lyren Plan or the
 * many other servers that default to it; below 49152, so it is outside the range Windows hands
 * out for outgoing connections and reserves for Hyper-V, WSL and Docker; and not a port that
 * common tools or Windows services use. It is fixed (rather than random) because the browser
 * keys a site's storage, service worker and installed app to its origin, port included.
 */
export const DESKTOP_PORT = 43770;

/** Ports tried after DESKTOP_PORT when it is taken (only when PORT is not set). */
export const DESKTOP_PORT_SPAN = 10;

/** Per-user data folder: where the database, snapshots and desktop.json live. */
export function desktopDataDir(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  home: string,
): string {
  if (platform === 'win32') {
    // Local, not Roaming: a SQLite database must not be copied around by roaming profiles.
    const local = env.LOCALAPPDATA && path.win32.isAbsolute(env.LOCALAPPDATA) ? env.LOCALAPPDATA : path.win32.join(home, 'AppData', 'Local');
    return path.win32.join(local, 'Lyren Plan');
  }
  if (platform === 'darwin') return path.posix.join(home, 'Library', 'Application Support', 'Lyren Plan');
  // XDG Base Directory: $XDG_DATA_HOME (only when absolute), else ~/.local/share.
  const xdg = env.XDG_DATA_HOME && path.posix.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.posix.join(home, '.local', 'share');
  return path.posix.join(xdg, 'lyren-plan');
}

/** Private to this computer (127.0.0.1) and no firewall prompt; --lan / HOST=0.0.0.0 opens it up. */
export function desktopDefaults(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  home: string,
): ConfigDefaults {
  return { host: '127.0.0.1', port: DESKTOP_PORT, dataDir: desktopDataDir(platform, env, home), webDir: null };
}
