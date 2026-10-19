// The app version for runtime-neutral code (design §10.9): the build defines __APP_VERSION__
// (scripts/build-server.mjs, Vite); otherwise, as under Wrangler and in tests, package.json's.
// Neutral code must not import config.ts, which reads process.env and imports node:path. A named import, so
// that bundlers keep only that field of package.json (a default import put all of it in the Worker).

import { version } from '../../../package.json';

declare const __APP_VERSION__: string | undefined;

export const APP_VERSION: string = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : version;
