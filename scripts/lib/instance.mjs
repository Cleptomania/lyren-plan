// The instance configuration of Lyren Plan on Cloudflare (docs/cloudflare.md, "Your instance configuration";
// design Appendix D 70): one JSONC file per deployment, a partial Wrangler configuration in Wrangler's own keys
// holding what belongs to that one instance (its Worker's name, custom domains, variables, the secrets it needs)
// and never a secret's value. scripts/cf/wrangler.mjs finds it, checks it and lays it over the committed
// wrangler.jsonc for each Wrangler run, as wrangler.deploy.<id>.jsonc; wrangler.jsonc keeps every setting the app
// owns, so an upgrade reaches every instance with nothing to edit. Here: where the file is found, what it may hold,
// the configuration it makes (a deploy's, or the Worker's name and account alone for other commands) and the header
// that names the run it is for, and the Wrangler arguments and secrets file that may go with it. Pure: nothing is
// read from disk (the caller passes the parsed files, and `exists` for the lookup); the app's own verdict on the
// variables is scripts/lib/app-config.mjs's. Unit-tested in scripts/test/instance.test.mjs.
//
//   const source = resolveInstanceSource({ flag, env: process.env, root, exists: fs.existsSync });
//   const { errors, warnings, notes } = checkInstance(instance, { env: process.env });
//   const config = generateConfig(base, instance, { required, runToken });
//
// Messages name settings, never values: no variable's value, account ID, Worker name or host name. They carry
// no ::error:: prefix; the caller adds it, and the source.

import path from 'node:path';
import { EMAIL_BINDING } from './cloudflare.mjs';

/** The instance configuration in the checkout (git-ignored), when no --instance or LYREN_INSTANCE_FILE names one. */
export const INSTANCE_FILE = 'wrangler.instance.jsonc';

/** The committed example that deployers copy: placeholders only, and it passes every check as it is. */
export const EXAMPLE_FILE = 'wrangler.instance.example.jsonc';

// Every variable the app reads on Cloudflare (server/src/core/config.ts, design Appendix B) except the secrets
// and MAIL_LOG_BODIES: the names "vars" may hold. scripts/test/instance.test.mjs checks the list against config.ts.
export const APP_VARIABLES = [
  ...['PUBLIC_URL', 'WEBAUTHN_RP_ID', 'INSTANCE_NAME', 'SIGNUP_POLICY'],
  ...['PASSWORD_MIN_LENGTH', 'PASSWORD_KDF', 'PASSWORD_SCRYPT_P'],
  ...['SESSION_TTL_DAYS', 'SESSION_MAX_DAYS', 'REAUTH_MINUTES', 'INVITATION_TTL_DAYS', 'SPACE_DELETE_GRACE_DAYS'],
  'AUTH_CACHE_SECONDS',
  ...['MAIL_TRANSPORT', 'MAIL_FROM', 'MAIL_FROM_NAME', 'MAIL_REPLY_TO', 'MAIL_DAILY_CAP'],
  ...['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURITY', 'SMTP_USER', 'SMTP_EHLO_NAME'],
  ...['MAX_SPACES_PER_USER', 'SPACES_CREATED_PER_DAY', 'MAX_MEMBERS_PER_SPACE', 'MAX_OPEN_INVITATIONS_PER_SPACE'],
  'INVITATIONS_PER_DAY',
  ...['BODY_LIMIT', 'IMPORT_BODY_LIMIT', 'IMPORT_MAX_JSON_VALUES', 'IMPORT_MAX_ROW_WRITES', 'IMPORT_DAILY_ROW_WRITES'],
  ...['SPACE_DAILY_ROW_WRITES', 'SPACE_MAX_BYTES', 'LOG_REQUESTS'],
];

/** The variables config.ts reads with readBool, which takes anything but 1, true, yes or on for false. */
export const BOOLEAN_VARIABLES = ['LOG_REQUESTS'];

/** What readBool reads as true and as false (any case, trimmed): the only values of BOOLEAN_VARIABLES. */
const BOOLEAN_SPELLINGS = ['1', 'true', 'yes', 'on', '0', 'false', 'no', 'off'];

/** The secrets a secrets file may carry (scripts/ci/write-secrets-file.sh writes these). */
export const SECRET_NAMES = ['SETUP_TOKEN', 'SMTP_USER', 'SMTP_PASS', 'MAIL_REPLY_TO', 'RESEND_API_KEY'];

/**
 * The secrets "secrets.required" may name. SETUP_TOKEN stays optional (without it the Worker makes a setup code),
 * and RECOVERY_TOKEN is set by hand only while it is needed (design §5.8.19).
 */
export const REQUIRABLE_SECRETS = ['SMTP_USER', 'SMTP_PASS', 'MAIL_REPLY_TO', 'RESEND_API_KEY'];

/** Secrets that are never a variable, so never in a file: set on the Worker alone. */
export const FILE_SECRETS = ['SETUP_TOKEN', 'SMTP_PASS', 'RESEND_API_KEY', 'RECOVERY_TOKEN'];

/** For development only (it writes sign-in links to the logs): .dev.vars, never an instance others can reach. */
export const DEV_ONLY = ['MAIL_LOG_BODIES'];

/** The Node server's own settings (server/src/config.ts and the rest), which the Worker never reads. */
export const NODE_ONLY = [
  ...['PORT', 'HOST', 'DATA_DIR', 'DB_PATH', 'WEB_DIR', 'TRUST_PROXY', 'COOKIE_SECURE', 'SNAPSHOT_KEEP'],
  ...['SPACES_OPEN_MAX', 'ALLOW_ADMIN_BACKUP_DOWNLOAD', 'LYREN_DB_STRICT'],
];

/**
 * Names that deploys once read and no longer do, with what took their place: an upgrade never ignores a setting
 * silently. A name upstream retires is added here.
 */
export const RETIRED = {
  WORKER_NAME: 'now "name"',
  WORKERS_DEV: 'now "workers_dev"',
  EMAIL_BINDING: 'MAIL_TRANSPORT=cloudflare adds send_email by itself',
};

