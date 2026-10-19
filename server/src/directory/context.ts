// What the directory's services and routes share: the dependencies, the mailer, and the state one
// directory keeps in memory (the throttle's buffered counters, the hash queue and failure floor, the
// setup code). createDirectoryApp builds one per directory database.

import type { DirectoryConfig } from '../core/config';
import type { Db } from '../core/db';
import type { DirectoryDeps } from './app';
import type { Mailer } from './mailer';
import type { PasswordHasher } from './passwords';
import type { SetupCode } from './settings';
import type { Throttle } from './throttle';

export interface DirectoryContext {
  deps: DirectoryDeps;
  db: Db;
  config: DirectoryConfig;
  throttle: Throttle;
  passwords: PasswordHasher;
  setupCode: SetupCode;
  /** Every message the directory sends goes through it (§5.10.5). */
  mailer: Mailer;
  /** deps.clock.now(). */
  now(): number;
}

/**
 * Run `work` after the request has been answered (a 0 ms timer, handed to DirectoryDeps.defer, which logs
 * a failure). The anonymous flows that must not reveal whether an address has an account (sign-up, forgot
 * password, §13.6) do their lookups and send their mail this way, so the answer and its timing are the same
 * on both paths.
 */
export function afterResponse(ctx: DirectoryContext, work: () => void | Promise<void>): void {
  ctx.deps.defer(new Promise((resolve) => setTimeout(resolve, 0)).then(work));
}
