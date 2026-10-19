// Runs after `npm run check:cf` (npm's postcheck:cf): Wrangler bundles the Worker inside .wrangler/tmp/
// next to wrangler.jsonc, and a dry run leaves that folder behind, empty. A check should leave nothing
// but dist/worker. Only empty folders are removed, so a `wrangler dev` running meanwhile keeps its own
// (and .wrangler/state, the local Durable Object data of `npm run dev:cf`, is never touched).

import fs from 'node:fs';

for (const dir of ['.wrangler/tmp', '.wrangler']) {
  try {
    fs.rmdirSync(new URL(`../../${dir}`, import.meta.url));
  } catch {
    // Not there, or not empty: left as it is.
  }
}