/** The keys an instance configuration may set (each one a key of Wrangler's own configuration). */
export const INSTANCE_KEYS = [
  ...['$schema', 'name', 'account_id', 'workers_dev', 'routes', 'send_email', 'vars', 'secrets', 'keep_vars'],
  ...['limits', 'observability', 'placement', 'logpush', 'tail_consumers'],
];

/** Keys that come from wrangler.jsonc, the same for every instance: the app's code, its objects and its build. */
export const APP_OWNED_KEYS = [
  ...['main', 'tsconfig', 'build', 'compatibility_date', 'compatibility_flags', 'assets', 'durable_objects'],
  ...['migrations', 'preview_urls', 'upload_source_maps', 'send_metrics', 'no_bundle', 'minify', 'define', 'alias'],
  ...['rules', 'find_additional_modules', 'base_dir', 'keep_names', 'node_compat'],
];

/** Wrangler's other bindings (and cron triggers): nothing of the app reads them. */
export const UNUSED_BINDINGS = [
  ...['kv_namespaces', 'd1_databases', 'r2_buckets', 'services', 'queues', 'triggers', 'ai', 'vectorize'],
  ...['hyperdrive', 'analytics_engine_datasets', 'browser', 'workflows', 'version_metadata', 'unsafe'],
  ...['wasm_modules', 'text_blobs', 'data_blobs', 'dispatch_namespaces', 'mtls_certificates', 'secrets_store_secrets'],
  ...['images', 'media', 'stream', 'pipelines', 'ratelimits', 'worker_loaders', 'vpc_services', 'vpc_networks'],
  ...['containers', 'artifacts', 'flagship', 'agent_memory', 'ai_search', 'ai_search_namespaces', 'analytics'],
  ...['k2', 'logfwdr', 'unsafe_hello_world'],
];

/** A Worker's name as Cloudflare takes it: lower-case letters, digits and dashes, 63 at most, no dash at an end. */
export const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** The project's own wrangler.jsonc, put back over a copy that holds an instance's settings. */
const PUT_BACK = "put back the project's file (git checkout <upstream>/master -- wrangler.jsonc)";

/**
 * The note when "vars" leaves MAIL_TRANSPORT to the Worker (keep_vars), which cannot be read offline: the check
 * sees only the file's variables, and a deploy adds the EMAIL binding only for the file's MAIL_TRANSPORT.
 */
const MAIL_NOTE =
  'MAIL_TRANSPORT is not in the file: the Worker keeps the one it has; put MAIL_TRANSPORT and the settings it ' +
  'needs (MAIL_FROM, PUBLIC_URL) here so that the check sees them';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Whether a name from the file may be printed: one shaped like a key or a variable's name, never anything else. */
const printable = (name) => typeof name === 'string' && /^[A-Za-z_$][A-Za-z0-9_-]{0,63}$/.test(name);

/**
 * Whether a secrets file's name may be printed: one shaped like a secret's name. A key of another shape may be a
 * value written where its name belongs (a Resend key, a setup code), and is never printed.
 */
const secretName = (name) => /^[A-Z][A-Z0-9_]{0,63}$/.test(name);

