// Runs Wrangler for this deployment's instance configuration (docs/cloudflare.md, "Your instance configuration";
// design Appendix D 70): npm run check:cf, deploy:cf, deploy (the deploy command the Deploy button and Workers
// Builds fill in) and cf, and both jobs of .github/workflows/deploy-cloudflare.yml. It finds the instance
// configuration (--instance, else LYREN_INSTANCE_FILE, else wrangler.instance.jsonc in the checkout), checks it
// together with wrangler.jsonc and the app's own parser (scripts/lib/instance.mjs, scripts/lib/app-config.mjs),
// lays it over the current wrangler.jsonc as wrangler.deploy.<id>.jsonc, a file of this run's own, and runs the
// pinned Wrangler from the checkout's root with --config=<that file> (scripts/lib/wrangler-run.mjs). The file is
// removed when Wrangler ends. Its header names the run (pid, place, kind): a file that a stopped run of this place
// left is removed by the next run, and a run that builds (deploy, versions upload, dry runs included) is refused
// while another one's file is there, since each build empties dist/web. Its build command carries this run's
// token, without which scripts/cf/build-web.mjs refuses a deploy, so a plain `npx wrangler deploy` cannot leave
// the instance configuration out. wrangler.jsonc and the instance configuration are never written.
//
//   node scripts/cf/wrangler.mjs [--instance=<file>] <Wrangler command> [arguments…]
//   node scripts/cf/wrangler.mjs [--instance=<file>] --validate     checks only, runs no Wrangler (the check job)
//
// Environment:
//   LYREN_INSTANCE_FILE   the instance configuration, when it is not wrangler.instance.jsonc in the checkout; a
//                         relative path, like --instance's, starts where npm ran (INIT_CWD), else here
//   LYREN_PREBUILT        1: dist/web is built already (the workflow's deploy job), and must be there
//
// deploy and versions upload, dry runs included, and --validate stop at any problem. Other commands (secret,
// tail, rollback, versions list, deployments, …) need only a file that parses and names its Worker, and whose
// account_id, if any, is valid; they warn about the rest, and take nothing from it but the Worker's name and
// account, so they still work during an incident. Without an instance configuration, a dry run checks
// wrangler.jsonc as it is, a deploy in Workers Builds (WORKERS_CI=1: the Deploy button's first build) deploys it
// as it is, and anything else, --validate included, is refused. --secrets-file (a deploy's; never read for a dry
// run) holds only SETUP_TOKEN, SMTP_USER, SMTP_PASS, MAIL_REPLY_TO and RESEND_API_KEY. Refused as bad usage: the
// wrapper's options that npm took for itself (no `--` before them; the message names the script that was run), a
// `--`, and CLOUDFLARE_ENV; Wrangler gets it empty, and --env= so that a .env in the checkout cannot name an
// environment either. A file is read as UTF-8 (one byte-order mark dropped), and a key given twice in an object
// is refused. The wrapper's own lines go to stderr, so stdout is Wrangler's alone; they name settings, never a
// value, the Worker's name, a host, the account ID or the run token. Exit status: Wrangler's; 1 when refused, 2
// for bad usage. Tested in scripts/test/cf-wrangler.test.mjs.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkAppConfig, loadAppConfigParser } from '../lib/app-config.mjs';
import {
  DEPLOY_CONFIG_PATTERN,
  deployConfigName,
  EMAIL_BINDING,
  LEGACY_DEPLOY_CONFIG,
  stripJsonc,
} from '../lib/cloudflare.mjs';
import {
  accountProblem,
  checkBase,
  checkInstance,
  checkSecretsFile,
  declaredSecrets,
  EXAMPLE_FILE,
  generateConfig,
  generatedConfigText,
  generatorOf,
  INSTANCE_FILE,
  instanceVars,
  nameProblem,
  readArgs,
  REQUIRABLE_SECRETS,
  resolveInstanceSource,
  varArgs,
  workerOnly,
  wranglerArgsProblems,
} from '../lib/instance.mjs';
import {
  checkWranglerPin,
  cleanTmp,
  newConfigId,
  newRunToken,
  runPlace,
  spawnWrangler,
} from '../lib/wrangler-run.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

const USAGE = [
  'Usage: node scripts/cf/wrangler.mjs [--instance=<file>] <Wrangler command> [arguments…]',
  '       node scripts/cf/wrangler.mjs [--instance=<file>] --validate',
].join('\n');

const NONE = `No instance configuration (--instance, LYREN_INSTANCE_FILE or ${INSTANCE_FILE})`;

