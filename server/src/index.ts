// Entry point of the Node build and Docker:
//   node dist/server.mjs [serve|backup <file>|reset-password <username>|help]
// The commands live in cli.ts; the single-file desktop app has its own entry (sea.ts).

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runServerCli } from './cli';
import { bundledWebDir, SERVER_DEFAULTS } from './config';

// The database, its WAL, backups and snapshots hold every project and the password hash:
// create all files owner-only (0600 / 0700 dirs) whatever umask the service was started with.
process.umask(0o077);

// Bundled: dist/server.mjs serves dist/web. Dev (tsx): server/src/index.ts serves <repo>/dist/web.
const entryDir = path.dirname(fileURLToPath(import.meta.url));
await runServerCli(process.argv.slice(2), { ...SERVER_DEFAULTS, webDir: bundledWebDir(entryDir) });
