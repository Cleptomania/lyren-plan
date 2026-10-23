// The instance configuration (scripts/lib/instance.mjs; docs/cloudflare.md, "Your instance configuration";
// design Appendix D 70): where it is found, what it may hold and the rules between its keys, the configuration
// made from it and the real wrangler.jsonc, the Wrangler arguments and secrets files that go with it, and the
// committed example, which the app's own parser checks too. The lists of names are checked against the app's own
// code (server/src/core/config.ts) and Wrangler's installed schema. No test reads the checkout's own instance
// configuration: a fork that commits one still passes.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkAppConfig, loadAppConfigParser } from '../lib/app-config.mjs';
import { parseJsonc } from '../lib/cloudflare.mjs';
import {
  APP_OWNED_KEYS,
  APP_VARIABLES,
  BOOLEAN_VARIABLES,
  DEV_ONLY,
  EXAMPLE_FILE,
  FILE_SECRETS,
  INSTANCE_FILE,
  INSTANCE_KEYS,
  NODE_ONLY,
  RETIRED,
  SECRET_NAMES,
  UNUSED_BINDINGS,
  accountProblem,
  checkBase,
  checkInstance,
  checkSecretsFile,
  declaredSecrets,
  generateConfig,
  generatedConfigText,
  generatorOf,
  instanceVars,
  nameProblem,
  nearest,
  readArgs,
  resolveInstanceSource,
  varArgs,
  workerOnly,
  wranglerArgsProblems,
} from '../lib/instance.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
/** The project's wrangler.jsonc, as each run reads it. */
const BASE = parseJsonc(read('wrangler.jsonc'));
/** A run token as newRunToken makes them. */
const TOKEN = '0123456789abcdef0123456789abcdef';

/** A value that a shell would turn into something else anywhere but in a variable or an argument. */
const ODD = `He said "hi" $(touch pwned) \`touch pwned2\` 'x' \\ $HOME ;|& *\nsecond line  `;

/** checkInstance of a configuration of the Worker lyren-plan with `fields`. */
const check = (fields, env = {}) => checkInstance({ name: 'lyren-plan', ...fields }, { env });
const errorsOf = (fields, env) => check(fields, env).errors;
/** A custom domain of "routes". */
const domain = (pattern) => ({ pattern, custom_domain: true });

// ---------------------------------------------------------------------------
// The names
// ---------------------------------------------------------------------------

