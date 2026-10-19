// Wrangler's build command (wrangler.jsonc, design §10.8): builds the web client into dist/web, which
// Workers Static Assets serve. It keeps a built dist/web/index.html as it is with LYREN_PREBUILT=1 (the
// deploy workflow builds the client in an earlier job, so that no Vite code runs next to the Cloudflare
// token, §10.10) and in a Workers Builds build whose build command has just built it (the Deploy button's,
// Appendix D 48; scripts/lib/cloudflare.mjs#prebuiltWebReason). Everyone else gets a normal build.

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { prebuiltWebReason } from '../lib/cloudflare.mjs';
import { npmRunInvocation } from '../lib/npm-run.mjs';

const mtime = (file) => {
  try {
    return fs.statSync(new URL(file, import.meta.url)).mtimeMs;
  } catch {
    return null;
  }
};

const reason = prebuiltWebReason(process.env, {
  indexMtime: mtime('../../dist/web/index.html'),
  checkoutMtime: mtime('../../package.json'),
});
if (reason !== null) {
  console.log(`build-web: ${reason}, using the web client already in dist/web`);
} else {
  const { command, args, shell } = npmRunInvocation('build:web');
  const result = spawnSync(command, args, { stdio: 'inherit', shell });
  if (result.error) {
    console.error(`build-web: could not start npm run build:web: ${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}
