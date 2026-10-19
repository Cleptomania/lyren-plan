// The Cloudflare deploy workflow (.github/workflows/deploy-cloudflare.yml, design §10.10) and its scripts,
// scripts/ci/write-secrets-file.sh and scripts/ci/deploy-cloudflare.sh. The scripts run in a copy of what they
// use, against a fake npx on PATH that records the arguments and environment Wrangler would get. actionlint
// and shellcheck are not part of npm run check: the workflow is read by scripts/test/support/workflow-yaml.mjs
// and checked against release.yml's patterns.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { parseJsonc } from '../lib/cloudflare.mjs';
import { parseWorkflowYaml } from './support/workflow-yaml.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const dirs = [];
afterAll(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lyren-deploy-'));
  dirs.push(d);
  return d;
}

/** The bash array `name=( … )` of a script, as a list of words. */
function bashArray(script, name) {
  const m = new RegExp(`^${name}=\\(([^)]*)\\)`, 'm').exec(script);
  if (!m) throw new Error(`No ${name}=( … ) in the script`);
  return m[1].split(/\s+/).filter(Boolean);
}

const DEPLOY_SCRIPT = read('scripts/ci/deploy-cloudflare.sh');
const VARIABLES = bashArray(DEPLOY_SCRIPT, 'VARIABLES');
const SECRETS = ['SETUP_TOKEN', 'SMTP_PASS', 'RESEND_API_KEY'];

/** A value that a shell would turn into something else anywhere but in a variable or an argument. */
const ODD = `He said "hi" $(touch pwned) \`touch pwned2\` 'x' \\ $HOME ;|& *\nsecond line  `;

// ---------------------------------------------------------------------------
// The variable list
// ---------------------------------------------------------------------------

