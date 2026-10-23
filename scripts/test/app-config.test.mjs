// The app's configuration check (scripts/lib/app-config.mjs, design §5.4): the parser a deploy runs is the app's
// own parseAppConfig, bundled by Wrangler's esbuild from server/src and shared/src alone, and a bundle that reaches
// anything else is refused at run time; the check derives the secrets the app asks for from its own errors,
// reports settings a configuration does not read, and never repeats a value.

import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseAppConfig as sourceParseAppConfig, SIGNUP_SEED_WARNING } from '../../server/src/core/config.ts';
import { checkAppConfig, loadAppConfigParser } from '../lib/app-config.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const dirs = [];
afterAll(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lyren-app-config-'));
  dirs.push(d);
  return d;
}

/** Wrangler's esbuild, as the module resolves it, and the version Wrangler pins. */
const wranglerPackage = path.join(ROOT, 'node_modules', 'wrangler', 'package.json');
const wranglerEsbuild = createRequire(wranglerPackage)('esbuild');
const pinnedEsbuild = JSON.parse(fs.readFileSync(wranglerPackage, 'utf8')).dependencies.esbuild;

/** A resolveEsbuild that hands out Wrangler's esbuild and records each build (root, options, result). */
function recording() {
  const builds = [];
  const resolveEsbuild = (root) => ({
    build: async (options) => {
      const result = await wranglerEsbuild.build(options);
      builds.push({ root, options, result });
      return result;
    },
  });
  return { builds, resolveEsbuild };
}

/** A checkout holding `files` ({path: text}) and a tsconfig.worker.json with the @shared alias. */
function fixture(files) {
  const dir = tmp();
  const all = {
    'tsconfig.worker.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@shared/*': ['shared/src/*'] } } }),
    ...files,
  };
  for (const [file, text] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
  return dir;
}

/** A server/src/core/config.ts whose parseAppConfig returns `expression`, after `imports`. */
const parserFile = (imports, expression) =>
  `${imports}\nexport class ConfigError extends Error {}\nexport function parseAppConfig(name: string) { return ${expression}; }\n`;

/** The maintainer's settings: Cloudflare Email Service on a custom domain. */
const CLOUDFLARE_EMAIL = {
  PUBLIC_URL: 'https://plan.example.com',
  INSTANCE_NAME: 'Example Plan',
  MAIL_TRANSPORT: 'cloudflare',
  MAIL_FROM: 'plan@example.com',
  MAIL_FROM_NAME: 'Example Plan',
  MAIL_DAILY_CAP: '96',
};

/** SMTP with credentials, the password a secret. */
const SMTP = {
  PUBLIC_URL: 'https://plan.example.com',
  MAIL_TRANSPORT: 'smtp',
  MAIL_FROM: 'plan@example.com',
  MAIL_REPLY_TO: 'help@example.com',
  SMTP_HOST: 'smtp.example.com',
  SMTP_SECURITY: 'starttls',
  SMTP_PORT: '587',
  SMTP_USER: 'plan@example.com',
};

let parser;
let builds;
beforeAll(async () => {
  const recorder = recording();
  parser = await loadAppConfigParser({ root: ROOT, resolveEsbuild: recorder.resolveEsbuild });
  builds = recorder.builds;
});

// ---------------------------------------------------------------------------