/** Said when Wrangler's "update the local config file" wrote into `file`, this run's generated configuration. */
const writeBack = (file) =>
  `Wrangler wrote the dashboard's values into ${file}, which is now removed; wrangler.jsonc and your instance ` +
  'configuration are unchanged: move what you want to keep into your instance configuration.';

/**
 * The wrapper's options that npm keeps for itself when no `--` comes before them (npm run deploy:cf --instance=x):
 * npm hands them on only as npm_config_<name>, and the wrapper would run without them. Each with its flag.
 */
const NPM_TAKES = [
  ['instance', '--instance'],
  ['secrets_file', '--secrets-file'],
  ['validate', '--validate'],
];

/** package.json's scripts that run the wrapper with a command of their own, which the example repeats. */
const NPM_SCRIPTS = ['check:cf', 'deploy:cf', 'deploy'];

/**
 * The command to give instead when npm took `flag`: the script that was run (`event`, npm_lifecycle_event) with
 * the option after its `--`, so that the example never turns a check or a secret command into a deploy.
 */
function npmExample(flag, event) {
  if (flag === '--validate') return 'npm run cf -- --validate';
  const option = `${flag}=<file>`;
  if (NPM_SCRIPTS.includes(event)) return `npm run ${event} -- ${option}`;
  // --instance is the wrapper's, before the command; --secrets-file is the deploy's, after it.
  if (event === 'cf') {
    return flag === '--instance' ? `npm run cf -- ${option} <command>` : `npm run cf -- deploy ${option}`;
  }
  return `npm run <script> -- ${option}`;
}

/** Bad usage: printed with the usage lines, exit status 2. */
class Usage extends Error {}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const blank = (value) => (value ?? '').trim() === '';
// Every line of the wrapper's own goes to stderr: stdout is Wrangler's (secret list prints JSON there).
const say = (line) => console.error(line);
const error = (message) => console.error(`::error::${message}`);
const warning = (message) => console.error(`::warning::${message}`);

/** Where a relative path given to the wrapper starts: where npm ran (npm run moves to the package's root). */
const startDir = (env) => (blank(env.INIT_CWD) ? process.cwd() : env.INIT_CWD);

/**
 * Wrangler's environment: the wrapper's, with CLOUDFLARE_ENV empty, and with `extra`. An environment of
 * Wrangler's (<name>-<env>, a Worker of its own) is no instance's: see TOP_LEVEL.
 */
const wranglerEnv = (env, extra = {}) => ({ ...env, CLOUDFLARE_ENV: '', ...extra });

/**
 * The argument that keeps Wrangler in the configuration's top level, as Wrangler itself suggests (--env=""): it
 * loads the checkout's .env and .env.local into its environment, and an empty CLOUDFLARE_ENV does not stand
 * against one set there (dotenv-expand keeps a file's value over an empty one, wrangler-dist/cli.js).
 */
const TOP_LEVEL = '--env=';

// ---------------------------------------------------------------------------
// The arguments
// ---------------------------------------------------------------------------

/** The wrapper's own options (--instance, --validate), taken out, and Wrangler's arguments. */
function readOwnArgs(argv) {
  let flag;
  let validate = false;
  const args = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // Wrangler would take what follows for words, --config and every --var of the wrapper's among them.
    if (arg === '--') throw new Usage("-- is not passed on: give Wrangler's options without it");
    if (arg === '--validate') {
      if (validate) throw new Usage('--validate is given twice');
      validate = true;
    } else if (arg === '--instance' || arg.startsWith('--instance=')) {
      if (flag !== undefined) throw new Usage('--instance is given twice');
      if (arg !== '--instance') flag = arg.slice('--instance='.length);
      else flag = i + 1 < argv.length && !argv[i + 1].startsWith('-') ? argv[++i] : '';
      if (flag.trim() === '') throw new Usage('--instance names no file: --instance=<path>');
    } else args.push(arg);
  }
  return { flag, validate, args };
}

// Wrangler's commands with subcommands, whose second word the output names (never a third: a name or an ID).
const GROUPS = ['versions', 'deployments', 'secret', 'triggers'];

/**
 * The Wrangler command of `args`: its words, read as Wrangler reads them (scripts/lib/instance.mjs#readArgs, so
 * `versions --message hi upload` is versions upload), what the output calls it, whether it deploys (deploy,
 * versions upload: everything is checked) and whether it is a dry run. The command comes first. Only a plain
 * --dry-run counts as one: any other spelling is refused, so that the wrapper never takes a deploy for a dry run.
 */
