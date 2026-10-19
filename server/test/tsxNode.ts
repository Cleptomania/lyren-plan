// Runs the server's TypeScript sources in a child process for the CLI and desktop tests: plain
// node with tsx's loader, in ONE process, on every platform.
//
// Not node_modules/.bin/tsx: on Windows that is a POSIX shell script (spawn fails with ENOENT, and
// npm's tsx.cmd would need a shell). Not tsx's CLI either: it runs the program in a second node
// process and relays signals to it, and on Windows child.kill() is TerminateProcess, which would
// end only the CLI and leave the server running.

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const LOADER = pathToFileURL(path.join(ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
const TSCONFIG = path.join(ROOT, 'tsconfig.server.json');

/**
 * Command and arguments for `tsx --tsconfig tsconfig.server.json <script> ...args` (cwd ROOT). Node 22's
 * ExperimentalWarning for node:sqlite is off, as in every documented command (README, docs/ubuntu-server.md),
 * so that the tests that compare stderr pass on the oldest Node that package.json allows too.
 */
export function tsxCommand(script: string, args: string[] = []): [string, string[]] {
  return [process.execPath, ['--disable-warning=ExperimentalWarning', '--import', LOADER, script, ...args]];
}

/** `env` plus the tsconfig for tsx (the server's path aliases). */
export function tsxEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  return { ...env, TSX_TSCONFIG_PATH: TSCONFIG };
}
