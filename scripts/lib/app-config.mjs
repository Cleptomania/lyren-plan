// The app's configuration check (design §5.4; docs/cloudflare.md, "Your instance configuration"): an instance
// configuration's variables, as the Worker reads them on Cloudflare, go through the parser the Worker runs,
// parseAppConfig of server/src/core/config.ts. scripts/cf/wrangler.mjs runs it before every deploy, dry run and
// --validate, in the workflow's deploy job too, next to the Cloudflare token: so it runs nothing but the app's own
// code. Wrangler's esbuild (the copy Wrangler resolves, which the deploy runs anyway) bundles the parser in memory,
// the bundle is refused unless it comes from server/src/ and shared/src/ alone and imports nothing
// (shared/src/emailAddress.ts keeps zod out of it), and it is imported from a data: URL: nothing is written. An
// import() esbuild cannot name becomes a require(), which loads nothing in that module. The check sees only the
// file's variables, not those the Worker keeps (keep_vars), and its messages say so where it matters.
// Unit-tested in scripts/test/app-config.test.mjs.
//
//   const parser = await loadAppConfigParser({ root });
//   const { errors, notes, required, unread } = checkAppConfig(vars, { declaredSecrets, parser });
//
// Messages name settings, never values: the app's own messages echo the value they refuse, which is replaced
// by <value>. They carry no ::error:: prefix; the caller adds it, and the source.

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { APP_VARIABLES } from './instance.mjs';

/** The bundle's entry: the app's parser and its error, nothing else. */
const ENTRY = "export { parseAppConfig, ConfigError } from './server/src/core/config';";

/** Where the parser's code may come from (repository-relative). */
const APP_SOURCES = ['server/src/', 'shared/src/'];

/** esbuild as Wrangler resolves it: its own dependency, or the hoisted copy after a dedupe. */
function wranglerEsbuild(root) {
  const wranglerPackage = path.join(root, 'node_modules', 'wrangler', 'package.json');
  if (!fs.existsSync(wranglerPackage)) throw new Error('Wrangler is not installed (node_modules/wrangler): run npm ci');
  return createRequire(wranglerPackage)('esbuild');
}

/**
 * Why a bundle of the parser may not run next to the Cloudflare token, or null: an import left in it (a package,
 * node:, cloudflare:, or an import() of one by name), or code from outside server/src/ and shared/src/. An
 * import() of a computed name is no import esbuild can list: the build turns it into a require(), which throws
 * in an ES module.
 */
function impurity({ metafile }) {
  const outputs = Object.values(metafile.outputs);
  for (const output of outputs) {
    const [imported] = output.imports;
    if (imported !== undefined) return `imports ${imported.path}`;
  }
  const entries = new Set(outputs.map((output) => output.entryPoint));
  for (const input of Object.keys(metafile.inputs)) {
    const file = input.split(path.sep).join('/');
    if (!entries.has(input) && !APP_SOURCES.some((dir) => file.startsWith(dir))) {
      return `reaches ${file}, outside server/src and shared/src`;
    }
  }
  return null;
}

/**
 * The app's parseAppConfig and ConfigError, bundled from the checkout at `root` by Wrangler's esbuild; throws when
 * the bundle reaches anything but the app's own code. `resolveEsbuild(root)` exists for tests.
 */