describe('the parser a deploy runs', () => {
  it("is bundled by Wrangler's esbuild from server/src and shared/src alone and imports nothing", () => {
    expect(wranglerEsbuild.version).toBe(pinnedEsbuild);
    expect(builds).toHaveLength(1);
    const [{ root, options, result }] = builds;
    expect(root).toBe(ROOT);
    expect(options).toMatchObject({
      absWorkingDir: ROOT,
      tsconfig: path.join(ROOT, 'tsconfig.worker.json'),
      bundle: true,
      platform: 'neutral',
      format: 'esm',
      packages: 'external',
      metafile: true,
      write: false,
      supported: { 'dynamic-import': false },
    });
    expect(options.stdin.contents).toBe("export { parseAppConfig, ConfigError } from './server/src/core/config';");
    const outputs = Object.values(result.metafile.outputs);
    expect(outputs).toHaveLength(1);
    expect(outputs[0].imports).toEqual([]);
    expect(outputs[0].exports.sort()).toEqual(['ConfigError', 'parseAppConfig']);
    const inputs = Object.keys(result.metafile.inputs)
      .filter((input) => input !== outputs[0].entryPoint)
      .map((input) => input.split(path.sep).join('/'));
    expect(inputs).toContain('server/src/core/config.ts');
    expect(inputs).toContain('shared/src/emailAddress.ts');
    // zod's module, and the server's re-export of it, stay out (shared/src/emailAddress.ts).
    expect(inputs).not.toContain('shared/src/email.ts');
    expect(inputs).not.toContain('server/src/core/email.ts');
    expect(inputs.filter((input) => !input.startsWith('server/src/') && !input.startsWith('shared/src/'))).toEqual([]);
    for (const input of Object.values(result.metafile.inputs)) {
      expect(input.imports.filter((imported) => imported.external)).toEqual([]);
    }
  });

  it("is the app's parser: the same configuration, the same errors", () => {
    const cases = [
      {},
      CLOUDFLARE_EMAIL,
      { ...SMTP, SMTP_PASS: 'secret' },
      { PUBLIC_URL: 'https://plan.example.com', WEBAUTHN_RP_ID: 'example.com', SIGNUP_POLICY: 'open', LOG_REQUESTS: 'yes' },
      { PUBLIC_URL: 'http://plan.example.com' },
      { MAIL_TRANSPORT: 'resend', MAIL_FROM: 'plan@example.com', PUBLIC_URL: 'https://plan.example.com' },
      { SMTP_PORT: '25', MAIL_TRANSPORT: 'smtp', MAIL_FROM: 'a@example.com', PUBLIC_URL: 'https://p.example.com', SMTP_HOST: 'h' },
    ];
    const outcome = (parse, vars) => {
      try {
        return { config: parse(vars, 'cloudflare') };
      } catch (err) {
        return { error: [err.name, err.variable, err.message] };
      }
    };
    for (const vars of cases) {
      expect(outcome(parser.parseAppConfig, vars), JSON.stringify(vars)).toEqual(outcome(sourceParseAppConfig, vars));
    }
    expect(() => parser.parseAppConfig({ PASSWORD_KDF: 'md5' }, 'cloudflare')).toThrow(parser.ConfigError);
  });

  it('is refused when it imports a package, node: or anything dynamically, or reaches code outside server/src and shared/src', async () => {
    const load = (files) => loadAppConfigParser({ root: fixture(files), resolveEsbuild: () => wranglerEsbuild });
    const refused = (what) => `the app's configuration parser now ${what}: a deploy will not run it (scripts/lib/app-config.mjs)`;

    const config = (imports, expression) => ({ 'server/src/core/config.ts': parserFile(imports, expression) });
    await expect(load(config("import { z } from 'zod';", 'z.string()'))).rejects.toThrow(refused('imports zod'));
    // As before shared/src/emailAddress.ts: the parser's email module took zod along, through the @shared alias.
    const copy = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
    await expect(
      load({
        'shared/src/constants.ts': copy('shared/src/constants.ts'),
        'shared/src/emailAddress.ts': copy('shared/src/emailAddress.ts'),
        'shared/src/email.ts': copy('shared/src/email.ts'),
        ...config("import { normalizeEmail } from '@shared/email';", 'normalizeEmail(name)'),
      }),
    ).rejects.toThrow(refused('imports zod'));
    await expect(load(config("import { randomUUID } from 'node:crypto';", 'randomUUID()'))).rejects.toThrow(
      refused('imports node:crypto'),
    );
    await expect(
      load({ 'lib/extra.ts': 'export const extra = 1;\n', ...config("import { extra } from '../../../lib/extra';", 'extra') }),
    ).rejects.toThrow(refused('reaches lib/extra.ts, outside server/src and shared/src'));
    // An import() of a name is in esbuild's list too; one of a computed name becomes a require(), which loads
    // nothing in the bundle's ES module.
    await expect(load(config('', "import('node:fs')"))).rejects.toThrow(refused('imports node:fs'));
    await expect(load(config('', "import('zod')"))).rejects.toThrow(refused('imports zod'));
    const computed = await load(config('', 'import(name)'));
    await expect(computed.parseAppConfig('node:fs')).rejects.toThrow('Dynamic require of "node:fs" is not supported');

    // What esbuild reports is what counts, whichever way the import got there.
    const fake = (inputs, imports) => () => ({
      build: async () => ({
        metafile: { inputs, outputs: { 'stdin.js': { imports, entryPoint: '<stdin>' } } },
        outputFiles: [{ text: 'export {};' }],
      }),
    });
    const root = fixture({});
    const inputs = { '<stdin>': {}, 'server/src/core/config.ts': {} };
    await expect(loadAppConfigParser({ root, resolveEsbuild: fake(inputs, [{ path: 'cloudflare:sockets', external: true }]) })).rejects.toThrow(
      refused('imports cloudflare:sockets'),
    );
    await expect(
      loadAppConfigParser({ root, resolveEsbuild: fake({ ...inputs, 'node_modules/zod/index.js': {} }, []) }),
    ).rejects.toThrow(refused('reaches node_modules/zod/index.js, outside server/src and shared/src'));
    // A clean bundle that lacks the exports is refused too.
    await expect(loadAppConfigParser({ root, resolveEsbuild: fake(inputs, []) })).rejects.toThrow(
      'server/src/core/config.ts no longer exports parseAppConfig and ConfigError',
    );
  });

  it('loads a parser whose comments and messages say "import (", which esbuild keeps in the bundle', async () => {
    const source = `export class ConfigError extends Error {}
export function parseAppConfig(name: string) {
  return {
    // A sign-in after an import (IMPORT_BODY_LIMIT) keeps its session.
    limit: 1,
    message: 'an import (of a space) is too large',
  };
}
`;
    const { builds, resolveEsbuild } = recording();
    const loaded = await loadAppConfigParser({ root: fixture({ 'server/src/core/config.ts': source }), resolveEsbuild });
    expect(builds[0].result.outputFiles[0].text).toMatch(/import \(IMPORT_BODY_LIMIT\)/);
    expect(loaded.parseAppConfig('x')).toEqual({ limit: 1, message: 'an import (of a space) is too large' });
  });

  it('needs the installed Wrangler, and says so when the parser does not build', async () => {
    const root = fixture({ 'server/src/core/config.ts': parserFile('', 'null') });
    await expect(loadAppConfigParser({ root })).rejects.toThrow('Wrangler is not installed (node_modules/wrangler): run npm ci');
    const broken = fixture({ 'server/src/core/config.ts': parserFile('export function broken( {', 'null') });
    await expect(loadAppConfigParser({ root: broken, resolveEsbuild: () => wranglerEsbuild })).rejects.toThrow(
      "the app's configuration parser (server/src/core/config.ts) does not build",
    );
  });
});

