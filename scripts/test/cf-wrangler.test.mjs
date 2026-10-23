// scripts/cf/wrangler.mjs, which runs Wrangler for an instance configuration (npm run check:cf, deploy:cf, deploy
// and cf; design Appendix D 70; docs/cloudflare.md, "Your instance configuration"). It runs in a copy of the
// checkout, from another folder, with a fake node_modules/wrangler whose bin records the arguments, the folder,
// the environment and the --config and --secrets-file it gets, can write into its --config as Wrangler's "update
// the local config file" does, can signal the wrapper as a terminal does, and can wait while another run goes on.
// The app's parser is bundled by Wrangler's real esbuild (linked into the fake) from a copy of its sources:
// scripts/lib/app-config.mjs refuses sources outside the checkout, which a link to server/ and shared/ would be.
// Nothing reaches Cloudflare, no test reads the checkout's own instance configuration, and a run gets nothing of
// the test runner's environment (release.yml runs these tests on GitHub Actions, under npm run check).

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { DEPLOY_CONFIG_PATTERN, LEGACY_DEPLOY_CONFIG, parseJsonc } from '../lib/cloudflare.mjs';
import { EXAMPLE_FILE, generateConfig, generatedConfigText, INSTANCE_FILE, instanceVars, varArgs } from '../lib/instance.mjs';
import { runPlace } from '../lib/wrangler-run.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const dirs = [];
afterAll(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lyren-cf-wrangler-'));
  dirs.push(d);
  return fs.realpathSync(d);
}

/** The project's wrangler.jsonc, which every run lays the instance configuration over. */
const BASE_TEXT = read('wrangler.jsonc');
const BASE = parseJsonc(BASE_TEXT);
const PINNED = JSON.parse(read('package.json')).devDependencies.wrangler;

/** Wrangler's own esbuild (its folder), which scripts/lib/app-config.mjs resolves from node_modules/wrangler. */
const wranglerRequire = createRequire(path.join(ROOT, 'node_modules', 'wrangler', 'package.json'));
const ESBUILD = path.dirname(wranglerRequire.resolve('esbuild/package.json'));

/** The app parser's sources, as that esbuild bundles them for scripts/lib/app-config.mjs. */
const PARSER_SOURCES = Object.keys(
  (
    await wranglerRequire('esbuild').build({
      absWorkingDir: ROOT,
      stdin: { contents: "export { parseAppConfig, ConfigError } from './server/src/core/config';", resolveDir: ROOT, loader: 'ts' },
      tsconfig: path.join(ROOT, 'tsconfig.worker.json'),
      bundle: true,
      platform: 'neutral',
      format: 'esm',
      packages: 'external',
      metafile: true,
      write: false,
      logLevel: 'silent',
    })
  ).metafile.inputs,
).filter((input) => input !== '<stdin>');

/** A value that a shell would turn into something else anywhere but in a variable or an argument. */
const ODD = `He said "hi" $(touch pwned) \`touch pwned2\` 'x' \\ $HOME ;|& *\nsecond line  `;

/**
 * Wrangler's bin as the wrapper runs it: records its run, leaves .wrangler/tmp behind, sends the wrapper
 * FAKE_SIGNALS, waits while FAKE_WAIT_FOR is not there, prints a line on stdout, and ends with FAKE_EXIT.
 */
const FAKE_WRANGLER = `const fs = require('node:fs');
const path = require('node:path');
const argv = process.argv.slice(2);
const option = (name) => argv.find((arg) => arg.startsWith(name + '='))?.slice(name.length + 1) ?? null;
const readIf = (file) => (file === null ? null : fs.readFileSync(path.resolve(file), 'utf8'));
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const config = option('--config');
fs.appendFileSync(process.env.FAKE_WRANGLER_LOG, JSON.stringify({
  argv,
  cwd: process.cwd(),
  ppid: process.ppid,
  env: process.env,
  config: readIf(config),
  secretsFile: readIf(option('--secrets-file')),
}) + '\\n');
// What Wrangler leaves next to its configuration: an empty .wrangler/tmp.
fs.mkdirSync('.wrangler/tmp', { recursive: true });
// Wrangler's "update the local config file": the dashboard's values, written into its --config.
if (process.env.FAKE_WRITE_BACK === '1' && config !== null) fs.appendFileSync(config, '// the dashboard\\'s values\\n');
// A terminal's Ctrl+C, a kill, a closed window: they reach the wrapper too, which must outlive Wrangler.
if (process.env.FAKE_SIGNALS) {
  for (const signal of process.env.FAKE_SIGNALS.split(',')) process.kill(process.ppid, signal);
  sleep(300);
}
// A run that goes on (a tail) until the test says.
if (process.env.FAKE_WAIT_FOR) while (!fs.existsSync(process.env.FAKE_WAIT_FOR)) sleep(20);
console.log('wrangler (fake): done');
process.exit(Number(process.env.FAKE_EXIT ?? 0));
`;

/**
 * A copy of what the wrapper uses: scripts/cf and scripts/lib, package.json, wrangler.jsonc (`base`), the
 * tsconfigs and the parser's sources, a fake node_modules/wrangler of `version`, a built web client unless `web`
 * is false, `instance` (text, a Buffer, or a value as JSON) as wrangler.instance.jsonc, and a folder to run it from.
 */
function checkout({ instance, base = BASE_TEXT, web = true, version = PINNED } = {}) {
  const dir = tmp();
  for (const folder of ['scripts/cf', 'scripts/lib']) {
    fs.cpSync(path.join(ROOT, folder), path.join(dir, folder), { recursive: true });
  }
  for (const file of ['package.json', 'tsconfig.base.json', 'tsconfig.worker.json', ...PARSER_SOURCES]) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, file), path.join(dir, file));
  }
  fs.writeFileSync(path.join(dir, 'wrangler.jsonc'), base);
  const wrangler = path.join(dir, 'node_modules', 'wrangler');
  fs.mkdirSync(path.join(wrangler, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(wrangler, 'node_modules'));
  fs.writeFileSync(path.join(wrangler, 'package.json'), JSON.stringify({ name: 'wrangler', version }));
  fs.writeFileSync(path.join(wrangler, 'bin', 'wrangler.js'), FAKE_WRANGLER);
  fs.symlinkSync(ESBUILD, path.join(wrangler, 'node_modules', 'esbuild'), 'junction');
  if (web) {
    fs.mkdirSync(path.join(dir, 'dist', 'web'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'dist', 'web', 'index.html'), '<!doctype html>');
  }
  fs.mkdirSync(path.join(dir, 'elsewhere'));
  if (instance !== undefined) writeJsonc(path.join(dir, INSTANCE_FILE), instance);
  return dir;
}

