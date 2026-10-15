// Bundles the server (and all its npm dependencies) into a single dist/server.mjs.
// The result only needs Node >= 22.13 (built-in node:sqlite) and dist/web.

import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

await build({
  entryPoints: ['server/src/index.ts'],
  outfile: 'dist/server.mjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  tsconfig: 'tsconfig.server.json',
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  // Some bundled CJS deps call require(); give the ESM bundle a real one.
  banner: {
    js: "import { createRequire as __lyrenCreateRequire } from 'node:module'; const require = __lyrenCreateRequire(import.meta.url);",
  },
  logLevel: 'info',
});