function readCommand(args) {
  const { words } = readArgs(args);
  if (words.length > 0 && args[0].startsWith('-')) {
    throw new Usage('the Wrangler command comes first, before its options');
  }
  const deploys = words[0] === 'deploy' || (words[0] === 'versions' && words[1] === 'upload');
  const shown = ['wrangler', ...words.slice(0, GROUPS.includes(words[0]) && /^[a-z][a-z-]*$/.test(words[1]) ? 2 : 1)];
  let dryRun = false;
  if (deploys) {
    args.forEach((arg, i) => {
      if (arg === '--dry-run' && args[i + 1] !== 'true' && args[i + 1] !== 'false') dryRun = true;
      else if (/^--(?:no-)?dry-?run/i.test(arg)) {
        throw new Usage(`${arg.split('=')[0]}: write --dry-run alone, or leave it out`);
      }
    });
  }
  return { words, deploys, dryRun, shown: shown.join(' ') };
}

/** Where --secrets-file is in a deploy's `args` ({ at, count: its words, given: the path as given }), or null. */
function secretsFileArg(args) {
  let found = null;
  args.forEach((arg, i) => {
    if (arg === '--secrets-file' || arg.startsWith('--secrets-file=')) {
      if (found !== null) throw new Usage('--secrets-file is given twice');
      const two = arg === '--secrets-file';
      const given = two ? args[i + 1] : arg.slice('--secrets-file='.length);
      if (given === undefined || given.trim() === '' || (two && given.startsWith('-'))) {
        throw new Usage('--secrets-file names no file: --secrets-file=<file>');
      }
      found = { at: i, count: two ? 2 : 1, given };
    } else if (/^--(?:no-)?secrets-?file/i.test(arg)) {
      throw new Usage(`${arg.split('=')[0]}: write --secrets-file=<file>`);
    }
  });
  return found;
}

// ---------------------------------------------------------------------------
// Reading the files
// ---------------------------------------------------------------------------

/** The line and column of the offset `index` in `text`. */
function lineColumn(text, index) {
  const lines = text.slice(0, index).split('\n');
  return `${lines.length}:${lines[lines.length - 1].length + 1}`;
}

/**
 * A file's text (`bytes`) as UTF-8 ({ text }), one leading byte-order mark dropped as Wrangler drops it, or why
 * it is not read ({ problem }): a byte-order mark of UTF-16 or UTF-32, an encoding Wrangler refuses as well.
 */
function decode(bytes, display) {
  const starts = (...marks) => marks.some((mark) => mark.every((byte, i) => bytes[i] === byte));
  // UTF-32's little-endian mark begins as UTF-16's does.
  const wide = starts([0xff, 0xfe, 0, 0], [0, 0, 0xfe, 0xff])
    ? 'UTF-32'
    : starts([0xff, 0xfe], [0xfe, 0xff])
      ? 'UTF-16'
      : null;
  if (wide !== null) return { problem: `${display} is saved as ${wide}: save it as UTF-8` };
  const text = bytes.toString('utf8');
  return { text: text.startsWith('\uFEFF') ? text.slice(1) : text };
}

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/**
 * Walks the JSON `text` as JSON.parse reads it, and returns the offset after its value. Calls `repeated(at,
 * keys)` for each member whose name its object has given before: `at` is that member's offset, `keys` the path to
 * it (names, and indexes in arrays). Throws the offset at which `text` goes wrong (its length when it ends too
 * early).
 */
function walkJson(text, repeated = () => {}) {
  let i = 0;
  const keys = [];
  const space = () => {
    while (i < text.length && ' \t\n\r'.includes(text[i])) i++;
  };
  const string = () => {
    for (i++; i < text.length && text[i] !== '"'; i++) {
      if (text.charCodeAt(i) < 0x20) throw i;
      if (text[i] !== '\\') continue;
      if (text[i + 1] === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) i += 5;
      else if (text[i + 1] !== undefined && '"\\/bfnrt'.includes(text[i + 1])) i++;
      else throw i;
    }
    if (i >= text.length) throw i;
    i++;
  };
  const members = (close, object) => {
    i++;
    space();
    if (text[i] === close) {
      i++;
      return;
    }
    const names = new Set();
    for (let index = 0; ; index++) {
      space();
      if (object) {
        if (text[i] !== '"') throw i;
        const start = i;
        string();
        // The name as JSON.parse reads it: "A" and "A" are one name.
        const name = JSON.parse(text.slice(start, i));
        if (names.has(name)) repeated(start, [...keys, name]);
        names.add(name);
        keys.push(name);
        space();
        if (text[i] !== ':') throw i;
        i++;
      } else keys.push(index);
      value();
      keys.pop();
      space();
      if (text[i] === ',') i++;
      else if (text[i] === close) {
        i++;
        return;
      } else throw i;
    }
  };
  const value = () => {
    space();
    if (text[i] === '{') return members('}', true);
    if (text[i] === '[') return members(']', false);
    if (text[i] === '"') return string();
    for (const word of ['true', 'false', 'null']) {
      if (text.startsWith(word, i)) {
        i += word.length;
        return undefined;
      }
    }
    NUMBER.lastIndex = i;
    const number = NUMBER.exec(text);
    if (number === null) throw i;
    i += number[0].length;
    return undefined;
  };
  value();
  space();
  return i;
}