function writeJsonc(file, value) {
  fs.writeFileSync(file, typeof value === 'string' || Buffer.isBuffer(value) ? value : `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * The environment of a run: PATH, the fake's log and `env`, and nothing of the test runner's own. So npm's options
 * (npm_config_instance, npm_config_secrets_file, npm_config_validate, npm_config_dry_run), npm_lifecycle_event,
 * INIT_CWD, CLOUDFLARE_ENV, WORKERS_CI, WRANGLER_CI_OVERRIDE_NAME, LYREN_INSTANCE_FILE, LYREN_PREBUILT,
 * GITHUB_ACTIONS and a Cloudflare token reach the wrapper only where a test gives them.
 */
const runEnv = (log, env) => ({ PATH: path.dirname(process.execPath), FAKE_WRANGLER_LOG: log, ...env });

/** The runs the fake Wrangler recorded in `log`. */
const callsIn = (log) =>
  fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];

/** Runs the wrapper of a checkout with `args`, from `cwd` (its elsewhere/), with only `env`. */
function run(dir, args, env = {}, { cwd = path.join(dir, 'elsewhere'), log = 'wrangler.log' } = {}) {
  const logFile = path.join(dir, log);
  fs.rmSync(logFile, { force: true });
  const result = spawnSync(process.execPath, [path.join(dir, 'scripts', 'cf', 'wrangler.mjs'), ...args], {
    cwd,
    env: runEnv(logFile, env),
    encoding: 'utf8',
  });
  const { status, stdout, stderr } = result;
  return { status, stdout, stderr, out: stdout + stderr, calls: callsIn(logFile) };
}

/** Starts the wrapper as run() does, and resolves as it ends: a run that goes on while another one runs. */
function start(dir, args, env = {}, { log }) {
  const logFile = path.join(dir, log);
  fs.rmSync(logFile, { force: true });
  const child = spawn(process.execPath, [path.join(dir, 'scripts', 'cf', 'wrangler.mjs'), ...args], {
    cwd: path.join(dir, 'elsewhere'),
    env: runEnv(logFile, env),
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  return new Promise((resolve) => {
    child.on('close', (status) => resolve({ status, stdout, stderr, out: stdout + stderr, calls: callsIn(logFile) }));
  });
}

/** Waits until `done()` holds, for 20 s at most. */
async function until(done) {
  for (let waited = 0; !done(); waited += 20) {
    if (waited > 20_000) throw new Error('waited 20 s in vain');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** The generated configurations at the root of a checkout. */
const generatedFiles = (dir) => fs.readdirSync(dir).filter((name) => DEPLOY_CONFIG_PATTERN.test(name)).sort();

/** The generated configuration a call got (--config), as Wrangler read it, and this run's token from its build command. */
function generated(call) {
  const config = parseJsonc(call.config);
  const file = call.argv.find((arg) => arg.startsWith('--config=')).slice('--config='.length);
  return { config, file, token: /--run=([0-9a-f]{32})$/.exec(config.build.command)?.[1] };
}

const CHECK_CF = ['deploy', '--dry-run', '--outdir', 'dist/worker'];
/** --config=wrangler.deploy.<id>.jsonc: a file of the run's own. */
const CONFIG_ARG = expect.stringMatching(/^--config=wrangler\.deploy\.[0-9a-f]{8}\.jsonc$/);
/** Wrangler's top-level environment, whatever a .env in the checkout says. */
const TOP_LEVEL = '--env=';
const NONE = 'No instance configuration (--instance, LYREN_INSTANCE_FILE or wrangler.instance.jsonc)';
/** Where the runs of these tests are, as their headers record it: this host, and this process's pid namespace. */
const PLACE = runPlace();
const APP_VALID = "App configuration: the file's variables are valid on Cloudflare (server/src/core/config.ts)";

/** The maintainer's instance configuration: a custom domain managed in the dashboard, workers.dev off, Cloudflare Email Service. */
const MAINTAINER_TEXT = `// This instance's part of the Wrangler configuration.
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "plan-worker",
  // The custom domain is managed in the dashboard.
  "workers_dev": false,
  "vars": {
    "PUBLIC_URL": "https://plan.example.com",
    "INSTANCE_NAME": "Example Plan",
    "MAIL_TRANSPORT": "cloudflare",
    "MAIL_FROM": "plan@example.com",
    "MAIL_FROM_NAME": "Example Plan",
    "MAIL_DAILY_CAP": 96, // a number: the Worker gets "96"
  },
}
`;
const MAINTAINER = parseJsonc(MAINTAINER_TEXT);

/** SMTP on workers.dev, its user a secret the file requires (and SMTP_PASS, which the app requires with it). */
const SMTP = {
  name: 'team-plan',
  vars: {
    PUBLIC_URL: 'https://team-plan.example-sub.workers.dev',
    INSTANCE_NAME: 'Team plan',
    MAIL_TRANSPORT: 'smtp',
    MAIL_FROM: 'plan@example.com',
    SMTP_HOST: 'smtp.example.com',
    SMTP_SECURITY: 'tls',
  },
  secrets: { required: ['SMTP_USER'] },
};

// ---------------------------------------------------------------------------
// Deploys
// ---------------------------------------------------------------------------

describe('a deploy with an instance configuration', () => {
  it("a dry run: wrangler deploy --dry-run with a configuration of the run's own from the root, variables in the file and as --var, no secrets; the file removed afterwards", () => {
    const dir = checkout({ instance: MAINTAINER_TEXT });
    // A dry run never reads a secrets file, or passes one on.
    const { status, stdout, stderr, out, calls } = run(dir, [...CHECK_CF, '--secrets-file=nowhere.json'], { LYREN_PREBUILT: '1' });
    expect(status, out).toBe(0);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    const vars = instanceVars(MAINTAINER);
    expect(vars.MAIL_DAILY_CAP).toBe('96');
    expect(call.argv).toEqual([...CHECK_CF, CONFIG_ARG, TOP_LEVEL, ...varArgs(vars)]);
    expect(call.cwd).toBe(dir);
    expect(call.secretsFile).toBeNull();
    expect(call.env.LYREN_PREBUILT).toBe('1');
    // wrangler.jsonc with the instance's keys, workers.dev off and the EMAIL binding; this run's token, also in
    // Wrangler's environment, where build-web.mjs compares the two.
    const { config, file, token } = generated(call);
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(file).not.toContain(token);
    expect(call.env.LYREN_WRANGLER_RUN).toBe(token);
    expect(config).toEqual(generateConfig(BASE, MAINTAINER, { runToken: token }));
    expect(config).toMatchObject({ name: 'plan-worker', workers_dev: false, send_email: [{ name: 'EMAIL' }], vars });
    expect(config.migrations).toEqual(BASE.migrations);
    // The header names the wrapper's process, which wrote it, its place, and its kind: a run that builds.
    expect(call.config.split('\n')[0]).toBe(
      `// Written by scripts/cf/wrangler.mjs (pid ${call.ppid} on ${PLACE}) for one Wrangler run of kind build, from wrangler.jsonc and wrangler.instance.jsonc; removed when it ends. Do not edit.`,
    );
    // The wrapper's own lines go to stderr; stdout is Wrangler's.
    expect(stdout).toBe('wrangler (fake): done\n');
    expect(stderr.split('\n').slice(0, 8)).toEqual([
      'Instance configuration: wrangler.instance.jsonc (from the checkout)',
      'Worker name: from the instance configuration',
      'workers.dev: off (the instance configuration)',
      'Custom domains: none listed; those added in the dashboard stay as they are',
      'Mail binding: EMAIL (MAIL_TRANSPORT=cloudflare)',
      'Variables (6): PUBLIC_URL INSTANCE_NAME MAIL_TRANSPORT MAIL_FROM MAIL_FROM_NAME MAIL_DAILY_CAP',
      'Secrets the Worker must have: none',
      APP_VALID,
    ]);
    expect(stderr).toContain('Secrets file: not read for a dry run\n');
    expect(stderr).toContain(`Dry run: wrangler deploy --dry-run with ${file}, 6 variables; nothing is uploaded.\n`);
    expect(stderr.endsWith(`Removed ${file}.\n`)).toBe(true);
    // The generated file and what Wrangler left in .wrangler are gone; wrangler.jsonc is as it was.
    expect(generatedFiles(dir)).toEqual([]);
    expect(fs.existsSync(path.join(dir, '.wrangler'))).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'wrangler.jsonc'), 'utf8')).toBe(BASE_TEXT);
    // Each run has a file of its own name.
    expect(generated(run(dir, CHECK_CF).calls[0]).file).not.toBe(file);
  });

  it("a deploy: the --var list, the secrets file as an absolute path, the secrets the app requires, and this run's token", () => {
    const dir = checkout({ instance: SMTP });
    const secrets = { SMTP_USER: 'smtp-user-k3', SMTP_PASS: 'smtp-pass-k4' };
    fs.writeFileSync(path.join(dir, 'elsewhere', 'secrets.json'), JSON.stringify(secrets));
    const env = { CLOUDFLARE_API_TOKEN: 'cf-token-x3', CLOUDFLARE_ACCOUNT_ID: 'f'.repeat(32) };
    const { status, out, calls } = run(dir, ['deploy', '--secrets-file=secrets.json'], env);
    expect(status, out).toBe(0);
    const [call] = calls;
    const vars = instanceVars(SMTP);
    const file = path.join(dir, 'elsewhere', 'secrets.json');
    expect(call.argv).toEqual(['deploy', `--secrets-file=${file}`, CONFIG_ARG, TOP_LEVEL, ...varArgs(vars)]);
    expect(JSON.parse(call.secretsFile)).toEqual(secrets);
    const { config, token } = generated(call);
    expect(call.env.LYREN_WRANGLER_RUN).toBe(token);
    // The file's SMTP_USER, required; SMTP_PASS, which the app requires with it, comes with this deploy.
    expect(config.secrets).toEqual({ required: ['SMTP_USER'] });
    expect(config).toEqual(generateConfig(BASE, SMTP, { runToken: token }));
    expect(config.send_email).toBeUndefined();
    expect(call.env).toMatchObject(env);
    // A dry run reads no secrets file: the Worker must have SMTP_PASS already, from the app's own rule.
    expect(generated(run(dir, CHECK_CF).calls[0]).config.secrets).toEqual({ required: ['SMTP_PASS', 'SMTP_USER'] });
    for (const line of [
      'workers.dev: on (wrangler.jsonc)',
      'Mail binding: none (MAIL_TRANSPORT is not cloudflare)',
      'Variables (6): PUBLIC_URL INSTANCE_NAME MAIL_TRANSPORT MAIL_FROM SMTP_HOST SMTP_SECURITY',
      'Secrets the Worker must have: SMTP_USER',
      'Secrets file (2): SMTP_USER SMTP_PASS, uploaded with the new version',
      `Deploying: wrangler deploy with ${generated(call).file}, 6 variables, a secrets file of 2 secrets.`,
    ]) {
      expect(out).toContain(`${line}\n`);
    }
    for (const value of [...Object.values(secrets), 'cf-token-x3', 'f'.repeat(32), token]) expect(out).not.toContain(value);
  });

  it("counts the secrets file's names in the app's check: SMTP_USER alone there requires SMTP_PASS of the Worker", () => {
    const { secrets: _, ...smtp } = SMTP;
    const dir = checkout({ instance: smtp });
    fs.writeFileSync(path.join(dir, 'elsewhere', 'secrets.json'), JSON.stringify({ SMTP_USER: 'smtp-user-k5' }));
    const { status, out, calls } = run(dir, ['deploy', '--secrets-file=secrets.json']);
    expect(status, out).toBe(0);
    // Uploaded, SMTP_USER needs no inherit binding; SMTP_PASS does, so Wrangler refuses while the Worker lacks it.
    expect(generated(calls[0]).config.secrets).toEqual({ required: ['SMTP_PASS'] });
    expect(out).toContain('Secrets the Worker must have: SMTP_PASS\n');
    expect(out).toContain(`${APP_VALID}\n`);
    expect(out).not.toContain('smtp-user-k5');
  });

  it('versions upload: the same, the secrets file given as two words and found from where npm ran (INIT_CWD)', () => {
    const dir = checkout({ instance: SMTP });
    fs.writeFileSync(path.join(dir, 'elsewhere', 'secrets.json'), JSON.stringify({ SMTP_PASS: 'smtp-pass-k4' }));
    // npm run moves to the package's root; INIT_CWD is where it was run.
    const { status, out, calls } = run(dir, ['versions', 'upload', '--secrets-file', 'secrets.json'], { INIT_CWD: path.join(dir, 'elsewhere') }, { cwd: dir });
    expect(status, out).toBe(0);
    expect(calls[0].argv).toEqual(['versions', 'upload', `--secrets-file=${path.join(dir, 'elsewhere', 'secrets.json')}`, CONFIG_ARG, TOP_LEVEL, ...varArgs(instanceVars(SMTP))]);
    expect(out).toContain(`Uploading a version: wrangler versions upload with ${generated(calls[0]).file}, 6 variables, a secrets file of 1 secret.\n`);
  });

  it('reads the command as Wrangler does: versions --message hi upload is a version upload, checked as one', () => {
    const dir = checkout({ instance: MAINTAINER_TEXT });
    const { status, out, calls } = run(dir, ['versions', '--message', 'hi', 'upload']);
    expect(status, out).toBe(0);
    expect(calls[0].argv).toEqual(['versions', '--message', 'hi', 'upload', CONFIG_ARG, TOP_LEVEL, ...varArgs(instanceVars(MAINTAINER))]);
    expect(out).toContain('Uploading a version: wrangler versions upload with');
    // Every problem stops it, as for any version upload.
    writeJsonc(path.join(dir, INSTANCE_FILE), { name: 'plan-worker', vars: { PUBLIC_URL: 'plan.example.com/x', LOG_REQUESTS: 'maybe' } });
    const refused = run(dir, ['versions', '--message', 'hi', 'upload', '--dry-run']);
    expect(refused.status).toBe(1);
    expect(refused.out).toContain('Nothing was deployed (2 problems).');
    expect(refused.calls).toEqual([]);
  });

  it('a secrets file that lists none is not passed on: the Worker keeps its secrets', () => {
    const dir = checkout({ instance: MAINTAINER_TEXT });
    fs.writeFileSync(path.join(dir, 'elsewhere', 'secrets.json'), '{}');
    const { status, out, calls } = run(dir, ['deploy', '--secrets-file=secrets.json']);
    expect(status, out).toBe(0);
    expect(calls[0].argv).toEqual(['deploy', CONFIG_ARG, TOP_LEVEL, ...varArgs(instanceVars(MAINTAINER))]);
    expect(out).toContain('Secrets file: lists none, so it is not passed on; the Worker keeps its own\n');
    expect(out).toContain(`Deploying: wrangler deploy with ${generated(calls[0]).file}, 6 variables, no secrets file.\n`);
  });

  it('leaves wrangler.jsonc and the instance configuration byte for byte unchanged when Wrangler writes to its --config, and says so', () => {
    const dir = checkout({ instance: MAINTAINER_TEXT });
    const { status, out, calls } = run(dir, ['deploy'], { FAKE_WRITE_BACK: '1' });
    expect(status, out).toBe(0);
    expect(calls).toHaveLength(1);
    expect(out).toContain(
      `Wrangler wrote the dashboard's values into ${generated(calls[0]).file}, which is now removed; wrangler.jsonc and your instance configuration are unchanged: move what you want to keep into your instance configuration.\n`,
    );
    expect(fs.readFileSync(path.join(dir, 'wrangler.jsonc'), 'utf8')).toBe(BASE_TEXT);
    expect(fs.readFileSync(path.join(dir, INSTANCE_FILE), 'utf8')).toBe(MAINTAINER_TEXT);
    expect(generatedFiles(dir)).toEqual([]);
    // Without a write, no such word.
    expect(run(dir, ['deploy']).out).not.toContain('Wrangler wrote');
  });

  it("ends with Wrangler's exit status, and removes its generated file and an empty .wrangler/tmp anyway", () => {
    const dir = checkout({ instance: MAINTAINER_TEXT });
    const { status, out, calls } = run(dir, ['deploy'], { FAKE_EXIT: '3' });
    expect(status, out).toBe(3);
    expect(calls).toHaveLength(1);
    expect(out).toContain(`Removed ${generated(calls[0]).file}.\n`);
    expect(generatedFiles(dir)).toEqual([]);
    expect(fs.existsSync(path.join(dir, '.wrangler'))).toBe(false);
    // The local data of npm run dev:cf stays.
    fs.mkdirSync(path.join(dir, '.wrangler', 'state'), { recursive: true });
    expect(run(dir, CHECK_CF, { FAKE_EXIT: '4' }).status).toBe(4);
    expect(fs.readdirSync(path.join(dir, '.wrangler'))).toEqual(['state']);
  });

  it.skipIf(process.platform === 'win32')('outlives a Ctrl+C, a SIGTERM and a closed terminal (SIGHUP) while Wrangler runs, and cleans up after it', () => {
    const dir = checkout({ instance: MAINTAINER_TEXT });
    // Wrangler gets them from the terminal too, and stops: 130, as after a Ctrl+C.
    const { status, out, calls } = run(dir, ['deploy'], { FAKE_SIGNALS: 'SIGINT,SIGTERM,SIGHUP', FAKE_EXIT: '130' });
    expect(status, out).toBe(130);
    expect(calls).toHaveLength(1);
    expect(out.endsWith(`Removed ${generated(calls[0]).file}.\n`)).toBe(true);
    expect(generatedFiles(dir)).toEqual([]);
    expect(fs.existsSync(path.join(dir, '.wrangler'))).toBe(false);
  });

  it('notes what a run does not read: a leftover wrangler.local.jsonc, the wrangler.deploy.jsonc of an earlier version, and .wrangler/deploy/config.json', () => {
    const dir = checkout({ instance: MAINTAINER_TEXT });
    fs.writeFileSync(path.join(dir, 'wrangler.local.jsonc'), '{}');
    fs.writeFileSync(path.join(dir, LEGACY_DEPLOY_CONFIG), '{}');
    fs.mkdirSync(path.join(dir, '.wrangler', 'deploy'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.wrangler', 'deploy', 'config.json'), '{}');
    const { status, out } = run(dir, CHECK_CF);
    expect(status, out).toBe(0);
    expect(out).toContain('Note: wrangler.local.jsonc is no longer read: move its settings into your instance configuration\n');
    expect(out).toContain('Note: wrangler.deploy.jsonc is left from an earlier version and no longer read: remove it\n');
    expect(out).toContain('Note: .wrangler/deploy/config.json: Wrangler follows it for wrangler dev and deploy: remove it\n');
    // A note, never a removal.
    expect(fs.readFileSync(path.join(dir, LEGACY_DEPLOY_CONFIG), 'utf8')).toBe('{}');
  });
});

