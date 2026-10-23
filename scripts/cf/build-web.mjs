// Wrangler's build command (wrangler.jsonc, design §10.8): builds the web client into dist/web, which
// Workers Static Assets serve. First it refuses a deploy or upload that scripts/cf/wrangler.mjs did not start
// while the checkout has an instance configuration (wrangler.instance.jsonc, or LYREN_INSTANCE_FILE; Appendix
// D 70, scripts/lib/cloudflare.mjs#wranglerRunRefusal), before anything is built or uploaded. It keeps a built
// dist/web/index.html as it is with LYREN_PREBUILT=1 (the deploy workflow builds the client in an earlier job,
// so that no Vite code runs next to the Cloudflare token, §10.10) and in a Workers Builds build whose build
// command has just built it (the Deploy button's, Appendix D 48; scripts/lib/cloudflare.mjs#prebuiltWebReason).
// Everyone else gets a normal build.
//
//   node scripts/cf/build-web.mjs [--run=<token>]     (--run: the build command of a run's wrangler.deploy.<id>.jsonc)

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { prebuiltWebReason, wranglerRunRefusal } from '../lib/cloudflare.mjs';
import { npmRunInvocation } from '../lib/npm-run.mjs';

const mtime = (file) => {
  try {
    return fs.statSync(new URL(file, import.meta.url)).mtimeMs;
  } catch {
    return null;
  }
};

// The instance configuration scripts/cf/wrangler.mjs reads without --instance (scripts/lib/instance.mjs):
// LYREN_INSTANCE_FILE, else wrangler.instance.jsonc in the checkout. Its path is not read here, only named.
const instanceSource =
  (process.env.LYREN_INSTANCE_FILE ?? '').trim() !== ''
    ? 'LYREN_INSTANCE_FILE'
    : fs.existsSync(new URL('../../wrangler.instance.jsonc', import.meta.url))
      ? 'wrangler.instance.jsonc'
      : null;
const refusal = wranglerRunRefusal(process.env, process.argv.slice(2), {
  instancePresent: instanceSource !== null,
  source: instanceSource,
});
if (refusal !== null) {
  console.error(refusal);
  process.exit(1);
}

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