/** "a, b, c and d". */
const listed = (names) => `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

/** The edit distance of two words (Levenshtein). */
function distance(a, b) {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = row;
  }
  return previous[b.length];
}

/** The candidate nearest to `word`, case aside, within two edits (the first of equals), or null. */
export function nearest(word, candidates) {
  if (typeof word !== 'string' || word === '') return null;
  let best = null;
  let bestDistance = 3;
  for (const candidate of candidates) {
    const d = distance(word.toLowerCase(), candidate.toLowerCase());
    if (d < bestDistance) [best, bestDistance] = [candidate, d];
  }
  return best;
}

/** " (did you mean X?)" for a misspelt name, or nothing. */
function didYouMean(word, candidates, quote = '') {
  const near = nearest(word, candidates);
  return near === null ? '' : ` (did you mean ${quote}${near}${quote}?)`;
}

// ---------------------------------------------------------------------------
// Where it is found
// ---------------------------------------------------------------------------

/**
 * The instance configuration to use, or null when there is none: `flag` (--instance <path>, from the command
 * line), else LYREN_INSTANCE_FILE (a blank value counts as unset), else wrangler.instance.jsonc at the root of the
 * checkout (`root`) if it `exists`. A relative path starts in INIT_CWD, where npm was run (npm run moves to the
 * package's root), else in `cwd`. A file named by the flag or the variable must exist: it is never passed over
 * for the next source (throws, with the message to print).
 *
 * Returns { path (absolute), display (as given), from ('--instance', 'LYREN_INSTANCE_FILE' or 'the checkout') }.
 */
export function resolveInstanceSource({ flag, env = {}, root, exists, cwd = process.cwd() }) {
  const start = typeof env.INIT_CWD === 'string' && env.INIT_CWD.trim() !== '' ? env.INIT_CWD : cwd;
  const named = (display, from) => {
    const file = path.resolve(start, display);
    if (!exists(file)) {
      throw new Error(`${from} names ${display}, which does not exist (a relative path starts where the command runs)`);
    }
    return { path: file, display, from };
  };
  if (flag !== undefined && flag !== null) {
    if (typeof flag !== 'string' || flag.trim() === '') throw new Error('--instance names no file: --instance=<path>');
    return named(flag, '--instance');
  }
  const variable = env.LYREN_INSTANCE_FILE;
  if (typeof variable === 'string' && variable.trim() !== '') return named(variable, 'LYREN_INSTANCE_FILE');
  const file = path.join(root, INSTANCE_FILE);
  return exists(file) ? { path: file, display: INSTANCE_FILE, from: 'the checkout' } : null;
}

// ---------------------------------------------------------------------------
// wrangler.jsonc under an instance configuration
// ---------------------------------------------------------------------------

/** wrangler.jsonc's keys that belong to one instance, with where they go now (Appendix D 70). */
const BASE_REPLACEMENTS = {
  routes: 'custom domains go in "routes" of your instance configuration',
  route: 'custom domains go in "routes" of your instance configuration',
  vars: 'variables go in "vars" of your instance configuration',
  send_email: 'MAIL_TRANSPORT=cloudflare adds the binding by itself, or "send_email" of your instance configuration',
  secrets: 'required secrets go in "secrets" of your instance configuration',
  account_id: 'the account goes in "account_id" of your instance configuration',
  env: 'each Worker has an instance configuration of its own (--instance or LYREN_INSTANCE_FILE)',
  limits: 'limits go in "limits" of your instance configuration',
};

/**
 * Why wrangler.jsonc (`base`, parsed) cannot carry an instance configuration: it holds a setting of one instance,
 * as copies edited under the old instructions do. Its "name" may differ (the Deploy button writes one); the
 * instance configuration's wins. An empty list when it is the project's.
 */
export function checkBase(base) {
  if (!isObject(base)) return ['wrangler.jsonc does not hold an object'];
  const problems = [];
  for (const [key, instead] of Object.entries(BASE_REPLACEMENTS)) {
    if (base[key] !== undefined) problems.push(`wrangler.jsonc has "${key}": ${instead}; ${PUT_BACK}`);
  }
  if (base.workers_dev !== true) {
    const instead = '"workers_dev" of your instance configuration decides it';
    problems.push(`wrangler.jsonc has "workers_dev" other than true: ${instead}; ${PUT_BACK}`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Checking an instance configuration
// ---------------------------------------------------------------------------

/** A variable's value as the Worker gets it: text as it is, a finite number or a boolean as text, else undefined. */
function varText(value) {
  if (typeof value === 'string') return value;
  if ((typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean') return String(value);
  return undefined;
}

/**
 * The instance configuration's variables as text, by name: the app's settings only, a finite number or a boolean
 * as String() gives it (Wrangler would upload anything else as a JSON variable, which the Worker ignores), and
 * neither empty values nor ones that are no text. What the generated configuration and the --var list carry.
 */
export function instanceVars(instance) {
  const vars = {};
  if (!isObject(instance) || !isObject(instance.vars)) return vars;
  for (const [name, value] of Object.entries(instance.vars)) {
    const text = varText(value);
    if (APP_VARIABLES.includes(name) && text !== undefined && text.trim() !== '') vars[name] = text;
  }
  return vars;
}

/** The secrets of "secrets.required" that it may name, in its order. */
export function declaredSecrets(instance) {
  const required = isObject(instance) && isObject(instance.secrets) ? instance.secrets.required : undefined;
  return Array.isArray(required) ? required.filter((name) => REQUIRABLE_SECRETS.includes(name)) : [];
}

/**
 * Why `name`, an instance configuration's "name", names no Worker this run may act on, or null: with
 * accountProblem, the check every Wrangler command needs. Under Workers Builds (WRANGLER_CI_OVERRIDE_NAME) it must
 * be the Worker that the build deploys, which Wrangler would otherwise override with a warning.
 */
export function nameProblem(name, { env = {} } = {}) {
  if (name === undefined) {
    return (
      '"name" is missing: the Worker\'s name, which every instance configuration gives (another name is another ' +
      'Worker, with new, empty Durable Objects)'
    );
  }
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
    return '"name" is not a Worker\'s name: 1 to 63 lower-case letters, digits and dashes, with no dash first or last';
  }
  const override = env.WRANGLER_CI_OVERRIDE_NAME;
  if (typeof override === 'string' && override.trim() !== '' && override.trim() !== name) {
    return (
      '"name" is not the Worker this Workers Builds build deploys (WRANGLER_CI_OVERRIDE_NAME): make it that ' +
      "Worker's name"
    );
  }
  return null;
}

/**
 * Why `accountId`, an instance configuration's "account_id" (when it has one), names no account this run may use,
 * or null: 32 lower-case hexadecimal digits, the same as CLOUDFLARE_ACCOUNT_ID when that is set too. Like "name",
 * it picks what every command acts on: without it, Wrangler would take CLOUDFLARE_ACCOUNT_ID's account instead.
 */
export function accountProblem(accountId, { env = {} } = {}) {
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  if (typeof accountId !== 'string' || !/^[0-9a-f]{32}$/.test(accountId)) {
    return '"account_id" must be 32 lower-case hexadecimal digits: the account ID that Workers & Pages shows';
  }
  if (typeof account === 'string' && account.trim() !== '' && account.trim() !== accountId) {
    return '"account_id" is not CLOUDFLARE_ACCOUNT_ID: both name the account, so make them the same, or remove one';
  }
  return null;
}

/**
 * What a Wrangler command other than deploy and versions upload takes from the instance configuration
 * (`instance`, parsed, its "name" and "account_id" checked: nameProblem, accountProblem): the Worker's "name",
 * and "account_id" when it has one. Such a command (secret, tail, rollback, …) reads nothing else, so a key the
 * file got wrong since its last deploy cannot stop it during an incident.
 */
export function workerOnly(instance) {
  const only = { name: instance.name };
  if (instance.account_id !== undefined) only.account_id = instance.account_id;
  return only;
}

/** Why a top-level key is refused. */
function keyRefusal(key) {
  if (APP_OWNED_KEYS.includes(key)) {
    return `"${key}" comes from wrangler.jsonc, the same for every instance: remove it here`;
  }
  if (key === 'env') {
    return (
      '"env" is refused: one instance configuration is one Worker; for another, use another file, with ' +
      'LYREN_INSTANCE_FILE or --instance'
    );
  }
  if (key === 'route') return '"route" is refused: use "routes", with custom domains';
  if (UNUSED_BINDINGS.includes(key)) return `"${key}": Lyren Plan reads no such binding`;
  if (!printable(key)) return 'a key that is no name is not a key an instance configuration may set';
  return `"${key}" is not a key an instance configuration may set${didYouMean(key, INSTANCE_KEYS, '"')}`;
}

function checkVars(vars, errors) {
  if (!isObject(vars)) {
    errors.push('"vars" is not an object of settings by name: { "PUBLIC_URL": "https://…", … }');
    return;
  }
  for (const [name, value] of Object.entries(vars)) {
    const at = `vars.${name}`;
    if (FILE_SECRETS.includes(name)) {
      errors.push(`${at} is a secret, never in a file: npm run cf -- secret put ${name}`);
    } else if (DEV_ONLY.includes(name)) errors.push(`${at} is for development only: .dev.vars`);
    else if (NODE_ONLY.includes(name)) errors.push(`${at} is not read on Cloudflare (the Node server's setting)`);
    else if (Object.hasOwn(RETIRED, name)) errors.push(`${at} is no longer read: ${RETIRED[name]}`);
    else if (!APP_VARIABLES.includes(name)) {
      errors.push(
        printable(name)
          ? `${at} is not a setting of Lyren Plan${didYouMean(name, APP_VARIABLES)}`
          : 'vars has a name that is not a setting of Lyren Plan',
      );
    } else {
      const text = varText(value);
      if (text === undefined) errors.push(`${at} is not text, a number, true or false`);
      else if (text.trim() === '') {
        errors.push(`${at} is empty: remove the line; to clear a value set in the dashboard, delete it there`);
      } else if (BOOLEAN_VARIABLES.includes(name) && !BOOLEAN_SPELLINGS.includes(text.trim().toLowerCase())) {
        errors.push(
          `${at} must be 1, true, yes or on, or 0, false, no or off (any case): the app reads anything else as off`,
        );
      }
    }
  }
}