// ---------------------------------------------------------------------------
// Runs side by side, and runs that were stopped
// ---------------------------------------------------------------------------

describe('the generated configurations of several runs', () => {
  it('a deploy while a tail runs: each run has its own file, and removes only its own', async () => {
    const dir = checkout({ instance: MAINTAINER_TEXT });
    const go = path.join(dir, 'go');
    // npm run cf -- tail, in another terminal, until the test says.
    const tail = start(dir, ['tail', '--format', 'pretty'], { FAKE_WAIT_FOR: go }, { log: 'tail.log' });
    await until(() => fs.existsSync(path.join(dir, 'tail.log')));
    const [tailFile] = generatedFiles(dir);
    expect(tailFile).toMatch(DEPLOY_CONFIG_PATTERN);
    const deploy = run(dir, ['deploy']);
    expect(deploy.status, deploy.out).toBe(0);
    const deployFile = generated(deploy.calls[0]).file;
    expect(deployFile).not.toBe(tailFile);
    // The tail's file stays, without a word: its run is going on.
    expect(generatedFiles(dir)).toEqual([tailFile]);
    expect(deploy.out).not.toContain(tailFile);
    expect(deploy.out).toContain(`Removed ${deployFile}.\n`);
    fs.writeFileSync(go, '');
    const ended = await tail;
    expect(ended.status, ended.out).toBe(0);
    expect(ended.out.endsWith(`Removed ${tailFile}.\n`)).toBe(true);
    expect(ended.out).not.toContain('Wrangler wrote');
    expect(ended.out).not.toContain(deployFile);
    expect(generatedFiles(dir)).toEqual([]);
  });

  it('a deploy or a check next to another one: refused before Wrangler starts, since each build empties dist/web; a tail still runs', async () => {
    const dir = checkout({ instance: MAINTAINER_TEXT });
    const go = path.join(dir, 'go');
    // npm run deploy:cf, in another terminal, until the test says.
    const deploy = start(dir, ['deploy'], { FAKE_WAIT_FOR: go }, { log: 'deploy.log' });
    await until(() => fs.existsSync(path.join(dir, 'deploy.log')));
    const [deployFile] = generatedFiles(dir);
    const busy = `::error::another deploy or check may be running in this checkout (${deployFile}): wait for it to end, or remove the file if none is\n`;
    for (const args of [CHECK_CF, ['deploy'], ['versions', 'upload', '--dry-run']]) {
      const refused = run(dir, args);
      expect(refused.status, refused.out).toBe(1);
      expect(refused.out).toContain(busy);
      expect(refused.calls).toEqual([]);
      expect(refused.stdout).toBe('');
    }
    expect(generatedFiles(dir)).toEqual([deployFile]);
    // A run that builds nothing never waits.
    const tail = run(dir, ['tail', '--format', 'pretty']);
    expect(tail.status, tail.out).toBe(0);
    expect(tail.out).not.toContain(deployFile);
    fs.writeFileSync(go, '');
    const ended = await deploy;
    expect(ended.status, ended.out).toBe(0);
    expect(ended.out.endsWith(`Removed ${deployFile}.\n`)).toBe(true);
    expect(generatedFiles(dir)).toEqual([]);
    // Once it has ended, the next one runs.
    expect(run(dir, CHECK_CF).status).toBe(0);
  });

  it("removes a file that a stopped run of this place left, and leaves one of a run that is going on, of another place, or that is not a run's", () => {
    const dir = checkout({ instance: MAINTAINER_TEXT });
    const header = (pid, where = PLACE, kind = 'other') => generatedConfigText(BASE, { source: INSTANCE_FILE, pid, where, kind });
    // A process that has ended: no run of that pid is going on here.
    const ended = spawnSync(process.execPath, ['-e', '']).pid;
    fs.writeFileSync(path.join(dir, 'wrangler.deploy.0badc0de.jsonc'), header(ended));
    fs.writeFileSync(path.join(dir, 'wrangler.deploy.0badc0d1.jsonc'), header(ended, PLACE, 'build'));
    // This test's own process is running.
    fs.writeFileSync(path.join(dir, 'wrangler.deploy.11111111.jsonc'), header(process.pid));
    // No header of the wrapper's (one being written, or someone else's), and another name.
    fs.writeFileSync(path.join(dir, 'wrangler.deploy.22222222.jsonc'), '');
    fs.writeFileSync(path.join(dir, 'wrangler.deploy.mine.jsonc'), header(ended));
    // A run in a container or another WSL distribution that shares the checkout: its pid means nothing here.
    fs.writeFileSync(path.join(dir, 'wrangler.deploy.33333333.jsonc'), header(ended, 'another-host pid:[1]'));
    fs.writeFileSync(path.join(dir, 'wrangler.deploy.44444444.jsonc'), header(ended, `${PLACE}0`));
    const { status, out, calls } = run(dir, CHECK_CF);
    expect(status, out).toBe(0);
    expect(out).toContain('Removed wrangler.deploy.0badc0de.jsonc, left by a run that was stopped.\n');
    expect(out).toContain('Removed wrangler.deploy.0badc0d1.jsonc, left by a run that was stopped.\n');
    expect(out).not.toMatch(/11111111|22222222|33333333|44444444|mine/);
    expect(generatedFiles(dir)).toEqual(['wrangler.deploy.11111111.jsonc', 'wrangler.deploy.22222222.jsonc', 'wrangler.deploy.33333333.jsonc', 'wrangler.deploy.44444444.jsonc']);
    expect(fs.existsSync(path.join(dir, 'wrangler.deploy.mine.jsonc'))).toBe(true);
    expect(generated(calls[0]).file).toMatch(DEPLOY_CONFIG_PATTERN);
  });

  it("refuses a deploy or a check next to a building run's file it cannot judge: of another place, or without a pid", () => {
    const dir = checkout({ instance: MAINTAINER_TEXT });
    const ended = spawnSync(process.execPath, ['-e', '']).pid;
    const file = 'wrangler.deploy.55555555.jsonc';
    const may = `::error::another deploy or check may be running in this checkout (${file}): wait for it to end, or remove the file if none is\n`;
    for (const text of [
      generatedConfigText(BASE, { source: INSTANCE_FILE, pid: ended, where: 'another-host pid:[1]', kind: 'build' }),
      `// Written by scripts/cf/wrangler.mjs (pid ? on ${PLACE}) for one Wrangler run of kind build, from wrangler.jsonc and x; removed when it ends. Do not edit.\n{}\n`,
    ]) {
      fs.writeFileSync(path.join(dir, file), text);
      for (const args of [CHECK_CF, ['deploy']]) {
        const refused = run(dir, args);
        expect(refused.status, refused.out).toBe(1);
        expect(refused.out).toContain(may);
        expect(refused.calls).toEqual([]);
      }
      // A run that builds nothing goes on, and leaves the file alone.
      const list = run(dir, ['secret', 'list']);
      expect(list.status, list.out).toBe(0);
      expect(list.out).not.toContain(file);
      expect(generatedFiles(dir)).toEqual([file]);
    }
    // Removed, as the message says, the check runs.
    fs.rmSync(path.join(dir, file));
    expect(run(dir, CHECK_CF).status).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

describe('refusals before Wrangler runs', () => {
  /** Runs the wrapper, which must stop with `status` and say `message`, before Wrangler and the generated file. */
  function refuse(dir, args, env, status, message) {
    const result = run(dir, args, env);
    expect(result.status, `${args.join(' ')}\n${result.out}`).toBe(status);
    expect(result.out).toContain(message);
    expect(result.calls).toEqual([]);
    expect(result.stdout).toBe('');
    return result.out;
  }

  it('bad usage and arguments that would bypass the instance configuration (exit 2)', () => {
    const dir = checkout({ instance: MAINTAINER_TEXT });
    refuse(dir, ['deploy', '--config=wrangler.jsonc'], {}, 2, '::error::--config is not passed on');
    refuse(dir, ['secret', 'put', 'SMTP_PASS', '--name', 'other'], {}, 2, '::error::--name is not passed on');
    refuse(dir, ['deploy', '--var', 'PUBLIC_URL:https://other.example.com'], {}, 2, '--var is not passed on: put PUBLIC_URL in "vars" of your instance configuration');
    refuse(dir, ['deploy', '--routes', 'other.example.com'], {}, 2, '--routes is not passed on');
    refuse(dir, ['deploy', 'other.js'], {}, 2, 'a script path is not passed on');
    refuse(dir, ['dev'], {}, 2, 'npm run dev:cf');
    refuse(dir, ['preview'], {}, 2, 'Lyren Plan has no previews');
    refuse(dir, ['triggers', 'deploy'], {}, 2, '::error::wrangler triggers deploy is not passed on: npm run deploy:cf applies routes and workers.dev');
    refuse(dir, ['types'], {}, 2, "::error::wrangler types is not passed on: npx wrangler types reads wrangler.jsonc, which is all the code's types need");
    // Only a plain --dry-run is a dry run: the wrapper never takes a deploy for one.
    refuse(dir, ['deploy', '--dry-run=false'], {}, 2, '--dry-run: write --dry-run alone, or leave it out');
    refuse(dir, ['deploy', '--dry-run', 'false'], {}, 2, 'write --dry-run alone');
    refuse(dir, ['--dry-run', 'deploy'], {}, 2, 'the Wrangler command comes first');
    refuse(dir, ['deploy', '--secrets-file'], {}, 2, '--secrets-file names no file');
    refuse(dir, ['deploy', '--secretsFile=x.json'], {}, 2, 'write --secrets-file=<file>');
    refuse(dir, [], {}, 2, 'Usage: node scripts/cf/wrangler.mjs');
    refuse(dir, ['--validate', 'deploy'], {}, 2, '--validate runs no Wrangler command');
    refuse(dir, ['deploy', '--instance'], {}, 2, '--instance names no file');
    refuse(dir, ['deploy', '--instance=a.jsonc', '--instance=b.jsonc'], {}, 2, '--instance is given twice');
    expect(generatedFiles(dir)).toEqual([]);
  });

  it('a `--`, after which Wrangler would take --config and every --var for words (exit 2)', () => {
    const dir = checkout({ instance: MAINTAINER_TEXT });
    const message = "::error::-- is not passed on: give Wrangler's options without it";
    refuse(dir, [...CHECK_CF, '--'], {}, 2, message);
    refuse(dir, ['secret', 'put', 'SMTP_PASS', '--'], {}, 2, message);
    refuse(dir, ['--', 'deploy'], {}, 2, message);
    refuse(dir, ['--validate', '--'], {}, 2, message);
  });

  it('the options npm took for itself when no -- came before them, before anything else, naming the script that was run (exit 2)', () => {
    const dir = checkout({ instance: MAINTAINER_TEXT });
    // npm run deploy:cf --instance=x.jsonc: npm passes on only npm_config_instance, and the script as npm_lifecycle_event.
    const tookInstance = '::error::npm took --instance for itself: put -- before it';
    refuse(dir, ['deploy'], { npm_config_instance: 'x.jsonc', npm_lifecycle_event: 'deploy:cf' }, 2, `${tookInstance} (npm run deploy:cf -- --instance=<file>)\n`);
    refuse(dir, ['deploy'], { npm_config_instance: 'x.jsonc', npm_lifecycle_event: 'deploy' }, 2, `${tookInstance} (npm run deploy -- --instance=<file>)\n`);
    // A check stays a check, and a secret command keeps its command.
    refuse(dir, CHECK_CF, { npm_config_instance: 'x.jsonc', npm_lifecycle_event: 'check:cf' }, 2, `${tookInstance} (npm run check:cf -- --instance=<file>)\n`);
    refuse(dir, ['secret', 'put', 'SMTP_PASS'], { npm_config_instance: 'x.jsonc', npm_lifecycle_event: 'cf' }, 2, `${tookInstance} (npm run cf -- --instance=<file> <command>)\n`);
    // Run otherwise (node scripts/cf/wrangler.mjs from another script): the script is not known.
    refuse(dir, ['deploy'], { npm_config_instance: 'x.jsonc' }, 2, `${tookInstance} (npm run <script> -- --instance=<file>)\n`);
    refuse(dir, ['deploy'], { npm_config_instance: 'x.jsonc', npm_lifecycle_event: 'test' }, 2, `${tookInstance} (npm run <script> -- --instance=<file>)\n`);
    refuse(dir, ['deploy'], { npm_config_secrets_file: 's.json', npm_lifecycle_event: 'deploy:cf' }, 2, '::error::npm took --secrets-file for itself: put -- before it (npm run deploy:cf -- --secrets-file=<file>)\n');
    refuse(dir, ['secret', 'list'], { npm_config_secrets_file: 's.json', npm_lifecycle_event: 'cf' }, 2, '::error::npm took --secrets-file for itself: put -- before it (npm run cf -- deploy --secrets-file=<file>)\n');
    for (const npm_lifecycle_event of ['cf', 'check:cf', undefined]) {
      refuse(dir, ['secret', 'list'], { npm_config_validate: 'true', npm_lifecycle_event }, 2, '::error::npm took --validate for itself: put -- before it (npm run cf -- --validate)\n');
    }
    // Before a usage problem of its own, and before the wrapper looks for the file it names.
    refuse(dir, ['--', 'deploy'], { npm_config_instance: 'nowhere.jsonc' }, 2, 'npm took --instance for itself');
    // npm run deploy:cf --dry-run: npm keeps it, and says nothing; a real deploy would follow.
    const dryRun = '::error::npm took --dry-run for itself: npm run check:cf, or npm run cf -- deploy --dry-run. Nothing was deployed.';
    refuse(dir, ['deploy'], { npm_config_dry_run: 'true' }, 2, dryRun);
    refuse(dir, ['versions', 'upload'], { npm_config_dry_run: 'true' }, 2, dryRun);
    // What is a dry run anyway, or deploys nothing, runs; blank values are no option.
    expect(run(dir, CHECK_CF, { npm_config_dry_run: 'true' }).status).toBe(0);
    expect(run(dir, ['secret', 'list'], { npm_config_dry_run: 'true' }).status).toBe(0);
    expect(run(dir, CHECK_CF, { npm_config_instance: '', npm_config_secrets_file: ' ', npm_config_validate: '' }).status).toBe(0);
  });

  it('CLOUDFLARE_ENV and --env-file, which would deploy to <name>-<env>, another Worker; Wrangler gets CLOUDFLARE_ENV empty', () => {
    const dir = checkout({ instance: MAINTAINER_TEXT });
    const message = '::error::CLOUDFLARE_ENV is not passed on: one instance configuration is one Worker; unset it';
    refuse(dir, ['deploy'], { CLOUDFLARE_ENV: 'production' }, 2, message);
    refuse(dir, ['secret', 'list'], { CLOUDFLARE_ENV: 'staging' }, 2, message);
    const envFile = '::error::--env-file is not passed on: settings go in "vars" of your instance configuration, secrets in npm run cf -- secret put <NAME>';
    // Node itself stops at an --env-file that names no file, even after the script's name (exit 9).
    for (const name of ['.env.production', '.env']) fs.writeFileSync(path.join(dir, 'elsewhere', name), 'CLOUDFLARE_ENV=production\n');
    refuse(dir, ['deploy', '--env-file', '.env.production'], {}, 2, envFile);
    refuse(dir, ['tail', '--env-file=.env'], {}, 2, envFile);
    // Empty in Wrangler's environment, and --env= (Wrangler's top level), which a CLOUDFLARE_ENV in the checkout's
    // .env does not override as it would an empty variable; also without an instance configuration.
    fs.writeFileSync(path.join(dir, '.env'), 'CLOUDFLARE_ENV=production\n');
    const { status, calls } = run(dir, ['secret', 'list'], { CLOUDFLARE_ENV: ' ' });
    expect(status).toBe(0);
    expect(calls[0].env.CLOUDFLARE_ENV).toBe('');
    expect(calls[0].argv).toEqual(['secret', 'list', CONFIG_ARG, TOP_LEVEL]);
    expect(run(dir, CHECK_CF).calls[0].env.CLOUDFLARE_ENV).toBe('');
    const base = run(checkout(), CHECK_CF).calls[0];
    expect(base.env.CLOUDFLARE_ENV).toBe('');
    expect(base.argv).toEqual([...CHECK_CF, TOP_LEVEL]);
  });

  it('no instance configuration outside Workers Builds: a deploy, --validate, and any command but a check', () => {
    const dir = checkout();
    refuse(dir, ['deploy'], {}, 1, '::error::No instance configuration: cp wrangler.instance.example.jsonc wrangler.instance.jsonc and edit it, or point LYREN_INSTANCE_FILE at yours (docs/cloudflare.md, "Your instance configuration"). Nothing was deployed.');
    refuse(dir, ['versions', 'upload'], { WORKERS_CI: '0' }, 1, 'Nothing was deployed.');
    refuse(dir, ['secret', 'list'], {}, 1, `::error::${NONE}: npm run cf runs Wrangler for your instance; for Wrangler itself use npx wrangler <command>`);
    // The workflow's check job, before anybody approves the deploy that would be refused.
    const validate = refuse(dir, ['--validate'], {}, 1, '::error::No instance configuration to check (--instance, LYREN_INSTANCE_FILE or wrangler.instance.jsonc): cp wrangler.instance.example.jsonc wrangler.instance.jsonc and edit it (docs/cloudflare.md, "Your instance configuration")');
    expect(validate).not.toContain('Checked:');
    // A file named by --instance or LYREN_INSTANCE_FILE must exist: the next source is never used instead.
    const named = checkout({ instance: MAINTAINER_TEXT });
    refuse(named, [...CHECK_CF, '--instance=nowhere.jsonc'], {}, 1, '--instance names nowhere.jsonc, which does not exist');
    refuse(named, CHECK_CF, { LYREN_INSTANCE_FILE: 'nowhere.jsonc' }, 1, 'LYREN_INSTANCE_FILE names nowhere.jsonc, which does not exist');
  });

  it('a Wrangler other than the pin, and LYREN_PREBUILT=1 without a built client', () => {
    refuse(checkout({ instance: MAINTAINER_TEXT, version: '4.0.0' }), CHECK_CF, {}, 1, `::error::node_modules holds Wrangler 4.0.0, but package.json pins ${PINNED}: run npm ci`);
    const unbuilt = checkout({ instance: MAINTAINER_TEXT, web: false });
    refuse(unbuilt, CHECK_CF, { LYREN_PREBUILT: '1' }, 1, '::error::LYREN_PREBUILT=1, but there is no dist/web/index.html: build the web client first (npm run build:web)');
    expect(run(unbuilt, CHECK_CF).status).toBe(0);
  });

  it("a file that is no JSONC, named by line and column and never quoted", () => {
    const dir = checkout({ instance: '{\n  "name": "plan-worker",\n  "vars": {\n    "PUBLIC_URL": https://quoted-host-q1.example.com\n  }\n}\n' });
    // JSON.parse would quote the text around the error, a value here.
    const out = refuse(dir, CHECK_CF, {}, 1, '::error::wrangler.instance.jsonc:4:19: not valid JSON');
    expect(out).not.toContain('quoted-host-q1');
    expect(out).toContain('Nothing was deployed (1 problem).');
    writeJsonc(path.join(dir, INSTANCE_FILE), '{\n  // the Worker\n  "name": "plan-worker"\n  "vars": {}\n}\n');
    refuse(dir, CHECK_CF, {}, 1, "::error::wrangler.instance.jsonc:4:3: Expected ',' or '}' after property value");
    writeJsonc(path.join(dir, INSTANCE_FILE), '{\n  /* open\n');
    refuse(dir, CHECK_CF, {}, 1, '::error::wrangler.instance.jsonc:2:3: Unterminated /* comment');
    writeJsonc(path.join(dir, INSTANCE_FILE), '{ "name": "plan-worker",');
    refuse(dir, CHECK_CF, {}, 1, '::error::wrangler.instance.jsonc:1:25: the file ends before its JSON does');
    writeJsonc(path.join(dir, INSTANCE_FILE), '["plan-worker"]');
    refuse(dir, CHECK_CF, {}, 1, 'wrangler.instance.jsonc: the file does not hold an object');
  });

  it('a key given twice in an object, which JSON.parse and Wrangler would keep the last of without a word', () => {
    // The example, with the dashboard's variables pasted at the top of its "vars": its own INSTANCE_NAME and
    // MAIL_TRANSPORT, further down, would win, and mail would go to the logs.
    const example = read(EXAMPLE_FILE);
    const lines = example.split('\n');
    const varsAt = lines.findIndex((line) => /^\s*"vars": \{/.test(line));
    const pasted = ['"PUBLIC_URL": "https://plan.example.com",', '"INSTANCE_NAME": "Example Plan",', '"MAIL_TRANSPORT": "cloudflare",', '"MAIL_FROM": "plan@example.com",', '"MAIL_DAILY_CAP": "96",'];
    const text = [...lines.slice(0, varsAt + 1), ...pasted.map((line) => `    ${line}`), ...lines.slice(varsAt + 1)].join('\n');
    /** "<line>:<column>" of the example's own active line of `name`, in `text`. */
    const own = (source, name) => {
      const at = source.split('\n').findLastIndex((line) => line.trimStart().startsWith(`"${name}":`));
      return `${at + 1}:${source.split('\n')[at].indexOf('"') + 1}`;
    };
    const dir = checkout({ instance: text });
    const out = refuse(dir, CHECK_CF, {}, 1, 'Nothing was deployed (2 problems).');
    expect(out).toContain(`::error::wrangler.instance.jsonc:${own(text, 'INSTANCE_NAME')}: "vars.INSTANCE_NAME" is given twice\n`);
    expect(out).toContain(`::error::wrangler.instance.jsonc:${own(text, 'MAIL_TRANSPORT')}: "vars.MAIL_TRANSPORT" is given twice\n`);
    // A whole "vars" block of the maintainer's kind pasted above the example's own: the first would be dropped.
    const block = `  "vars": {\n${pasted.map((line) => `    ${line}`).join('\n')}\n  },\n`;
    const twice = [...lines.slice(0, varsAt), ...block.split('\n').slice(0, -1), ...lines.slice(varsAt)].join('\n');
    writeJsonc(path.join(dir, INSTANCE_FILE), twice);
    refuse(dir, ['--validate'], {}, 1, `::error::wrangler.instance.jsonc:${own(twice, 'vars')}: "vars" is given twice\n`);
    // Fatal for every command, like a file that does not parse; in an array, and in wrangler.jsonc too.
    writeJsonc(path.join(dir, INSTANCE_FILE), '{\n  "name": "plan-worker",\n  "routes": [{ "pattern": "a.example.com", "pattern": "b.example.com" }]\n}\n');
    refuse(dir, ['secret', 'list'], {}, 1, '::error::wrangler.instance.jsonc:3:44: "routes[0].pattern" is given twice');
    writeJsonc(path.join(dir, INSTANCE_FILE), '{ "name": "plan-worker", "vars": { "PUBLIC URL": "a", "PUBLIC URL": "b" } }');
    refuse(dir, ['rollback'], {}, 1, '::error::wrangler.instance.jsonc:1:55: a key is given twice');
    writeJsonc(path.join(dir, INSTANCE_FILE), MAINTAINER_TEXT);
    fs.writeFileSync(path.join(dir, 'wrangler.jsonc'), BASE_TEXT.replace('"name": "lyren-plan",', '"name": "lyren-plan", "name": "other",'));
    refuse(dir, ['secret', 'list'], {}, 1, '"name" is given twice');
  });

  it('reads a file as UTF-8, a byte-order mark and CRLF line ends as well, and refuses UTF-16 and UTF-32 by name', () => {
    const crlf = MAINTAINER_TEXT.replaceAll('\n', '\r\n');
    const dir = checkout({ instance: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(crlf)]) });
    const valid = run(dir, ['--validate']);
    expect(valid.status, valid.out).toBe(0);
    expect(valid.stderr.endsWith('Checked: no problems.\n')).toBe(true);
    // A secrets file with a byte-order mark, as PowerShell 5.1 writes one.
    fs.writeFileSync(path.join(dir, 'elsewhere', 'secrets.json'), `\uFEFF${JSON.stringify({ SETUP_TOKEN: 'setup-k6' })}`);
    expect(run(dir, ['deploy', '--secrets-file=secrets.json']).out).toContain('Secrets file (1): SETUP_TOKEN, uploaded with the new version\n');
    // Positions after the mark are the file's own, as an editor shows them.
    writeJsonc(path.join(dir, INSTANCE_FILE), Buffer.from('\uFEFF{\r\n  "name": "plan-worker"\r\n  "vars": {}\r\n}\r\n'));
    refuse(dir, ['--validate'], {}, 1, "::error::wrangler.instance.jsonc:3:3: Expected ',' or '}' after property value");
    writeJsonc(path.join(dir, INSTANCE_FILE), Buffer.from(`\uFEFF${crlf}`, 'utf16le'));
    refuse(dir, ['--validate'], {}, 1, '::error::wrangler.instance.jsonc is saved as UTF-16: save it as UTF-8');
    writeJsonc(path.join(dir, INSTANCE_FILE), Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(crlf, 'utf16le').swap16()]));
    refuse(dir, ['--validate'], {}, 1, 'wrangler.instance.jsonc is saved as UTF-16: save it as UTF-8');
    writeJsonc(path.join(dir, INSTANCE_FILE), Buffer.from([0xff, 0xfe, 0, 0, 0x7b, 0, 0, 0]));
    refuse(dir, ['--validate'], {}, 1, 'wrangler.instance.jsonc is saved as UTF-32: save it as UTF-8');
    writeJsonc(path.join(dir, INSTANCE_FILE), MAINTAINER_TEXT);
    fs.writeFileSync(path.join(dir, 'elsewhere', 'secrets.json'), Buffer.from(`\uFEFF${JSON.stringify({ SETUP_TOKEN: 'setup-k6' })}`, 'utf16le'));
    const secrets = refuse(dir, ['deploy', '--secrets-file=secrets.json'], {}, 1, '::error::secrets.json is saved as UTF-16: save it as UTF-8');
    expect(secrets).not.toContain('setup-k6');
  });

  it("every problem of the file, of wrangler.jsonc and of the app's settings, values redacted", () => {
    const instance = {
      name: 'plan-worker',
      migrations: [],
      vars: { MAIL_TRANSPRT: 'log', PUBLIC_URL: 'http://plain-host-q2.example.com' },
    };
    const dir = checkout({ instance });
    const out = refuse(dir, CHECK_CF, {}, 1, 'Nothing was deployed (3 problems).');
    expect(out).toContain('::error::wrangler.instance.jsonc: "migrations" comes from wrangler.jsonc, the same for every instance: remove it here');
    expect(out).toContain('::error::wrangler.instance.jsonc: vars.MAIL_TRANSPRT is not a setting of Lyren Plan (did you mean MAIL_TRANSPORT?)');
    expect(out).toMatch(/::error::wrangler\.instance\.jsonc: Invalid value for PUBLIC_URL: <value> \(.*\)/);
    expect(out).not.toContain('plain-host-q2');
    // A custom domain with workers.dev left on is worth a warning, not a refusal.
    expect(out).toContain('::warning::wrangler.instance.jsonc: PUBLIC_URL is a custom domain, but this deploy turns workers.dev on (wrangler.jsonc): add "workers_dev": false once the domain works\n');
    // A wrangler.jsonc that holds a deployment's settings, as copies edited under the old instructions do.
    const copy = checkout({ instance: MAINTAINER_TEXT, base: JSON.stringify({ ...BASE, vars: { PUBLIC_URL: 'https://x.example.com' }, workers_dev: false }) });
    const base = refuse(copy, ['deploy'], {}, 1, '::error::wrangler.jsonc has "vars": variables go in "vars" of your instance configuration');
    expect(base).toContain('::error::wrangler.jsonc has "workers_dev" other than true');
    expect(base).toContain('Nothing was deployed (2 problems).');
  });

  it('values only wrangler dev uses, as copied from .dev.vars', () => {
    const local = { name: 'plan-worker', vars: { PUBLIC_URL: 'http://localhost:8787', MAIL_TRANSPORT: 'smtp', MAIL_FROM: 'plan@example.com', SMTP_HOST: 'localhost', SMTP_SECURITY: 'none', SMTP_PORT: '1025' } };
    const out = refuse(checkout({ instance: local }), ['--validate'], {}, 1, 'Checked: 3 problems.');
    expect(out).toContain('::error::wrangler.instance.jsonc: vars.PUBLIC_URL is a local address, for wrangler dev only: put it in .dev.vars, never in an instance configuration\n');
    expect(out).toContain('::error::wrangler.instance.jsonc: vars.SMTP_HOST is a local address, for wrangler dev only: put it in .dev.vars, never in an instance configuration\n');
    expect(out).toContain('::error::wrangler.instance.jsonc: vars.SMTP_SECURITY none is for a local relay under wrangler dev only: use tls or starttls\n');
    expect(out).not.toContain(APP_VALID);
  });

  it('a secrets file with RECOVERY_TOKEN, a name that is a variable, another name, no JSON, or none at all, never repeating a value', () => {
    const dir = checkout({ instance: { ...SMTP, vars: { ...SMTP.vars, SMTP_USER: 'plan@example.com' }, secrets: undefined } });
    const file = path.join(dir, 'elsewhere', 'secrets.json');
    const deploy = ['deploy', '--secrets-file=secrets.json'];
    fs.writeFileSync(file, JSON.stringify({ SMTP_PASS: 'smtp-secret-k1', RECOVERY_TOKEN: 'recovery-secret-k2', SMTP_USER: 'user-secret-k3', OTHER: 'other-secret-k4', 're_secret-k7': 'RESEND_API_KEY' }));
    const out = refuse(dir, deploy, {}, 1, 'Nothing was deployed (4 problems).');
    expect(out).toContain('::error::secrets.json lists RECOVERY_TOKEN, which no deploy sets');
    expect(out).toContain('::error::secrets.json lists SMTP_USER, which "vars" of the instance configuration has too');
    expect(out).toContain('::error::secrets.json lists OTHER, which is not one of SETUP_TOKEN, SMTP_USER, SMTP_PASS, MAIL_REPLY_TO and RESEND_API_KEY');
    // A name and its value swapped: the name is a value.
    expect(out).toContain('::error::secrets.json lists a name that is not one of SETUP_TOKEN, SMTP_USER, SMTP_PASS, MAIL_REPLY_TO and RESEND_API_KEY\n');
    expect(out).not.toMatch(/secret-k\d/);
    fs.writeFileSync(file, 'SMTP_PASS=smtp-secret-k1');
    const lines = refuse(dir, deploy, {}, 1, '::error::secrets.json is not a JSON object such as {"SMTP_PASS": "…"} (NAME=value lines are not read here)');
    expect(lines).not.toContain('secret-k1');
    fs.writeFileSync(file, '["smtp-secret-k1"]');
    expect(refuse(dir, deploy, {}, 1, '::error::secrets.json does not hold a JSON object')).not.toContain('secret-k1');
    refuse(dir, ['deploy', '--secrets-file=none.json'], {}, 1, '::error::--secrets-file names none.json, which does not exist');
  });
});

// ---------------------------------------------------------------------------
// Without an instance configuration
// ---------------------------------------------------------------------------

describe('without an instance configuration', () => {
  it('check:cf checks wrangler.jsonc as it is', () => {
    const dir = checkout();
    const { status, stdout, out, calls } = run(dir, CHECK_CF);
    expect(status, out).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].argv).toEqual([...CHECK_CF, TOP_LEVEL]);
    expect(calls[0].cwd).toBe(dir);
    expect(calls[0].config).toBeNull();
    expect(calls[0].env.LYREN_WRANGLER_RUN).toBeUndefined();
    expect(stdout).toBe('wrangler (fake): done\n');
    expect(out).toContain(`${NONE}: checking wrangler.jsonc as it is.\n`);
    expect(out).toContain('Dry run: wrangler deploy --dry-run with wrangler.jsonc; nothing is uploaded.\n');
    expect(fs.existsSync(path.join(dir, '.wrangler'))).toBe(false);
  });

  it('under WORKERS_CI deploys wrangler.jsonc as it is: the Deploy button\'s first build', () => {
    const dir = checkout();
    const { status, out, calls } = run(dir, ['deploy'], { WORKERS_CI: '1' });
    expect(status, out).toBe(0);
    expect(calls[0].argv).toEqual(['deploy', TOP_LEVEL]);
    expect(calls[0].env.LYREN_WRANGLER_RUN).toBeUndefined();
    expect(out).toContain(`${NONE}: deploying wrangler.jsonc as it is (Workers Builds, WORKERS_CI=1).\n`);
    expect(out).toContain('Deploying: wrangler deploy with wrangler.jsonc.\n');
    expect(generatedFiles(dir)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Other commands
// ---------------------------------------------------------------------------

describe('other Wrangler commands', () => {
  const flawed = { name: 'plan-worker', kv_namespaces: [], vars: { MAIL_TRANSPRT: 'smtp', PUBLIC_URL: 'http://plan.example.com' } };

  it('need only a file that parses and names its Worker, and warn about the rest, so they work during an incident', () => {
    const dir = checkout({ instance: flawed });
    const { status, out, calls } = run(dir, ['secret', 'put', 'SMTP_PASS']);
    expect(status, out).toBe(0);
    expect(calls).toHaveLength(1);
    // The configuration names the Worker; no --var for a command that deploys nothing.
    expect(calls[0].argv).toEqual(['secret', 'put', 'SMTP_PASS', CONFIG_ARG, TOP_LEVEL]);
    const { config, file, token } = generated(calls[0]);
    expect(config.name).toBe('plan-worker');
    expect(calls[0].env.LYREN_WRANGLER_RUN).toBe(token);
    expect(out).toContain('::warning::wrangler.instance.jsonc: "kv_namespaces": Lyren Plan reads no such binding\n');
    expect(out).toContain('::warning::wrangler.instance.jsonc: vars.MAIL_TRANSPRT is not a setting of Lyren Plan (did you mean MAIL_TRANSPORT?)\n');
    expect(out).toContain('::warning::wrangler.instance.jsonc: Invalid value for PUBLIC_URL: <value>');
    expect(out).toContain(`Running: wrangler secret put with ${file}.\n`);
    expect(out).not.toContain('::error::');
    expect(generatedFiles(dir)).toEqual([]);
    expect(run(dir, ['tail', '--format', 'pretty']).calls[0].argv).toEqual(['tail', '--format', 'pretty', CONFIG_ARG, TOP_LEVEL]);
    expect(run(dir, ['versions', 'list']).out).toContain('Running: wrangler versions list with wrangler.deploy.');
    // A deploy of the same file stops at every problem.
    const deploy = run(dir, ['deploy']);
    expect(deploy.status).toBe(1);
    expect(deploy.out).toContain('Nothing was deployed (3 problems).');
    expect(deploy.calls).toEqual([]);
  });

  it("take nothing from the file but the Worker's name and account: a key it got wrong cannot stop them", () => {
    const account = 'a'.repeat(32);
    // Wrangler refuses "cpu_ms": "100" in any configuration it reads, a secret put's too.
    const instance = { ...MAINTAINER, account_id: account, limits: { cpu_ms: '100' }, routes: [{ pattern: 'plan.example.com/*', zone_name: 'example.com' }], keep_vars: 'no' };
    const dir = checkout({ instance });
    const { status, out, calls } = run(dir, ['secret', 'list']);
    expect(status, out).toBe(0);
    expect(calls[0].argv).toEqual(['secret', 'list', CONFIG_ARG, TOP_LEVEL]);
    const { config, token } = generated(calls[0]);
    expect(config).toEqual(generateConfig(BASE, { name: 'plan-worker', account_id: account }, { runToken: token }));
    for (const key of ['limits', 'routes', 'vars', 'send_email', 'secrets']) expect(config[key], key).toBeUndefined();
    expect(config.keep_vars).toBe(BASE.keep_vars);
    expect(out).toContain('::warning::wrangler.instance.jsonc: limits.cpu_ms must be a whole number above 0\n');
    expect(out).toContain('Worker name: from the instance configuration\nAccount: from the instance configuration\n');
    // The same account in CLOUDFLARE_ACCOUNT_ID is fine; a deploy of the file stops.
    expect(generated(run(dir, ['secret', 'list'], { CLOUDFLARE_ACCOUNT_ID: account }).calls[0]).config.account_id).toBe(account);
    expect(run(dir, ['deploy']).status).toBe(1);
  });

  it('stop without a file that parses or without a Worker name', () => {
    const dir = checkout({ instance: { vars: {} } });
    const nameless = run(dir, ['secret', 'list']);
    expect(nameless.status).toBe(1);
    expect(nameless.out).toContain('::error::wrangler.instance.jsonc: "name" is missing');
    expect(nameless.out).toContain('Wrangler did not run (1 problem).');
    expect(nameless.calls).toEqual([]);
    writeJsonc(path.join(dir, INSTANCE_FILE), '{ "name": "plan-worker" ');
    const broken = run(dir, ['rollback']);
    expect(broken.status).toBe(1);
    expect(broken.calls).toEqual([]);
  });

  it('stop at an account_id that fails its check: without it, Wrangler would act on a Worker of that name in another account', () => {
    const account = 'a'.repeat(32);
    const dir = checkout({ instance: { ...MAINTAINER, account_id: account, limits: { cpu_ms: '100' } } });
    // CLOUDFLARE_ACCOUNT_ID names another account: Wrangler would take that one.
    const other = run(dir, ['secret', 'list'], { CLOUDFLARE_ACCOUNT_ID: 'b'.repeat(32) });
    expect(other.status).toBe(1);
    expect(other.out).toContain('::error::wrangler.instance.jsonc: "account_id" is not CLOUDFLARE_ACCOUNT_ID: both name the account, so make them the same, or remove one\n');
    expect(other.out).toContain('Wrangler did not run (1 problem).\n');
    expect(other.calls).toEqual([]);
    expect(other.out).not.toContain('b'.repeat(32));
    // One that is no account ID, for every command, with a bad name too.
    writeJsonc(path.join(dir, INSTANCE_FILE), { ...MAINTAINER, account_id: account.toUpperCase() });
    for (const args of [['secret', 'put', 'SMTP_PASS'], ['tail'], ['rollback']]) {
      const malformed = run(dir, args);
      expect(malformed.status, args.join(' ')).toBe(1);
      expect(malformed.out).toContain('::error::wrangler.instance.jsonc: "account_id" must be 32 lower-case hexadecimal digits');
      expect(malformed.out).toContain('Wrangler did not run (1 problem).\n');
      expect(malformed.calls).toEqual([]);
    }
    writeJsonc(path.join(dir, INSTANCE_FILE), { ...MAINTAINER, name: 'Plan', account_id: 5 });
    const both = run(dir, ['secret', 'list']);
    expect(both.status).toBe(1);
    expect(both.out).toContain('Wrangler did not run (2 problems).\n');
    expect(generatedFiles(dir)).toEqual([]);
  });

  it("leave stdout to Wrangler, so that npm run -s cf -- secret list gives Wrangler's JSON alone", () => {
    const dir = checkout({ instance: MAINTAINER_TEXT });
    const { status, stdout, stderr } = run(dir, ['secret', 'list']);
    expect(status, stderr).toBe(0);
    expect(stdout).toBe('wrangler (fake): done\n');
    expect(stderr).toContain('Instance configuration: wrangler.instance.jsonc (from the checkout)\n');
    expect(stderr).toMatch(/Removed wrangler\.deploy\.[0-9a-f]{8}\.jsonc\.\n$/);
  });
});

// ---------------------------------------------------------------------------
// --validate, the source, and what the output never says
// ---------------------------------------------------------------------------

describe('--validate', () => {
  it('runs no Wrangler and writes nothing, and stops at any problem', () => {
    const dir = checkout({ instance: MAINTAINER_TEXT });
    const valid = run(dir, ['--validate']);
    expect(valid.status, valid.out).toBe(0);
    expect(valid.calls).toEqual([]);
    expect(valid.stdout).toBe('');
    expect(valid.out).toContain('Variables (6): PUBLIC_URL INSTANCE_NAME MAIL_TRANSPORT MAIL_FROM MAIL_FROM_NAME MAIL_DAILY_CAP\n');
    expect(valid.out).toContain(`${APP_VALID}\n`);
    expect(valid.stderr.endsWith('Checked: no problems.\n')).toBe(true);
    expect(generatedFiles(dir)).toEqual([]);
    writeJsonc(path.join(dir, INSTANCE_FILE), { name: 'Plan', vars: { LOG_REQUESTS: 'maybe' } });
    const invalid = run(dir, ['--validate']);
    expect(invalid.status).toBe(1);
    expect(invalid.calls).toEqual([]);
    expect(invalid.out).toContain('Checked: 2 problems.');
  });

  it('passes the example as it is', () => {
    const { status, out } = run(checkout({ instance: read(EXAMPLE_FILE) }), ['--validate']);
    expect(status, out).toBe(0);
    expect(out).toContain('Checked: no problems.\n');
    expect(out).not.toMatch(/::warning::|Note:/);
  });
});

describe('where the instance configuration comes from', () => {
  it('--instance over LYREN_INSTANCE_FILE over the checkout\'s file, each relative to INIT_CWD, and the source named first', () => {
    const dir = checkout({ instance: { ...MAINTAINER, name: 'from-checkout' } });
    const caller = path.join(dir, 'elsewhere');
    writeJsonc(path.join(caller, 'flag.jsonc'), { ...MAINTAINER, name: 'from-flag' });
    writeJsonc(path.join(caller, 'env.jsonc'), { ...MAINTAINER, name: 'from-env' });
    // npm run runs the wrapper from the package's root; INIT_CWD is where npm ran.
    const npm = (args, env = {}) => run(dir, args, { INIT_CWD: caller, ...env }, { cwd: dir });
    const used = ({ status, stderr, out, calls }) => {
      expect(status, out).toBe(0);
      return { first: stderr.split('\n')[0], name: generated(calls[0]).config.name, argv: calls[0].argv };
    };
    expect(used(npm([...CHECK_CF, '--instance=flag.jsonc'], { LYREN_INSTANCE_FILE: 'env.jsonc' }))).toEqual({
      first: 'Instance configuration: flag.jsonc (from --instance)',
      name: 'from-flag',
      argv: [...CHECK_CF, CONFIG_ARG, TOP_LEVEL, ...varArgs(instanceVars(MAINTAINER))],
    });
    expect(used(npm(['--instance', 'flag.jsonc', ...CHECK_CF])).name).toBe('from-flag');
    expect(used(npm(CHECK_CF, { LYREN_INSTANCE_FILE: 'env.jsonc' }))).toMatchObject({
      first: 'Instance configuration: env.jsonc (from LYREN_INSTANCE_FILE)',
      name: 'from-env',
    });
    for (const blank of ['', '  ']) {
      expect(used(npm(CHECK_CF, { LYREN_INSTANCE_FILE: blank }))).toMatchObject({
        first: 'Instance configuration: wrangler.instance.jsonc (from the checkout)',
        name: 'from-checkout',
      });
    }
    // Without INIT_CWD, from the working directory; an absolute path as it is.
    expect(used(run(dir, CHECK_CF, { LYREN_INSTANCE_FILE: 'env.jsonc' })).name).toBe('from-env');
    expect(used(run(dir, [...CHECK_CF, `--instance=${path.join(caller, 'flag.jsonc')}`], {}, { cwd: os.tmpdir() })).name).toBe('from-flag');
  });
});

describe('the harness', () => {
  it("passes on nothing of the test runner's environment: npm's options and script, CLOUDFLARE_ENV, Workers Builds, GitHub Actions", () => {
    const inherited = {
      npm_config_instance: 'x.jsonc',
      npm_config_secrets_file: 's.json',
      npm_config_validate: 'true',
      npm_config_dry_run: 'true',
      npm_lifecycle_event: 'check:cf',
      CLOUDFLARE_ENV: 'production',
      WORKERS_CI: '1',
      WRANGLER_CI_OVERRIDE_NAME: 'other-worker',
      LYREN_INSTANCE_FILE: 'nowhere.jsonc',
      LYREN_PREBUILT: '1',
      GITHUB_ACTIONS: 'true',
      INIT_CWD: os.tmpdir(),
    };
    const saved = Object.fromEntries(Object.keys(inherited).map((name) => [name, process.env[name]]));
    Object.assign(process.env, inherited);
    try {
      const { status, out, calls } = run(checkout({ instance: MAINTAINER_TEXT, web: false }), ['deploy']);
      expect(status, out).toBe(0);
      // CLOUDFLARE_ENV is the wrapper's own: empty.
      for (const name of Object.keys(inherited)) expect(calls[0].env[name], name).toBe(name === 'CLOUDFLARE_ENV' ? '' : undefined);
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});

describe('the output', () => {
  it('never prints a value, the Worker name, a host, the token or the account ID (ODD strings)', () => {
    const account = 'a9'.repeat(16);
    const instance = {
      name: 'odd-worker-q9',
      account_id: account,
      routes: [{ pattern: 'odd-host-q9.example.com', custom_domain: true }],
      vars: {
        PUBLIC_URL: 'https://odd-host-q9.example.com',
        INSTANCE_NAME: `Odd q9 "name" $(touch pwned) \`touch pwned2\` ;|& *`,
        MAIL_TRANSPORT: 'smtp',
        MAIL_FROM: 'odd-from-q9@example.com',
        MAIL_FROM_NAME: 'Odd q9 sender',
        MAIL_REPLY_TO: 'odd-reply-q9@example.com',
        SMTP_HOST: 'odd-smtp-q9.example.com',
        SMTP_USER: 'odd-user-q9',
        SMTP_EHLO_NAME: 'odd-ehlo-q9.example.com',
      },
      limits: { cpu_ms: 50 },
    };
    const dir = checkout({ instance });
    fs.writeFileSync(path.join(dir, 'elsewhere', 'secrets.json'), JSON.stringify({ SMTP_PASS: `q9${ODD}`, SETUP_TOKEN: 'odd-setup-q9' }));
    const env = { CLOUDFLARE_API_TOKEN: 'odd-token-q9', CLOUDFLARE_ACCOUNT_ID: account };
    const { status, out, calls } = run(dir, ['deploy', '--secrets-file=secrets.json'], env);
    expect(status, out).toBe(0);
    expect(calls).toHaveLength(1);
    const { config, token } = generated(calls[0]);
    expect(config).toMatchObject({ name: 'odd-worker-q9', account_id: account, routes: instance.routes, workers_dev: false });
    expect(out).toContain('Account: from the instance configuration\n');
    expect(out).toContain('Custom domains (1): those of "routes", which replace the Worker\'s custom domains\n');
    expect(out).toContain('Also from the instance configuration: limits\n');
    const never = (text) => {
      expect(text).not.toMatch(/q9|pwned|said/);
      for (const value of [account, token]) expect(text).not.toContain(value);
    };
    never(out);
    // Refusals say as little: a value the app refuses, a host "routes" does not hold, a secrets file with a variable.
    const refusing = { ...instance, routes: [{ pattern: 'other-q9.example.com', custom_domain: true }], vars: { ...instance.vars, PUBLIC_URL: 'http://odd-host-q9.example.com' } };
    writeJsonc(path.join(dir, INSTANCE_FILE), refusing);
    fs.writeFileSync(path.join(dir, 'elsewhere', 'secrets.json'), JSON.stringify({ SMTP_USER: `q9${ODD}` }));
    const refused = run(dir, ['deploy', '--secrets-file=secrets.json'], env);
    expect(refused.status).toBe(1);
    expect(refused.out).toContain('Nothing was deployed (3 problems).');
    never(refused.out);
    // A key given twice whose name is a value, and a value's name pasted twice.
    writeJsonc(path.join(dir, INSTANCE_FILE), `{ "name": "odd-worker-q9", "vars": { "q9 said": "a", "q9 said": "b" } }`);
    never(run(dir, ['--validate']).out);
    // Nothing went through a shell.
    for (const name of ['pwned', 'pwned2']) {
      expect(fs.existsSync(path.join(dir, name))).toBe(false);
      expect(fs.existsSync(path.join(dir, 'elsewhere', name))).toBe(false);
    }
  });
});
