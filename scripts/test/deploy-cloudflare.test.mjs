// The Cloudflare deploy workflow (.github/workflows/deploy-cloudflare.yml, design §10.10, Appendix D 70) and
// scripts/ci/write-secrets-file.sh, which writes its secrets file. The workflow checks and deploys through
// scripts/cf/wrangler.mjs (scripts/test/cf-wrangler.test.mjs), with the instance configuration the repository
// holds or names (LYREN_INSTANCE_FILE) and no other repository variable. The script runs in a copy, with only
// the environment it is given. actionlint and shellcheck are not part of npm run check: the workflow is read by
// scripts/test/support/workflow-yaml.mjs and checked against release.yml's patterns.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { SECRET_NAMES } from '../lib/instance.mjs';
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

/** A value that a shell would turn into something else anywhere but in a variable or an argument. */
const ODD = `He said "hi" $(touch pwned) \`touch pwned2\` 'x' \\ $HOME ;|& *\nsecond line  `;

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

  it('gives no secret to the check job, which checks the instance configuration and hands on only the built web client', () => {
    expect(JSON.stringify(wf.jobs.check)).not.toMatch(/secrets\.|github\.token/);
    expect(steps('check').map((s) => s.run ?? s.uses.split('@')[0])).toEqual([
      'actions/checkout',
      'actions/setup-node',
      'npm ci --ignore-scripts --no-audit --no-fund',
      'node scripts/cf/wrangler.mjs --validate',
      'npm run check',
      'actions/upload-artifact',
    ]);
    // A bad instance configuration stops the run before anybody approves the deploy job.
    const validate = step('check', 'Check the instance configuration (no secrets in this job)');
    expect(validate).toEqual({
      name: 'Check the instance configuration (no secrets in this job)',
      env: { LYREN_INSTANCE_FILE: '${{ vars.LYREN_INSTANCE_FILE }}' },
      run: 'node scripts/cf/wrangler.mjs --validate',
    });
    expect(step('check', 'Keep the web client').with).toEqual({ name: 'web', path: 'dist/web', 'if-no-files-found': 'error', 'retention-days': '1' });
    expect(step('deploy', 'Download the web client').with).toEqual({ name: 'web', path: 'dist/web' });
  });

  it('runs nothing in the deploy job but the install, the secrets file, the wrapper and the removal of the secrets file', () => {
    expect(steps('deploy').map((s) => s.run ?? s.uses.split('@')[0])).toEqual([
      'actions/checkout',
      'actions/setup-node',
      'npm ci --ignore-scripts --no-audit --no-fund',
      'actions/download-artifact',
      `bash scripts/ci/write-secrets-file.sh ${SECRETS_FILE_SHELL}`,
      'node scripts/cf/wrangler.mjs deploy --dry-run --outdir dist/worker',
      `node scripts/cf/wrangler.mjs deploy --secrets-file=${SECRETS_FILE_SHELL}`,
      `rm -f ${SECRETS_FILE_SHELL}`,
    ]);
  });

  it('gives the app secrets to the secrets-file step alone, and only for a deploy', () => {
    const write = step('deploy', 'Write the app secrets to a private file');
    expect(write.if).toBe('${{ !inputs.dry_run }}');
    expect(write.env).toEqual(Object.fromEntries(SECRET_NAMES.map((n) => [n, `\${{ secrets.${n} }}`])));
    // Every secret the workflow names is in one of the two steps.
    const named = (s) => [...JSON.stringify(s).matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]);
    const deploy = step('deploy', 'Deploy');
    expect(allSteps.filter((s) => named(s).length > 0)).toEqual([write, deploy]);
    expect(named(deploy).sort()).toEqual(['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN']);
    // RECOVERY_TOKEN is set by hand only while it is needed; MAIL_LOG_BODIES is for development only.
    for (const name of ['RECOVERY_TOKEN', 'MAIL_LOG_BODIES']) expect(JSON.stringify(wf), name).not.toContain(name);
  });

  it('a dry run: the wrapper with the prebuilt client and the instance configuration, and no token at all', () => {
    const dry = step('deploy', 'Dry run');
    expect(dry).toEqual({
      name: 'Dry run',
      if: '${{ inputs.dry_run }}',
      env: { LYREN_PREBUILT: '1', LYREN_INSTANCE_FILE: '${{ vars.LYREN_INSTANCE_FILE }}' },
      run: 'node scripts/cf/wrangler.mjs deploy --dry-run --outdir dist/worker',
    });
    expect(JSON.stringify(dry)).not.toContain('secrets.');
  });

  it('a deploy: the wrapper with the Cloudflare token, the prebuilt client, the instance configuration and the secrets file', () => {
    expect(step('deploy', 'Deploy')).toEqual({
      name: 'Deploy',
      if: '${{ !inputs.dry_run }}',
      env: {
        CLOUDFLARE_API_TOKEN: '${{ secrets.CLOUDFLARE_API_TOKEN }}',
        CLOUDFLARE_ACCOUNT_ID: '${{ secrets.CLOUDFLARE_ACCOUNT_ID }}',
        LYREN_PREBUILT: '1',
        LYREN_INSTANCE_FILE: '${{ vars.LYREN_INSTANCE_FILE }}',
      },
      run: `node scripts/cf/wrangler.mjs deploy --secrets-file=${SECRETS_FILE_SHELL}`,
    });
  });

  it("reads no repository variable but LYREN_INSTANCE_FILE: the deployment's settings are its instance configuration", () => {
    const code = text.replace(/^\s*#.*$/gm, '');
    const variables = [...code.matchAll(/\bvars\.[\w-]+/g)].map((m) => m[0]);
    expect(variables).toEqual(['vars.LYREN_INSTANCE_FILE', 'vars.LYREN_INSTANCE_FILE', 'vars.LYREN_INSTANCE_FILE']);
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
// The secrets file
// ---------------------------------------------------------------------------

/** A copy of scripts/ci/write-secrets-file.sh, and a folder to run it from. */
function checkout() {
  const dir = tmp();
  const file = 'scripts/ci/write-secrets-file.sh';
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.copyFileSync(path.join(ROOT, file), path.join(dir, file));
  fs.mkdirSync(path.join(dir, 'elsewhere'));
  return dir;
}

/** Runs scripts/ci/<script> of a checkout from another folder, with only `env` (and PATH). */
function run(dir, script, env = {}, args = []) {
  // stdin is not a socket (Node's pipes are), or bash would read the user's ~/.bashrc as for a remote shell.
  const result = spawnSync('bash', [path.join(dir, 'scripts', 'ci', script), ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: path.join(dir, 'elsewhere'),
    env: { PATH: [path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter), ...env },
    encoding: 'utf8',
  });
  return { status: result.status, out: result.stdout + result.stderr };
}

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

  it('writes every name of SECRET_NAMES, which a secrets file of scripts/cf/wrangler.mjs may list, in that order', () => {
    const dir = checkout();
    const file = path.join(dir, 'secrets.json');
    const secrets = Object.fromEntries(SECRET_NAMES.map((n) => [n, `secret-of-${n}-z9`]));
    const { status, out } = run(dir, 'write-secrets-file.sh', { ...secrets, OTHER_SECRET: 'other-z9' }, [file]);
    expect(status, out).toBe(0);
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(written).toEqual(secrets);
    expect(Object.keys(written)).toEqual(SECRET_NAMES);
    expect(out).toBe(`Wrote ${SECRET_NAMES.join(', ')} to ${file}.\n`);
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