describe('the names an instance configuration knows', () => {
  const configTs = read('server/src/core/config.ts');
  // Every variable core/config.ts reads: readText(vars, 'X'), readInt(vars, 'X', …), limit('X', …), …
  const readNames = new Set([...configTs.matchAll(/\b(?:read\w+\(vars, |limit\()'([A-Z][A-Z0-9_]*)'/g)].map((m) => m[1]));

  it('APP_VARIABLES are every variable the app reads on Cloudflare but the secrets and MAIL_LOG_BODIES', () => {
    // Of the Node server's settings, core/config.ts reads SNAPSHOT_KEEP only (Appendix B: n/a on Cloudflare).
    expect(NODE_ONLY.filter((name) => readNames.has(name))).toEqual(['SNAPSHOT_KEEP']);
    for (const name of [...FILE_SECRETS, ...DEV_ONLY]) expect(readNames, name).toContain(name);
    const left = [...NODE_ONLY, ...FILE_SECRETS, ...DEV_ONLY];
    expect([...APP_VARIABLES].sort()).toEqual([...readNames].filter((name) => !left.includes(name)).sort());
    expect(new Set(APP_VARIABLES).size).toBe(APP_VARIABLES.length);
    // The ones the task names, so a broken pattern cannot pass with an empty list.
    for (const name of ['PUBLIC_URL', 'WEBAUTHN_RP_ID', 'MAIL_TRANSPORT', 'MAIL_FROM', 'SMTP_HOST', 'SMTP_SECURITY', 'AUTH_CACHE_SECONDS']) {
      expect(APP_VARIABLES).toContain(name);
    }
    // SMTP_USER and MAIL_REPLY_TO are settings that may be secrets instead.
    for (const name of SECRET_NAMES) expect(APP_VARIABLES.includes(name) || FILE_SECRETS.includes(name), name).toBe(true);
  });

  it('fit in a Worker together with the secrets and MAIL_LOG_BODIES (64 variables at most, §11.1)', () => {
    expect(APP_VARIABLES.length + FILE_SECRETS.length + DEV_ONLY.length).toBeLessThanOrEqual(64);
  });

  it("BOOLEAN_VARIABLES are config.ts's readBool names but MAIL_LOG_BODIES, and readBool knows four spellings of true", () => {
    const bools = [...configTs.matchAll(/\breadBool\(vars, '([A-Z][A-Z0-9_]*)'/g)].map((m) => m[1]);
    expect(bools).toContain('MAIL_LOG_BODIES');
    expect(bools.filter((name) => !DEV_ONLY.includes(name)).sort()).toEqual([...BOOLEAN_VARIABLES].sort());
    const readBool = /export function readBool[\s\S]*?\n}/.exec(configTs)?.[0];
    expect(readBool).toContain("['1', 'true', 'yes', 'on'].includes(v.toLowerCase())");
  });

  it("NODE_ONLY are the Node server's own settings", () => {
    const nodeConfig = read('server/src/config.ts');
    const names = [...nodeConfig.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)|env(?:Int|Bool)\('([A-Z][A-Z0-9_]*)'/g)].map((m) => m[1] ?? m[2]);
    expect([...new Set([...names, 'SNAPSHOT_KEEP', 'LYREN_DB_STRICT'])].sort()).toEqual([...NODE_ONLY].sort());
    expect(read('server/src/runtime/node/nodeDb.ts')).toContain('process.env.LYREN_DB_STRICT');
  });

  // The workflow's secrets file holds every secret a secrets file may carry, in the same order.
  it('SECRET_NAMES are the secrets write-secrets-file.sh writes', () => {
    expect(read('scripts/ci/write-secrets-file.sh')).toContain(`"$1" ${SECRET_NAMES.join(' ')}\n`);
  });

  it("every instance key is a key of Wrangler's RawConfig in the installed config-schema.json", () => {
    const schema = JSON.parse(read('node_modules/wrangler/config-schema.json'));
    const keys = Object.keys(schema.definitions.RawConfig.properties);
    for (const key of INSTANCE_KEYS) expect(keys, key).toContain(key);
    // The lists that refuse keys name Wrangler's keys too (node_compat is Wrangler 3's).
    for (const key of [...UNUSED_BINDINGS, ...APP_OWNED_KEYS.filter((k) => k !== 'node_compat'), 'env', 'route']) {
      expect(keys, key).toContain(key);
    }
  });

  it('nearest: the closest name within two edits, case aside', () => {
    expect(nearest('MAIL_TRANSPRT', APP_VARIABLES)).toBe('MAIL_TRANSPORT');
    expect(nearest('public_url', APP_VARIABLES)).toBe('PUBLIC_URL');
    expect(nearest('worker_dev', INSTANCE_KEYS)).toBe('workers_dev');
    expect(nearest('COLOUR', APP_VARIABLES)).toBeNull();
    expect(nearest('', INSTANCE_KEYS)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Where it is found
// ---------------------------------------------------------------------------

describe('where the instance configuration comes from', () => {
  const root = path.resolve('/repo');
  const caller = path.resolve('/caller');
  const atRoot = path.join(root, INSTANCE_FILE);
  const all = () => true;
  const only = (...files) => (file) => files.includes(file);

  it("precedence: --instance over LYREN_INSTANCE_FILE over the checkout's file, each relative to INIT_CWD, a named missing file refused", () => {
    const env = { INIT_CWD: caller, LYREN_INSTANCE_FILE: 'env.jsonc' };
    expect(resolveInstanceSource({ flag: 'flag.jsonc', env, root, exists: all })).toEqual({
      path: path.join(caller, 'flag.jsonc'),
      display: 'flag.jsonc',
      from: '--instance',
    });
    expect(resolveInstanceSource({ env, root, exists: all })).toEqual({
      path: path.join(caller, 'env.jsonc'),
      display: 'env.jsonc',
      from: 'LYREN_INSTANCE_FILE',
    });
    // A blank variable counts as unset; the checkout's file is the root's, wherever npm ran.
    for (const variable of [undefined, '', '  ']) {
      expect(resolveInstanceSource({ env: { INIT_CWD: caller, LYREN_INSTANCE_FILE: variable }, root, exists: all })).toEqual({
        path: atRoot,
        display: INSTANCE_FILE,
        from: 'the checkout',
      });
    }
    expect(resolveInstanceSource({ env: {}, root, exists: () => false })).toBeNull();
    // A file named by the flag or the variable must exist: never passed over for the next source.
    expect(() => resolveInstanceSource({ flag: 'gone.jsonc', env, root, exists: only(atRoot, path.join(caller, 'env.jsonc')) })).toThrow(
      '--instance names gone.jsonc, which does not exist',
    );
    expect(() => resolveInstanceSource({ env, root, exists: only(atRoot) })).toThrow('LYREN_INSTANCE_FILE names env.jsonc, which does not exist');
    expect(() => resolveInstanceSource({ flag: ' ', env, root, exists: all })).toThrow('--instance names no file');
  });

  it('takes absolute paths as they are, and relative ones from the working directory without INIT_CWD', () => {
    const elsewhere = path.resolve('/elsewhere/plan.jsonc');
    expect(resolveInstanceSource({ flag: elsewhere, env: { INIT_CWD: caller }, root, exists: all }).path).toBe(elsewhere);
    const cwd = path.resolve('/work');
    expect(resolveInstanceSource({ env: { LYREN_INSTANCE_FILE: 'plan.jsonc' }, root, exists: all, cwd }).path).toBe(path.join(cwd, 'plan.jsonc'));
    expect(resolveInstanceSource({ flag: 'plan.jsonc', env: { INIT_CWD: '' }, root, exists: all, cwd }).path).toBe(path.join(cwd, 'plan.jsonc'));
  });
});

// ---------------------------------------------------------------------------
// wrangler.jsonc
// ---------------------------------------------------------------------------

describe('wrangler.jsonc under an instance configuration', () => {
  it("passes as the project has it, and with another name (the Deploy button's)", () => {
    expect(checkBase(BASE)).toEqual([]);
    expect(checkBase({ ...BASE, name: 'team-plan' })).toEqual([]);
  });

  it('refuses a wrangler.jsonc that carries instance keys, naming their replacements', () => {
    const replacements = {
      routes: '"routes" of your instance configuration',
      route: '"routes" of your instance configuration',
      vars: '"vars" of your instance configuration',
      send_email: 'MAIL_TRANSPORT=cloudflare adds the binding by itself',
      secrets: '"secrets" of your instance configuration',
      account_id: '"account_id" of your instance configuration',
      env: 'an instance configuration of its own (--instance or LYREN_INSTANCE_FILE)',
      limits: '"limits" of your instance configuration',
    };
    for (const [key, replacement] of Object.entries(replacements)) {
      const problems = checkBase({ ...BASE, [key]: { x: 1 } });
      expect(problems, key).toHaveLength(1);
      expect(problems[0]).toMatch(new RegExp(`^wrangler.jsonc has "${key}": `));
      expect(problems[0]).toContain(replacement);
      expect(problems[0]).toContain("put back the project's file (git checkout <upstream>/master -- wrangler.jsonc)");
    }
    for (const workersDev of [false, undefined, 'true']) {
      const problems = checkBase({ ...BASE, workers_dev: workersDev });
      expect(problems, String(workersDev)).toEqual([
        'wrangler.jsonc has "workers_dev" other than true: "workers_dev" of your instance configuration decides it; ' +
          "put back the project's file (git checkout <upstream>/master -- wrangler.jsonc)",
      ]);
    }
    expect(checkBase([])).toEqual(['wrangler.jsonc does not hold an object']);
  });
});

// ---------------------------------------------------------------------------
// Checking it
// ---------------------------------------------------------------------------

describe('checking an instance configuration', () => {
  it('needs a Worker name, which Workers Builds checks against its own', () => {
    expect(checkInstance({}).errors).toEqual([expect.stringMatching(/^"name" is missing: /)]);
    expect(checkInstance([]).errors).toEqual([expect.stringMatching(/^the file does not hold an object/)]);
    for (const name of ['a', 'lyren-plan', '0x', 'a'.repeat(63)]) expect(nameProblem(name), name).toBeNull();
    for (const name of ['Lyren', '-plan', 'plan-', 'plan_x', 'plan.x', '', 'a'.repeat(64), 5, null]) {
      expect(checkInstance({ name }).errors[0], String(name)).toMatch(/^"name" is not a Worker's name: /);
    }
    const builds = { WRANGLER_CI_OVERRIDE_NAME: 'team-plan' };
    expect(nameProblem('lyren-plan', { env: builds })).toMatch(/WRANGLER_CI_OVERRIDE_NAME/);
    expect(nameProblem('team-plan', { env: builds })).toBeNull();
    expect(nameProblem('lyren-plan', { env: { WRANGLER_CI_OVERRIDE_NAME: ' ' } })).toBeNull();
    // A name problem comes first, before the file's other keys.
    expect(checkInstance({ migrations: [], name: 'X' }).errors[0]).toMatch(/^"name"/);
  });

  it('refuses app-owned keys, env, route, unused bindings and unknown keys, saying why, with the nearest key', () => {
    expect(errorsOf({ migrations: [] })).toEqual(['"migrations" comes from wrangler.jsonc, the same for every instance: remove it here']);
    for (const key of APP_OWNED_KEYS) {
      expect(errorsOf({ [key]: 1 }), key).toEqual([`"${key}" comes from wrangler.jsonc, the same for every instance: remove it here`]);
    }
    expect(errorsOf({ env: { staging: {} } })).toEqual([
      '"env" is refused: one instance configuration is one Worker; for another, use another file, with LYREN_INSTANCE_FILE or --instance',
    ]);
    expect(errorsOf({ route: 'plan.example.com' })).toEqual(['"route" is refused: use "routes", with custom domains']);
    for (const key of ['kv_namespaces', 'd1_databases', 'r2_buckets', 'services', 'queues', 'triggers', 'ai']) {
      expect(errorsOf({ [key]: [] }), key).toEqual([`"${key}": Lyren Plan reads no such binding`]);
    }
    expect(errorsOf({ worker_dev: false })).toEqual(['"worker_dev" is not a key an instance configuration may set (did you mean "workers_dev"?)']);
    expect(errorsOf({ WORKERS_DEV: false })).toEqual(['"WORKERS_DEV" is not a key an instance configuration may set (did you mean "workers_dev"?)']);
    expect(errorsOf({ compatibility: 1 })).toEqual(['"compatibility" is not a key an instance configuration may set']);
    // Everything an instance may set, of the right shape.
    const every = {
      $schema: 'node_modules/wrangler/config-schema.json',
      account_id: 'a'.repeat(32),
      workers_dev: false,
      routes: [domain('plan.example.com')],
      send_email: [{ name: 'EMAIL' }],
      vars: { PUBLIC_URL: 'https://plan.example.com', MAIL_TRANSPORT: 'cloudflare', MAIL_FROM: 'plan@example.com' },
      secrets: { required: ['MAIL_REPLY_TO'] },
      keep_vars: false,
      limits: { cpu_ms: 100, subrequests: 50 },
      observability: { head_sampling_rate: 0.1 },
      placement: { mode: 'smart' },
      logpush: true,
      tail_consumers: [{ service: 'lyren-plan-tail' }],
    };
    expect(Object.keys({ name: 1, ...every }).sort()).toEqual([...INSTANCE_KEYS].sort());
    expect(check(every)).toEqual({ errors: [], warnings: [], notes: [] });
  });

  it('checks the shapes of account_id, workers_dev, keep_vars, limits and observability', () => {
    const id = 'a'.repeat(32);
    expect(errorsOf({ account_id: id.toUpperCase() })).toEqual([expect.stringMatching(/^"account_id" must be 32 lower-case hexadecimal digits/)]);
    expect(errorsOf({ account_id: 5 })).toHaveLength(1);
    expect(errorsOf({ account_id: id }, { CLOUDFLARE_ACCOUNT_ID: 'b'.repeat(32) })).toEqual([
      '"account_id" is not CLOUDFLARE_ACCOUNT_ID: both name the account, so make them the same, or remove one',
    ]);
    expect(errorsOf({ account_id: id }, { CLOUDFLARE_ACCOUNT_ID: id })).toEqual([]);
    expect(errorsOf({ account_id: id }, { CLOUDFLARE_ACCOUNT_ID: '' })).toEqual([]);
    // The same check alone, which every command needs (scripts/cf/wrangler.mjs).
    expect(accountProblem(id)).toBeNull();
    expect(accountProblem(id, { env: { CLOUDFLARE_ACCOUNT_ID: ` ${id} ` } })).toBeNull();
    expect(accountProblem(id, { env: { CLOUDFLARE_ACCOUNT_ID: 'b'.repeat(32) } })).toMatch(/^"account_id" is not CLOUDFLARE_ACCOUNT_ID/);
    for (const bad of [id.toUpperCase(), id.slice(1), 5, null]) expect(accountProblem(bad), String(bad)).toMatch(/^"account_id" must be/);
    expect(errorsOf({ workers_dev: 'false' })).toEqual(['"workers_dev" must be true or false']);
    expect(errorsOf({ keep_vars: 0 })).toEqual(['"keep_vars" must be true or false']);
    for (const limits of [{ cpu_ms: 0 }, { cpu_ms: 1.5 }, { subrequests: '50' }]) {
      expect(errorsOf({ limits }), JSON.stringify(limits)).toEqual([expect.stringMatching(/^limits\.(cpu_ms|subrequests) must be a whole number above 0$/)]);
    }
    expect(errorsOf({ limits: { memory: 128 } })).toEqual(['limits.memory is not a limit: only cpu_ms and subrequests']);
    expect(errorsOf({ limits: 100 })).toEqual([expect.stringMatching(/^"limits" must be /)]);
    expect(errorsOf({ observability: true })).toEqual([expect.stringMatching(/^"observability" must be an object/)]);
  });

  it("vars: only the app's settings; secrets, MAIL_LOG_BODIES, Node-only and old deploy names refused with what to do; numbers and booleans become text; null, objects, arrays and empty values refused", () => {
    const vars = { PUBLIC_URL: 'https://plan.example.com', MAIL_DAILY_CAP: 96, LOG_REQUESTS: true };
    expect(errorsOf({ vars })).toEqual([]);
    expect(instanceVars({ vars })).toEqual({ PUBLIC_URL: 'https://plan.example.com', MAIL_DAILY_CAP: '96', LOG_REQUESTS: 'true' });
    for (const name of FILE_SECRETS) {
      expect(errorsOf({ vars: { [name]: 'x' } }), name).toEqual([`vars.${name} is a secret, never in a file: npm run cf -- secret put ${name}`]);
    }
    expect(errorsOf({ vars: { MAIL_LOG_BODIES: '1' } })).toEqual(['vars.MAIL_LOG_BODIES is for development only: .dev.vars']);
    for (const name of NODE_ONLY) expect(errorsOf({ vars: { [name]: '1' } }), name).toEqual([`vars.${name} is not read on Cloudflare (the Node server's setting)`]);
    expect(errorsOf({ vars: { WORKER_NAME: 'x' } })).toEqual(['vars.WORKER_NAME is no longer read: now "name"']);
    expect(errorsOf({ vars: { WORKERS_DEV: 'false' } })).toEqual(['vars.WORKERS_DEV is no longer read: now "workers_dev"']);
    expect(errorsOf({ vars: { EMAIL_BINDING: 'true' } })).toEqual(['vars.EMAIL_BINDING is no longer read: MAIL_TRANSPORT=cloudflare adds send_email by itself']);
    expect(Object.keys(RETIRED)).toEqual(['WORKER_NAME', 'WORKERS_DEV', 'EMAIL_BINDING']);
    expect(errorsOf({ vars: { MAIL_TRANSPRT: 'smtp' } })).toEqual(['vars.MAIL_TRANSPRT is not a setting of Lyren Plan (did you mean MAIL_TRANSPORT?)']);
    expect(errorsOf({ vars: { public_url: 'x' } })).toEqual(['vars.public_url is not a setting of Lyren Plan (did you mean PUBLIC_URL?)']);
    expect(errorsOf({ vars: { COLOUR: 'x' } })).toEqual(['vars.COLOUR is not a setting of Lyren Plan']);
    for (const value of [null, {}, [], ['a'], Number.NaN]) {
      expect(errorsOf({ vars: { INSTANCE_NAME: value } }), String(value)).toEqual(['vars.INSTANCE_NAME is not text, a number, true or false']);
    }
    for (const value of ['', '  ']) {
      expect(errorsOf({ vars: { INSTANCE_NAME: value } })).toEqual([
        'vars.INSTANCE_NAME is empty: remove the line; to clear a value set in the dashboard, delete it there',
      ]);
    }
    expect(errorsOf({ vars: ['PUBLIC_URL'] })).toEqual([expect.stringMatching(/^"vars" is not an object/)]);
    // Text passes as it is; anything else the Worker would not get is left out.
    expect(instanceVars({ vars: { INSTANCE_NAME: ' Plan ', MAIL_FROM: '', SMTP_PASS: 'x', SMTP_HOST: null, SMTP_PORT: 587 } })).toEqual({
      INSTANCE_NAME: ' Plan ',
      SMTP_PORT: '587',
    });
    expect(instanceVars({ name: 'x' })).toEqual({});
  });

  it('readBool settings take only the spellings readBool knows', () => {
    for (const value of ['1', 'TRUE', 'Yes', 'on', ' 0 ', 'false', 'NO', 'Off', true, false, 1, 0]) {
      expect(errorsOf({ vars: { LOG_REQUESTS: value } }), String(value)).toEqual([]);
    }
    for (const value of ['enabled', '2', 'y', 'oui', 2]) {
      expect(errorsOf({ vars: { LOG_REQUESTS: value } }), String(value)).toEqual([
        'vars.LOG_REQUESTS must be 1, true, yes or on, or 0, false, no or off (any case): the app reads anything else as off',
      ]);
    }
    // Other settings take any text: the app's parser decides.
    expect(errorsOf({ vars: { INSTANCE_NAME: 'enabled' } })).toEqual([]);
  });

  it("routes are custom domains holding PUBLIC_URL's host; a workers.dev PUBLIC_URL needs workers.dev on and starts with name", () => {
    const at = (url, fields) => check({ vars: { PUBLIC_URL: url, MAIL_TRANSPORT: 'log' }, ...fields });
    expect(at('https://plan.example.com', { routes: [domain('plan.example.com')] })).toEqual({ errors: [], warnings: [], notes: [] });
    expect(at('https://plan.example.com', { routes: [domain('www.example.com'), domain('plan.example.com')] }).errors).toEqual([]);
    expect(at('https://plan.example.com:443/', { routes: [domain('plan.example.com')] }).errors).toEqual([]);
    expect(at('https://plan.example.com', { routes: [domain('www.example.com')] }).errors).toEqual([
      'PUBLIC_URL\'s host is not one of "routes": the API answers PUBLIC_URL alone, so list its host',
    ]);
    expect(errorsOf({ routes: [domain('plan.example.com')] })).toEqual(['"routes" needs PUBLIC_URL in "vars", on one of the hosts it lists']);
    // An invalid PUBLIC_URL is the app's check's to name.
    expect(at('plan.example.com', { routes: [domain('plan.example.com')] }).errors).toEqual([]);
    // Custom domains only, of one host each.
    for (const routes of [[], {}, 'plan.example.com']) {
      expect(at('https://plan.example.com', { routes }).errors, JSON.stringify(routes)).toEqual([
        expect.stringMatching(/^"routes" must be a non-empty list of custom domains/),
      ]);
    }
    for (const route of [
      'plan.example.com',
      { pattern: 'plan.example.com' },
      { pattern: 'plan.example.com', custom_domain: false },
      { pattern: 'plan.example.com/*', zone_name: 'example.com' },
      { pattern: 'plan.example.com', custom_domain: true, zone_id: 'x' },
    ]) {
      expect(at('https://plan.example.com', { routes: [route] }).errors, JSON.stringify(route)).toEqual([
        expect.stringMatching(/^routes\[0\] must be \{ "pattern": "<host>", "custom_domain": true \}: custom domains only/),
      ]);
    }
    const notHosts = ['https://plan.example.com', 'plan.example.com:8443', 'plan.example.com/app', '*.example.com'];
    for (const pattern of [...notHosts, 'Plan.example.com', 'localhost', '192.168.0.1', ' plan.example.com', 5]) {
      expect(at('https://plan.example.com', { routes: [domain(pattern)] }).errors, String(pattern)).toEqual([
        'routes[0].pattern must be a host name alone, in lower case: no scheme, port, path or *',
      ]);
    }
    expect(at('https://plan.example.com', { routes: [domain('plan.example.com'), domain('lyren-plan.alice.workers.dev')] }).errors).toEqual([
      'routes[1].pattern is on workers.dev, which is no custom domain: "workers_dev" turns it on or off',
    ]);
    // workers.dev: <name>.<subdomain>.workers.dev.
    expect(at('https://lyren-plan.alice.workers.dev', {}).errors).toEqual([]);
    expect(at('https://lyren-plan.alice.workers.dev', { workers_dev: true }).errors).toEqual([]);
    expect(at('https://team-plan.alice.workers.dev', {}).errors).toEqual([
      'PUBLIC_URL is on workers.dev but does not start with "name": the Worker answers at <name>.<your-subdomain>.workers.dev',
    ]);
    const off = 'PUBLIC_URL is on workers.dev, which this instance turns off ("workers_dev": false, or "routes" listed)';
    expect(at('https://lyren-plan.alice.workers.dev', { workers_dev: false }).errors).toEqual([off]);
    expect(at('https://lyren-plan.alice.workers.dev', { routes: [domain('plan.example.com')] }).errors).toContain(off);
    // A public instance turns workers.dev off: "routes" with it on is allowed, with a warning.
    const both = at('https://plan.example.com', { routes: [domain('plan.example.com')], workers_dev: true });
    expect(both.errors).toEqual([]);
    expect(both.warnings).toEqual([
      '"routes" with "workers_dev": true keeps the workers.dev address on: a public instance turns it off ' +
        '(docs/cloudflare.md, "Hostnames, passkeys and workers.dev")',
    ]);
  });

  it('send_email: EMAIL only, no recipient limits or remote, senders include MAIL_FROM', () => {
    const cloudflare = { MAIL_TRANSPORT: 'cloudflare', MAIL_FROM: 'plan@example.com' };
    const mail = (sendEmail, vars = cloudflare) => check({ vars, send_email: sendEmail });
    expect(mail([{ name: 'EMAIL' }])).toEqual({ errors: [], warnings: [], notes: [] });
    expect(mail([{ name: 'EMAIL', allowed_sender_addresses: ['other@example.com', 'Plan@Example.com'] }]).errors).toEqual([]);
    expect(mail([{ name: 'EMAIL', allowed_sender_addresses: ['other@example.com'] }]).errors).toEqual([
      'send_email[0].allowed_sender_addresses does not include MAIL_FROM: the binding would refuse every message',
    ]);
    expect(mail([{ name: 'EMAIL', allowed_sender_addresses: ['plan@example.com'] }], { MAIL_TRANSPORT: 'cloudflare' }).errors).toEqual([
      'send_email[0].allowed_sender_addresses needs MAIL_FROM in "vars", which it must include',
    ]);
    for (const senders of [[], 'plan@example.com', [''], [5]]) {
      expect(mail([{ name: 'EMAIL', allowed_sender_addresses: senders }]).errors, JSON.stringify(senders)).toEqual([
        'send_email[0].allowed_sender_addresses must be a non-empty list of addresses',
      ]);
    }
    expect(mail([{ name: 'MAIL' }]).errors).toEqual(['send_email[0].name must be EMAIL, the binding the app sends through']);
    for (const sendEmail of [{ name: 'EMAIL' }, [], [{ name: 'EMAIL' }, { name: 'OTHER' }], ['EMAIL']]) {
      expect(mail(sendEmail).errors, JSON.stringify(sendEmail)).toEqual([
        '"send_email" must hold one binding, [{ "name": "EMAIL" }]: the app sends through EMAIL alone',
      ]);
    }
    for (const key of ['destination_address', 'allowed_destination_addresses']) {
      expect(mail([{ name: 'EMAIL', [key]: 'a@example.com' }]).errors).toEqual([
        `send_email[0].${key} is refused: invitations go to anyone, so the binding cannot be limited to some recipients`,
      ]);
    }
    expect(mail([{ name: 'EMAIL', remote: true }]).errors).toEqual(['send_email[0].remote is refused: it matters to wrangler dev alone']);
    expect(mail([{ name: 'EMAIL', sender: 'x' }]).errors).toEqual([
      'send_email[0].sender is not a key of the binding: only "name" and "allowed_sender_addresses"',
    ]);
    // The binding may ship before the switch to cloudflare: deployed, unused.
    expect(mail([{ name: 'EMAIL' }], { MAIL_TRANSPORT: 'smtp' }).notes).toEqual([
      'send_email: the binding EMAIL is deployed, unused while MAIL_TRANSPORT is not cloudflare',
    ]);
  });

  it('a name is a variable or a required secret, never both; SETUP_TOKEN and RECOVERY_TOKEN never required', () => {
    expect(errorsOf({ secrets: { required: ['SMTP_USER', 'SMTP_PASS', 'MAIL_REPLY_TO', 'RESEND_API_KEY'] } })).toEqual([]);
    expect(errorsOf({ secrets: {} })).toEqual([]);
    expect(errorsOf({ vars: { SMTP_USER: 'plan@example.com' }, secrets: { required: ['SMTP_USER'] } })).toEqual([
      'SMTP_USER is in "vars" and in "secrets.required": a name is a variable or a secret, never both',
    ]);
    expect(errorsOf({ secrets: { required: ['SETUP_TOKEN'] } })).toEqual([expect.stringMatching(/^secrets\.required lists SETUP_TOKEN, which stays optional: /)]);
    expect(errorsOf({ secrets: { required: ['RECOVERY_TOKEN'] } })).toEqual([
      'secrets.required lists RECOVERY_TOKEN, which is set by hand only while it is needed (docs/cloudflare.md, "Locked out")',
    ]);
    expect(errorsOf({ secrets: { required: ['PUBLIC_URL'] } })).toEqual([
      'secrets.required lists PUBLIC_URL: only SMTP_USER, SMTP_PASS, MAIL_REPLY_TO and RESEND_API_KEY may be required',
    ]);
    expect(errorsOf({ secrets: { required: ['SMTP_PAS'] } })[0]).toMatch(/\(did you mean SMTP_PASS\?\)$/);
    expect(errorsOf({ secrets: { required: 'SMTP_USER' } })).toEqual(['secrets.required must be a list of names']);
    expect(errorsOf({ secrets: { optional: [] } })).toEqual(['secrets.optional is not a key here: only "required"']);
    expect(errorsOf({ secrets: ['SMTP_USER'] })).toEqual(['"secrets" must be { "required": [names] }']);
  });

  it('notes what it cannot know: a MAIL_TRANSPORT the Worker keeps', () => {
    const note =
      'MAIL_TRANSPORT is not in the file: the Worker keeps the one it has; put MAIL_TRANSPORT and the settings it ' +
      'needs (MAIL_FROM, PUBLIC_URL) here so that the check sees them';
    expect(check({}).notes).toEqual([note]);
    expect(check({ vars: { INSTANCE_NAME: 'Plan' } }).notes).toEqual([note]);
    expect(check({ vars: { MAIL_TRANSPORT: 'log' } }).notes).toEqual([]);
    expect(check({ keep_vars: false }).notes).toEqual([]);
    expect(check({ send_email: [{ name: 'EMAIL' }] }).notes).toEqual([]);
  });

  it('refuses the values only wrangler dev uses: a local PUBLIC_URL or SMTP_HOST, and SMTP_SECURITY none', () => {
    const local = (name) =>
      `vars.${name} is a local address, for wrangler dev only: put it in .dev.vars, never in an instance configuration`;
    for (const url of ['http://localhost:8787', 'http://LOCALHOST', 'https://plan.localhost', 'http://127.0.0.1:8787', 'http://127.1', 'http://[::1]:8787', 'http://[0:0:0:0:0:0:0:1]']) {
      expect(errorsOf({ vars: { PUBLIC_URL: url } }), url).toEqual([local('PUBLIC_URL')]);
    }
    for (const host of ['localhost', ' LocalHost ', 'mail.localhost', 'localhost.', '127.0.0.1', '127.255.0.9', '[::1]', '::1']) {
      expect(errorsOf({ vars: { SMTP_HOST: host } }), host).toEqual([local('SMTP_HOST')]);
    }
    for (const security of ['none', ' NONE ']) {
      expect(errorsOf({ vars: { SMTP_SECURITY: security } })).toEqual([
        'vars.SMTP_SECURITY none is for a local relay under wrangler dev only: use tls or starttls',
      ]);
    }
    // A host of the network, and a name that only starts like one of this machine.
    for (const host of ['smtp.example.com', '10.0.0.1', '128.0.0.1', 'localhost.example.com', 'mylocalhost']) {
      expect(errorsOf({ vars: { SMTP_HOST: host, SMTP_SECURITY: 'starttls' } }), host).toEqual([]);
    }
    expect(errorsOf({ vars: { PUBLIC_URL: 'https://localhost.example.com', MAIL_TRANSPORT: 'log' }, workers_dev: false })).toEqual([]);
  });

  it('warns when PUBLIC_URL is a custom domain while this deploy leaves workers.dev on', () => {
    const warning = 'PUBLIC_URL is a custom domain, but this deploy turns workers.dev on (wrangler.jsonc): add "workers_dev": false once the domain works';
    const vars = { PUBLIC_URL: 'https://plan.example.com', MAIL_TRANSPORT: 'log' };
    expect(check({ vars })).toEqual({ errors: [], warnings: [warning], notes: [] });
    // "workers_dev" decided either way, "routes" (which turns it off), a workers.dev PUBLIC_URL, or none: no word.
    expect(check({ vars, workers_dev: false }).warnings).toEqual([]);
    expect(check({ vars, workers_dev: true }).warnings).toEqual([]);
    expect(check({ vars, routes: [domain('plan.example.com')] }).warnings).toEqual([]);
    expect(check({ vars: { ...vars, PUBLIC_URL: 'https://lyren-plan.alice.workers.dev' } }).warnings).toEqual([]);
    expect(check({ vars: { MAIL_TRANSPORT: 'log' } }).warnings).toEqual([]);
    // A local one is refused instead.
    expect(check({ vars: { ...vars, PUBLIC_URL: 'http://localhost:8787' } }).warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The generated configuration
// ---------------------------------------------------------------------------

describe('the generated configuration', () => {
  it('is wrangler.jsonc with only the instance keys changed, workers_dev false with routes, EMAIL with MAIL_TRANSPORT=cloudflare, and the run token in the build command', () => {
    const instance = {
      $schema: 'node_modules/wrangler/config-schema.json',
      name: 'team-plan',
      account_id: 'f'.repeat(32),
      routes: [domain('plan.example.com')],
      vars: { PUBLIC_URL: 'https://plan.example.com', MAIL_TRANSPORT: ' Cloudflare ', MAIL_FROM: 'plan@example.com', MAIL_DAILY_CAP: 96 },
      secrets: { required: ['MAIL_REPLY_TO'] },
      keep_vars: false,
      limits: { cpu_ms: 100 },
      observability: { head_sampling_rate: 0.5 },
    };
    const copy = structuredClone(instance);
    expect(checkInstance(instance).errors).toEqual([]);
    const config = generateConfig(BASE, instance, { required: [], runToken: TOKEN });
    const changed = ['name', 'routes', 'workers_dev', 'vars', 'send_email', 'secrets', 'keep_vars', 'limits', 'observability', 'build', 'account_id'];
    for (const key of Object.keys(BASE)) if (!changed.includes(key)) expect(config[key], key).toEqual(BASE[key]);
    expect(config.migrations).toEqual(BASE.migrations);
    expect(config.compatibility_date).toBe(BASE.compatibility_date);
    expect(config.$schema).toBe(BASE.$schema);
    // wrangler.jsonc's keys keep their order; the instance's own come after them.
    expect(Object.keys(config).slice(0, Object.keys(BASE).length)).toEqual(Object.keys(BASE));
    expect(Object.keys(config).filter((key) => !(key in BASE)).sort()).toEqual(['account_id', 'limits', 'routes', 'secrets', 'send_email', 'vars']);
    expect(config).toMatchObject({
      name: 'team-plan',
      account_id: 'f'.repeat(32),
      routes: [domain('plan.example.com')],
      workers_dev: false,
      keep_vars: false,
      limits: { cpu_ms: 100 },
      send_email: [{ name: 'EMAIL' }],
      secrets: { required: ['MAIL_REPLY_TO'] },
      vars: { PUBLIC_URL: 'https://plan.example.com', MAIL_TRANSPORT: ' Cloudflare ', MAIL_FROM: 'plan@example.com', MAIL_DAILY_CAP: '96' },
    });
    expect(config.observability).toEqual({ ...BASE.observability, head_sampling_rate: 0.5 });
    expect(config.build).toEqual({ ...BASE.build, command: `node scripts/cf/build-web.mjs --run=${TOKEN}` });
    // Neither input changes.
    expect(instance).toEqual(copy);
    expect(BASE).toEqual(parseJsonc(read('wrangler.jsonc')));
  });

  it('a name alone: wrangler.jsonc as it is, but for the build command', () => {
    expect(generateConfig(BASE, { name: 'lyren-plan' }, { runToken: TOKEN })).toEqual({
      ...BASE,
      build: { ...BASE.build, command: `node scripts/cf/build-web.mjs --run=${TOKEN}` },
    });
    expect(BASE.workers_dev).toBe(true);
    expect(BASE.send_email).toBeUndefined();
    expect(BASE.secrets).toBeUndefined();
  });

  it("derives workers_dev, the EMAIL binding and the required secrets, and keeps the file's own choices", () => {
    const make = (instance, required = []) => generateConfig(BASE, { name: 'lyren-plan', ...instance }, { required, runToken: TOKEN });
    expect(make({ routes: [domain('plan.example.com')], workers_dev: true }).workers_dev).toBe(true);
    expect(make({ workers_dev: false }).workers_dev).toBe(false);
    const own = [{ name: 'EMAIL', allowed_sender_addresses: ['plan@example.com'] }];
    expect(make({ vars: { MAIL_TRANSPORT: 'cloudflare' }, send_email: own }).send_email).toEqual(own);
    expect(make({ vars: { MAIL_TRANSPORT: 'smtp' } }).send_email).toBeUndefined();
    expect(make({ vars: { MAIL_TRANSPORT: 'smtp' }, send_email: [{ name: 'EMAIL' }] }).send_email).toEqual([{ name: 'EMAIL' }]);
    // Declared and demanded, sorted, once each.
    expect(make({ secrets: { required: ['SMTP_USER'] } }, ['SMTP_USER', 'SMTP_PASS']).secrets).toEqual({ required: ['SMTP_PASS', 'SMTP_USER'] });
    expect(make({}, ['RESEND_API_KEY']).secrets).toEqual({ required: ['RESEND_API_KEY'] });
    expect(make({ secrets: { required: [] } }).secrets).toBeUndefined();
    // Keys an instance may not set never reach the configuration.
    expect(make({ migrations: [], main: 'x.ts', kv_namespaces: [{}] })).toEqual(make({}));
    for (const runToken of [undefined, '', 'x'.repeat(32), TOKEN.toUpperCase(), `${TOKEN}0`]) {
      expect(() => generateConfig(BASE, { name: 'x' }, { runToken }), String(runToken)).toThrow(/run token/);
    }
  });

  it('is written with a header naming the run that wrote it (pid, place and kind) and its sources', () => {
    const config = generateConfig(BASE, { name: 'lyren-plan' }, { runToken: TOKEN });
    const where = 'host-a pid:[4026531836]';
    const text = generatedConfigText(config, { source: 'wrangler.instance.jsonc', pid: 4242, where, kind: 'build' });
    expect(text.split('\n')[0]).toBe(
      '// Written by scripts/cf/wrangler.mjs (pid 4242 on host-a pid:[4026531836]) for one Wrangler run of kind build, from wrangler.jsonc and wrangler.instance.jsonc; removed when it ends. Do not edit.',
    );
    expect(text.endsWith('}\n')).toBe(true);
    expect(parseJsonc(text)).toEqual(config);
    expect(generatorOf(text)).toEqual({ kind: 'build', pid: 4242, where });
    const header = { source: 'x', pid: 1, where, kind: 'other' };
    expect(generatorOf(generatedConfigText(config, header))).toEqual({ kind: 'other', pid: 1, where });
    for (const pid of [undefined, 0, -1, 1.5, '42']) {
      expect(() => generatedConfigText(config, { ...header, pid }), String(pid)).toThrow(/process ID/);
    }
    // A place that would end the parenthesis or the comment, or says nothing.
    for (const bad of [undefined, '', ' ', 'host (a)', 'host\nb', 'host\u2028b']) {
      expect(() => generatedConfigText(config, { ...header, where: bad }), JSON.stringify(bad)).toThrow(/place of the run/);
    }
    for (const kind of [undefined, 'deploy', 'Build']) {
      expect(() => generatedConfigText(config, { ...header, kind }), String(kind)).toThrow(/kind of the run/);
    }
    // A line break in the source's name cannot end the comment.
    expect(parseJsonc(generatedConfigText(config, { ...header, source: 'a\n}{\r\u2028' }))).toEqual(config);
  });

  it("reads back the run of a generated file's header only, whatever its source says, and its kind without its pid", () => {
    const config = generateConfig(BASE, { name: 'lyren-plan' }, { runToken: TOKEN });
    const source = '/x (pid 7 on y) for one Wrangler run of kind build, from z';
    expect(generatorOf(generatedConfigText(config, { source, pid: 99, where: 'h', kind: 'other' }))).toEqual({ kind: 'other', pid: 99, where: 'h' });
    // A header whose parenthesis names no pid or no place: its kind, and nothing to judge its run by.
    for (const run of ['pid ? on h', 'pid 5', 'pid 5 on ', 'pid 0 on h', '']) {
      const text = `// Written by scripts/cf/wrangler.mjs (${run}) for one Wrangler run of kind build, from wrangler.jsonc and x; removed when it ends. Do not edit.\n{}`;
      expect(generatorOf(text), run).toEqual({ kind: 'build', pid: null, where: null });
    }
    for (const text of [
      '',
      '{}',
      '// Written by someone else (pid 5 on h) for one Wrangler run of kind build, from x\n{}',
      '// Written by scripts/cf/wrangler.mjs from wrangler.jsonc and x\n{}',
      // An earlier header, without the place and the kind.
      '// Written by scripts/cf/wrangler.mjs (pid 5) from wrangler.jsonc and x for one Wrangler run; removed when it ends. Do not edit.\n{}',
      '// Written by scripts/cf/wrangler.mjs (pid 5 on h) for one Wrangler run of kind deploy, from x\n{}',
      '\n// Written by scripts/cf/wrangler.mjs (pid 5 on h) for one Wrangler run of kind build, from x\n{}',
    ]) {
      expect(generatorOf(text), text).toBeNull();
    }
  });

  it("other commands take the Worker's name and its account (both checked by the caller), and nothing else", () => {
    const account = 'f'.repeat(32);
    const flawed = { name: 'team-plan', account_id: account, limits: { cpu_ms: '100' }, routes: 'x', vars: { PUBLIC_URL: 'x' }, keep_vars: 'no' };
    expect(workerOnly(flawed)).toEqual({ name: 'team-plan', account_id: account });
    expect(workerOnly({ name: 'team-plan' })).toEqual({ name: 'team-plan' });
    // wrangler.jsonc with the name (and account) alone, but for the build command.
    expect(generateConfig(BASE, workerOnly(flawed), { runToken: TOKEN })).toEqual({
      ...BASE,
      name: 'team-plan',
      account_id: account,
      build: { ...BASE.build, command: `node scripts/cf/build-web.mjs --run=${TOKEN}` },
    });
  });

  it('passes the variables as --var NAME:value too', () => {
    expect(varArgs({ PUBLIC_URL: 'https://plan.example.com', MAIL_FROM: 'a:b' })).toEqual([
      '--var',
      'PUBLIC_URL:https://plan.example.com',
      '--var',
      'MAIL_FROM:a:b',
    ]);
    expect(varArgs({})).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Wrangler's arguments
// ---------------------------------------------------------------------------

describe("Wrangler's arguments", () => {
  it('passes what needs no instance setting', () => {
    for (const args of [
      ['deploy'],
      ['deploy', '--dry-run', '--outdir', 'dist/worker'],
      ['deploy', '--dry-run', 'false', '--strict'],
      ['deploy', '--secrets-file=/tmp/s.json', '--tag', 'v1', '--message', 'a b', '--metafile', 'meta.json'],
      ['versions', 'upload', '--preview-alias', 'x', '--tag=v2'],
      ['--profile', 'work', 'deploy'],
      ['secret', 'put', 'SMTP_PASS'],
      ['secret', 'delete', 'RECOVERY_TOKEN'],
      ['tail', '--format', 'pretty'],
      ['rollback', '--message', 'back'],
      ['versions', 'list'],
      ['deployments', 'status'],
      // Deploy options mean nothing to other commands, which Wrangler refuses on its own.
      ['tail', '--var', 'X:1'],
      [],
    ]) {
      expect(wranglerArgsProblems(args), args.join(' ')).toEqual([]);
    }
  });

  it('refuses --config, --cwd, --env and --name everywhere, and --var, --routes, --domains, --keep-vars and compatibility flags for deploys', () => {
    const refused = (...args) => wranglerArgsProblems(args);
    const config = 'Wrangler gets the configuration made from wrangler.jsonc and yours; name another instance configuration with --instance or LYREN_INSTANCE_FILE';
    expect(refused('secret', 'put', 'X', '--config', 'w.jsonc')).toEqual([`--config is not passed on: ${config}`]);
    expect(refused('tail', '-c', 'w.jsonc')).toEqual([`-c is not passed on: ${config}`]);
    expect(refused('tail', '--config=w.jsonc')).toEqual([`--config is not passed on: ${config}`]);
    expect(refused('tail', '--cwd=..')).toEqual(["--cwd is not passed on: Wrangler runs in the checkout's root, next to wrangler.jsonc"]);
    const env = 'one instance configuration is one Worker; name another instance configuration with --instance or LYREN_INSTANCE_FILE';
    expect(refused('secret', 'list', '-e', 'staging')).toEqual([`-e is not passed on: ${env}`]);
    expect(refused('secret', 'list', '--env=staging')).toEqual([`--env is not passed on: ${env}`]);
    expect(refused('secret', 'put', 'X', '--name', 'other')).toEqual(['--name is not passed on: the Worker is "name" of your instance configuration']);
    expect(refused('deploy', '--name=other')).toEqual(['--name is not passed on: the Worker is "name" of your instance configuration']);
    // Wrangler loads an --env-file into its environment, CLOUDFLARE_ENV with the rest.
    const envFile = '--env-file is not passed on: settings go in "vars" of your instance configuration, secrets in npm run cf -- secret put <NAME>';
    for (const args of [['deploy', '--env-file', '.env.prod'], ['secret', 'list', '--env-file=.env'], ['tail', '--env-file', 'a', 'b'], ['rollback', '--envFile', 'x']]) {
      expect(wranglerArgsProblems(args), args.join(' ')).toEqual([envFile.replace('--env-file', args.find((a) => a.startsWith('--env')).split('=')[0])]);
    }
    // Deploys: settings of the instance configuration.
    const vars = (name) => `--var is not passed on: put ${name} in "vars" of your instance configuration`;
    expect(refused('deploy', '--var', 'PUBLIC_URL:https://plan.example.com')).toEqual([vars('PUBLIC_URL')]);
    expect(refused('deploy', '--var', 'A:1', 'B:2', '--var=C:3')).toEqual([vars('A'), vars('B'), vars('C')]);
    expect(refused('versions', 'upload', '--var')).toEqual([vars('the variable')]);
    const domains = 'list custom domains in "routes" of your instance configuration';
    for (const flag of ['--routes', '--route', '--domains', '--domain']) {
      expect(refused('deploy', flag, 'plan.example.com'), flag).toEqual([`${flag} is not passed on: ${domains}`]);
    }
    for (const args of [['--keep-vars'], ['--keepVars'], ['--no-keep-vars'], ['--keep-vars=false'], ['--keep-vars', 'true']]) {
      expect(refused('deploy', ...args), args.join(' ')).toEqual([`${args[0].split('=')[0]} is not passed on: set "keep_vars" in your instance configuration`]);
    }
    for (const args of [['--compatibility-date', '2026-01-01'], ['--compatibility-flags', 'x'], ['--compatibility-flag=x'], ['--compatibilityDate', 'x']]) {
      const flag = args[0].split('=')[0];
      expect(refused('deploy', ...args), args.join(' ')).toEqual([`${flag} is not passed on: it comes from wrangler.jsonc, the same for every instance`]);
    }
    expect(refused('deploy', '--latest')).toEqual(['--latest is not passed on: the compatibility date comes from wrangler.jsonc, the same for every instance']);
    expect(refused('deploy', '--no-bundle')).toEqual(['--no-bundle is not passed on: the Worker is bundled as wrangler.jsonc says, the same for every instance']);
    for (const args of [['--assets', 'dist'], ['--tsconfig', 'x.json'], ['--define', 'A:1'], ['--alias', 'a:b'], ['--minify']]) {
      expect(refused('versions', 'upload', ...args), args[0]).toEqual([`${args[0]} is not passed on: it comes from wrangler.jsonc, the same for every instance`]);
    }
    expect(refused('deploy', '--schedule', '* * * * *')).toEqual(['--schedule is not passed on: Lyren Plan runs no cron triggers']);
    // A script path: "main" of wrangler.jsonc.
    const script = 'a script path is not passed on: the Worker\'s code is "main" of wrangler.jsonc, the same for every instance';
    for (const args of [
      ['deploy', 'src/index.ts'],
      ['versions', 'upload', 'src/index.ts'],
      ['deploy', '--', 'src/index.ts'],
      ['deploy', '--script', 'x.ts'],
      ['deploy', '--dry-run', 'src/index.ts'],
    ]) {
      expect(wranglerArgsProblems(args), args.join(' ')).toEqual([script]);
    }
    // Several at once, each once. An array option takes the words after it, as yargs does: x.ts is a --var.
    expect(refused('deploy', 'x.ts', '-ce', 'x', '--var', 'A:1', '--route', 'a', '--route', 'b')).toEqual([
      `-c is not passed on: ${config}`,
      `-e is not passed on: ${env}`,
      vars('A'),
      `--route is not passed on: ${domains}`,
      script,
    ]);
    expect(refused('deploy', '--var', 'A:1', 'x.ts')).toEqual([vars('A'), vars('the variable')]);
  });

  it('refuses wrangler dev and preview, with a pointer to npm run dev:cf', () => {
    expect(wranglerArgsProblems(['dev'])).toEqual([
      'wrangler dev does not run with an instance configuration: npm run dev:cf runs it with wrangler.jsonc and .dev.vars',
    ]);
    expect(wranglerArgsProblems(['preview', '--var', 'A:1'])).toEqual([
      'wrangler preview does not run: Lyren Plan has no previews ("preview_urls": false); npm run dev:cf runs the Worker on this computer',
    ]);
  });

  it('refuses wrangler triggers deploy, which would apply routes and workers.dev unchecked, and wrangler types', () => {
    const triggers = 'wrangler triggers deploy is not passed on: npm run deploy:cf applies routes and workers.dev';
    for (const args of [['triggers', 'deploy'], ['triggers', 'deploy', '--routes', 'x.example.com/*'], ['triggers', '--message', 'm', 'deploy']]) {
      expect(wranglerArgsProblems(args), args.join(' ')).toEqual([triggers]);
    }
    // types writes worker-configuration.d.ts with the variables' values in it.
    expect(wranglerArgsProblems(['types', '--include-runtime=false'])).toEqual([
      "wrangler types is not passed on: npx wrangler types reads wrangler.jsonc, which is all the code's types need",
    ]);
    // triggers alone, or another of its words, is Wrangler's to answer.
    expect(wranglerArgsProblems(['triggers'])).toEqual([]);
  });

  it('reads the command as yargs does: options anywhere, their values not words', () => {
    expect(readArgs(['versions', '--message', 'hi', 'upload']).words).toEqual(['versions', 'upload']);
    expect(readArgs(['versions', '--message=hi', 'upload', '--dry-run']).words).toEqual(['versions', 'upload']);
    expect(readArgs(['--profile', 'work', 'deploy', '--var', 'A:1', 'B:2']).words).toEqual(['deploy']);
    expect(readArgs(['secret', 'put', 'SMTP_PASS']).words).toEqual(['secret', 'put', 'SMTP_PASS']);
    expect(readArgs(['deploy', '--strict', 'true']).options).toEqual([{ flag: '--strict', name: 'strict', values: ['true'] }]);
    // A version upload with an option between its words is one, with every deploy rule.
    expect(wranglerArgsProblems(['versions', '--message', 'hi', 'upload', '--var', 'A:1'])).toEqual([
      '--var is not passed on: put A in "vars" of your instance configuration',
    ]);
  });
});

// ---------------------------------------------------------------------------
// The secrets file
// ---------------------------------------------------------------------------

describe('a secrets file', () => {
  it('lists secrets of SECRET_NAMES with values, never RECOVERY_TOKEN, and none that is also a variable', () => {
    const all = { SETUP_TOKEN: 's', SMTP_USER: 'u', SMTP_PASS: ' p ', MAIL_REPLY_TO: 'r', RESEND_API_KEY: 'k' };
    expect(checkSecretsFile(all, { vars: {} })).toEqual({ problems: [], names: Object.keys(all) });
    expect(checkSecretsFile({}, { vars: {} })).toEqual({ problems: [], names: [] });
    for (const value of [[], null, 'x', 5]) expect(checkSecretsFile(value).problems, JSON.stringify(value)).toEqual(['does not hold a JSON object']);
    expect(checkSecretsFile({ RECOVERY_TOKEN: 'x', SETUP_TOKEN: 's' })).toEqual({
      problems: ['lists RECOVERY_TOKEN, which no deploy sets: set it by hand only while you need it (docs/cloudflare.md, "Locked out")'],
      names: ['SETUP_TOKEN'],
    });
    expect(checkSecretsFile({ SMTP_PASSWD: 'x', SESSION_TTL_DAYS: '1' }).problems).toEqual([
      'lists SMTP_PASSWD, which is not one of SETUP_TOKEN, SMTP_USER, SMTP_PASS, MAIL_REPLY_TO and RESEND_API_KEY (did you mean SMTP_PASS?)',
      'lists SESSION_TTL_DAYS, which is not one of SETUP_TOKEN, SMTP_USER, SMTP_PASS, MAIL_REPLY_TO and RESEND_API_KEY',
    ]);
    // A name and its value swapped: a key shaped like a Resend key or a setup code is a value, never printed.
    const swapped = { re_AbC123xyz_TOPSECRET: 'RESEND_API_KEY', ['ab'.repeat(32)]: 'SETUP_TOKEN', smtp_pass: 'x' };
    expect(checkSecretsFile(swapped).problems).toEqual(
      Array(3).fill('lists a name that is not one of SETUP_TOKEN, SMTP_USER, SMTP_PASS, MAIL_REPLY_TO and RESEND_API_KEY'),
    );
    for (const value of ['', '  ', 5, null]) {
      expect(checkSecretsFile({ SMTP_PASS: value }).problems, JSON.stringify(value)).toEqual(['has no value for SMTP_PASS']);
    }
    expect(checkSecretsFile({ SMTP_USER: 'u' }, { vars: { SMTP_USER: 'plan@example.com' } })).toEqual({
      problems: ['lists SMTP_USER, which "vars" of the instance configuration has too: a name is a variable or a secret, never both'],
      names: [],
    });
  });
});

// ---------------------------------------------------------------------------
// The example
// ---------------------------------------------------------------------------

describe('wrangler.instance.example.jsonc', () => {
  const text = read(EXAMPLE_FILE);
  const example = parseJsonc(text);

  it("passes every check as it is, the app's own parser among them, and names only example hosts", async () => {
    expect(example.$schema).toBe('node_modules/wrangler/config-schema.json');
    expect(checkBase(BASE)).toEqual([]);
    expect(checkInstance(example, { env: {} })).toEqual({ errors: [], warnings: [], notes: [] });
    expect(generateConfig(BASE, example, { runToken: TOKEN }).name).toBe(example.name);
    // The parser every deploy runs (scripts/lib/app-config.mjs): the example's INSTANCE_NAME and MAIL_TRANSPORT log
    // are valid, read, need no secret and set nothing worth a note, so it has no note at all.
    const parser = await loadAppConfigParser({ root: ROOT });
    expect(checkAppConfig(instanceVars(example), { declaredSecrets: declaredSecrets(example), parser })).toEqual({
      errors: [],
      notes: [],
      required: [],
      unread: [],
    });
    // Host names, file names aside: example.com's, or workers.dev with <your-subdomain> to fill in.
    const hosts = [...text.matchAll(/(?:[\w<>-]+\.)+[a-z]{2,}\b/gi)].map((m) => m[0]).filter((h) => !/\.(?:md|json|jsonc|mjs)$/.test(h));
    expect(hosts).toContain('plan.example.com');
    for (const host of hosts) {
      expect(host).toMatch(/^(?:(?:[\w-]+\.)*example\.com|workers\.dev|[\w<>-]+\.<your-subdomain>\.workers\.dev)$/);
    }
  });

  it('shows every optional key, each mail transport and the quotas, commented, as JSON one can uncomment', () => {
    for (const key of INSTANCE_KEYS) expect(text, key).toContain(`"${key}":`);
    for (const name of ['PUBLIC_URL', 'WEBAUTHN_RP_ID', 'MAIL_FROM', 'SMTP_HOST', 'SMTP_SECURITY', 'SMTP_USER', 'MAIL_DAILY_CAP', 'MAX_SPACES_PER_USER']) {
      expect(text, name).toContain(`// "${name}":`);
    }
    for (const transport of ['smtp', 'resend', 'cloudflare']) expect(text).toMatch(new RegExp(`// ${transport}: `));
    expect(text).toContain('docs/cloudflare.md, "Your instance configuration"');
    // Every commented member is valid JSON, and a key the configuration knows.
    const members = text.split('\n').filter((line) => /^\s*\/\/ "\w+":/.test(line));
    expect(members.length).toBeGreaterThan(20);
    for (const line of members) {
      const member = JSON.parse(`{${line.replace(/^\s*\/\/ /, '').replace(/,$/, '')}}`);
      const [key] = Object.keys(member);
      expect([...INSTANCE_KEYS, ...APP_VARIABLES], line).toContain(key);
    }
  });
});

// ---------------------------------------------------------------------------
// No values in messages
// ---------------------------------------------------------------------------

describe('messages', () => {
  it('name settings, never values', () => {
    // Every value below holds ODD or a marker (qq…), or is a hexadecimal account ID.
    const odd = (s) => `${s}${ODD}`;
    const env = { WRANGLER_CI_OVERRIDE_NAME: 'qqci', CLOUDFLARE_ACCOUNT_ID: 'e'.repeat(32) };
    const messages = [];
    const collect = ({ errors, warnings, notes }) => messages.push(...errors, ...warnings, ...notes);
    collect(
      checkInstance(
        {
          name: odd('x'),
          account_id: odd('x'),
          workers_dev: ODD,
          keep_vars: ODD,
          routes: [domain(odd('x')), { pattern: ODD }],
          send_email: [{ name: odd('E'), allowed_sender_addresses: [odd('x')], destination_address: ODD, [ODD]: ODD }],
          vars: { PUBLIC_URL: odd('https://qqhost.workers.dev'), LOG_REQUESTS: ODD, MAIL_FROM: odd('x'), SMTP_PASS: ODD, [odd('X')]: ODD, MAIL_TRANSPRT: ODD },
          secrets: { required: [odd('X'), 'SETUP_TOKEN'], [odd('k')]: ODD },
          limits: { cpu_ms: ODD, [ODD]: 1 },
          observability: ODD,
          [odd('key')]: ODD,
        },
        { env },
      ),
    );
    // Values of the right shape that break the rules between keys.
    const valid = {
      name: 'qqname',
      account_id: 'd'.repeat(32),
      routes: [domain('qqroute.example.com')],
      workers_dev: true,
      vars: { PUBLIC_URL: 'https://qqhost.example.com', MAIL_TRANSPORT: 'smtp', MAIL_FROM: 'qqfrom@example.com', SMTP_USER: 'qquser' },
      send_email: [{ name: 'EMAIL', allowed_sender_addresses: ['qqsender@example.com'] }],
      secrets: { required: ['SMTP_USER'] },
    };
    collect(checkInstance(valid, { env }));
    collect(checkInstance({ name: 'qqname', workers_dev: false, vars: { PUBLIC_URL: 'https://qqother.qqsub.workers.dev' } }));
    // wrangler dev's values, and a custom domain with workers.dev left on.
    collect(checkInstance({ name: 'qqname', vars: { PUBLIC_URL: 'http://qqlocal.localhost:8787', SMTP_HOST: 'qqmail.localhost', SMTP_SECURITY: 'none' } }));
    collect(checkInstance({ name: 'qqname', vars: { PUBLIC_URL: 'https://qqhost.example.com' } }));
    messages.push(...checkBase({ ...BASE, vars: { A: ODD }, account_id: odd('x'), routes: ODD, workers_dev: ODD }));
    messages.push(...wranglerArgsProblems(['deploy', '--var', `PUBLIC_URL:${ODD}`, '--name=qqname', '--routes', 'qqhost.example.com', '--var', ODD, ODD]));
    const secrets = { SMTP_PASS: ODD, [ODD]: ODD, SMTP_USER: ODD, RECOVERY_TOKEN: ODD, RESEND_API_KEY: '  ' };
    messages.push(...checkSecretsFile(secrets, { vars: { SMTP_USER: ODD } }).problems);
    expect(() => resolveInstanceSource({ flag: 'qq.jsonc', env: {}, root: '/', exists: () => false })).toThrow();
    expect(messages.length).toBeGreaterThan(30);
    for (const message of messages) {
      expect(message).not.toMatch(/pwned|said|qq|dddd|eeee|ffff/);
      expect(message).not.toContain('\n');
    }
  });
});
