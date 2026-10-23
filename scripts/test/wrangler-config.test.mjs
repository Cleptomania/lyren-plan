// The Wrangler configurations and the scripts around them (design §10.8-§10.10, Appendix D 45 and 48).
// Workers Static Assets answer every path that run_worker_first does not list before the Worker runs, and
// "/api/*" does not match "/api" itself, which the SPA's index.html then answered with 200 under wrangler dev,
// where Node's gateway answers it as an API path. The workers tests reach the Worker through SELF.fetch, which
// skips the asset router, so only this checks the list. Also: reading .jsonc (scripts/lib/cloudflare.mjs), the
// names of the generated configurations, package.json's Cloudflare scripts, when scripts/cf/build-web.mjs builds,
// and which Wrangler runs it refuses (Appendix D 70), against the pinned Wrangler itself, offline.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  DEPLOY_CONFIG_PATTERN,
  deployConfigName,
  LEGACY_DEPLOY_CONFIG,
  parseJsonc,
  prebuiltWebReason,
  stripJsonc,
  wranglerRunRefusal,
} from '../lib/cloudflare.mjs';

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
    for (const key of ['account_id', 'routes', 'route', 'vars', 'env', 'send_email', 'secrets', 'limits']) expect(config[key], key).toBeUndefined();
    expect(config).toMatchObject({ name: 'lyren-plan', workers_dev: true, keep_vars: true, preview_urls: false, send_metrics: false });
    expect(config.build).toEqual({ command: 'node scripts/cf/build-web.mjs', watch_dir: 'web/src' });
  });

  it('the generated configurations are git-ignored, as are local ones and instance configurations but the example', () => {
    const ignored = read('.gitignore').split('\n');
    for (const name of ['wrangler.deploy*.jsonc', 'wrangler.local.jsonc', '.dev.vars', '.wrangler/', 'wrangler.instance*.jsonc', '!wrangler.instance.example.jsonc']) {
      expect(ignored).toContain(name);
    }
    // The exception after the pattern it excepts from, or git ignores the example as well.
    expect(ignored.indexOf('!wrangler.instance.example.jsonc')).toBeGreaterThan(ignored.indexOf('wrangler.instance*.jsonc'));
    const docker = read('.dockerignore').split('\n');
    for (const name of ['wrangler.instance*.jsonc', 'wrangler.deploy*.jsonc', 'wrangler.local.jsonc', '.dev.vars', '.wrangler']) expect(docker).toContain(name);
    // wrangler.deploy*.jsonc as git matches it: each run's file, and the one an earlier version wrote.
    const glob = /^wrangler\.deploy[^/]*\.jsonc$/;
    for (const name of [deployConfigName('0123abcd'), LEGACY_DEPLOY_CONFIG]) expect(name).toMatch(glob);
    expect('wrangler.jsonc').not.toMatch(glob);
  });

  it('each run generates a configuration of its own name, next to wrangler.jsonc', () => {
    expect(deployConfigName('0123abcd')).toBe('wrangler.deploy.0123abcd.jsonc');
    expect(deployConfigName('0123abcd')).toMatch(DEPLOY_CONFIG_PATTERN);
    for (const id of ['0123ABCD', '0123abc', '0123abcde', '../x1234', undefined]) {
      expect(() => deployConfigName(id), String(id)).toThrow('deployConfigName needs 8 hexadecimal digits');
    }
    for (const name of [LEGACY_DEPLOY_CONFIG, 'wrangler.deploy.0123abcd.jsonc.bak', 'wrangler.deploy.mine.jsonc', 'wrangler.jsonc']) {
      expect(name).not.toMatch(DEPLOY_CONFIG_PATTERN);
    }
  });

  it("package.json's Cloudflare scripts: the wrapper for every run but npm run dev:cf, and no postcheck:cf", () => {
    const { scripts } = JSON.parse(read('package.json'));
    expect(scripts).toMatchObject({
      'check:cf': 'node scripts/cf/wrangler.mjs deploy --dry-run --outdir dist/worker',
      'deploy:cf': 'node scripts/cf/wrangler.mjs deploy',
      // What the Deploy button and Workers Builds fill in as the deploy command.
      deploy: 'node scripts/cf/wrangler.mjs deploy',
      cf: 'node scripts/cf/wrangler.mjs',
      // wrangler.jsonc and .dev.vars, never an instance configuration.
      'dev:cf': 'wrangler dev --ip 127.0.0.1 --port 8787',
    });
    expect(scripts['postcheck:cf']).toBeUndefined();
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

  it('keeps every position: comments and dropped commas become spaces, line breaks stay', () => {
    const comment = '// a comment, with "quotes" and a , comma';
    const text = `{\r\n  ${comment}\r\n  "a": [1, /* x\n y */ 2, ],\n  "b": "// /* kept */",\n}`;
    const json = stripJsonc(text);
    const blank = (s) => ' '.repeat(s.length);
    expect(json).toBe(`{\r\n  ${blank(comment)}\r\n  "a": [1, ${blank('/* x')}\n${blank(' y */')} 2  ],\n  "b": "// /* kept */" \n}`);
    expect(json.length).toBe(text.length);
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '\n' || text[i] === '\r') expect(json[i], `line break at ${i}`).toBe(text[i]);
    }
    expect(JSON.parse(json)).toEqual({ a: [1, 2], b: '// /* kept */' });
  });

  it("names the file's own line and column in a syntax error after comments", () => {
    const text = `{
  // Lyren Plan
  /* two
     lines */
  "name": "plan",
  "vars": { "A": "1" "B": "2" }
}`;
    expect(() => parseJsonc(text)).toThrow(/\(line 6 column 22\)/);
    expect(() => parseJsonc('{\n  "a": [1, ], // x, y\n  /* z */ "b": 2\n  "c": 3\n}')).toThrow(/\(line 4 column 3\)/);
    expect(() => stripJsonc('{\n  // x\n  "a": "open\n}')).toThrow('Unterminated string (line 3 column 8)');
    expect(() => stripJsonc('{\n  "a": 1 /* open\n}')).toThrow('Unterminated /* comment (line 2 column 10)');
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

describe('the guard of the build command against runs without the instance configuration (Appendix D 70)', () => {
  const TOKEN = 'c'.repeat(32);
  const present = { instancePresent: true, source: 'wrangler.instance.jsonc' };
  const absent = { instancePresent: false, source: null };

  it('refuses a deploy, versions upload or any command but dev and types that the wrapper did not start, with an instance configuration', () => {
    expect(wranglerRunRefusal({ WRANGLER_COMMAND: 'deploy' }, [], present)).toBe(
      '::error::This checkout has an instance configuration (wrangler.instance.jsonc), but this wrangler deploy does not use it: ' +
        'deploy with npm run deploy:cf (in Workers Builds: Settings → Build → Deploy command). Nothing was uploaded.',
    );
    const elsewhere = { instancePresent: true, source: 'LYREN_INSTANCE_FILE' };
    expect(wranglerRunRefusal({ WRANGLER_COMMAND: 'versions upload' }, [], elsewhere)).toContain('(LYREN_INSTANCE_FILE), but this wrangler versions upload does not use it');
    // In Workers Builds as well, once the copy has one: its deploy command must be the wrapper's.
    expect(wranglerRunRefusal({ WRANGLER_COMMAND: 'deploy', WORKERS_CI: '1' }, [], present)).not.toBeNull();
    // Another run's token, the token in only one of the two places, or an empty one.
    const deploy = (env, argv) => wranglerRunRefusal({ WRANGLER_COMMAND: 'deploy', ...env }, argv, present);
    expect(deploy({ LYREN_WRANGLER_RUN: TOKEN }, [`--run=${'d'.repeat(32)}`])).not.toBeNull();
    expect(deploy({ LYREN_WRANGLER_RUN: TOKEN }, [])).not.toBeNull();
    expect(deploy({}, [`--run=${TOKEN}`])).not.toBeNull();
    expect(deploy({ LYREN_WRANGLER_RUN: TOKEN }, [`--run=${TOKEN}x`])).not.toBeNull();
    expect(deploy({ LYREN_WRANGLER_RUN: '' }, ['--run='])).not.toBeNull();
    expect(deploy({ LYREN_WRANGLER_RUN: ' ' }, ['--run= '])).not.toBeNull();
    // A command a later Wrangler may hand on.
    expect(wranglerRunRefusal({ WRANGLER_COMMAND: 'build' }, [], present)).toContain('this wrangler build does not use it');
  });

  it("lets dev, types, an unset WRANGLER_COMMAND, this run's token and a checkout without an instance configuration through", () => {
    for (const command of ['dev', 'types', '', ' ', undefined]) expect(wranglerRunRefusal({ WRANGLER_COMMAND: command }, [], present), String(command)).toBeNull();
    for (const command of ['deploy', 'versions upload']) {
      expect(wranglerRunRefusal({ WRANGLER_COMMAND: command, LYREN_WRANGLER_RUN: TOKEN }, [`--run=${TOKEN}`], present)).toBeNull();
      // wrangler.jsonc as it is, as before: a checkout without one, or the Deploy button's first build.
      expect(wranglerRunRefusal({ WRANGLER_COMMAND: command }, [], absent)).toBeNull();
      expect(wranglerRunRefusal({ WRANGLER_COMMAND: command, WORKERS_CI: '1' }, [], absent)).toBeNull();
    }
  });

  it.skipIf(process.platform === 'win32')('build-web refuses before it builds, with wrangler.instance.jsonc in the checkout or LYREN_INSTANCE_FILE', () => {
    const dir = copyOf(['scripts/cf/build-web.mjs', 'scripts/lib/cloudflare.mjs', 'scripts/lib/npm-run.mjs', 'package.json']);
    const log = path.join(dir, 'npm.log');
    fs.mkdirSync(path.join(dir, 'bin'));
    fs.writeFileSync(path.join(dir, 'bin', 'npm'), `#!/bin/sh\necho "$*" >> "${log}"\n`, { mode: 0o755 });
    const build = (env, args = []) => {
      fs.rmSync(log, { force: true });
      const result = spawnSync(process.execPath, [path.join(dir, 'scripts/cf/build-web.mjs'), ...args], {
        cwd: os.tmpdir(),
        env: { PATH: [path.join(dir, 'bin'), '/usr/bin', '/bin'].join(path.delimiter), ...env },
        encoding: 'utf8',
      });
      return { status: result.status, out: result.stdout, err: result.stderr, npm: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '' };
    };
    const built = { status: 0, out: '', err: '', npm: 'run build:web\n' };
    const refused = (source, command) => ({
      status: 1,
      out: '',
      err: expect.stringContaining(`::error::This checkout has an instance configuration (${source}), but this wrangler ${command} does not use it`),
      npm: '',
    });
    // No instance configuration: as before.
    expect(build({ WRANGLER_COMMAND: 'deploy' })).toEqual(built);
    expect(build({ WRANGLER_COMMAND: 'deploy', LYREN_INSTANCE_FILE: '  ' })).toEqual(built);
    expect(build({ WRANGLER_COMMAND: 'deploy', LYREN_INSTANCE_FILE: '/elsewhere/plan.jsonc' })).toEqual(refused('LYREN_INSTANCE_FILE', 'deploy'));
    fs.writeFileSync(path.join(dir, 'wrangler.instance.jsonc'), '{ "name": "plan" }');
    expect(build({ WRANGLER_COMMAND: 'versions upload' })).toEqual(refused('wrangler.instance.jsonc', 'versions upload'));
    // Before a built client is kept: the refusal does not depend on what is built.
    fs.mkdirSync(path.join(dir, 'dist', 'web'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'dist', 'web', 'index.html'), '<!doctype html>');
    expect(build({ WRANGLER_COMMAND: 'deploy', LYREN_PREBUILT: '1' })).toEqual(refused('wrangler.instance.jsonc', 'deploy'));
    expect(build({ WRANGLER_COMMAND: 'deploy', LYREN_PREBUILT: '1', LYREN_WRANGLER_RUN: TOKEN }, [`--run=${TOKEN}`])).toEqual({
      ...built,
      out: 'build-web: LYREN_PREBUILT=1, using the web client already in dist/web\n',
      npm: '',
    });
    expect(build({ WRANGLER_COMMAND: 'deploy', LYREN_WRANGLER_RUN: TOKEN }, [`--run=${TOKEN}`])).toEqual(built);
    expect(build({ WRANGLER_COMMAND: 'dev' })).toEqual(built);
    expect(build({ WRANGLER_COMMAND: 'types' })).toEqual(built);
    expect(build({})).toEqual(built);
  });

  /** Runs the pinned Wrangler in `dir`, offline: no account, no metrics, no banner (its update check), its files in a temporary home. */
  function wrangler(dir, args, env = {}) {
    const home = tmp();
    const result = spawnSync(process.execPath, [path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js'), ...args], {
      cwd: dir,
      env: {
        PATH: [path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
        HOME: home,
        XDG_CONFIG_HOME: path.join(home, 'config'),
        WRANGLER_LOG_PATH: path.join(home, 'logs'),
        TMPDIR: home,
        WRANGLER_SEND_METRICS: 'false',
        WRANGLER_HIDE_BANNER: 'true',
        ...env,
      },
      encoding: 'utf8',
      timeout: 60_000,
    });
    return { status: result.status, out: `${result.stdout}${result.stderr}` };
  }
  const WORKER = 'export default { fetch: () => new Response("ok") };\n';
  const fixture = (build) => ({ name: 'guard-probe', main: 'index.js', compatibility_date: '2025-01-01', build: { command: build } });

  it.skipIf(process.platform === 'win32')(
    'the pinned Wrangler hands WRANGLER_COMMAND to the build command: deploy, versions upload, types; a failing build stops it',
    () => {
      const dir = tmp();
      fs.writeFileSync(path.join(dir, 'index.js'), WORKER);
      fs.writeFileSync(
        path.join(dir, 'record.mjs'),
        `import fs from 'node:fs';
fs.appendFileSync(new URL('./record.log', import.meta.url), JSON.stringify({ command: process.env.WRANGLER_COMMAND ?? null, argv: process.argv.slice(2) }) + '\\n');
process.exit(Number(process.env.RECORD_EXIT ?? 0));
`,
      );
      fs.writeFileSync(path.join(dir, 'wrangler.jsonc'), JSON.stringify(fixture('node record.mjs --run=probe')));
      const records = () => fs.readFileSync(path.join(dir, 'record.log'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      for (const command of [['deploy'], ['versions', 'upload']]) {
        const { status, out } = wrangler(dir, [...command, '--dry-run', '--outdir', 'out']);
        expect(status, out).toBe(0);
        expect(fs.existsSync(path.join(dir, 'out', 'index.js')), out).toBe(true);
        fs.rmSync(path.join(dir, 'out'), { recursive: true });
      }
      // wrangler types runs the build command too, offline (no runtime types: those need workerd).
      const types = wrangler(dir, ['types', path.join(dir, 'types.d.ts'), '--include-runtime=false']);
      expect(types.status, types.out).toBe(0);
      expect(fs.existsSync(path.join(dir, 'types.d.ts')), types.out).toBe(true);
      expect(records()).toEqual([
        { command: 'deploy', argv: ['--run=probe'] },
        { command: 'versions upload', argv: ['--run=probe'] },
        { command: 'types', argv: ['--run=probe'] },
      ]);
      // A build command that fails stops Wrangler before it bundles anything.
      const failed = wrangler(dir, ['deploy', '--dry-run', '--outdir', 'out'], { RECORD_EXIT: '1' });
      expect(failed.status, failed.out).toBe(1);
      expect(fs.existsSync(path.join(dir, 'out'))).toBe(false);
      expect(records()).toHaveLength(4);
    },
    60_000,
  );

  it.skipIf(process.platform === 'win32')(
    "with an instance configuration, the pinned Wrangler stops at build-web unless the wrapper's run token is there",
    () => {
      const dir = copyOf(['scripts/cf/build-web.mjs', 'scripts/lib/cloudflare.mjs', 'scripts/lib/npm-run.mjs', 'package.json']);
      fs.writeFileSync(path.join(dir, 'index.js'), WORKER);
      fs.mkdirSync(path.join(dir, 'dist', 'web'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'dist', 'web', 'index.html'), '<!doctype html>');
      fs.writeFileSync(path.join(dir, 'wrangler.jsonc'), JSON.stringify(fixture('node scripts/cf/build-web.mjs')));
      // What scripts/cf/wrangler.mjs generates: the build command with this run's token.
      const generated = deployConfigName('0123abcd');
      fs.writeFileSync(path.join(dir, generated), JSON.stringify(fixture(`node scripts/cf/build-web.mjs --run=${TOKEN}`)));
      fs.writeFileSync(path.join(dir, 'wrangler.instance.jsonc'), '{ "name": "plan" }');
      for (const command of [['deploy'], ['versions', 'upload']]) {
        for (const [args, env] of [
          [[], {}],
          // A leftover generated configuration, or the token alone, is no run of the wrapper.
          [[`--config=${generated}`], {}],
          [[], { LYREN_WRANGLER_RUN: TOKEN }],
        ]) {
          const refused = wrangler(dir, [...command, '--dry-run', '--outdir', 'out', ...args], { LYREN_PREBUILT: '1', ...env });
          expect(refused.status, refused.out).toBe(1);
          expect(refused.out).toContain(`::error::This checkout has an instance configuration (wrangler.instance.jsonc), but this wrangler ${command.join(' ')} does not use it`);
          expect(fs.existsSync(path.join(dir, 'out'))).toBe(false);
        }
        const passed = wrangler(dir, [...command, '--dry-run', '--outdir', 'out', `--config=${generated}`], { LYREN_PREBUILT: '1', LYREN_WRANGLER_RUN: TOKEN });
        expect(passed.status, passed.out).toBe(0);
        expect(passed.out).toContain('build-web: LYREN_PREBUILT=1, using the web client already in dist/web');
        expect(fs.existsSync(path.join(dir, 'out', 'index.js'))).toBe(true);
        fs.rmSync(path.join(dir, 'out'), { recursive: true });
      }
    },
    60_000,
  );
});
