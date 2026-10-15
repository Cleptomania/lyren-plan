// Entry point of the single-file desktop app (lyren-plan.exe), a Node.js single executable
// application built by scripts/package.mjs. It is bundled as CommonJS (the only format SEA runs),
// so this module graph must not use top-level await or import.meta.
//
// Inside the executable the web client is embedded (desktop/assets.ts). Run from source
// (`npx tsx server/src/sea.ts`) it behaves the same but has no embedded client (set WEB_DIR) and
// always runs in its console (the notification-area icon is the Windows executable's, mode.ts).

import path from 'node:path';
import { isSea } from 'node:sea';
import { DamagedAppError, embeddedTrayIcon, embeddedWeb } from './desktop/assets';
import { runDesktopCli } from './desktop/main';
import type { StaticSource } from './http/static';

// The database, its WAL, backups and snapshots hold every project and the password hash:
// owner-only files (on Linux / macOS; on Windows the per-user data folder is private already).
process.umask(0o077);

async function main(): Promise<void> {
  const sea = isSea();
  let embedded: StaticSource | null = null;
  let damaged: string | null = null;
  if (sea) {
    try {
      embedded = embeddedWeb().source;
    } catch (err) {
      if (!(err instanceof DamagedAppError)) throw err;
      damaged = `This copy of Lyren Plan is damaged (${err.message}). Download or build it again.`;
    }
  }
  const exe = sea ? path.basename(process.execPath) : 'lyren-plan';
  await runDesktopCli(process.argv.slice(2), {
    exe,
    embedded,
    damaged,
    windowsApp: sea && process.platform === 'win32',
    trayIcon: embeddedTrayIcon,
  });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
