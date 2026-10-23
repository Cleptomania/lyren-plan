// Helpers of the Cloudflare scripts (design §10.8-§10.10, Appendix D 70): reading wrangler.jsonc and an
// instance configuration, the names of the configurations scripts/cf/wrangler.mjs generates, one per Wrangler run,
// when scripts/cf/build-web.mjs may keep the web client that is already built, and which Wrangler runs it refuses
// to build for. Unit-tested in scripts/test/wrangler-config.test.mjs.

/**
 * The configuration scripts/cf/wrangler.mjs generates for one Wrangler run, `id` (8 hexadecimal digits) its own:
 * wrangler.deploy.<id>.jsonc, next to wrangler.jsonc so that the relative paths in it resolve as there
 * (git-ignored as wrangler.deploy*.jsonc; removed when the run ends). Runs at the same time, such as a tail and a
 * deploy, each have their own.
 */
export function deployConfigName(id) {
  if (typeof id !== 'string' || !/^[0-9a-f]{8}$/.test(id)) {
    throw new Error('deployConfigName needs 8 hexadecimal digits');
  }
  return `wrangler.deploy.${id}.jsonc`;
}

/** The names deployConfigName gives. */
export const DEPLOY_CONFIG_PATTERN = /^wrangler\.deploy\.[0-9a-f]{8}\.jsonc$/;

/** The one name an earlier version generated for every run, which no run reads now. */
export const LEGACY_DEPLOY_CONFIG = 'wrangler.deploy.jsonc';

/** "(line 3 column 5)" of the position `index` in `text`, as JSON.parse names a position. */
function lineColumn(text, index) {
  const lines = text.slice(0, index).split('\n');
  return `(line ${lines.length} column ${lines[lines.length - 1].length + 1})`;
}

/**
 * The JSON text of a .jsonc file: `//` and `/* *\/` comments outside strings and trailing commas turned into
 * spaces, which is what Wrangler accepts beyond JSON. Everything else keeps its place, line breaks included,
 * so the line and column of a JSON.parse error are the file's own. A fork's wrangler.jsonc may have comments
 * at the end of a line.
 */
export function stripJsonc(text) {
  const out = text.split('');
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
  };
  // The position of a comma that only white space and comments follow so far: dropped before } or ].
  let comma = -1;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      if (j >= text.length) throw new Error(`Unterminated string ${lineColumn(text, i)}`);
      comma = -1;
      i = j + 1;
    } else if (c === '/' && text[i + 1] === '/') {
      const start = i;
      while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i++;
      blank(start, i);
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) throw new Error(`Unterminated /* comment ${lineColumn(text, i)}`);
      blank(i, end + 2);
      i = end + 2;
    } else {
      if ((c === '}' || c === ']') && comma !== -1) out[comma] = ' ';
      if (c === ',') comma = i;
      else if (!/\s/.test(c)) comma = -1;
      i++;
    }
  }
  return out.join('');
}

/** A .jsonc file's value. */
export const parseJsonc = (text) => JSON.parse(stripJsonc(text));

/** The send_email binding that MAIL_TRANSPORT=cloudflare sends through (server/src/mail/cloudflare.ts). */
export const EMAIL_BINDING = 'EMAIL';

/**
 * Why scripts/cf/build-web.mjs, wrangler.jsonc's build command, may leave dist/web as it is, or null when it
 * must build it. `indexMtime` is dist/web/index.html's modification time (null when there is none),
 * `checkoutMtime` package.json's, which the checkout wrote.
 *
 * - LYREN_PREBUILT=1: whoever set it built the client before (the deploy workflow does, in a job without the
 *   Cloudflare token, so that no Vite code runs next to it; §10.10).
 * - Workers Builds (WORKERS_CI=1: the Deploy button's builds, and any repository connected in the dashboard):
 *   its build command, prefilled from package.json's build script, has built the client in this checkout
 *   already, and `npx wrangler deploy` would build it again (Appendix D 48). Only a client newer than the
 *   checkout counts, so one that came from anywhere else (a build cache) is built again.
 */
export function prebuiltWebReason(env, { indexMtime, checkoutMtime }) {
  if (indexMtime === null) return null;
  if (env.LYREN_PREBUILT === '1') return 'LYREN_PREBUILT=1';
  if (env.WORKERS_CI === '1' && checkoutMtime !== null && indexMtime > checkoutMtime) {
    return 'Workers Builds built it already (WORKERS_CI=1)';
  }
  return null;
}

/**
 * Why scripts/cf/build-web.mjs, wrangler.jsonc's build command, refuses this Wrangler run, or null when it may
 * build (Appendix D 70; docs/cloudflare.md, "Your instance configuration"). With an instance configuration, a
 * deploy must come from scripts/cf/wrangler.mjs, which lays it over wrangler.jsonc: a plain `npx wrangler deploy`
 * would deploy wrangler.jsonc without it. The wrapper's generated build command carries `--run=<token>` (`argv`)
 * and its environment the same token as LYREN_WRANGLER_RUN, so neither a leftover wrangler.deploy.<id>.jsonc nor
 * an exported variable passes alone. Wrangler hands the build command WRANGLER_COMMAND: deploy, versions upload
 * and types, as scripts/test/wrangler-config.test.mjs pins against the pinned Wrangler, offline; deploy for
 * preview, and dev for wrangler dev, as read from wrangler-dist/cli.js (no test starts wrangler dev: it would
 * reach Cloudflare for its request.cf data). The build runs before Wrangler reads the Worker's state, so a refusal
 * also stops the write-back of the dashboard's values into the tracked wrangler.jsonc.
 *
 * - WRANGLER_COMMAND unset: allowed (fail open; the pinned test catches a Wrangler that stops setting it).
 * - dev and types: allowed (npm run dev:cf never reads the instance configuration).
 * - this run's token: allowed.
 * - no instance configuration (`instancePresent` false): allowed, wrangler.jsonc as it is, as before (the
 *   Deploy button's first build). `source` names the one there is.
 */
export function wranglerRunRefusal(env, argv, { instancePresent, source }) {
  const command = (env.WRANGLER_COMMAND ?? '').trim();
  if (command === '' || command === 'dev' || command === 'types') return null;
  const token = env.LYREN_WRANGLER_RUN ?? '';
  if (token.trim() !== '' && argv.includes(`--run=${token}`)) return null;
  if (!instancePresent) return null;
  return (
    `::error::This checkout has an instance configuration (${source}), but this wrangler ${command} does not use it: ` +
    'deploy with npm run deploy:cf (in Workers Builds: Settings → Build → Deploy command). Nothing was uploaded.'
  );
}
