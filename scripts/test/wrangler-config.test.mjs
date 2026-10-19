// The Wrangler configurations and the scripts around them (design §10.8-§10.10, Appendix D 45 and 48).
// Workers Static Assets answer every path that run_worker_first does not list before the Worker runs, and
// "/api/*" does not match "/api" itself, which the SPA's index.html then answered with 200 under wrangler dev,
// where Node's gateway answers it as an API path. The workers tests reach the Worker through SELF.fetch, which
// skips the asset router, so only this checks the list. Also: reading .jsonc (scripts/lib/cloudflare.mjs),
// the deploy configuration of scripts/ci/wrangler-config.mjs, and when scripts/cf/build-web.mjs builds.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { DEPLOY_CONFIG, deployConfig, parseJsonc, prebuiltWebReason, stripJsonc } from '../lib/cloudflare.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const dirs = [];
afterAll(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lyren-wrangler-'));
  dirs.push(d);
  return d;
}

/** A folder holding copies of the repository's `files`. */
function copyOf(files) {
  const dir = tmp();
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, file), path.join(dir, file));
  }
  return dir;
}

describe('the Wrangler configurations', () => {
  it.each(['wrangler.jsonc', 'server/test-workers/wrangler.test.jsonc'])('%s runs the Worker first for /api and /api/*', (file) => {
    expect(parseJsonc(read(file)).assets.run_worker_first).toEqual(['/api', '/api/*']);
  });

  it('wrangler.jsonc holds nothing of one deployment (§10.8)', () => {
    const config = parseJsonc(read('wrangler.jsonc'));
    for (const key of ['account_id', 'routes', 'route', 'vars', 'env']) expect(config[key], key).toBeUndefined();
    expect(config).toMatchObject({ name: 'lyren-plan', workers_dev: true, keep_vars: true, preview_urls: false, send_metrics: false });
    expect(config.build).toEqual({ command: 'node scripts/cf/build-web.mjs', watch_dir: 'web/src' });
  });

  it('the deploy configuration is git-ignored, as are local ones', () => {
    const ignored = read('.gitignore').split('\n');
    for (const name of [DEPLOY_CONFIG, 'wrangler.local.jsonc', '.dev.vars', '.wrangler/']) expect(ignored).toContain(name);
  });

  it('.dev.vars.example has SETUP_TOKEN as its only active line, which the Deploy button asks for (§10.8)', () => {
    const active = read('.dev.vars.example')
      .split('\n')
      .filter((line) => line.trim() !== '' && !line.trimStart().startsWith('#'));
    expect(active).toEqual(['SETUP_TOKEN=']);
    expect(Object.keys(JSON.parse(read('package.json')).cloudflare.bindings)).toEqual(['SETUP_TOKEN']);
  });
});

describe('reading .jsonc', () => {
  it('drops comments outside strings and trailing commas, and keeps strings as they are', () => {
    const text = `{
  // a comment
  "url": "https://plan.example.com", // after a value
  /* a block
     comment */ "glob": "/api/*",
  "quote": "a \\"// not a comment\\" b",
  "list": [1, 2, /* x */ ],
  "nested": { "a": 1, },
}`;
    expect(parseJsonc(text)).toEqual({
      url: 'https://plan.example.com',
      glob: '/api/*',
      quote: 'a "// not a comment" b',
      list: [1, 2],
      nested: { a: 1 },
    });
    expect(stripJsonc('["a,", "]"]')).toBe('["a,", "]"]');
    expect(() => stripJsonc('{ /* open')).toThrow(/Unterminated/);
    expect(() => stripJsonc('{ "open')).toThrow(/Unterminated/);
  });
});