const HOST_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOST = new RegExp(`^(?:${HOST_LABEL}\\.)+${HOST_LABEL}$`);

/** A host name of two labels or more, in lower case, alone (no scheme, port, path or *), and no IP address. */
const isHost = (value) =>
  typeof value === 'string' && value.length <= 253 && HOST.test(value) && !/^[0-9]+$/.test(value.split('.').pop());

const isWorkersDev = (host) => host === 'workers.dev' || host.endsWith('.workers.dev');

/**
 * Whether `host` (a URL's host name, or SMTP_HOST as written) is this machine: localhost, a name under
 * .localhost, 127.0.0.0/8 or [::1], in any of the spellings a URL accepts. Only wrangler dev reaches it, never a
 * deployed Worker.
 */
function isLoopback(host) {
  let name = host.trim().toLowerCase();
  for (const form of [name, `[${name}]`]) {
    try {
      name = new URL(`http://${form}/`).hostname;
      break;
    } catch {
      // no host in this form
    }
  }
  name = name.replace(/\.$/, '');
  return name === 'localhost' || name.endsWith('.localhost') || /^127(?:\.\d{1,3}){3}$/.test(name) || name === '[::1]';
}

/** A URL's host name, or null when it is no URL (the app's check names that). */
function hostOf(url) {
  try {
    return new URL(url.trim()).hostname || null;
  } catch {
    return null;
  }
}

/** The custom domains "routes" lists, or null when it is not a valid list of them. */
function checkRoutes(routes, errors) {
  const shape = '{ "pattern": "<host>", "custom_domain": true }';
  if (!Array.isArray(routes) || routes.length === 0) {
    errors.push(`"routes" must be a non-empty list of custom domains, [${shape}]`);
    return null;
  }
  const hosts = [];
  routes.forEach((route, i) => {
    const at = `routes[${i}]`;
    const domain =
      isObject(route) &&
      route.custom_domain === true &&
      Object.keys(route).every((k) => k === 'pattern' || k === 'custom_domain');
    if (!domain) {
      errors.push(
        `${at} must be ${shape}: custom domains only, since a route with a path or a zone would break ` +
          "PUBLIC_URL's one origin",
      );
    } else if (!isHost(route.pattern)) {
      errors.push(`${at}.pattern must be a host name alone, in lower case: no scheme, port, path or *`);
    } else if (isWorkersDev(route.pattern)) {
      errors.push(`${at}.pattern is on workers.dev, which is no custom domain: "workers_dev" turns it on or off`);
    } else hosts.push(route.pattern);
  });
  return hosts.length === routes.length ? hosts : null;
}

function checkSendEmail(sendEmail, vars, errors) {
  if (!Array.isArray(sendEmail) || sendEmail.length !== 1 || !isObject(sendEmail[0])) {
    const shape = `[{ "name": "${EMAIL_BINDING}" }]`;
    errors.push(`"send_email" must hold one binding, ${shape}: the app sends through ${EMAIL_BINDING} alone`);
    return;
  }
  const [binding] = sendEmail;
  const keys = 'only "name" and "allowed_sender_addresses"';
  for (const key of Object.keys(binding)) {
    if (key === 'name' || key === 'allowed_sender_addresses') continue;
    if (key === 'destination_address' || key === 'allowed_destination_addresses') {
      const why = 'invitations go to anyone, so the binding cannot be limited to some recipients';
      errors.push(`send_email[0].${key} is refused: ${why}`);
    } else if (key === 'remote') errors.push('send_email[0].remote is refused: it matters to wrangler dev alone');
    else if (!printable(key)) errors.push(`send_email[0] has a key that is no name: ${keys}`);
    else errors.push(`send_email[0].${key} is not a key of the binding: ${keys}`);
  }
  if (binding.name !== EMAIL_BINDING) {
    errors.push(`send_email[0].name must be ${EMAIL_BINDING}, the binding the app sends through`);
  }
  const senders = binding.allowed_sender_addresses;
  if (senders === undefined) return;
  const addresses = Array.isArray(senders) && senders.every((s) => typeof s === 'string' && s.trim() !== '');
  if (!addresses || senders.length === 0) {
    errors.push('send_email[0].allowed_sender_addresses must be a non-empty list of addresses');
  } else if (vars.MAIL_FROM === undefined) {
    errors.push('send_email[0].allowed_sender_addresses needs MAIL_FROM in "vars", which it must include');
  } else if (!senders.some((s) => s.trim().toLowerCase() === vars.MAIL_FROM.trim().toLowerCase())) {
    errors.push(
      'send_email[0].allowed_sender_addresses does not include MAIL_FROM: the binding would refuse every message',
    );
  }
}

