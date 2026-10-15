// Opens the user's default browser at an http(s) URL. No shell is involved, so nothing in the URL
// can be interpreted as a command: Windows uses rundll32's url.dll,FileProtocolHandler (the
// shell's "open" for the URL, i.e. the default browser), by absolute path so that a program
// planted next to the exe or in the working directory can't stand in for it; macOS `open`;
// elsewhere `xdg-open`. Also opens the data folder in File Explorer (the tray menu, Windows).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { NO_TEST_HOOKS, type TestHooks } from './hooks';

export interface BrowserCommand {
  file: string;
  args: string[];
}

export function browserCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): BrowserCommand {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(`Not a web address: ${url}`);
  const href = parsed.href;
  if (platform === 'win32') {
    const windir = env.SystemRoot || env.windir || 'C:\\Windows';
    return { file: path.win32.join(windir, 'System32', 'rundll32.exe'), args: ['url.dll,FileProtocolHandler', href] };
  }
  if (platform === 'darwin') return { file: '/usr/bin/open', args: [href] };
  return { file: 'xdg-open', args: [href] };
}

/** Whether a graphical session is available to open a browser in (Linux/BSD without a display has none). */
export function canOpenBrowser(platform: NodeJS.Platform = process.platform, env: Record<string, string | undefined> = process.env): boolean {
  if (platform === 'win32' || platform === 'darwin') return true;
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

/**
 * Start the browser; resolves false when that was not possible (the caller prints the URL anyway).
 * LYREN_TEST_BROWSER_LOG (hooks.ts) records the URL instead.
 */
export function openBrowser(url: string, hooks: TestHooks = NO_TEST_HOOKS): Promise<boolean> {
  if (hooks.browserLog) {
    try {
      browserCommand(url);
      fs.appendFileSync(hooks.browserLog, `${url}\n`);
      return Promise.resolve(true);
    } catch {
      return Promise.resolve(false);
    }
  }
  if (!canOpenBrowser()) return Promise.resolve(false);
  let cmd: BrowserCommand;
  try {
    cmd = browserCommand(url);
  } catch {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd.file, cmd.args, { detached: true, stdio: 'ignore', windowsHide: true });
      child.once('error', () => resolve(false));
      child.once('spawn', () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}

/**
 * File Explorer opens a folder only when its path is shorter than this (MAX_PATH); with a longer one
 * it opens Documents instead (measured on Windows 11 25H2: 259 characters open, 260 do not).
 */
export const MAX_EXPLORER_PATH = 259;

export interface FolderCommand extends BrowserCommand {
  /** Pass `args` to CreateProcess as they are (explorer.exe reads its own command line). */
  verbatim: boolean;
}

/**
 * File Explorer at `dir` (Windows): explorer.exe by absolute path, no shell, the folder in double
 * quotes (explorer.exe splits an unquoted path at a comma, semicolon or equals sign and then opens
 * Documents; Node would quote only a path with a space). A drive's root (D:\) stays unquoted: a
 * backslash before the closing quote may be read as an escaped quote, and a root has nothing to split.
 * Throws for a relative path and for one File Explorer can't open (MAX_EXPLORER_PATH).
 */
export function folderCommand(dir: string, env: Record<string, string | undefined> = process.env): FolderCommand {
  if (!path.win32.isAbsolute(dir)) throw new Error(`Not an absolute folder: ${dir}`);
  if (dir.length > MAX_EXPLORER_PATH) throw new FolderTooLongError(dir);
  if (dir.includes('"')) throw new Error(`Not a folder name: ${dir}`);
  const arg = dir.endsWith('\\') ? dir : `"${dir}"`;
  return { file: path.win32.join(env.SystemRoot || env.windir || 'C:\\Windows', 'explorer.exe'), args: [arg], verbatim: true };
}

/** A folder File Explorer can't open (its path is too long). */
export class FolderTooLongError extends Error {
  constructor(readonly dir: string) {
    super(`File Explorer can't open a folder whose path is longer than ${MAX_EXPLORER_PATH} characters`);
    this.name = 'FolderTooLongError';
  }
}

/**
 * Open `dir` in File Explorer. Not started hidden: explorer.exe is a windowed program (no console to
 * hide), and windowsHide would open the folder's window hidden. Resolves 'opened', 'too-long'
 * (FolderTooLongError) or 'failed'.
 */
export function openFolder(dir: string): Promise<'opened' | 'too-long' | 'failed'> {
  let cmd: FolderCommand;
  try {
    cmd = folderCommand(dir);
  } catch (err) {
    return Promise.resolve(err instanceof FolderTooLongError ? 'too-long' : 'failed');
  }
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd.file, cmd.args, { detached: true, stdio: 'ignore', windowsVerbatimArguments: cmd.verbatim });
      child.once('error', () => resolve('failed'));
      child.once('spawn', () => {
        child.unref();
        resolve('opened');
      });
    } catch {
      resolve('failed');
    }
  });
}