describe('the variables a deploy passes', () => {
  // Every variable core/config.ts reads: readText(vars, 'X'), readInt(vars, 'X', …), limit('X', …), …
  const read_ = [...read('server/src/core/config.ts').matchAll(/\b(?:read\w+\(vars, |limit\()'([A-Z][A-Z0-9_]*)'/g)].map((m) => m[1]);
  const all = new Set(read_);
  // Read on Node only (Appendix B: n/a on Cloudflare).
  const NODE_ONLY = ['SNAPSHOT_KEEP'];
  // Secrets: three through the secrets file, RECOVERY_TOKEN never (§5.8.19).
  const SECRET_NAMES = [...SECRETS, 'RECOVERY_TOKEN'];
  // Development only (§5.10.2): never passed by a deploy.
  const LEFT_OUT = ['MAIL_LOG_BODIES'];

  it('are every variable the app reads on Cloudflare but the secrets and MAIL_LOG_BODIES', () => {
    for (const name of [...NODE_ONLY, ...SECRET_NAMES, ...LEFT_OUT]) expect(all, name).toContain(name);
    const expected = [...all].filter((n) => ![...NODE_ONLY, ...SECRET_NAMES, ...LEFT_OUT].includes(n)).sort();
    expect([...VARIABLES].sort()).toEqual(expected);
    expect(new Set(VARIABLES).size).toBe(VARIABLES.length);
    // The ones the task names, so a broken pattern cannot pass with an empty list.
    for (const name of ['PUBLIC_URL', 'WEBAUTHN_RP_ID', 'MAIL_TRANSPORT', 'MAIL_FROM', 'SMTP_HOST', 'SMTP_SECURITY', 'AUTH_CACHE_SECONDS']) {
      expect(VARIABLES).toContain(name);
    }
  });

  it('fit in a Worker together with the secrets (64 variables at most, §11.1)', () => {
    expect(VARIABLES.length + SECRET_NAMES.length).toBeLessThanOrEqual(64);
  });

  it('are the secrets write-secrets-file.sh writes and the deploy script accepts', () => {
    expect(bashArray(DEPLOY_SCRIPT, 'SECRETS')).toEqual(SECRETS);
    expect(read('scripts/ci/write-secrets-file.sh')).toContain(`"$1" ${SECRETS.join(' ')}\n`);
  });
});

// ---------------------------------------------------------------------------
// The workflow
// ---------------------------------------------------------------------------

describe('the deploy workflow', () => {
  const text = read('.github/workflows/deploy-cloudflare.yml');
  const wf = parseWorkflowYaml(text);
  const release = parseWorkflowYaml(read('.github/workflows/release.yml'));
  const steps = (job) => wf.jobs[job].steps;
  const allSteps = Object.values(wf.jobs).flatMap((job) => job.steps);
  const step = (job, name) => {
    const found = steps(job).filter((s) => s.name === name);
    expect(found, name).toHaveLength(1);
    return found[0];
  };
  const SECRETS_FILE_SHELL = '"$RUNNER_TEMP/lyren-secrets.json"';
  const deployName = "${{ inputs.dry_run && 'Dry run' || 'Deploy' }}";

  it('runs only by hand, as a dry run unless unchecked', () => {
    expect(Object.keys(wf.on)).toEqual(['workflow_dispatch']);
    expect(wf.on.workflow_dispatch.inputs).toEqual({
      dry_run: {
        description: 'Only build and validate (wrangler deploy --dry-run); nothing is deployed',
        type: 'boolean',
        default: 'true',
      },
    });
    const code = text.replace(/^\s*#.*$/gm, '');
    expect(code).not.toMatch(/pull_request|push:|schedule:|workflow_run|workflow_call/);
  });

  it('can only read, never runs twice at once, and has the optional environment', () => {
    expect(wf.permissions).toEqual({ contents: 'read' });
    for (const job of Object.values(wf.jobs)) expect(job.permissions).toBeUndefined();
    expect(wf.concurrency).toEqual({ group: 'deploy-cloudflare', 'cancel-in-progress': 'false' });
    expect(Object.keys(wf.jobs)).toEqual(['check', 'deploy']);
    expect(wf.jobs.check.environment).toBeUndefined();
    expect(wf.jobs.deploy).toMatchObject({ needs: 'check', environment: 'cloudflare', name: deployName });
  });

  it("uses only GitHub's own actions, pinned to the commits release.yml uses", () => {
    const pins = (yaml) => new Map([...yaml.matchAll(/uses: (actions\/[\w-]+)@([0-9a-f]{40}) # (v[\d.]+)$/gm)].map((m) => [m[1], `${m[2]} ${m[3]}`]));
    const ours = pins(text);
    const theirs = pins(read('.github/workflows/release.yml'));
    const used = allSteps.filter((s) => s.uses).map((s) => s.uses);
    expect(used.length).toBeGreaterThan(0);
    for (const uses of used) {
      expect(uses).toMatch(/^actions\/[\w-]+@[0-9a-f]{40}$/);
      const action = uses.split('@')[0];
      expect(theirs.get(action), action).toBeDefined();
      expect(ours.get(action)).toBe(theirs.get(action));
    }
    expect(text).not.toMatch(/wrangler-action|cloudflare\//);
    // release.yml is read by the same reader, and its pins are those of the steps it parsed.
    const releaseUses = Object.values(release.jobs).flatMap((job) => job.steps.filter((s) => s.uses).map((s) => s.uses.split('@')[0]));
    expect(new Set(releaseUses)).toEqual(new Set(theirs.keys()));
  });

  it('checks out without keeping the token and sets up the Node.js of .nvmrc without a cache, in both jobs', () => {
    for (const job of ['check', 'deploy']) {
      expect(step(job, 'Check out').with).toEqual({ 'persist-credentials': 'false' });
      expect(step(job, 'Set up Node.js (the exact version in .nvmrc)').with).toEqual({
        'node-version-file': '.nvmrc',
        'package-manager-cache': 'false',
      });
      expect(step(job, 'Install dependencies').run).toBe('npm ci --ignore-scripts --no-audit --no-fund');
    }
  });

  it('passes text into scripts through the environment only, never through ${{ }} in a script', () => {
    const runs = allSteps.filter((s) => s.run !== undefined);
    expect(runs.length).toBeGreaterThan(0);
    for (const s of runs) expect(s.run, s.name).not.toContain('${{');
  });

  it('gives no secret to the check job, which hands on only the built web client', () => {
    expect(JSON.stringify(wf.jobs.check)).not.toMatch(/secrets\.|github\.token/);
    expect(steps('check').map((s) => s.run ?? s.uses.split('@')[0])).toEqual([
      'actions/checkout',
      'actions/setup-node',
      'npm ci --ignore-scripts --no-audit --no-fund',
      'npm run check',
      'actions/upload-artifact',
    ]);
    expect(step('check', 'Keep the web client').with).toEqual({ name: 'web', path: 'dist/web', 'if-no-files-found': 'error', 'retention-days': '1' });
    expect(step('deploy', 'Download the web client').with).toEqual({ name: 'web', path: 'dist/web' });
  });

  it('runs nothing in the deploy job but the install, the two scripts and the removal of the secrets file', () => {
    expect(steps('deploy').map((s) => s.run ?? s.uses.split('@')[0])).toEqual([
      'actions/checkout',
      'actions/setup-node',
      'npm ci --ignore-scripts --no-audit --no-fund',
      'actions/download-artifact',
      `bash scripts/ci/write-secrets-file.sh ${SECRETS_FILE_SHELL}`,
      'bash scripts/ci/deploy-cloudflare.sh',
      `rm -f ${SECRETS_FILE_SHELL}`,
    ]);
  });

  it('gives the app secrets to the secrets-file step alone, and only for a deploy', () => {
    const write = step('deploy', 'Write the app secrets to a private file');
    expect(write.if).toBe('${{ !inputs.dry_run }}');
    expect(write.env).toEqual(Object.fromEntries(SECRETS.map((n) => [n, `\${{ secrets.${n} }}`])));
    // Every secret the workflow names is in one of the two steps.
    const named = (s) => [...JSON.stringify(s).matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]);
    const deploy = step('deploy', deployName);
    expect(allSteps.filter((s) => named(s).length > 0)).toEqual([write, deploy]);
    expect(named(deploy).sort()).toEqual(['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN']);
    expect(JSON.stringify(wf.jobs)).not.toContain('RECOVERY_TOKEN');
  });

  it('deploys with the Cloudflare token (none for a dry run), the prebuilt client and every variable from the repository variables', () => {
    const deploy = step('deploy', deployName);
    expect(deploy.run).toBe('bash scripts/ci/deploy-cloudflare.sh');
    expect(deploy.env).toEqual({
      CLOUDFLARE_API_TOKEN: "${{ !inputs.dry_run && secrets.CLOUDFLARE_API_TOKEN || '' }}",
      CLOUDFLARE_ACCOUNT_ID: "${{ !inputs.dry_run && secrets.CLOUDFLARE_ACCOUNT_ID || '' }}",
      LYREN_PREBUILT: '1',
      DRY_RUN: '${{ inputs.dry_run }}',
      SECRETS_FILE: '${{ runner.temp }}/lyren-secrets.json',
      WORKER_NAME: '${{ vars.WORKER_NAME }}',
      WORKERS_DEV: '${{ vars.WORKERS_DEV }}',
      EMAIL_BINDING: '${{ vars.EMAIL_BINDING }}',
      ...Object.fromEntries(VARIABLES.map((n) => [n, `\${{ vars.${n} }}`])),
    });
    // The same order as the script's list, so the two read side by side.
    expect(Object.keys(deploy.env).slice(8)).toEqual(VARIABLES);
  });

  it('removes the secrets file whatever happened', () => {
    const last = steps('deploy').at(-1);
    expect(last).toEqual({ name: 'Remove the secrets file', if: '${{ always() }}', run: `rm -f ${SECRETS_FILE_SHELL}` });
  });
});

describe('the workflow reader', () => {
  it('reads release.yml', () => {
    const wf = parseWorkflowYaml(read('.github/workflows/release.yml'));
    expect(Object.keys(wf.jobs)).toEqual(['build', 'test-oldest-node', 'smoke-windows', 'smoke-node', 'release', 'release-dry-run']);
    expect(wf.on.push.tags).toEqual(['v*']);
    expect(wf.jobs.release.needs).toEqual(['build', 'test-oldest-node', 'smoke-windows', 'smoke-node']);
    expect(wf.jobs.build.steps.find((s) => s.id === 'version').run).toMatch(/^version=\$\(node -p .*\n.*echo "version=\$version" >> "\$GITHUB_OUTPUT"\n$/s);
    expect(wf.jobs['smoke-node'].strategy.matrix.include[1]).toEqual({ name: 'Ubuntu 26.04 nodejs package', os: 'ubuntu-26.04', node: 'ubuntu' });
  });

  it('refuses what it cannot read for certain', () => {
    expect(() => parseWorkflowYaml('a:\n\tb: c\n')).toThrow(/tab/);
    expect(() => parseWorkflowYaml('a: {b: c}\n')).toThrow(/unsupported/);
    expect(() => parseWorkflowYaml('run: echo a: b\n')).toThrow(/unsupported/);
    expect(() => parseWorkflowYaml('a: 1\na: 2\n')).toThrow(/duplicate/);
    expect(() => parseWorkflowYaml('a:\n  - b\n c: d\n')).toThrow(/indentation/);
    expect(parseWorkflowYaml("a: 'it''s' # note\nb: \"x # y\"\nc: |\n  # kept\n  z\n")).toEqual({ a: "it's", b: 'x # y', c: '# kept\nz\n' });
  });
});

// ---------------------------------------------------------------------------
// The scripts
// ---------------------------------------------------------------------------

/** npx as the scripts call it: records its arguments, its folder and environment, and the two files Wrangler would read. */
const FAKE_NPX = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const option = (name) => args.find((a) => a.startsWith(name + '='))?.slice(name.length + 1) ?? null;
const readIf = (file) => (file === null ? null : fs.readFileSync(file, 'utf8'));
fs.appendFileSync(process.env.FAKE_NPX_LOG, JSON.stringify({
  args,
  cwd: process.cwd(),
  env: process.env,
  config: readIf(option('--config')),
  secretsFile: readIf(option('--secrets-file')),
}) + '\\n');
console.log('wrangler (fake): done');
process.exit(Number(process.env.FAKE_NPX_EXIT ?? 0));
`;

/** A copy of what the scripts use, a built web client and the fake npx. */
function checkout({ web = true } = {}) {
  const dir = tmp();
  for (const file of [
    'scripts/ci/deploy-cloudflare.sh',
    'scripts/ci/write-secrets-file.sh',
    'scripts/ci/wrangler-config.mjs',
    'scripts/lib/cloudflare.mjs',
    'scripts/cf/clean-tmp.mjs',
    'wrangler.jsonc',
  ]) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, file), path.join(dir, file));
  }
  if (web) {
    fs.mkdirSync(path.join(dir, 'dist', 'web'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'dist', 'web', 'index.html'), '<!doctype html>');
  }
  fs.mkdirSync(path.join(dir, 'bin'));
  fs.writeFileSync(path.join(dir, 'bin', 'npx'), FAKE_NPX, { mode: 0o755 });
  fs.mkdirSync(path.join(dir, 'elsewhere'));
  return dir;
}

/** Runs scripts/ci/<script> of a checkout from another folder, with only `env` (and PATH). */
function run(dir, script, env = {}, args = []) {
  const log = path.join(dir, 'npx.log');
  fs.rmSync(log, { force: true });
  // stdin is not a socket (Node's pipes are), or bash would read the user's ~/.bashrc as for a remote shell.
  const result = spawnSync('bash', [path.join(dir, 'scripts', 'ci', script), ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: path.join(dir, 'elsewhere'),
    env: {
      PATH: [path.join(dir, 'bin'), path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
      FAKE_NPX_LOG: log,
      ...env,
    },
    encoding: 'utf8',
  });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
  return { status: result.status, out: result.stdout + result.stderr, calls };
}

const WRANGLER = ['--no', '--', 'wrangler', 'deploy'];
const varArgs = (vars) => VARIABLES.filter((n) => n in vars).flatMap((n) => ['--var', `${n}:${vars[n]}`]);

describe.skipIf(process.platform === 'win32')('scripts/ci/write-secrets-file.sh', () => {
  it('writes the secrets that are set to a new file of mode 0600 as JSON, and prints their names only', () => {
    const dir = checkout();
    const file = path.join(dir, 'secrets.json');
    const env = { SETUP_TOKEN: ODD, SMTP_PASS: 'smtp-secret-zq9', RESEND_API_KEY: '' };
    // The caller's umask does not matter.
    const result = spawnSync('bash', ['-c', 'umask 022 && exec bash "$0" "$1"', path.join(dir, 'scripts/ci/write-secrets-file.sh'), file], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: path.join(dir, 'elsewhere'),
      env: { PATH: [path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter), ...env },
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ SETUP_TOKEN: ODD, SMTP_PASS: 'smtp-secret-zq9' });
    expect(result.stdout).toBe(`Wrote SETUP_TOKEN, SMTP_PASS to ${file}.\n`);
    expect(result.stderr).toBe('');
    for (const name of ['pwned', 'pwned2']) {
      expect(fs.existsSync(path.join(dir, 'elsewhere', name))).toBe(false);
    }
  });

  it('leaves out values of white space only, and writes {} when nothing is set', () => {
    const dir = checkout();
    const file = path.join(dir, 'secrets.json');
    const { status, out } = run(dir, 'write-secrets-file.sh', { SETUP_TOKEN: ' \t\n ', SMTP_PASS: '' }, [file]);
    expect(status).toBe(0);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({});
    expect(out).toContain('No secret is set');
  });

  it('never replaces a file, and needs exactly one', () => {
    const dir = checkout();
    const file = path.join(dir, 'secrets.json');
    fs.writeFileSync(file, 'keep');
    const refused = run(dir, 'write-secrets-file.sh', { SETUP_TOKEN: 'setup-secret-k1' }, [file]);
    expect(refused.status).toBe(1);
    expect(refused.out).toContain('exists already');
    expect(refused.out).not.toContain('setup-secret-k1');
    expect(fs.readFileSync(file, 'utf8')).toBe('keep');
    expect(run(dir, 'write-secrets-file.sh', {}, []).status).toBe(2);
    expect(run(dir, 'write-secrets-file.sh', {}, [file, 'more']).status).toBe(2);
  });

  it('does not write RECOVERY_TOKEN', () => {
    const dir = checkout();
    const file = path.join(dir, 'secrets.json');
    expect(run(dir, 'write-secrets-file.sh', { RECOVERY_TOKEN: 'r'.repeat(40), SETUP_TOKEN: 'x' }, [file]).status).toBe(0);
    expect(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')))).toEqual(['SETUP_TOKEN']);
  });
});

describe.skipIf(process.platform === 'win32')('scripts/ci/deploy-cloudflare.sh', () => {
  it('a dry run: wrangler deploy --dry-run in the repository root, with the variables that are set and no secrets', () => {
    const dir = checkout();
    const secrets = path.join(dir, 'secrets.json');
    fs.writeFileSync(secrets, JSON.stringify({ SETUP_TOKEN: 'setup-secret-k1' }));
    const vars = { PUBLIC_URL: 'https://plan.example.com', INSTANCE_NAME: 'Plan', SIGNUP_POLICY: 'invite_only' };
    const { status, out, calls } = run(dir, 'deploy-cloudflare.sh', { DRY_RUN: 'true', LYREN_PREBUILT: '1', SECRETS_FILE: secrets, ...vars });
    expect(status, out).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual([...WRANGLER, '--dry-run', '--outdir', 'dist/worker', ...varArgs(vars)]);
    expect(calls[0].cwd).toBe(dir);
    expect(calls[0].secretsFile).toBeNull();
    expect(calls[0].env.LYREN_PREBUILT).toBe('1');
    expect(out).toContain('Dry run: the Worker is bundled');
    expect(out).toContain('Variables set (3): PUBLIC_URL INSTANCE_NAME SIGNUP_POLICY');
    expect(out).toContain('Secrets: not read for a dry run');
    expect(out).toContain('workers.dev: as wrangler.jsonc says (on; once a custom domain works, WORKERS_DEV=false keeps it off)');
    expect(out).toContain('wrangler (fake): done');
  });

  it('a deploy with secrets: the file goes with the version, and nothing set is printed', () => {
    const dir = checkout();
    const file = path.join(dir, 'secrets.json');
    const secrets = Object.fromEntries(SECRETS.map((n) => [n, `secret-of-${n}-z9`]));
    expect(run(dir, 'write-secrets-file.sh', secrets, [file]).status).toBe(0);
    const vars = Object.fromEntries(VARIABLES.map((n) => [n, `value-of-${n}-q7`]));
    const { status, out, calls } = run(dir, 'deploy-cloudflare.sh', {
      CLOUDFLARE_API_TOKEN: 'cf-token-x3',
      CLOUDFLARE_ACCOUNT_ID: 'cf-account-x4',
      DRY_RUN: 'false',
      LYREN_PREBUILT: '1',
      SECRETS_FILE: file,
      WORKER_NAME: 'lyren-test',
      ...vars,
    });
    expect(status, out).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual([...WRANGLER, '--name=lyren-test', ...varArgs(vars), `--secrets-file=${file}`]);
    expect(JSON.parse(calls[0].secretsFile)).toEqual(secrets);
    // Wrangler gets the token from its environment and no app secret there.
    expect(calls[0].env).toMatchObject({ CLOUDFLARE_API_TOKEN: 'cf-token-x3', CLOUDFLARE_ACCOUNT_ID: 'cf-account-x4' });
    for (const name of SECRETS) expect(calls[0].env[name]).toBeUndefined();
    expect(out).toContain('Deploying to Cloudflare.');
    expect(out).toContain('Worker name: from WORKER_NAME');
    expect(out).toContain(`Variables set (${VARIABLES.length}): ${VARIABLES.join(' ')}`);
    expect(out).toContain(`Secrets set (3): ${SECRETS.join(' ')}`);
    for (const value of [...Object.values(vars), ...Object.values(secrets), 'cf-token-x3', 'cf-account-x4', 'lyren-test']) {
      expect(out).not.toContain(value);
    }
  });

  it('WORKERS_DEV=false: wrangler.deploy.jsonc with workers.dev off next to wrangler.jsonc, removed afterwards', () => {
    const dir = checkout();
    const { status, out, calls } = run(dir, 'deploy-cloudflare.sh', { DRY_RUN: 'true', WORKERS_DEV: 'false' });
    expect(status, out).toBe(0);
    expect(calls[0].args).toEqual([...WRANGLER, '--dry-run', '--outdir', 'dist/worker', '--config=wrangler.deploy.jsonc']);
    const committed = parseJsonc(fs.readFileSync(path.join(dir, 'wrangler.jsonc'), 'utf8'));
    expect(committed.workers_dev).toBe(true);
    expect(parseJsonc(calls[0].config)).toEqual({ ...committed, workers_dev: false });
    expect(fs.existsSync(path.join(dir, 'wrangler.deploy.jsonc'))).toBe(false);
    expect(out).toContain('workers.dev: off (WORKERS_DEV=false)');
    // Any other spelling of yes or no is no mistake; anything else is.
    expect(run(dir, 'deploy-cloudflare.sh', { DRY_RUN: 'TRUE', WORKERS_DEV: ' Off ' }).calls[0].args).toContain('--config=wrangler.deploy.jsonc');
    expect(run(dir, 'deploy-cloudflare.sh', { DRY_RUN: 'true', WORKERS_DEV: 'true' }).calls[0].args).not.toContain('--config=wrangler.deploy.jsonc');
  });

  it('MAIL_TRANSPORT=cloudflare or EMAIL_BINDING=true: wrangler.deploy.jsonc with the send_email binding EMAIL, removed afterwards', () => {
    const dir = checkout();
    const committed = parseJsonc(fs.readFileSync(path.join(dir, 'wrangler.jsonc'), 'utf8'));
    expect(committed.send_email).toBeUndefined();
    const { status, out, calls } = run(dir, 'deploy-cloudflare.sh', { DRY_RUN: 'true', MAIL_TRANSPORT: ' Cloudflare ' });
    expect(status, out).toBe(0);
    expect(calls[0].args).toEqual([...WRANGLER, '--dry-run', '--outdir', 'dist/worker', '--config=wrangler.deploy.jsonc', '--var', 'MAIL_TRANSPORT: Cloudflare ']);
    expect(parseJsonc(calls[0].config)).toEqual({ ...committed, send_email: [{ name: 'EMAIL' }] });
    expect(out).toContain('Email binding: EMAIL, for Cloudflare Email Service (MAIL_TRANSPORT=cloudflare)');
    expect(fs.existsSync(path.join(dir, 'wrangler.deploy.jsonc'))).toBe(false);
    // MAIL_TRANSPORT set in the dashboard instead: EMAIL_BINDING=true, here with workers.dev off as well.
    const both = run(dir, 'deploy-cloudflare.sh', { DRY_RUN: 'true', EMAIL_BINDING: 'yes', WORKERS_DEV: 'false' });
    expect(both.status, both.out).toBe(0);
    expect(both.calls[0].args).toEqual([...WRANGLER, '--dry-run', '--outdir', 'dist/worker', '--config=wrangler.deploy.jsonc']);
    expect(parseJsonc(both.calls[0].config)).toEqual({ ...committed, workers_dev: false, send_email: [{ name: 'EMAIL' }] });
    expect(both.out).toContain('Email binding: EMAIL, for Cloudflare Email Service (EMAIL_BINDING=true)');
    expect(fs.existsSync(path.join(dir, 'wrangler.deploy.jsonc'))).toBe(false);
    // Another transport, none, or EMAIL_BINDING=false: wrangler.jsonc as it is.
    for (const env of [{ MAIL_TRANSPORT: 'smtp' }, {}, { EMAIL_BINDING: 'false' }]) {
      const plain = run(dir, 'deploy-cloudflare.sh', { DRY_RUN: 'true', ...env });
      expect(plain.status, plain.out).toBe(0);
      expect(plain.calls[0].args).not.toContain('--config=wrangler.deploy.jsonc');
      expect(plain.out).toContain('Email binding: as wrangler.jsonc says');
    }
  });

  it('drops empty values and values of white space, and passes others exactly as they are', () => {
    const dir = checkout();
    const vars = { PUBLIC_URL: '', INSTANCE_NAME: '  \t ', MAIL_FROM_NAME: ODD, SMTP_USER: ' padded ' };
    const { status, out, calls } = run(dir, 'deploy-cloudflare.sh', { DRY_RUN: 'true', WORKER_NAME: ' ', SECRETS_FILE: '', ...vars });
    expect(status, out).toBe(0);
    expect(calls[0].args).toEqual([...WRANGLER, '--dry-run', '--outdir', 'dist/worker', '--var', `MAIL_FROM_NAME:${ODD}`, '--var', 'SMTP_USER: padded ']);
    expect(out).toContain('Worker name: from wrangler.jsonc');
    expect(out).toContain('Variables set (2): MAIL_FROM_NAME SMTP_USER');
    expect(out).not.toContain('He said');
    for (const name of ['pwned', 'pwned2']) {
      expect(fs.existsSync(path.join(dir, 'elsewhere', name))).toBe(false);
      expect(fs.existsSync(path.join(dir, name))).toBe(false);
    }
    // Nothing set at all is fine too: the Worker keeps what it has.
    const bare = run(dir, 'deploy-cloudflare.sh', { DRY_RUN: 'true' });
    expect(bare.calls[0].args).toEqual([...WRANGLER, '--dry-run', '--outdir', 'dist/worker']);
    expect(bare.out).toContain('Variables set (0): none; the Worker keeps the ones it has');
  });

  it('a secret value with quotes, $( ), new lines and spaces reaches the file and Wrangler as it is', () => {
    const dir = checkout();
    const file = path.join(dir, 'secrets.json');
    expect(run(dir, 'write-secrets-file.sh', { SMTP_PASS: ODD }, [file]).status).toBe(0);
    const { status, out, calls } = run(dir, 'deploy-cloudflare.sh', { SECRETS_FILE: file });
    expect(status, out).toBe(0);
    expect(calls[0].args).toEqual([...WRANGLER, `--secrets-file=${file}`]);
    expect(JSON.parse(calls[0].secretsFile)).toEqual({ SMTP_PASS: ODD });
    expect(out).not.toContain('He said');
    expect(fs.existsSync(path.join(dir, 'elsewhere', 'pwned'))).toBe(false);
  });

  it('a secrets file that lists none: no --secrets-file, so the Worker keeps its secrets', () => {
    const dir = checkout();
    const file = path.join(dir, 'secrets.json');
    expect(run(dir, 'write-secrets-file.sh', {}, [file]).status).toBe(0);
    const { status, out, calls } = run(dir, 'deploy-cloudflare.sh', { SECRETS_FILE: file });
    expect(status, out).toBe(0);
    expect(calls[0].args).toEqual(WRANGLER);
    expect(out).toContain('Secrets: none set; the Worker keeps the ones it has');
    expect(run(dir, 'deploy-cloudflare.sh', {}).out).toContain('Secrets: none set (no SECRETS_FILE)');
  });

  it('refuses before Wrangler runs: an unknown yes/no, a missing client or secrets file, RECOVERY_TOKEN or another name', () => {
    const dir = checkout();
    const refuse = (env, message) => {
      const { status, out, calls } = run(dir, 'deploy-cloudflare.sh', env);
      expect(status, out).toBe(1);
      expect(out).toContain(message);
      expect(calls).toEqual([]);
      return out;
    };
    refuse({ DRY_RUN: 'maybe' }, 'DRY_RUN must be true or false');
    refuse({ DRY_RUN: 'true', WORKERS_DEV: 'flase' }, 'WORKERS_DEV must be true or false');
    refuse({ DRY_RUN: 'true', EMAIL_BINDING: 'maybe' }, 'EMAIL_BINDING must be true or false');
    // The binding would be gone with this deploy, and every directory request would answer 503.
    refuse({ DRY_RUN: 'true', MAIL_TRANSPORT: 'cloudflare', EMAIL_BINDING: 'off' }, 'MAIL_TRANSPORT=cloudflare sends through the send_email binding EMAIL');
    refuse({ SECRETS_FILE: path.join(dir, 'none.json') }, 'SECRETS_FILE names no file');
    const file = path.join(dir, 'odd.json');
    fs.writeFileSync(file, JSON.stringify({ SETUP_TOKEN: 'setup-secret-k1', RECOVERY_TOKEN: 'recovery-secret-k2' }));
    const out = refuse({ SECRETS_FILE: file }, 'lists RECOVERY_TOKEN, which no deploy sets');
    expect(out).not.toMatch(/secret-k[12]/);
    fs.writeFileSync(file, JSON.stringify({ SETUP_TOKEN: 'setup-secret-k1', OTHER: 'x' }));
    refuse({ SECRETS_FILE: file }, 'lists "OTHER", which is not one of SETUP_TOKEN, SMTP_PASS, RESEND_API_KEY');
    fs.writeFileSync(file, JSON.stringify({ SETUP_TOKEN: '' }));
    refuse({ SECRETS_FILE: file }, 'has no value for SETUP_TOKEN');
    fs.writeFileSync(file, '["setup-secret-k1"]');
    expect(refuse({ SECRETS_FILE: file }, 'does not hold a JSON object')).not.toContain('secret-k1');
    fs.writeFileSync(file, 'SETUP_TOKEN=setup-secret-k1');
    expect(refuse({ SECRETS_FILE: file }, 'is not a JSON file')).not.toContain('secret-k1');
    // LYREN_PREBUILT promises a built client: without one, wrangler.jsonc's build command would run Vite.
    const unbuilt = checkout({ web: false });
    const { status, out: why, calls } = run(unbuilt, 'deploy-cloudflare.sh', { DRY_RUN: 'true', LYREN_PREBUILT: '1' });
    expect(status).toBe(1);
    expect(why).toContain('LYREN_PREBUILT=1, but there is no dist/web/index.html');
    expect(calls).toEqual([]);
  });

  it("ends with Wrangler's exit status, and removes wrangler.deploy.jsonc and an empty .wrangler/tmp anyway", () => {
    const dir = checkout();
    // What Wrangler leaves next to its configuration (Appendix D 40).
    fs.mkdirSync(path.join(dir, '.wrangler', 'tmp'), { recursive: true });
    const { status, calls } = run(dir, 'deploy-cloudflare.sh', { DRY_RUN: 'true', WORKERS_DEV: 'false', FAKE_NPX_EXIT: '3' });
    expect(status).toBe(3);
    expect(calls).toHaveLength(1);
    expect(fs.existsSync(path.join(dir, 'wrangler.deploy.jsonc'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '.wrangler'))).toBe(false);
  });
});