/**
 * The offset at which the JSON `text` goes wrong (its length when it ends too early), for the errors whose
 * message gives none: those quote the text around the error, which may be a value, so they are never printed.
 */
function jsonErrorAt(text) {
  try {
    return walkJson(text);
  } catch (at) {
    return at;
  }
}

/** A name that may be printed in a path of keys: shaped like a key, never like a value. */
const KEY = /^[A-Za-z_$][A-Za-z0-9_$-]{0,63}$/;

/**
 * Why a member that repeats a name of its object (`keys`, the path to it) is refused: JSON.parse, and Wrangler,
 * keep the last one without a word, so a setting pasted above the file's own would be dropped.
 */
function givenTwice(keys) {
  if (keys.some((key) => typeof key === 'string' && !KEY.test(key))) return 'a key is given twice';
  const at = keys.map((key, i) => (typeof key === 'number' ? `[${key}]` : i === 0 ? key : `.${key}`)).join('');
  return `"${at}" is given twice`;
}

/**
 * A .jsonc file's value ({ text, value, problems: [] }), or what is wrong with it ({ problems }): each one
 * `<file>:<line>:<column>: why`, never a piece of its text. A key its object gives twice is one (each repeat).
 */
function readJsonc(file, display) {
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch (err) {
    return { problems: [`${display} could not be read (${err.code ?? 'error'})`] };
  }
  const { text, problem } = decode(bytes, display);
  if (problem !== undefined) return { problems: [problem] };
  let json;
  try {
    json = stripJsonc(text);
  } catch (err) {
    // "Unterminated string (line 3 column 8)": the file's own position.
    const m = /^(.*) \(line (\d+) column (\d+)\)$/.exec(err.message);
    return { problems: [m === null ? `${display}: ${err.message}` : `${display}:${m[2]}:${m[3]}: ${m[1]}`] };
  }
  let value;
  try {
    value = JSON.parse(json);
  } catch (err) {
    // V8 names a position, or quotes the text around the error instead (which is not printed).
    const m = /^(.*) in JSON at position (\d+)/.exec(err.message);
    const at = m === null ? jsonErrorAt(json) : Number(m[2]);
    let why = m !== null && !m[1].includes('"') ? m[1] : 'not valid JSON';
    if (at >= json.trimEnd().length) why = 'the file ends before its JSON does';
    return { problems: [`${display}:${lineColumn(json, at)}: ${why}`] };
  }
  const repeats = [];
  try {
    walkJson(json, (at, keys) => repeats.push(`${display}:${lineColumn(json, at)}: ${givenTwice(keys)}`));
  } catch {
    // JSON.parse read it, so the walk does too.
  }
  return repeats.length > 0 ? { problems: repeats } : { text, value, problems: [] };
}

/** Files that Wrangler or an older Lyren Plan reads, which a run does not: worth a word, never fatal. */
function leftoverNotes() {
  const notes = [];
  if (fs.existsSync(path.join(ROOT, 'wrangler.local.jsonc'))) {
    notes.push('wrangler.local.jsonc is no longer read: move its settings into your instance configuration');
  }
  if (fs.existsSync(path.join(ROOT, LEGACY_DEPLOY_CONFIG))) {
    notes.push(`${LEGACY_DEPLOY_CONFIG} is left from an earlier version and no longer read: remove it`);
  }
  if (fs.existsSync(path.join(ROOT, '.wrangler', 'deploy', 'config.json'))) {
    notes.push('.wrangler/deploy/config.json: Wrangler follows it for wrangler dev and deploy: remove it');
  }
  return notes;
}

/**
 * A deploy's secrets file (--secrets-file, `given` as on the command line): its absolute path and the names it
 * lists, or its problems (scripts/lib/instance.mjs#checkSecretsFile), none of which repeats a value. `vars` are
 * the instance configuration's: a name is a variable or a secret, never both.
 */
