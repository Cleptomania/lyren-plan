// Writes wrangler.deploy.jsonc next to wrangler.jsonc: the same configuration with "workers_dev": false, the
// send_email binding EMAIL of MAIL_TRANSPORT=cloudflare, or both, for scripts/ci/deploy-cloudflare.sh
// (WORKERS_DEV=false, EMAIL_BINDING) and for `npx wrangler deploy --config wrangler.deploy.jsonc` by hand
// (design §10.10, §10.11, Appendix D 68). Next to it, so the paths in it resolve as before; git-ignored, and
// removed again by the deploy script.
//
//   node scripts/ci/wrangler-config.mjs [--workers-dev=false] [--email-binding]

import fs from 'node:fs';
import { DEPLOY_CONFIG, deployChanges, deployConfig } from '../lib/cloudflare.mjs';

const USAGE = 'Usage: node scripts/ci/wrangler-config.mjs [--workers-dev=false] [--email-binding] (one or both)';
const args = process.argv.slice(2);
const known = ['--workers-dev=false', '--email-binding'];
if (args.length === 0 || args.some((arg) => !known.includes(arg)) || new Set(args).size !== args.length) {
  console.error(USAGE);
  process.exit(2);
}
const options = { workersDev: !args.includes('--workers-dev=false'), emailBinding: args.includes('--email-binding') };
const source = new URL('../../wrangler.jsonc', import.meta.url);
const target = new URL(`../../${DEPLOY_CONFIG}`, import.meta.url);
fs.writeFileSync(target, deployConfig(fs.readFileSync(source, 'utf8'), options));
console.log(`Wrote ${DEPLOY_CONFIG}: wrangler.jsonc with ${deployChanges(options)}`);