function checkSecrets(secrets, errors) {
  if (!isObject(secrets)) {
    errors.push('"secrets" must be { "required": [names] }');
    return;
  }
  for (const key of Object.keys(secrets)) {
    if (key === 'required') continue;
    const what = printable(key) ? `secrets.${key} is not a key here` : '"secrets" has a key that is no name';
    errors.push(`${what}: only "required"`);
  }
  const { required } = secrets;
  if (required === undefined) return;
  if (!Array.isArray(required)) {
    errors.push('secrets.required must be a list of names');
    return;
  }
  for (const name of required) {
    if (!printable(name)) errors.push("secrets.required holds something that is no secret's name");
    else if (name === 'SETUP_TOKEN') {
      errors.push(
        'secrets.required lists SETUP_TOKEN, which stays optional: without it the Worker makes a setup code and ' +
          'writes it to its log (docs/cloudflare.md, "The setup code")',
      );
    } else if (name === 'RECOVERY_TOKEN') {
      errors.push(
        'secrets.required lists RECOVERY_TOKEN, which is set by hand only while it is needed (docs/cloudflare.md, ' +
          '"Locked out")',
      );
    } else if (!REQUIRABLE_SECRETS.includes(name)) {
      errors.push(
        `secrets.required lists ${name}: only ${listed(REQUIRABLE_SECRETS)} may be required` +
          didYouMean(name, REQUIRABLE_SECRETS),
      );
    }
  }
}

function checkLimits(limits, errors) {
  const keys = 'only cpu_ms and subrequests';
  if (!isObject(limits)) {
    errors.push('"limits" must be { "cpu_ms": <milliseconds>, "subrequests": <count> }, either or both');
    return;
  }
  for (const [key, value] of Object.entries(limits)) {
    if (key !== 'cpu_ms' && key !== 'subrequests') {
      const what = printable(key) ? `limits.${key} is not a limit` : '"limits" has a key that is no name';
      errors.push(`${what}: ${keys}`);
    } else if (!Number.isInteger(value) || value <= 0) errors.push(`limits.${key} must be a whole number above 0`);
  }
}

/**
 * The problems of an instance configuration (`instance`, parsed): its keys and their shapes, and the rules
 * between them. Not the app's verdict on the variables' values (scripts/lib/app-config.mjs). `env` is the
 * environment, for Workers Builds' WRANGLER_CI_OVERRIDE_NAME and CLOUDFLARE_ACCOUNT_ID.
 *
 * - errors: what stops a deploy, among them values only wrangler dev uses (a local PUBLIC_URL or SMTP_HOST,
 *   SMTP_SECURITY none); a problem with "name" comes first (nameProblem);
 * - warnings: allowed, but likely a mistake ("routes" with "workers_dev": true; a PUBLIC_URL on a custom domain
 *   while workers.dev stays on);
 * - notes: what the file cannot know (the Worker's MAIL_TRANSPORT when "vars" has none).
 */
export function checkInstance(instance, { env = {} } = {}) {
  const errors = [];
  const warnings = [];
  const notes = [];
  if (!isObject(instance)) {
    errors.push('the file does not hold an object: { "name": "…", … }');
    return { errors, warnings, notes };
  }
  const name = nameProblem(instance.name, { env });
  if (name !== null) errors.push(name);
  const vars = instanceVars(instance);
  const hasVar = (n) => isObject(instance.vars) && Object.hasOwn(instance.vars, n);

  let hosts = null;
  for (const [key, value] of Object.entries(instance)) {
    if (!INSTANCE_KEYS.includes(key)) errors.push(keyRefusal(key));
    else if (key === 'account_id') {
      const account = accountProblem(value, { env });
      if (account !== null) errors.push(account);
    } else if (key === 'workers_dev' || key === 'keep_vars') {
      if (typeof value !== 'boolean') errors.push(`"${key}" must be true or false`);
    } else if (key === 'routes') hosts = checkRoutes(value, errors);
    else if (key === 'send_email') checkSendEmail(value, vars, errors);
    else if (key === 'vars') checkVars(value, errors);
    else if (key === 'secrets') checkSecrets(value, errors);
    else if (key === 'limits') checkLimits(value, errors);
    else if (key === 'observability' && !isObject(value)) {
      errors.push('"observability" must be an object, merged key by key onto wrangler.jsonc\'s');
    }
    // $schema and name are checked above; placement, logpush and tail_consumers are Wrangler's to check.
  }

  // Custom domains: the API answers PUBLIC_URL alone (design §10.11), so its host is one of them.
  const routesListed = instance.routes !== undefined;
  const publicHost = vars.PUBLIC_URL === undefined ? null : hostOf(vars.PUBLIC_URL);
  if (hosts !== null) {
    if (!hasVar('PUBLIC_URL')) errors.push('"routes" needs PUBLIC_URL in "vars", on one of the hosts it lists');
    else if (publicHost !== null && !hosts.includes(publicHost)) {
      errors.push('PUBLIC_URL\'s host is not one of "routes": the API answers PUBLIC_URL alone, so list its host');
    }
  }
  // workers.dev: <name>.<subdomain>.workers.dev, on unless "workers_dev" is false or "routes" turns it off.
  if (publicHost !== null && isWorkersDev(publicHost)) {
    if (instance.workers_dev === false || (instance.workers_dev === undefined && routesListed)) {
      errors.push(
        'PUBLIC_URL is on workers.dev, which this instance turns off ("workers_dev": false, or "routes" listed)',
      );
    }
    if (name === null && publicHost.split('.')[0] !== instance.name) {
      errors.push(
        'PUBLIC_URL is on workers.dev but does not start with "name": the Worker answers at ' +
          '<name>.<your-subdomain>.workers.dev',
      );
    }
  }
  if (routesListed && instance.workers_dev === true) {
    warnings.push(
      '"routes" with "workers_dev": true keeps the workers.dev address on: a public instance turns it off ' +
        '(docs/cloudflare.md, "Hostnames, passkeys and workers.dev")',
    );
  }
  // wrangler dev's own values: npm run dev:cf reads .dev.vars, never an instance configuration.
  const local = (name) =>
    `vars.${name} is a local address, for wrangler dev only: put it in .dev.vars, never in an instance configuration`;
  const localPublicUrl = publicHost !== null && isLoopback(publicHost);
  if (localPublicUrl) errors.push(local('PUBLIC_URL'));
  if (vars.SMTP_HOST !== undefined && isLoopback(vars.SMTP_HOST)) errors.push(local('SMTP_HOST'));
  if (vars.SMTP_SECURITY?.trim().toLowerCase() === 'none') {
    errors.push('vars.SMTP_SECURITY none is for a local relay under wrangler dev only: use tls or starttls');
  }
  // A custom domain added in the dashboard, while wrangler.jsonc's workers.dev stays on.
  if (
    publicHost !== null &&
    !isWorkersDev(publicHost) &&
    !localPublicUrl &&
    !routesListed &&
    instance.workers_dev === undefined
  ) {
    warnings.push(
      'PUBLIC_URL is a custom domain, but this deploy turns workers.dev on (wrangler.jsonc): add "workers_dev": ' +
        'false once the domain works',
    );
  }

  // A name is a variable or a secret, never both (docs/cloudflare.md, step 4B).
  for (const secret of declaredSecrets(instance)) {
    if (APP_VARIABLES.includes(secret) && hasVar(secret)) {
      errors.push(`${secret} is in "vars" and in "secrets.required": a name is a variable or a secret, never both`);
    }
  }

  // Mail: a deploy carries the EMAIL binding when this file says so, by MAIL_TRANSPORT or send_email (Appendix D 68).
  const transport = vars.MAIL_TRANSPORT?.trim().toLowerCase();
  if (!hasVar('MAIL_TRANSPORT') && instance.keep_vars !== false && instance.send_email === undefined) {
    notes.push(MAIL_NOTE);
  }
  if (instance.send_email !== undefined && transport !== undefined && transport !== 'cloudflare') {
    notes.push(`send_email: the binding ${EMAIL_BINDING} is deployed, unused while MAIL_TRANSPORT is not cloudflare`);
  }
  return { errors, warnings, notes };
}

