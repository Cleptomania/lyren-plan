// Bundle purity (design §10.9, §14.6): what each entry pulls in, from esbuild's metafile (nothing is
// written). The Worker (bundled by Wrangler for workerd) must reach no Node-only code: no runtime/node/,
// desktop/, http/static.ts, server/src/config.ts or @hono/node-server, and no node:sqlite, node:fs,
// node:child_process, node:net or node:tls (nodejs_compat stubs or half-implements them; the SMTP client
// reaches the network through cloudflare:sockets there, §5.10.2). The Node and desktop entries must reach
// nothing of the Cloudflare runtime, cloudflare:sockets included.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** A bundle of `entry`, kept in memory (its text in outputFiles). */
const bundle = (entry, options) =>
  build({
    absWorkingDir: ROOT,
    entryPoints: [entry],
    bundle: true,
    write: false,
    metafile: true,
    format: 'esm',
    logLevel: 'silent',
    outdir: 'out',
    ...options,
  });

/** How Wrangler bundles the Worker for workerd. */
const WORKER_OPTIONS = {
  platform: 'neutral',
  conditions: ['workerd', 'worker', 'browser'],
  mainFields: ['module', 'main'],
  external: ['node:*', 'cloudflare:*'],
  tsconfig: 'tsconfig.worker.json',
};

/** The metafile of a bundle of `entry`: its inputs (repo-relative, '/' separators) and its external imports. */
async function graph(entry, options) {
  const result = await bundle(entry, options);
  const inputs = Object.keys(result.metafile.inputs).map((p) => p.split(path.sep).join('/'));
  const externals = new Set();
  for (const input of Object.values(result.metafile.inputs)) {
    for (const imported of input.imports) if (imported.external) externals.add(imported.path);
  }
  return { inputs, externals: [...externals].sort() };
}

describe('bundle purity (§14.6)', () => {
  it('the Worker reaches no Node-only module', async () => {
    const { inputs, externals } = await graph('server/src/runtime/cloudflare/worker.ts', WORKER_OPTIONS);
    expect(inputs).toContain('server/src/runtime/cloudflare/worker.ts');
    expect(inputs).toContain('server/src/runtime/cloudflare/directoryDo.ts');
    expect(inputs).toContain('server/src/runtime/cloudflare/spaceDo.ts');
    const forbidden = inputs.filter(
      (p) =>
        p.startsWith('server/src/runtime/node/') ||
        p.startsWith('server/src/desktop/') ||
        p === 'server/src/http/static.ts' ||
        p === 'server/src/config.ts' ||
        p.includes('node_modules/@hono/node-server/'),
    );
    expect(forbidden).toEqual([]);
    for (const name of ['node:sqlite', 'node:fs', 'node:fs/promises', 'node:child_process', 'node:net', 'node:tls']) {
      expect(externals).not.toContain(name);
    }
    expect(externals).toContain('cloudflare:workers');
    // The mail drivers (§5.10.2): SMTP over cloudflare:sockets, never Node's connector.
    expect(inputs).toContain('server/src/mail/smtp/client.ts');
    expect(inputs).toContain('server/src/runtime/cloudflare/smtpConnector.ts');
    expect(externals).toContain('cloudflare:sockets');
  });

  it('the Worker takes nothing from package.json but its version (Appendix D 48)', async () => {
    const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const [out] = (await bundle('server/src/runtime/cloudflare/worker.ts', WORKER_OPTIONS)).outputFiles;
    expect(out.text).toContain(JSON.stringify(version));
    // A default import of the JSON put all of it in the bundle: the scripts, the dependencies, the overrides.
    for (const field of ['devDependencies', 'overrides']) expect(out.text).not.toMatch(new RegExp(`\\b${field}\\b\\s*:`));
  });

  it.each(['server/src/index.ts', 'server/src/sea.ts'])('%s reaches nothing of the Cloudflare runtime', async (entry) => {
    const { inputs, externals } = await graph(entry, {
      platform: 'node',
      target: 'node22',
      tsconfig: 'tsconfig.server.json',
    });
    expect(inputs).toContain(entry);
    expect(inputs.filter((p) => p.startsWith('server/src/runtime/cloudflare/'))).toEqual([]);
    expect(externals.filter((p) => p.startsWith('cloudflare:'))).toEqual([]);
    // SMTP through node:net and node:tls (runtime/node/smtpConnector.ts).
    expect(inputs).toContain('server/src/runtime/node/smtpConnector.ts');
  });
});