function readSecretsFile(given, vars, env) {
  const file = path.resolve(startDir(env), given);
  const refused = (why) => ({ file, names: [], problems: [why] });
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch (err) {
    if (err.code === 'ENOENT') return refused(`--secrets-file names ${given}, which does not exist`);
    return refused(`${given} could not be read (${err.code ?? 'error'})`);
  }
  const { text, problem } = decode(bytes, given);
  if (problem !== undefined) return refused(problem);
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    // A JSON error's message quotes the file's text: never printed.
    return refused(`${given} is not a JSON object such as {"SMTP_PASS": "…"} (NAME=value lines are not read here)`);
  }
  const { problems, names } = checkSecretsFile(value, { vars });
  return { file, names, problems: problems.map((why) => `${given} ${why}`) };
}

/**
 * Wrangler's arguments with the secrets file as Wrangler gets it: an absolute path, or left out for a dry run
 * and for a file that lists no secret (the Worker keeps the ones it has).
 */
function withSecretsFile(args, arg, secrets) {
  if (arg === null) return args;
  const keep = secrets !== null && secrets.names.length > 0 ? [`--secrets-file=${secrets.file}`] : [];
  return [...args.slice(0, arg.at), ...keep, ...args.slice(arg.at + arg.count)];
}

/** The line about the secrets file, or null when there is none. */
function secretsLine(arg, secrets, dryRun) {
  if (arg === null) return null;
  if (dryRun) return 'Secrets file: not read for a dry run';
  if (secrets.names.length === 0) return 'Secrets file: lists none, so it is not passed on; the Worker keeps its own';
  return `Secrets file (${secrets.names.length}): ${secrets.names.join(' ')}, uploaded with the new version`;
}

// ---------------------------------------------------------------------------
// The generated configuration
// ---------------------------------------------------------------------------

/** Whether the process `pid` is running (it may belong to someone else): only ESRCH says it is not. */
function running(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== 'ESRCH';
  }
}

/**
 * Looks at the generated configurations of other runs at the root, before this run writes its own (`where`, this
 * run's place: wrangler-run.mjs#runPlace), and returns why this run may not go on (an empty list when it may):
 *
 * - one that a stopped run left (a closed terminal, a killed process) is removed, saying so: its header names this
 *   place and a pid that is no longer running;
 * - a run that builds (`building`: deploy and versions upload, dry runs included) is refused next to another
 *   building run's: its build empties dist/web, which the other one's Wrangler may be uploading. The message says
 *   how to go on either way, since a pid can be reused and one of another place cannot be judged at all. Two runs
 *   started at the same moment can both get past this check: it keeps a habit from breaking a deploy, and is no
 *   lock.
 *
 * Anything else is left as it is, without a word: a run that is going on, a file of another place (a container,
 * another WSL distribution: its pid means nothing here), one whose header does not say. A run that builds nothing
 * (tail, secret, …) never waits.
 */
function otherRuns(where, building) {
  const refusals = [];
  for (const name of fs.readdirSync(ROOT).filter((entry) => DEPLOY_CONFIG_PATTERN.test(entry)).sort()) {
    const file = path.join(ROOT, name);
    let run;
    try {
      run = generatorOf(fs.readFileSync(file, 'utf8'));
    } catch {
      continue; // gone meanwhile
    }
    if (run === null) continue;
    // A file naming this very process is not another run's: its pid was reused.
    const here = run.pid !== null && run.where === where;
    if (here && (run.pid === process.pid || !running(run.pid))) {
      try {
        fs.rmSync(file);
        say(`Removed ${name}, left by a run that was stopped.`);
      } catch {
        // Another run removed it first.
      }
    } else if (building && run.kind === 'build') {
      refusals.push(
        `another deploy or check may be running in this checkout (${name}): wait for it to end, or remove the file ` +
          'if none is',
      );
    }
  }
  return refusals;
}