// ---------------------------------------------------------------------------
// The generated configuration
// ---------------------------------------------------------------------------

/** Keys whose value the instance configuration's replaces, when it has one. */
const REPLACED_KEYS = [
  ...['name', 'account_id', 'routes', 'send_email', 'keep_vars', 'limits', 'placement', 'logpush'],
  'tail_consumers',
];

/**
 * The configuration of one Wrangler run: wrangler.jsonc (`base`, parsed from the current file) with the instance
 * configuration's keys, and everything else as it is (migrations, compatibility date, assets, objects, tsconfig).
 *
 * - name, account_id, routes, send_email, keep_vars, limits, placement, logpush, tail_consumers: the file's, when
 *   it has them; observability merged key by key onto the base's; vars: the file's, as text (instanceVars);
 * - workers_dev: the file's, else false when it lists "routes", else the base's (true);
 * - send_email: the binding EMAIL when MAIL_TRANSPORT is cloudflare (trimmed, any case) and the file lists none;
 * - secrets.required: the sorted names the file declares and the app requires (`required`, app-config.mjs's),
 *   none when there are none (never in wrangler.jsonc: wrangler dev would drop the rest of .dev.vars);
 * - build.command: build-web.mjs with this run's token (`runToken`), which it checks against LYREN_WRANGLER_RUN.
 */
export function generateConfig(base, instance, { required = [], runToken }) {
  if (!isObject(base)) throw new Error('wrangler.jsonc does not hold an object');
  if (!isObject(instance)) throw new Error('the instance configuration does not hold an object');
  if (typeof runToken !== 'string' || !/^[0-9a-f]{32}$/.test(runToken)) {
    throw new Error('generateConfig needs a run token of 32 hexadecimal digits');
  }
  const config = structuredClone(base);
  for (const key of REPLACED_KEYS) if (instance[key] !== undefined) config[key] = structuredClone(instance[key]);
  if (isObject(instance.observability)) {
    const observability = isObject(base.observability) ? base.observability : {};
    config.observability = { ...observability, ...structuredClone(instance.observability) };
  }
  const vars = instanceVars(instance);
  if (Object.keys(vars).length > 0) config.vars = vars;
  if (typeof instance.workers_dev === 'boolean') config.workers_dev = instance.workers_dev;
  else if (instance.routes !== undefined) config.workers_dev = false;
  if (vars.MAIL_TRANSPORT?.trim().toLowerCase() === 'cloudflare' && instance.send_email === undefined) {
    config.send_email = [{ name: EMAIL_BINDING }];
  }
  const secrets = [...new Set([...declaredSecrets(instance), ...required])].sort();
  if (secrets.length > 0) config.secrets = { required: secrets };
  const build = isObject(base.build) ? base.build : {};
  config.build = { ...build, command: `node scripts/cf/build-web.mjs --run=${runToken}` };
  return config;
}

/**
 * The kinds of run a generated configuration is for: `build`, a deploy or a versions upload (dry runs included),
 * whose build command empties dist/web and builds it again, so that two at once in a checkout would spoil each
 * other's upload; `other`, any other command, which builds nothing.
 */
const RUN_KINDS = ['build', 'other'];

/** A place as a header records it (wrangler-run.mjs#runPlace): no parenthesis or line break, nothing blank. */
const PLACE = /^[^()\p{Cc}\p{Zl}\p{Zp}]*[^()\s][^()\p{Cc}\p{Zl}\p{Zp}]*$/u;

/**
 * A generated configuration's header, up to its source: who wrote it, the run's process ID and its place, and its
 * kind. The parenthesis is read on its own, so that a file whose pid cannot be read still says its kind.
 */
const GENERATED_BY =
  /^\/\/ Written by scripts\/cf\/wrangler\.mjs \(([^()\n]*)\) for one Wrangler run of kind (\w+), from /;
const RUN = /^pid ([1-9][0-9]{0,9}) on (.+)$/;

