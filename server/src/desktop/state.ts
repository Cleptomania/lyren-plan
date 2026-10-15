// desktop.json, next to the database (files.ts names it), what the desktop app remembers between starts:
//   port    the port it last listened on when PORT was not set, tried first next time so the
//           address (and with it the browser's storage and an installed app) stays the same
//   secret  the running server's instance secret (see instance.ts)
//   setupCode  while no account exists: the setup code, so that starting the app again opens the
//           setup page with it filled in (the folder is private to its owner, like the database)
// Written in place (not write-to-temp-and-rename: Windows refuses to replace a file another
// process has open) and owner-only; a damaged file just counts as empty.

import fs from 'node:fs';

export interface DesktopState {
  port?: number;
  secret?: string;
  setupCode?: string;
}

export function parseDesktopState(text: string): DesktopState {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof raw !== 'object' || raw === null) return {};
  const { port, secret, setupCode } = raw as Record<string, unknown>;
  const state: DesktopState = {};
  if (typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535) state.port = port;
  if (typeof secret === 'string' && /^[0-9a-f]{32,128}$/.test(secret)) state.secret = secret;
  if (typeof setupCode === 'string' && setupCode.length > 0 && setupCode.length <= 200) state.setupCode = setupCode;
  return state;
}

export function readDesktopState(file: string): DesktopState {
  try {
    return parseDesktopState(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

/** Returns false (after a warning) when the file can't be written. */
export function writeDesktopState(file: string, state: DesktopState): boolean {
  try {
    fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    return true;
  } catch (err) {
    console.warn(`[lyren] Could not write ${file}: ${(err as Error).message}`);
    return false;
  }
}