/** Writes `text` as a new wrangler.deploy.<id>.jsonc at the root, never over another one, and returns its name. */
function writeGenerated(text) {
  for (let attempt = 1; ; attempt++) {
    const name = deployConfigName(newConfigId());
    try {
      fs.writeFileSync(path.join(ROOT, name), text, { flag: 'wx' });
      return name;
    } catch (err) {
      if (err.code !== 'EEXIST' || attempt === 5) throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// What a deploy does, in words
// ---------------------------------------------------------------------------

/** One line per decision the generated configuration (`config`) makes: names of settings, never values. */
function decisions(instance, config, vars) {
  const lines = ['Worker name: from the instance configuration'];
  if (instance.account_id !== undefined) lines.push('Account: from the instance configuration');
  const workersDevWhy =
    typeof instance.workers_dev === 'boolean'
      ? 'the instance configuration'
      : instance.routes !== undefined
        ? '"routes" is listed'
        : 'wrangler.jsonc';
  lines.push(`workers.dev: ${config.workers_dev === false ? 'off' : 'on'} (${workersDevWhy})`);
  lines.push(
    Array.isArray(instance.routes)
      ? `Custom domains (${instance.routes.length}): those of "routes", which replace the Worker's custom domains`
      : 'Custom domains: none listed; those added in the dashboard stay as they are',
  );
  if (instance.send_email !== undefined) {
    lines.push(`Mail binding: ${EMAIL_BINDING} ("send_email" of the instance configuration)`);
  } else if (config.send_email !== undefined) lines.push(`Mail binding: ${EMAIL_BINDING} (MAIL_TRANSPORT=cloudflare)`);
  else if (vars.MAIL_TRANSPORT === undefined) lines.push('Mail binding: none (no MAIL_TRANSPORT in the file)');
  else lines.push('Mail binding: none (MAIL_TRANSPORT is not cloudflare)');
  const names = Object.keys(vars);
  const keep = config.keep_vars !== false;
  if (names.length > 0) lines.push(`Variables (${names.length}): ${names.join(' ')}`);
  else lines.push(`Variables (0): none listed; ${keep ? 'the Worker keeps the ones it has' : 'the Worker keeps none'}`);
  if (!keep && names.length > 0) lines.push('Variables not listed: removed by this deploy ("keep_vars": false)');
  const secrets = config.secrets?.required ?? [];
  lines.push(`Secrets the Worker must have: ${secrets.length > 0 ? secrets.join(' ') : 'none'}`);
  const others = ['limits', 'observability', 'placement', 'logpush', 'tail_consumers'].filter((k) => k in instance);
  if (others.length > 0) lines.push(`Also from the instance configuration: ${others.join(', ')}`);
  return lines;
}

// ---------------------------------------------------------------------------
// A run
// ---------------------------------------------------------------------------

/** Runs Wrangler with wrangler.jsonc as it is (no instance configuration), and cleans .wrangler up after it. */
async function runBase(args, env) {
  try {
    return await spawnWrangler([...args, TOP_LEVEL], { root: ROOT, env: wranglerEnv(env) });
  } finally {
    cleanTmp(ROOT);
  }
}

/** A run without an instance configuration: wrangler.jsonc as it is, for a check or the Deploy button's build. */
async function withoutInstance({ validate, command, args, secretsArg, env }) {
  const notes = () => leftoverNotes().forEach((note) => say(`Note: ${note}`));
  if (validate) {
    // The workflow's check job, before anybody approves its deploy job: the deploy would be refused too.
    error(
      `No instance configuration to check (--instance, LYREN_INSTANCE_FILE or ${INSTANCE_FILE}): cp ${EXAMPLE_FILE} ` +
        `${INSTANCE_FILE} and edit it (docs/cloudflare.md, "Your instance configuration")`,
    );
    return 1;
  }
  if (command.deploys && command.dryRun) {
    say(`${NONE}: checking wrangler.jsonc as it is.`);
    notes();
    const line = secretsLine(secretsArg, null, true);
    if (line !== null) say(line);
    say(`Dry run: ${command.shown} --dry-run with wrangler.jsonc; nothing is uploaded.`);
    return runBase(withSecretsFile(args, secretsArg, null), env);
  }
  if (command.deploys && env.WORKERS_CI === '1') {
    say(`${NONE}: deploying wrangler.jsonc as it is (Workers Builds, WORKERS_CI=1).`);
    notes();
    const secrets = secretsArg === null ? null : readSecretsFile(secretsArg.given, {}, env);
    if (secrets !== null && secrets.problems.length > 0) {
      secrets.problems.forEach(error);
      say(`Nothing was deployed (${plural(secrets.problems.length, 'problem')}).`);
      return 1;
    }
    const line = secretsLine(secretsArg, secrets, false);
    if (line !== null) say(line);
    say(`Deploying: ${command.shown} with wrangler.jsonc.`);
    return runBase(withSecretsFile(args, secretsArg, secrets), env);
  }
  if (command.deploys) {
    error(
      `No instance configuration: cp ${EXAMPLE_FILE} ${INSTANCE_FILE} and edit it, or point LYREN_INSTANCE_FILE at ` +
        'yours (docs/cloudflare.md, "Your instance configuration"). Nothing was deployed.',
    );
    return 1;
  }
  error(`${NONE}: npm run cf runs Wrangler for your instance; for Wrangler itself use npx wrangler <command>`);
  return 1;
}

async function main(argv, env) {
  // 1. What npm or the environment took from the wrapper, its own arguments, and Wrangler's that would bypass the
  // instance configuration. npm's slips come first, --dry-run's as soon as the command is known: whatever else is
  // wrong, the run is not the one asked for.
  for (const [name, flag] of NPM_TAKES) {
    if (!blank(env[`npm_config_${name}`])) {
      throw new Usage(`npm took ${flag} for itself: put -- before it (${npmExample(flag, env.npm_lifecycle_event)})`);
    }
  }
  if (!blank(env.CLOUDFLARE_ENV)) {
    throw new Usage('CLOUDFLARE_ENV is not passed on: one instance configuration is one Worker; unset it');
  }
  const { flag, validate, args } = readOwnArgs(argv);
  if (validate && args.length > 0) throw new Usage('--validate runs no Wrangler command: give it alone');
  if (!validate && args.length === 0) throw new Usage('no Wrangler command');
  const command = validate ? null : readCommand(args);
  const deploys = command?.deploys ?? false;
  const dryRun = command?.dryRun ?? false;
  if (deploys && !dryRun && env.npm_config_dry_run === 'true') {
    throw new Usage(
      'npm took --dry-run for itself: npm run check:cf, or npm run cf -- deploy --dry-run. Nothing was deployed.',
    );
  }
  const refused = validate ? [] : wranglerArgsProblems(args);
  if (refused.length > 0) {
    refused.forEach(error);
    return 2;
  }
  const secretsArg = deploys ? secretsFileArg(args) : null;

  // 2. The pinned Wrangler, and the web client LYREN_PREBUILT promises.
  const pin = checkWranglerPin(ROOT);
  if (pin !== null) {
    error(pin);
    return 1;
  }
  if (deploys && env.LYREN_PREBUILT === '1' && !fs.existsSync(path.join(ROOT, 'dist', 'web', 'index.html'))) {
    error('LYREN_PREBUILT=1, but there is no dist/web/index.html: build the web client first (npm run build:web)');
    return 1;
  }

  // 3. The instance configuration.
  let source;
  try {
    source = resolveInstanceSource({ flag, env, root: ROOT, exists: fs.existsSync, cwd: process.cwd() });
  } catch (err) {
    error(err.message);
    return 1;
  }
  if (source === null) return withoutInstance({ validate, command, args, secretsArg, env });
  say(`Instance configuration: ${source.display} (from ${source.from})`);
  const strict = validate || deploys;
  const done = (n) =>
    validate
      ? `Checked: ${plural(n, 'problem')}.`
      : deploys
        ? `Nothing was deployed (${plural(n, 'problem')}).`
        : `Wrangler did not run (${plural(n, 'problem')}).`;

  // 4. Parse, then wrangler.jsonc, the file's keys and the rules between them, the secrets file of a deploy (a
  // dry run never reads one), and the app's own verdict, which counts the secrets file's names. For a deploy every
  // problem stops it; other commands stop only without a file, or when its "name" or "account_id", which pick the
  // Worker they act on, fails its check.
  const base = readJsonc(path.join(ROOT, 'wrangler.jsonc'), 'wrangler.jsonc');
  const file = readJsonc(source.path, source.display);
  const own = (message) => `${source.display}: ${message}`;
  const unusable = [...base.problems, ...file.problems];
  if (unusable.length === 0 && !isObject(base.value)) unusable.push('wrangler.jsonc does not hold an object');
  if (unusable.length === 0 && !isObject(file.value)) {
    unusable.push(own('the file does not hold an object: { "name": "…", … }'));
  }
  if (unusable.length > 0) {
    unusable.forEach(error);
    say(done(unusable.length));
    return 1;
  }
  const instance = file.value;
  const errors = [];
  const warnings = [];
  const notes = leftoverNotes();
  const checked = checkInstance(instance, { env });
  if (strict) errors.push(...checkBase(base.value), ...checked.errors.map(own));
  else {
    // Left out, the file's account would give way to CLOUDFLARE_ACCOUNT_ID's: the command would act on a Worker of
    // that name in another account.
    const account = instance.account_id === undefined ? null : accountProblem(instance.account_id, { env });
    const worker = [nameProblem(instance.name, { env }), account].filter((problem) => problem !== null);
    if (worker.length > 0) {
      worker.forEach((problem) => error(own(problem)));
      say(done(worker.length));
      return 1;
    }
    warnings.push(...checkBase(base.value), ...checked.errors.map(own));
  }
  warnings.push(...checked.warnings.map(own));
  notes.push(...checked.notes);

  const secrets =
    secretsArg === null || dryRun
      ? null
      : readSecretsFile(secretsArg.given, isObject(instance.vars) ? instance.vars : {}, env);
  if (secrets !== null) errors.push(...secrets.problems);
  // Names only: a secret the file uploads stands in with a placeholder, as one the Worker must have does.
  const uploaded = (secrets?.names ?? []).filter((name) => REQUIRABLE_SECRETS.includes(name));
  const declared = [...new Set([...declaredSecrets(instance), ...uploaded])];

  const vars = instanceVars(instance);
  let required = [];
  let appValid = false;
  try {
    const parser = await loadAppConfigParser({ root: ROOT });
    const app = checkAppConfig(vars, { declaredSecrets: declared, parser });
    for (const { variable, message } of app.errors) {
      (strict ? errors : warnings).push(own(message.includes(variable) ? message : `${variable}: ${message}`));
    }
    required = app.required;
    notes.push(...app.notes);
    appValid = app.errors.length === 0;
  } catch (err) {
    (strict ? errors : warnings).push(err.message);
  }

  if (errors.length > 0) {
    errors.forEach(error);
    warnings.forEach(warning);
    say(done(errors.length));
    return 1;
  }
  warnings.forEach(warning);

  // 5. The configuration of this run: the instance configuration's for a deploy; for any other command the
  // Worker's name (and account) alone, so that nothing else in the file can stop it.
  const runToken = newRunToken();
  let config;
  if (strict) {
    config = generateConfig(base.value, instance, { required, runToken });
    for (const line of decisions(instance, config, vars)) say(line);
    if (appValid) say("App configuration: the file's variables are valid on Cloudflare (server/src/core/config.ts)");
    for (const note of notes) say(`Note: ${note}`);
  } else {
    const worker = workerOnly(instance);
    config = generateConfig(base.value, worker, { runToken });
    say('Worker name: from the instance configuration');
    if (worker.account_id !== undefined) say('Account: from the instance configuration');
  }
  if (validate) {
    say('Checked: no problems.');
    return 0;
  }

  // 6. wrangler.deploy.<id>.jsonc, this run's own, after those that stopped runs left are gone, and for a run that
  // builds, while no other one does.
  const where = runPlace();
  const busy = otherRuns(where, deploys);
  if (busy.length > 0) {
    busy.forEach(error);
    return 1;
  }
  const kind = deploys ? 'build' : 'other';
  const text = generatedConfigText(config, { source: source.display, pid: process.pid, where, kind });
  const generated = writeGenerated(text);

  // 7. Wrangler, with the variables as --var too for a deploy (its bindings table then prints "(hidden)").
  const runArgs = [...withSecretsFile(args, secretsArg, secrets), `--config=${generated}`, TOP_LEVEL];
  if (deploys) runArgs.push(...varArgs(vars));
  const line = secretsLine(secretsArg, secrets, dryRun);
  if (line !== null) say(line);
  const counted = plural(Object.keys(vars).length, 'variable');
  if (dryRun) {
    say(`Dry run: ${command.shown} --dry-run with ${generated}, ${counted}; nothing is uploaded.`);
  } else if (deploys) {
    const listed = secrets === null ? 0 : secrets.names.length;
    const secretsPart = listed > 0 ? `a secrets file of ${plural(listed, 'secret')}` : 'no secrets file';
    const verb = command.words[0] === 'deploy' ? 'Deploying' : 'Uploading a version';
    say(`${verb}: ${command.shown} with ${generated}, ${counted}, ${secretsPart}.`);
  } else say(`Running: ${command.shown} with ${generated}.`);
  try {
    return await spawnWrangler(runArgs, { root: ROOT, env: wranglerEnv(env, { LYREN_WRANGLER_RUN: runToken }) });
  } finally {
    // 8. Wrangler's "update the local config file" writes the dashboard's values into its --config: this file.
    const at = path.join(ROOT, generated);
    let after = null;
    try {
      after = fs.readFileSync(at, 'utf8');
    } catch {
      // Gone already: nothing to tell.
    }
    if (after !== null && after !== text) say(writeBack(generated));
    try {
      fs.rmSync(at, { force: true });
      say(`Removed ${generated}.`);
    } catch (err) {
      warning(`${generated} could not be removed (${err.code ?? 'error'}): remove it before the next run`);
    }
    cleanTmp(ROOT);
  }
}

try {
  process.exitCode = await main(process.argv.slice(2), process.env);
} catch (err) {
  error(err.message);
  if (err instanceof Usage) console.error(USAGE);
  process.exitCode = err instanceof Usage ? 2 : 1;
}