/**
 * The text of a run's wrangler.deploy.<id>.jsonc: a header naming the run that wrote it (`pid`, its process ID,
 * on `where`, its place: process IDs of another place mean nothing here) and its `kind` (RUN_KINDS), and where it
 * comes from (`source`, the instance configuration as the output names it), then `config` as JSON.
 */
export function generatedConfigText(config, { source, pid, where, kind }) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('generatedConfigText needs the process ID of the run');
  if (typeof where !== 'string' || !PLACE.test(where)) {
    throw new Error('generatedConfigText needs the place of the run, with no parenthesis or line break');
  }
  if (!RUN_KINDS.includes(kind)) {
    throw new Error(`generatedConfigText needs the kind of the run: ${RUN_KINDS.join(' or ')}`);
  }
  // A line break in a path would end the comment.
  const from = String(source).replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, '?');
  return (
    `// Written by scripts/cf/wrangler.mjs (pid ${pid} on ${where}) for one Wrangler run of kind ${kind}, from ` +
    `wrangler.jsonc and ${from}; removed when it ends. Do not edit.\n${JSON.stringify(config, null, 2)}\n`
  );
}

/**
 * The run that wrote a generated configuration (`text`, generatedConfigText's): { kind, pid, where }, pid and
 * where null when its header does not say them; or null when the header is not that of one: another file of a
 * similar name, or one being written.
 */
export function generatorOf(text) {
  const m = GENERATED_BY.exec(String(text));
  if (m === null || !RUN_KINDS.includes(m[2])) return null;
  const run = RUN.exec(m[1]);
  return { kind: m[2], pid: run === null ? null : Number(run[1]), where: run === null ? null : run[2] };
}

/**
 * The variables (instanceVars) as Wrangler arguments, `--var NAME:value` each: a deploy passes them as well as
 * writing them into the generated configuration, so its bindings table prints "(hidden)" instead of the values.
 */
export const varArgs = (vars) => Object.entries(vars).flatMap(([name, value]) => ['--var', `${name}:${value}`]);

// ---------------------------------------------------------------------------
// Wrangler's arguments
// ---------------------------------------------------------------------------

// Wrangler's options that take a value (its global ones, deploy's and versions upload's), so that the word after
// one is not taken for a command or a script path; an array option takes every word up to the next option.
const VALUE_OPTIONS = new Set([
  ...['cwd', 'config', 'env', 'profile', 'path', 'script', 'name', 'tag', 'message', 'outdir', 'outfile'],
  ...['compatibility-date', 'assets', 'site', 'jsx-factory', 'jsx-fragment', 'tsconfig', 'secrets-file', 'event-code'],
  ...['metafile', 'old-asset-ttl', 'dispatch-namespace', 'containers-rollout', 'durable-objects-code-update-mode'],
  'preview-alias',
]);
const ARRAY_OPTIONS = new Set([
  ...['env-file', 'compatibility-flags', 'compatibility-flag', 'site-include', 'site-exclude', 'var', 'define'],
  ...['alias', 'triggers', 'schedule', 'schedules', 'routes', 'route', 'zone', 'zones', 'zone-id', 'zone-ids'],
  ...['domains', 'domain'],
]);
const SHORT_OPTIONS = { c: 'config', e: 'env', v: 'version', h: 'help' };

/**
 * Wrangler's arguments as options ({ flag as given, name, values }) and words (the command, its arguments), the
 * way yargs reads them: `versions --message hi upload` is versions upload. scripts/cf/wrangler.mjs takes the
 * command from it too, so the command it checks is the one Wrangler runs.
 */