// ---------------------------------------------------------------------------

describe('checkAppConfig', () => {
  const check = (vars, options = {}) => checkAppConfig(vars, { parser, ...options });

  it("passes the maintainer's Cloudflare Email Service settings and an SMTP set with its password a secret", () => {
    expect(check(CLOUDFLARE_EMAIL)).toMatchObject({ errors: [], required: [], unread: [] });
    expect(check(SMTP, { declaredSecrets: ['SMTP_PASS'] })).toMatchObject({ errors: [], required: [], unread: [] });
    // Nothing set at all is a valid configuration too: the log transport, no PUBLIC_URL.
    expect(check({})).toEqual({ errors: [], notes: [], required: [], unread: [] });
  });

  it("derives SMTP_PASS and RESEND_API_KEY from the app's own errors, never SETUP_TOKEN", () => {
    expect(check(SMTP).required).toEqual(['SMTP_PASS']);
    const { SMTP_USER, ...withoutUser } = SMTP;
    expect(check(withoutUser, { declaredSecrets: ['SMTP_PASS'] })).toMatchObject({ errors: [], required: ['SMTP_USER'] });
    expect(check(withoutUser).required).toEqual([]); // no AUTH
    const resend = { PUBLIC_URL: 'https://plan.example.com', MAIL_TRANSPORT: 'resend', MAIL_FROM: 'plan@example.com' };
    expect(check(resend)).toMatchObject({ errors: [], required: ['RESEND_API_KEY'] });
    expect(check(resend, { declaredSecrets: ['RESEND_API_KEY'] })).toMatchObject({ errors: [], required: [] });
    // A declared secret stands in with a value the app accepts.
    expect(check(CLOUDFLARE_EMAIL, { declaredSecrets: ['MAIL_REPLY_TO', 'SMTP_PASS'] })).toMatchObject({ errors: [], required: [] });
    // Blank values count as unset, as the Worker's stringVars drops them.
    expect(check({ ...SMTP, SMTP_PASS: '  ' }).required).toEqual(['SMTP_PASS']);

    // By name: the app's error about SETUP_TOKEN or RECOVERY_TOKEN stays an error, and a secret is supplied once.
    class FakeError extends Error {
      constructor(variable) {
        super(`${variable} is wrong`);
        this.variable = variable;
      }
    }
    const always = (variable) => {
      const seen = [];
      const parseAppConfig = (vars) => {
        seen.push({ ...vars });
        throw new FakeError(variable);
      };
      return { seen, parser: { parseAppConfig, ConfigError: FakeError } };
    };
    for (const name of ['SETUP_TOKEN', 'RECOVERY_TOKEN']) {
      const { seen, parser: fake } = always(name);
      expect(checkAppConfig({}, { parser: fake })).toMatchObject({ errors: [{ variable: name }], required: [] });
      expect(seen).toEqual([{}]);
    }
    const { seen, parser: fake } = always('SMTP_PASS');
    expect(checkAppConfig({}, { parser: fake })).toMatchObject({ errors: [{ variable: 'SMTP_PASS' }], required: ['SMTP_PASS'] });
    expect(seen).toEqual([{}, { SMTP_PASS: 'placeholder' }]);
    // Anything but a ConfigError is no verdict on the configuration.
    const crash = { parseAppConfig: () => null.x, ConfigError: FakeError };
    expect(() => checkAppConfig({}, { parser: crash })).toThrow(TypeError);
  });

  it("reports settings this configuration does not read, and the app's warnings", () => {
    const unused = { ...CLOUDFLARE_EMAIL, SMTP_HOST: 'smtp.example.com', SMTP_PORT: '587', MAIL_FROM_NAME: ' ' };
    const result = check(unused);
    expect(result).toMatchObject({ errors: [], unread: ['SMTP_HOST', 'SMTP_PORT'] });
    expect(result.notes).toContain('SMTP_HOST is set but not read (MAIL_TRANSPORT is not smtp)');
    expect(result.notes).toContain('SMTP_PORT is set but not read (MAIL_TRANSPORT is not smtp)');
    expect(check({ ...SMTP, SMTP_EHLO_NAME: 'plan.example.com' }, { declaredSecrets: ['SMTP_PASS'] }).unread).toEqual([]);
    // Without MAIL_TRANSPORT in the file, the Worker keeps its own, which the check cannot see.
    const { MAIL_TRANSPORT, ...partial } = SMTP;
    expect(check(partial)).toMatchObject({ errors: [], unread: ['SMTP_HOST', 'SMTP_SECURITY', 'SMTP_PORT', 'SMTP_USER'] });
    expect(check(partial).notes).toContain(
      "SMTP_HOST is not read unless the Worker's MAIL_TRANSPORT is smtp: put MAIL_TRANSPORT here so that the check reads it",
    );
    expect(check(partial).notes.filter((note) => note.includes('MAIL_TRANSPORT is not smtp'))).toEqual([]);

    const open = check({ SIGNUP_POLICY: 'open', PASSWORD_MIN_LENGTH: '14', PASSWORD_KDF: 'pbkdf2' });
    expect(open).toMatchObject({ errors: [], unread: [] });
    expect(open.notes).toEqual([
      SIGNUP_SEED_WARNING,
      'PASSWORD_KDF: decide before the first account: once both kinds exist, a failed sign-in does both',
      'SIGNUP_POLICY is read once, when the directory is created; afterwards Administration → Settings decides',
      'PASSWORD_MIN_LENGTH is read once, when the directory is created; afterwards Administration → Settings decides',
    ]);
  });

  it('an invalid value names its variable with the value redacted', () => {
    const ODD = 'odd-7f3a9c';
    const errors = (vars) => check(vars).errors;
    expect(errors({ PUBLIC_URL: `http://${ODD}.example.com` })).toEqual([
      {
        variable: 'PUBLIC_URL',
        message:
          'Invalid value for PUBLIC_URL: <value> (expected an https origin such as https://plan.example.com; ' +
          'http only for localhost under wrangler dev)',
      },
    ]);
    expect(errors({ PASSWORD_MIN_LENGTH: '6' })).toEqual([
      { variable: 'PASSWORD_MIN_LENGTH', message: 'Invalid value for PASSWORD_MIN_LENGTH: <value> (expected 8..64)' },
    ]);
    expect(errors({ MAIL_DAILY_CAP: ' 0 ' })).toEqual([
      { variable: 'MAIL_DAILY_CAP', message: 'Invalid value for MAIL_DAILY_CAP:  <value>  (expected 1..9007199254740991)' },
    ]);
    expect(errors({ INSTANCE_NAME: `"${ODD}"\u0007` })).toEqual([
      { variable: 'INSTANCE_NAME', message: 'Invalid value for INSTANCE_NAME: <value> (expected up to 100 characters, no line breaks)' },
    ]);
    expect(errors({ MAIL_TRANSPORT: 'cloudflare', MAIL_FROM: ODD, PUBLIC_URL: 'https://plan.example.com' })).toEqual([
      { variable: 'MAIL_FROM', message: 'Invalid value for MAIL_FROM: <value> (expected an email address)' },
    ]);
    // The app names PUBLIC_URL's host in WEBAUTHN_RP_ID's message: that is a value too.
    const [rp] = errors({ PUBLIC_URL: `https://plan.${ODD}.example`, WEBAUTHN_RP_ID: `${ODD}.org` });
    expect(rp.variable).toBe('WEBAUTHN_RP_ID');
    expect(rp.message).toMatch(/^Invalid value for WEBAUTHN_RP_ID: <value> \(expected PUBLIC_URL's host, <value>, or a parent/);
    for (const vars of [
      { PUBLIC_URL: `https://${ODD}.example.com/path` },
      { SMTP_HOST: `${ODD}!`, MAIL_TRANSPORT: 'smtp', MAIL_FROM: 'a@example.com', PUBLIC_URL: 'https://plan.example.com' },
      { MAIL_TRANSPORT: ODD },
      { SESSION_TTL_DAYS: `${ODD}` },
    ]) {
      const result = check(vars);
      expect(result.errors, JSON.stringify(vars)).toHaveLength(1);
      expect(JSON.stringify(result)).not.toContain(ODD);
    }
  });

  it("leaves the app's own words and the variables' names whole", () => {
    const errors = (vars) => check(vars).errors;
    // The hint keeps invite_only, and the name keeps its tail.
    expect(errors({ SIGNUP_POLICY: 'invite' })).toEqual([
      { variable: 'SIGNUP_POLICY', message: 'Invalid value for SIGNUP_POLICY: <value> (expected open, invite_only, closed)' },
    ]);
    expect(errors({ PASSWORD_KDF: 'KDF' })).toEqual([
      { variable: 'PASSWORD_KDF', message: 'Invalid value for PASSWORD_KDF: <value> (expected scrypt, pbkdf2)' },
    ]);
    // A value that is a variable's name is no instance's data.
    expect(errors({ SIGNUP_POLICY: 'SIGNUP_POLICY' })).toEqual([
      { variable: 'SIGNUP_POLICY', message: 'Invalid value for SIGNUP_POLICY: SIGNUP_POLICY (expected open, invite_only, closed)' },
    ]);
  });

  it('says that it reads only the file\'s variables when the app asks for one the file does not list', () => {
    const unseen = (name) => ` (the check reads only this file's variables: put ${name} here)`;
    expect(check({ MAIL_TRANSPORT: 'cloudflare' }).errors).toEqual([
      { variable: 'MAIL_FROM', message: `MAIL_FROM is required with MAIL_TRANSPORT=cloudflare${unseen('MAIL_FROM')}` },
    ]);
    const { MAIL_FROM, ...smtp } = SMTP;
    expect(check(smtp, { declaredSecrets: ['SMTP_PASS'] }).errors).toEqual([
      { variable: 'MAIL_FROM', message: `MAIL_FROM is required with MAIL_TRANSPORT=smtp${unseen('MAIL_FROM')}` },
    ]);
    // A value the file has, or a secret it declares or the app derives, is no unseen one.
    const [refused] = check({ ...CLOUDFLARE_EMAIL, MAIL_FROM: 'nobody' }).errors;
    expect(refused).toEqual({ variable: 'MAIL_FROM', message: 'Invalid value for MAIL_FROM: <value> (expected an email address)' });
  });
});