describe('the deploy configuration (WORKERS_DEV=false, EMAIL_BINDING)', () => {
  const OFF = { workersDev: false };
  const EMAIL = { emailBinding: true };

  it('is wrangler.jsonc with workers_dev false and everything else unchanged', () => {
    const committed = parseJsonc(read('wrangler.jsonc'));
    const text = deployConfig(read('wrangler.jsonc'), OFF);
    expect(text.startsWith('// Written by scripts/ci/wrangler-config.mjs')).toBe(true);
    expect(text).toContain('the same configuration with workers_dev false.');
    const deploy = parseJsonc(text);
    expect(deploy).toEqual({ ...committed, workers_dev: false });
    expect(Object.keys(deploy)).toEqual(Object.keys(committed));
    expect(parseJsonc(deployConfig('{ "name": "x" }', OFF))).toEqual({ name: 'x', workers_dev: false });
    expect(() => deployConfig('[]', OFF)).toThrow(/object/);
    expect(() => deployConfig('{ "name": "x" }')).toThrow(/needs workersDev false or emailBinding true/);
  });

  it('adds the send_email binding EMAIL of MAIL_TRANSPORT=cloudflare, which wrangler.jsonc does not have (Appendix D 68)', () => {
    const committed = parseJsonc(read('wrangler.jsonc'));
    expect(committed.send_email).toBeUndefined();
    const text = deployConfig(read('wrangler.jsonc'), EMAIL);
    expect(text).toContain('the same configuration with the send_email binding EMAIL.');
    expect(parseJsonc(text)).toEqual({ ...committed, send_email: [{ name: 'EMAIL' }] });
    expect(parseJsonc(deployConfig(read('wrangler.jsonc'), { ...OFF, ...EMAIL }))).toEqual({ ...committed, workers_dev: false, send_email: [{ name: 'EMAIL' }] });
    // A fork's own binding of that name stays as it is (it may be restricted); others stay next to it.
    const own = { name: 'x', send_email: [{ name: 'EMAIL', allowed_sender_addresses: ['plan@example.com'] }] };
    expect(parseJsonc(deployConfig(JSON.stringify(own), EMAIL))).toEqual(own);
    expect(parseJsonc(deployConfig('{ "name": "x", "send_email": [{ "name": "OTHER" }] }', EMAIL)).send_email).toEqual([{ name: 'OTHER' }, { name: 'EMAIL' }]);
    expect(() => deployConfig('{ "name": "x", "send_email": { "name": "EMAIL" } }', EMAIL)).toThrow(/not a list/);
  });

  it('scripts/ci/wrangler-config.mjs writes it next to wrangler.jsonc', () => {
    const dir = copyOf(['scripts/ci/wrangler-config.mjs', 'scripts/lib/cloudflare.mjs', 'wrangler.jsonc']);
    const cli = (...args) => spawnSync(process.execPath, [path.join(dir, 'scripts/ci/wrangler-config.mjs'), ...args], { cwd: os.tmpdir(), encoding: 'utf8' });
    const written = () => fs.readFileSync(path.join(dir, DEPLOY_CONFIG), 'utf8');
    const result = cli('--workers-dev=false');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(`Wrote ${DEPLOY_CONFIG}: wrangler.jsonc with workers_dev false\n`);
    expect(written()).toBe(deployConfig(read('wrangler.jsonc'), OFF));
    const email = cli('--email-binding');
    expect(email.status, email.stderr).toBe(0);
    expect(email.stdout).toBe(`Wrote ${DEPLOY_CONFIG}: wrangler.jsonc with the send_email binding EMAIL\n`);
    expect(written()).toBe(deployConfig(read('wrangler.jsonc'), EMAIL));
    const both = cli('--email-binding', '--workers-dev=false');
    expect(both.status, both.stderr).toBe(0);
    expect(both.stdout).toBe(`Wrote ${DEPLOY_CONFIG}: wrangler.jsonc with workers_dev false and the send_email binding EMAIL\n`);
    expect(written()).toBe(deployConfig(read('wrangler.jsonc'), { ...OFF, ...EMAIL }));
    for (const args of [[], ['--workers-dev=true'], ['--email-binding', '--email-binding'], ['--email-binding=false']]) {
      const refused = cli(...args);
      expect(refused.status, args.join(' ')).toBe(2);
      expect(refused.stderr).toContain('Usage: node scripts/ci/wrangler-config.mjs');
    }
  });
});