export function readArgs(args) {
  const options = [];
  const words = [];
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i]);
    if (arg === '--') {
      words.push(...args.slice(i + 1).map(String));
      break;
    }
    if (!arg.startsWith('-') || arg === '-') {
      words.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const values = eq === -1 ? [] : [arg.slice(eq + 1)];
    // --keepVars is --keep-vars to yargs; -ce is -c and -e.
    const named = flag.startsWith('--')
      ? [{ flag, name: flag.slice(2).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`) }]
      : [...flag.slice(1)].map((c) => ({ flag: `-${c}`, name: SHORT_OPTIONS[c] ?? c }));
    const last = named[named.length - 1].name;
    const next = () => i + 1 < args.length && !String(args[i + 1]).startsWith('-');
    if (eq === -1) {
      if (ARRAY_OPTIONS.has(last)) while (next()) values.push(String(args[++i]));
      else if (VALUE_OPTIONS.has(last)) {
        if (next()) values.push(String(args[++i]));
      } else if (args[i + 1] === 'true' || args[i + 1] === 'false') values.push(String(args[++i]));
    }
    for (const { flag: given, name } of named) options.push({ flag: given, name, values });
  }
  return { options, words };
}

const SCRIPT_PATH =
  'a script path is not passed on: the Worker\'s code is "main" of wrangler.jsonc, the same for every instance';
const ANOTHER = 'name another instance configuration with --instance or LYREN_INSTANCE_FILE';
const APP_OWNED = 'it comes from wrangler.jsonc, the same for every instance';
const BUNDLED = 'the Worker is bundled as wrangler.jsonc says, the same for every instance';
const DOMAINS = 'list custom domains in "routes" of your instance configuration';

/**
 * Options refused for every command (everywhere) or for deploy and versions upload, with what to do instead
 * (why). --var names its variable; a script option is a script path.
 */
const ARG_RULES = {
  config: { everywhere: true, why: `Wrangler gets the configuration made from wrangler.jsonc and yours; ${ANOTHER}` },
  cwd: { everywhere: true, why: "Wrangler runs in the checkout's root, next to wrangler.jsonc" },
  env: { everywhere: true, why: `one instance configuration is one Worker; ${ANOTHER}` },
  // Wrangler loads the files it names into its environment, CLOUDFLARE_ENV and all.
  'env-file': {
    everywhere: true,
    why: 'settings go in "vars" of your instance configuration, secrets in npm run cf -- secret put <NAME>',
  },
  name: { everywhere: true, why: 'the Worker is "name" of your instance configuration' },
  var: { variable: true },
  routes: { why: DOMAINS },
  domains: { why: DOMAINS },
  'keep-vars': { why: 'set "keep_vars" in your instance configuration' },
  logpush: { why: 'set "logpush" in your instance configuration' },
  'compatibility-date': { why: APP_OWNED },
  'compatibility-flags': { why: APP_OWNED },
  latest: { why: 'the compatibility date comes from wrangler.jsonc, the same for every instance' },
  bundle: { why: BUNDLED },
  'no-bundle': { why: BUNDLED },
  triggers: { why: 'Lyren Plan runs no cron triggers' },
  script: { path: true },
};
// The app's build, as wrangler.jsonc has it.
for (const name of ['assets', 'tsconfig', 'define', 'alias', 'jsx-factory', 'jsx-fragment', 'minify']) {
  ARG_RULES[name] = { why: APP_OWNED };
}
for (const name of ['upload-source-maps', 'node-compat']) ARG_RULES[name] = { why: APP_OWNED };

/** Wrangler's other spellings of the options above. */
const ARG_ALIASES = {
  route: 'routes',
  domain: 'domains',
  'compatibility-flag': 'compatibility-flags',
  schedule: 'triggers',
  schedules: 'triggers',
};

/** The rule of an option's name, also when it is an alias or negated (--no-keep-vars). */
function argRule(name) {
  for (const candidate of [name, name.startsWith('no-') ? name.slice(3) : null]) {
    if (candidate === null) continue;
    const rule = ARG_RULES[ARG_ALIASES[candidate] ?? candidate];
    if (rule !== undefined) return rule;
  }
  return undefined;
}

/**
 * Why Wrangler's arguments (`args`, the wrapper's own --instance and --validate removed) may not run with an
 * instance configuration: options that would bypass it (--config, --cwd, --env, --env-file and --name for every
 * command; for deploy and versions upload also --var, --routes, --domains, --keep-vars, the compatibility date
 * and flags, --latest, --no-bundle, options of the app's build, and a script path); wrangler dev and preview,
 * which npm run dev:cf replaces; wrangler triggers deploy, which would apply routes and workers.dev outside a
 * checked deploy; and wrangler types, which would write the instance's values into worker-configuration.d.ts.
 * Each message says where the setting goes instead; none repeats a value.
 */
export function wranglerArgsProblems(args) {
  const { options, words } = readArgs(args);
  const [command, sub] = words;
  if (command === 'dev') {
    return [
      'wrangler dev does not run with an instance configuration: npm run dev:cf runs it with wrangler.jsonc and ' +
        '.dev.vars',
    ];
  }
  if (command === 'preview') {
    return [
      'wrangler preview does not run: Lyren Plan has no previews ("preview_urls": false); npm run dev:cf runs the ' +
        'Worker on this computer',
    ];
  }
  if (command === 'triggers' && sub === 'deploy') {
    return ['wrangler triggers deploy is not passed on: npm run deploy:cf applies routes and workers.dev'];
  }
  if (command === 'types') {
    return [
      "wrangler types is not passed on: npx wrangler types reads wrangler.jsonc, which is all the code's types need",
    ];
  }
  const deploys = command === 'deploy' || (command === 'versions' && sub === 'upload');
  const problems = [];
  for (const { flag, name, values } of options) {
    const rule = argRule(name);
    if (rule === undefined || !(rule.everywhere || deploys)) continue;
    if (rule.path) problems.push(SCRIPT_PATH);
    else if (rule.variable) {
      // --var NAME:value: the name is printed, never the value.
      for (const value of values.length > 0 ? values : ['']) {
        const variable = value.includes(':') ? value.slice(0, value.indexOf(':')) : '';
        const shown = /^[A-Z][A-Z0-9_]{0,63}$/.test(variable) ? variable : 'the variable';
        problems.push(`${flag} is not passed on: put ${shown} in "vars" of your instance configuration`);
      }
    } else problems.push(`${flag} is not passed on: ${rule.why}`);
  }
  if (deploys && words.length > (command === 'deploy' ? 1 : 2)) problems.push(SCRIPT_PATH);
  return [...new Set(problems)];
}

// ---------------------------------------------------------------------------
// The secrets file
// ---------------------------------------------------------------------------

/**
 * The secrets file of a deploy (--secrets-file, as scripts/ci/write-secrets-file.sh writes it; `value` is its
 * parsed JSON): a JSON object of SECRET_NAMES with values that are not blank, never RECOVERY_TOKEN, and no name
 * that is also a variable (`vars`, the instance configuration's "vars"). Returns the names it lists, in its order,
 * and its problems, each to follow the file's name ("<file> lists …"). A name is printed only when it is shaped
 * like a secret's name: a key and value swapped would print the value. A file that lists none is not passed on:
 * the Worker keeps its secrets.
 */
export function checkSecretsFile(value, { vars = {} } = {}) {
  if (!isObject(value)) return { problems: ['does not hold a JSON object'], names: [] };
  const problems = [];
  const names = [];
  for (const [name, secret] of Object.entries(value)) {
    if (name === 'RECOVERY_TOKEN') {
      problems.push(
        'lists RECOVERY_TOKEN, which no deploy sets: set it by hand only while you need it (docs/cloudflare.md, ' +
          '"Locked out")',
      );
    } else if (!SECRET_NAMES.includes(name)) {
      problems.push(
        secretName(name)
          ? `lists ${name}, which is not one of ${listed(SECRET_NAMES)}${didYouMean(name, SECRET_NAMES)}`
          : `lists a name that is not one of ${listed(SECRET_NAMES)}`,
      );
    } else if (typeof secret !== 'string' || secret.trim() === '') problems.push(`has no value for ${name}`);
    else if (isObject(vars) && Object.hasOwn(vars, name)) {
      const why = 'a name is a variable or a secret, never both';
      problems.push(`lists ${name}, which "vars" of the instance configuration has too: ${why}`);
    } else names.push(name);
  }
  return { problems, names };
}