export async function loadAppConfigParser({ root, resolveEsbuild = wranglerEsbuild }) {
  const esbuild = resolveEsbuild(root);
  let result;
  try {
    result = await esbuild.build({
      absWorkingDir: root,
      stdin: { contents: ENTRY, resolveDir: root, loader: 'ts' },
      tsconfig: path.join(root, 'tsconfig.worker.json'),
      bundle: true,
      platform: 'neutral',
      format: 'esm',
      packages: 'external',
      metafile: true,
      write: false,
      logLevel: 'silent',
      // import() becomes a require(): one of a name is in the metafile, and any one loads nothing here.
      supported: { 'dynamic-import': false },
    });
  } catch (err) {
    throw new Error(`the app's configuration parser (server/src/core/config.ts) does not build: ${err.message}`);
  }
  const why = result.outputFiles.length === 1 ? impurity(result) : `is ${result.outputFiles.length} files`;
  if (why !== null) {
    throw new Error(`the app's configuration parser now ${why}: a deploy will not run it (scripts/lib/app-config.mjs)`);
  }
  const url = `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`;
  const { parseAppConfig, ConfigError } = await import(url);
  if (typeof parseAppConfig !== 'function' || typeof ConfigError !== 'function') {
    const why = 'server/src/core/config.ts no longer exports parseAppConfig and ConfigError';
    throw new Error(`${why} (scripts/lib/app-config.mjs)`);
  }
  return { parseAppConfig, ConfigError };
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

/**
 * Secrets the app's checks may ask for, with what stands in for one in the check: the Worker holds the value, no
 * file does. SETUP_TOKEN and RECOVERY_TOKEN are never required (the app makes a setup code; a recovery token is
 * set by hand only while it is needed).
 */
const SECRET_PLACEHOLDERS = {
  SMTP_USER: 'placeholder',
  SMTP_PASS: 'placeholder',
  MAIL_REPLY_TO: 'reply@example.com',
  RESEND_API_KEY: 'placeholder',
};
const placeholder = (name) => SECRET_PLACEHOLDERS[name] ?? 'placeholder';

/** Settings worth a word whenever a configuration sets them: what changing them later does. */
const SETTING_NOTES = {
  PUBLIC_URL: 'PUBLIC_URL: decide its host before the first passkey: passkeys belong to it, or to WEBAUTHN_RP_ID',
  WEBAUTHN_RP_ID: 'WEBAUTHN_RP_ID: decide before the first passkey: a change makes those registered before unusable',
  PASSWORD_KDF: 'PASSWORD_KDF: decide before the first account: once both kinds exist, a failed sign-in does both',
  SIGNUP_POLICY:
    'SIGNUP_POLICY is read once, when the directory is created; afterwards Administration → Settings decides',
  PASSWORD_MIN_LENGTH:
    'PASSWORD_MIN_LENGTH is read once, when the directory is created; afterwards Administration → Settings decides',
};

/** A character of a word, a number or a variable's name. */
const ALNUM = /[A-Za-z0-9_]/;

/**
 * `message` with each occurrence of `values` (trimmed, or as JSON text) replaced by <value>, longest first, and
 * only where it is not part of a longer word, number or name: "6" of PASSWORD_MIN_LENGTH=6 leaves "8..64" as it
 * is, "invite" leaves invite_only, and "KDF" leaves PASSWORD_KDF. A value that is the name of one of the app's
 * variables is no instance's data, and stays.
 */
function redact(message, values) {
  const trimmed = values
    .map((value) => value.trim())
    .filter((value) => value !== '' && !APP_VARIABLES.includes(value));
  const forms = [...new Set(trimmed.flatMap((value) => [JSON.stringify(value), value]))];
  forms.sort((a, b) => b.length - a.length);
  const bounded = (at, form) =>
    !(ALNUM.test(form[0]) && ALNUM.test(message[at - 1] ?? '')) &&
    !(ALNUM.test(form.at(-1)) && ALNUM.test(message[at + form.length] ?? ''));
  let out = '';
  for (let i = 0; i < message.length; ) {
    const form = forms.find((candidate) => message.startsWith(candidate, i) && bounded(i, candidate));
    out += form === undefined ? message[i] : '<value>';
    i += form === undefined ? 1 : form.length;
  }
  return out;
}

/**
 * The values a ConfigError of `variable` may echo: its own, and PUBLIC_URL's host, which the WEBAUTHN_RP_ID and
 * SMTP_EHLO_NAME messages name.
 */
function echoedValues(vars, variable) {
  const values = [vars[variable], vars.PUBLIC_URL].filter((value) => value !== undefined);
  if (vars.PUBLIC_URL !== undefined) {
    try {
      values.push(new URL(vars.PUBLIC_URL.trim()).hostname);
    } catch {
      // not a URL: its text is redacted as it is
    }
  }
  return values;
}

/**
 * Why a variable the parser did not read is not read. Without MAIL_TRANSPORT in the file (`transportSet` false)
 * the check cannot know the Worker's, which keep_vars keeps.
 */
function unreadNote(name, transportSet) {
  const transport = name.startsWith('SMTP_') ? 'smtp' : name.startsWith('RESEND_') ? 'resend' : null;
  if (transport !== null && !transportSet) {
    return (
      `${name} is not read unless the Worker's MAIL_TRANSPORT is ${transport}: put MAIL_TRANSPORT here so that ` +
      'the check reads it'
    );
  }
  return transport === 'smtp'
    ? `${name} is set but not read (MAIL_TRANSPORT is not smtp)`
    : `${name} is set but not read on Cloudflare with these settings`;
}

/**
 * The hint after an app error about `variable` that the check had no value for: the Worker may hold one the
 * file does not list (keep_vars), which the check cannot see.
 */
const unseen = (variable) => ` (the check reads only this file's variables: put ${variable} here)`;

/**
 * The app's verdict on an instance configuration's variables (`vars`, text by name), as the Worker reads them on
 * Cloudflare: empty values count as unset, as runtime/cloudflare/config.ts#stringVars drops them, and each secret
 * the configuration declares (`declaredSecrets`, secrets.required) stands in with a placeholder. `parser` is
 * loadAppConfigParser's.
 *
 * - errors: the parser's ConfigError, { variable, message }, the value redacted (the parser stops at the first);
 *   about a setting the check had no value for, the message adds that the check reads only the file's variables;
 * - required: the secrets the app asks for that neither the variables nor the declared secrets hold (SMTP_PASS
 *   next to SMTP_USER, RESEND_API_KEY with resend), found by running the parser again with a placeholder, at most
 *   once per secret; never SETUP_TOKEN or RECOVERY_TOKEN;
 * - unread: the variables this configuration does not read (SMTP_HOST while MAIL_TRANSPORT is not smtp), known
 *   only when it parses;
 * - notes: every note to print, the parser's warnings, the unread variables (with the MAIL_TRANSPORT they need,
 *   when the file has none) and the settings that are read once or are best decided early.
 */
export function checkAppConfig(vars, { declaredSecrets = [], parser }) {
  const { parseAppConfig, ConfigError } = parser;
  const text = {};
  for (const [name, value] of Object.entries(vars)) {
    if (typeof value === 'string' && value.trim() !== '') text[name] = value;
  }
  const supplied = { ...text };
  for (const name of declaredSecrets) if (supplied[name] === undefined) supplied[name] = placeholder(name);

  const errors = [];
  const required = [];
  const unread = [];
  const notes = [];
  for (let run = 0; run <= Object.keys(SECRET_PLACEHOLDERS).length; run++) {
    const read = new Set();
    const watched = new Proxy(supplied, {
      get(target, name, receiver) {
        if (typeof name === 'string') read.add(name);
        return Reflect.get(target, name, receiver);
      },
    });
    let config;
    try {
      config = parseAppConfig(watched, 'cloudflare');
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      if (Object.hasOwn(SECRET_PLACEHOLDERS, err.variable) && supplied[err.variable] === undefined) {
        required.push(err.variable);
        supplied[err.variable] = placeholder(err.variable);
        continue;
      }
      let message = redact(err.message, echoedValues(text, err.variable));
      if (supplied[err.variable] === undefined && APP_VARIABLES.includes(err.variable)) message += unseen(err.variable);
      errors.push({ variable: err.variable, message });
      break;
    }
    notes.push(...config.directory.warnings);
    for (const name of Object.keys(text)) if (!read.has(name)) unread.push(name);
    notes.push(...unread.map((name) => unreadNote(name, text.MAIL_TRANSPORT !== undefined)));
    break;
  }
  for (const [name, note] of Object.entries(SETTING_NOTES)) if (text[name] !== undefined) notes.push(note);
  return { errors, notes, required: required.sort(), unread };
}