describe('the web build of wrangler.jsonc (scripts/cf/build-web.mjs, Appendix D 48)', () => {
  const at = (indexMtime, checkoutMtime = 1000) => ({ indexMtime, checkoutMtime });

  it('keeps a built client with LYREN_PREBUILT=1, and one Workers Builds built after the checkout', () => {
    expect(prebuiltWebReason({ LYREN_PREBUILT: '1' }, at(1))).toBe('LYREN_PREBUILT=1');
    expect(prebuiltWebReason({ WORKERS_CI: '1' }, at(2000))).toBe('Workers Builds built it already (WORKERS_CI=1)');
  });

  it('builds otherwise: no client yet, one older than the checkout, or a local build', () => {
    expect(prebuiltWebReason({ LYREN_PREBUILT: '1', WORKERS_CI: '1' }, at(null))).toBeNull();
    expect(prebuiltWebReason({ WORKERS_CI: '1' }, at(1000))).toBeNull();
    expect(prebuiltWebReason({ WORKERS_CI: '1' }, at(999))).toBeNull();
    expect(prebuiltWebReason({ WORKERS_CI: '1' }, at(2000, null))).toBeNull();
    expect(prebuiltWebReason({}, at(2000))).toBeNull();
    expect(prebuiltWebReason({ LYREN_PREBUILT: 'true', WORKERS_CI: 'true' }, at(2000))).toBeNull();
  });

  it.skipIf(process.platform === 'win32')('runs npm run build:web only when it must, once per Workers Builds deploy', () => {
    const dir = copyOf(['scripts/cf/build-web.mjs', 'scripts/lib/cloudflare.mjs', 'scripts/lib/npm-run.mjs', 'package.json']);
    const log = path.join(dir, 'npm.log');
    fs.mkdirSync(path.join(dir, 'bin'));
    fs.writeFileSync(path.join(dir, 'bin', 'npm'), `#!/bin/sh\necho "$*" >> "${log}"\n`, { mode: 0o755 });
    const build = (env) => {
      fs.rmSync(log, { force: true });
      const result = spawnSync(process.execPath, [path.join(dir, 'scripts/cf/build-web.mjs')], {
        cwd: dir,
        // No npm_execpath: npm is the fake on PATH.
        env: { PATH: [path.join(dir, 'bin'), '/usr/bin', '/bin'].join(path.delimiter), ...env },
        encoding: 'utf8',
      });
      expect(result.status, result.stderr).toBe(0);
      return { out: result.stdout, npm: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '' };
    };
    // Workers Builds: the clone, then the build command (npm run build), then npx wrangler deploy.
    const index = path.join(dir, 'dist', 'web', 'index.html');
    expect(build({ WORKERS_CI: '1' }).npm).toBe('run build:web\n');
    fs.mkdirSync(path.dirname(index), { recursive: true });
    fs.writeFileSync(index, '<!doctype html>');
    fs.utimesSync(path.join(dir, 'package.json'), new Date(1_700_000_000_000), new Date(1_700_000_000_000));
    expect(build({ WORKERS_CI: '1' })).toEqual({ out: 'build-web: Workers Builds built it already (WORKERS_CI=1), using the web client already in dist/web\n', npm: '' });
    expect(build({ LYREN_PREBUILT: '1' }).npm).toBe('');
    expect(build({}).npm).toBe('run build:web\n');
    // A client from before the checkout is built again.
    fs.utimesSync(index, new Date(1_600_000_000_000), new Date(1_600_000_000_000));
    expect(build({ WORKERS_CI: '1' }).npm).toBe('run build:web\n');
  });
});
