#!/usr/bin/env node
// Packages Lyren Plan for servers that have Node.js: the release download
// lyren-plan-<version>-node.tar.gz, which needs no npm, no node_modules and no build.
//
//   npm run package:node                     -> dist/lyren-plan-<version>-node.tar.gz (+ .sha256)
//   node scripts/pack-node.mjs --no-build    packs the dist/ that is already there
//
// The archive holds one folder, lyren-plan-<version>/, with server.mjs and web/ from dist/ (no
// source maps); `node lyren-plan-<version>/server.mjs` runs it with Node.js 22.13 or newer.
// docs/ubuntu-server.md installs it as a systemd service. How the archive is written (fixed order,
// root-owned, fixed modes, one time stamp): scripts/lib/node-tarball.mjs.
//
// Steps:
//  1. npm run build (skip with --no-build).
//  2. Check that dist/server.mjs is this version: `node dist/server.mjs help` must print
//     "Lyren Plan <version>" (a dist/ from an older build is refused).
//  3. Write the archive and its .sha256 file ("<hex>  <name>", like the single-file apps). Every
//     entry gets the time SOURCE_DATE_EPOCH (seconds, set by the release workflow to the time of
//     the commit), else the modification time of dist/server.mjs.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { npmRunInvocation } from './lib/npm-run.mjs';
import { describeRun } from './lib/self-test.mjs';
import { archiveTime, packNodeTarball, sha256Line, VERSION_RE } from './lib/node-tarball.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const opts = { build: true };
  for (const a of argv) {
    if (a === '--no-build') opts.build = false;
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/pack-node.mjs [--no-build]');
      console.log('  Writes dist/lyren-plan-<version>-node.tar.gz and its .sha256 file.');
      console.log('  --no-build            pack the existing dist/ instead of running npm run build first');
      console.log('  SOURCE_DATE_EPOCH=<s> time stamp of every archive entry (default: that of dist/server.mjs)');
      process.exit(0);
    } else throw new Error(`Unknown argument ${a}`);
  }
  return opts;
}

const kib = (n) => `${(n / 1024).toFixed(0)} KiB`;

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  if (!VERSION_RE.test(version)) throw new Error(`The version in package.json, ${version}, is not <major>.<minor>.<patch>[-<prerelease>]`);
  const distDir = path.join(ROOT, 'dist');
  const serverFile = path.join(distDir, 'server.mjs');
  const started = Date.now();
  console.log(`Packaging Lyren Plan ${version} for Node.js (server.mjs and web/)`);

  if (opts.build) {
    const { command, args, shell } = npmRunInvocation('build');
    const res = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', shell });
    if (res.status !== 0) throw new Error(`npm run build failed (${describeRun(res)})`);
  } else if (!fs.existsSync(serverFile)) {
    throw new Error('dist/server.mjs is missing: run npm run build (or drop --no-build)');
  }

  // The bundle must be this version: dist/ may be left from an older build.
  const help = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', serverFile, 'help'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30_000,
  });
  const first = (help.stdout ?? '').split('\n')[0].trim();
  if (help.status !== 0 || first !== `Lyren Plan ${version}`) {
    const what = help.status === 0 ? `says "${first}"` : `failed (${describeRun(help)})`;
    throw new Error(`node dist/server.mjs help ${what}, expected "Lyren Plan ${version}": run npm run build (or drop --no-build)`);
  }

  const mtime = archiveTime(process.env, serverFile);
  const pack = packNodeTarball(distDir, { version, mtime });
  const outFile = path.join(distDir, pack.name);
  fs.rmSync(`${outFile}.sha256`, { force: true }); // written again only when the archive is complete
  fs.writeFileSync(outFile, pack.gz);
  fs.writeFileSync(`${outFile}.sha256`, sha256Line(pack.gz, pack.name));

  const files = pack.entries.filter((e) => e.type === 'file');
  const unpacked = files.reduce((n, e) => n + e.size, 0);
  const maps = pack.skipped.reduce((n, e) => n + e.size, 0);
  console.log('');
  console.log(`Output:    ${outFile}`);
  console.log(`Contents:  ${pack.top}/ with ${files.length} files (${kib(unpacked)} unpacked); ${pack.skipped.length} source maps (${kib(maps)}) left out`);
  console.log(`Size:      ${kib(pack.gz.length)} (${pack.gz.length} bytes)`);
  console.log(`Time:      ${new Date(mtime * 1000).toISOString()} on every entry${process.env.SOURCE_DATE_EPOCH ? ' (SOURCE_DATE_EPOCH)' : ''}`);
  console.log(`SHA-256:   ${pack.sha256}  (also in ${pack.name}.sha256)`);
  console.log(`Done in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}

try {
  main();
} catch (err) {
  console.error(`\npack-node: ${err.message}`);
  process.exit(1);
}
