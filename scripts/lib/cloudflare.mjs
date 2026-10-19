// Helpers of the Cloudflare scripts (design §10.8-§10.10): reading wrangler.jsonc, the copy of it that
// scripts/ci/wrangler-config.mjs writes for a deploy with workers.dev turned off or the email binding, and when
// scripts/cf/build-web.mjs may keep the web client that is already built. Unit-tested in
// scripts/test/wrangler-config.test.mjs.

/** The deploy configuration's file name, next to wrangler.jsonc (git-ignored). */
export const DEPLOY_CONFIG = 'wrangler.deploy.jsonc';

/**
 * The JSON text of a .jsonc file: `//` and `/* *\/` comments outside strings and trailing commas removed,
 * which is what Wrangler accepts beyond JSON. A fork's wrangler.jsonc may have comments at the end of a line.
 */
export function stripJsonc(text) {
  let out = '';
  // The position in `out` of a comma that only white space and comments follow so far: dropped before } or ].
  let comma = -1;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      if (j >= text.length) throw new Error('Unterminated string');
      out += text.slice(i, j + 1);
      comma = -1;
      i = j + 1;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) throw new Error('Unterminated /* comment');
      i = end + 2;
    } else {
      if ((c === '}' || c === ']') && comma !== -1) out = out.slice(0, comma) + out.slice(comma + 1);
      if (c === ',') comma = out.length;
      else if (!/\s/.test(c)) comma = -1;
      out += c;
      i++;
    }
  }
  return out;
}

/** A .jsonc file's value. */
export const parseJsonc = (text) => JSON.parse(stripJsonc(text));

/** The send_email binding that MAIL_TRANSPORT=cloudflare sends through (server/src/mail/cloudflare.ts). */
export const EMAIL_BINDING = 'EMAIL';

/** What deployConfig changed, for its header and the output of scripts/ci/wrangler-config.mjs. */
export function deployChanges({ workersDev = true, emailBinding = false } = {}) {
  const changes = [];
  if (!workersDev) changes.push('workers_dev false');
  if (emailBinding) changes.push(`the send_email binding ${EMAIL_BINDING}`);
  return changes.join(' and ');
}

/**
 * The text of wrangler.deploy.jsonc: wrangler.jsonc as JSON with what a deploy asks for, and everything else
 * as it is, the relative paths included, which is why the file goes next to wrangler.jsonc.
 *
 * - workersDev false: "workers_dev": false, once a custom domain works (WORKERS_DEV=false, §10.11).
 * - emailBinding true: the send_email binding EMAIL that MAIL_TRANSPORT=cloudflare needs (Cloudflare Email
 *   Service, Workers Paid; EMAIL_BINDING, Appendix D 68), unless the configuration has one of that name: a
 *   fork may have its own, restricted one. Not in the committed wrangler.jsonc, which suits the Free plan.
 */
export function deployConfig(text, { workersDev = true, emailBinding = false } = {}) {
  const config = parseJsonc(text);
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('wrangler.jsonc does not hold an object');
  }
  const changes = deployChanges({ workersDev, emailBinding });
  if (changes === '') throw new Error('deployConfig needs workersDev false or emailBinding true');
  if (!workersDev) config.workers_dev = false;
  if (emailBinding) {
    const bindings = config.send_email ?? [];
    if (!Array.isArray(bindings)) throw new Error('send_email in wrangler.jsonc is not a list');
    if (!bindings.some((binding) => binding?.name === EMAIL_BINDING)) config.send_email = [...bindings, { name: EMAIL_BINDING }];
  }
  return (
    '// Written by scripts/ci/wrangler-config.mjs from wrangler.jsonc, for scripts/ci/deploy-cloudflare.sh or\n' +
    `// \`npx wrangler deploy --config ${DEPLOY_CONFIG}\`: the same configuration with ${changes}.\n` +
    '// Do not edit; edit wrangler.jsonc.\n' +
    `${JSON.stringify(config, null, 2)}\n`
  );
}

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
