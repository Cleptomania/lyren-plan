#!/usr/bin/env node
// Packages Lyren Plan as ONE executable that needs nothing installed: a Node.js single executable
// application (https://nodejs.org/docs/latest-v24.x/api/single-executable-applications.html).
//
//   npm run package:win      -> dist/lyren-plan-<version>-win-x64.exe
//   npm run package:linux    -> dist/lyren-plan-<version>-linux-x64
//   node scripts/package.mjs --target win-arm64|linux-arm64 [--no-build]
//
// Steps:
//  1. npm run build (skip with --no-build to package the existing dist/).
//  2. Bundle server/src/sea.ts as ONE CommonJS file (SEA runs CommonJS only, and its require()
//     loads built-in modules only, so every dependency is bundled).
//  3. Embed dist/web (minus source maps) as SEA assets with a manifest (size, SHA-256, etag), and
//     the notification-area icon (Windows app, server/src/desktop/tray.ts).
//  4. Write sea-config.json and generate the blob with THIS Node.js (`node
//     --experimental-sea-config`); the blob only works in a node binary of the same version.
//  5. Take the official node binary of that version for the target from nodejs.org, SHA-256
//     verified against SHASUMS256.txt and cached in .cache/node/ (LYREN_NODE_BINARY=<file>
//     for offline builds, LYREN_NODE_MIRROR=<url> for a mirror of nodejs.org/dist).
//     LYREN_NODE_PINNED_ONLY=1 (the release workflow) refuses, before step 1, a Node.js version
//     whose SHA-256 is not pinned in scripts/lib/node-hashes.mjs.
//  6. Windows: remove its Authenticode signature (the injection would invalidate it).
//  7. Inject the blob with postject; Windows: set the app's icon and version information, add
//     consoleAllocationPolicy "detached" to the manifest (no console window when double-clicked,
//     scripts/lib/manifest.mjs) and fix the PE checksum.
//  8. Windows, optional: sign the exe with LYREN_SIGN_CMD (scripts/lib/sign.mjs), the very last
//     change to it, and check that only a signature was added.
//  9. Windows: check that the exe is a PE image for the target's CPU. Self-test `<exe> help` when
//     the exe can run here (a policy block of an unsigned program, confirmed by its Win32 error, is
//     a warning, see scripts/lib/self-test.mjs), then write the .sha256 file and print path, size
//     and SHA-256.
//
// Only build-time tools are involved (esbuild, postject, resedit); the executable makes no
// network requests.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { buildIco, iconPng } from './lib/icons.mjs';
import { fetchNodeBinary, requirePinned, sha256, TARGETS } from './lib/node-dist.mjs';
import { npmRunInvocation } from './lib/npm-run.mjs';
import { PE_MACHINES, peMachine, stripAuthenticode, updatePeChecksum } from './lib/pe.mjs';
import { setDetachedConsolePolicy } from './lib/manifest.mjs';
import {
  buildAssetManifest,
  buildPathNeedles,
  collectWebAssets,
  findStrings,
  MANIFEST_KEY,
  seaConfig,
  TRAY_ICON_KEY,
} from './lib/sea-assets.mjs';
import {
  blockedByWindows,
  blockedExplanation,
  describeRun,
  describeStartError,
  refusedToStart,
  runOutput,
  windowsStartError,
} from './lib/self-test.mjs';
import { expandSignCommand, parseCommandTemplate, signExecutable } from './lib/sign.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SENTINEL_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const ICON_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];
/** The notification-area icon: 16 px at 100% display scaling up to 48 px at 300%. */
const TRAY_ICON_SIZES = [16, 20, 24, 32, 40, 48];
/** Exit code when --require-self-test is given and Windows blocked the self-test (the build is complete). */
const EXIT_SELF_TEST_BLOCKED = 3;

function parseArgs(argv) {
  const opts = { target: 'win-x64', build: true, requireSelfTest: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--target') opts.target = argv[++i];
    else if (a.startsWith('--target=')) opts.target = a.slice('--target='.length);
    else if (a === '--no-build') opts.build = false;
    else if (a === '--require-self-test') opts.requireSelfTest = true;
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/package.mjs [--target win-x64|win-arm64|linux-x64|linux-arm64] [--no-build] [--require-self-test]');
      console.log('  --require-self-test  exit with code 3 (instead of a warning) when Windows does not let the new exe');
      console.log('                       start, e.g. Smart App Control blocking an unsigned build');
      console.log('  LYREN_SIGN_CMD=<command with {file}> signs a Windows exe (see README.md, "Signing the app")');
      console.log('  LYREN_NODE_PINNED_ONLY=1 builds only on a Node.js version pinned in scripts/lib/node-hashes.mjs');
      process.exit(0);
    } else throw new Error(`Unknown argument ${a}`);
  }
  if (!TARGETS[opts.target]) throw new Error(`Unknown target ${opts.target} (expected ${Object.keys(TARGETS).join(', ')})`);
  return opts;
}

function npmRun(script) {
  // No shell under npm; on Windows outside npm one command string for npm.cmd (no DEP0190).
  const { command, args, shell } = npmRunInvocation(script);
  const res = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', shell });
  if (res.status !== 0) throw new Error(`npm run ${script} failed (${describeRun(res)})`);
}

const mib = (n) => `${(n / 1024 / 1024).toFixed(1)} MiB`;

/** 0.1.0-beta.2 -> [0, 1, 0, 0] (Windows version numbers are four 16-bit integers). */
function versionParts(version) {
  const nums = version.split(/[-+]/)[0].split('.').map((n) => Number.parseInt(n, 10) || 0);
  return [0, 1, 2, 3].map((i) => Math.min(nums[i] ?? 0, 65535));
}

async function setWindowsResources(exeBuffer, { version, fileName, nodeVersion }) {
  const ResEdit = await import('resedit');
  const exe = ResEdit.NtExecutable.from(exeBuffer);
  const res = ResEdit.NtExecutableResource.from(exe);

  const ico = buildIco(ICON_SIZES.map((size) => ({ size, png: iconPng(size, { rounded: true, scale: 1 }) })));
  const iconFile = ResEdit.Data.IconFile.from(ico);
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  const group = groups[0] ?? { id: 1, lang: 1033 };
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, group.id, group.lang, iconFile.icons.map((i) => i.data));

  const [vi] = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  if (!vi) throw new Error('node.exe has no version information to update');
  const lang = { lang: 1033, codepage: 1200 };
  for (const l of vi.getAllLanguagesForStringValues()) vi.removeAllStringValues(l, false);
  vi.setStringValues(lang, {
    FileDescription: 'Lyren Plan',
    ProductName: 'Lyren Plan',
    FileVersion: version,
    ProductVersion: version,
    OriginalFilename: fileName,
    InternalName: 'lyren-plan',
    LegalCopyright: 'MIT License. Includes Node.js (copyright Node.js contributors, MIT License).',
    Comments: `Self-hosted project management as a single executable, built on Node.js ${nodeVersion}.`,
  });
  const [a, b, c, d] = versionParts(version);
  vi.setFileVersion(a, b, c, d, 1033);
  vi.setProductVersion(a, b, c, d, 1033);
  vi.outputToResourceEntries(res.entries);

  setDetachedConsolePolicy(res.entries);

  res.outputResource(exe);
  return Buffer.from(exe.generate());
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const version = pkg.version;
  const nodeVersion = process.version;
  const { platform, exe: isExe } = TARGETS[opts.target];
  const distDir = path.join(ROOT, 'dist');
  const webDir = path.join(distDir, 'web');
  const workDir = path.join(distDir, 'sea', opts.target);
  const fileName = `lyren-plan-${version}-${opts.target}${isExe ? '.exe' : ''}`;
  const outFile = path.join(distDir, fileName);
  const started = Date.now();

  console.log(`Packaging Lyren Plan ${version} for ${opts.target} on Node.js ${nodeVersion}`);
  // An unpinned Node.js (LYREN_NODE_PINNED_ONLY=1) and a mistake in LYREN_SIGN_CMD show now, not after the build.
  requirePinned(opts.target, nodeVersion);
  const signTemplate = process.env.LYREN_SIGN_CMD?.trim();
  if (signTemplate && platform === 'win32') expandSignCommand(parseCommandTemplate(signTemplate), { file: outFile, out: `${outFile}.signed` });

  // 1. Fresh build.
  if (opts.build) npmRun('build');
  else if (!fs.existsSync(path.join(webDir, 'index.html'))) throw new Error('dist/web has no index.html: run npm run build (or drop --no-build)');

  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });

  // 2. CommonJS bundle of the desktop entry. Its file name is all that stack traces of the app
  //    show (sea-config "main" is relative), never the build machine's folders.
  const mainName = 'lyren-plan.cjs';
  const mainFile = path.join(workDir, mainName);
  const result = await build({
    absWorkingDir: ROOT,
    entryPoints: ['server/src/sea.ts'],
    outfile: mainFile,
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    tsconfig: 'tsconfig.server.json',
    define: { __APP_VERSION__: JSON.stringify(version) },
    legalComments: 'none',
    logLevel: 'silent',
  });
  if (result.warnings.length > 0) {
    for (const w of result.warnings) console.error(`esbuild: ${w.text}${w.location ? ` (${w.location.file}:${w.location.line})` : ''}`);
    throw new Error('The SEA bundle must build without warnings (e.g. no import.meta in CommonJS)');
  }
  const bundle = fs.readFileSync(mainFile, 'utf8');
  if (bundle.includes(SENTINEL_FUSE)) throw new Error('The bundle contains the SEA fuse string; postject would refuse it');
  console.log(`Bundled server/src/sea.ts -> ${path.relative(ROOT, mainFile)} (${mib(bundle.length)})`);

  // 3. Web client assets and their manifest.
  const files = collectWebAssets(webDir);
  const manifest = buildAssetManifest(files, { version, builtAt: new Date().toISOString() });
  const manifestFile = path.join(workDir, 'manifest.json');
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
  const assets = { [MANIFEST_KEY]: manifestFile };
  for (const f of files) assets[f.key] = f.file;
  console.log(`Embedding ${files.length} web files (${mib(files.reduce((n, f) => n + f.size, 0))}, source maps left out)`);
  if (platform === 'win32') {
    const trayIcon = path.join(workDir, 'tray-icon.ico');
    fs.writeFileSync(trayIcon, buildIco(TRAY_ICON_SIZES.map((size) => ({ size, png: iconPng(size, { rounded: true, scale: 1 }) }))));
    assets[TRAY_ICON_KEY] = trayIcon;
  }

  // 4. The preparation blob, made by this Node.js (same version as the target binary).
  // Paths relative to workDir (the cwd of the generator), so the blob holds no build-machine path.
  const blobFile = path.join(workDir, 'sea-prep.blob');
  const configFile = path.join(workDir, 'sea-config.json');
  const rel = (file) => path.relative(workDir, file).split(path.sep).join('/');
  const relAssets = Object.fromEntries(Object.entries(assets).map(([key, file]) => [key, rel(file)]));
  fs.writeFileSync(configFile, JSON.stringify(seaConfig({ main: mainName, output: rel(blobFile), assets: relAssets }), null, 2) + '\n');
  const gen = spawnSync(process.execPath, ['--experimental-sea-config', configFile], { cwd: workDir, encoding: 'utf8' });
  if (gen.status !== 0) throw new Error(`Generating the SEA blob failed:\n${gen.stdout}${gen.stderr}`);
  const blob = fs.readFileSync(blobFile);
  console.log(`SEA blob ${path.relative(ROOT, blobFile)} (${mib(blob.length)})`);

  // 5. The official node binary for the target.
  const { binary } = await fetchNodeBinary({
    target: opts.target,
    version: nodeVersion,
    cacheDir: path.join(ROOT, '.cache', 'node'),
    mirror: process.env.LYREN_NODE_MIRROR || undefined,
  });

  // 6. Windows: no (soon invalid) signature.
  let base = binary;
  if (platform === 'win32') {
    const stripped = stripAuthenticode(binary);
    if (stripped.stripped) console.log(`Removed the Authenticode signature (${stripped.removedBytes} bytes)`);
    base = stripped.data;
  }
  fs.rmSync(outFile, { force: true });
  fs.rmSync(`${outFile}.sha256`, { force: true }); // written again only when the build succeeds
  fs.writeFileSync(outFile, base, { mode: 0o755 });

  // 7. Inject the blob and flip the fuse. postject (LIEF) moves the resources into a new last
  //    section; only then are the icon and version information replaced (resedit rewrites that
  //    last section in place; doing it first makes resedit move .reloc, which LIEF rejects).
  const { inject } = await import('postject');
  await inject(outFile, 'NODE_SEA_BLOB', blob, { sentinelFuse: SENTINEL_FUSE });
  let out = fs.readFileSync(outFile);
  if (platform === 'win32') {
    out = await setWindowsResources(out, { version, fileName, nodeVersion });
    updatePeChecksum(out);
    fs.writeFileSync(outFile, out);
    console.log('Set the icon, the version information and the manifest (consoleAllocationPolicy detached)');
  }
  fs.chmodSync(outFile, 0o755);
  const leaked = findStrings(out, buildPathNeedles(ROOT, os.homedir()));
  if (leaked.length > 0) throw new Error(`${fileName} contains a path of the build machine: ${leaked.join(', ')}`);

  // 8. Optional code signing, the last change to the exe. Signing tools rewrite only the PE checksum
  //    and the certificate-table entry, and append the signature; signExecutable checks exactly that.
  let signed = false;
  if (signTemplate && platform !== 'win32') {
    console.warn(`LYREN_SIGN_CMD is set, but only Windows programs are signed (Authenticode); ${opts.target} is not.`);
  } else if (signTemplate) {
    try {
      out = signExecutable({ template: signTemplate, file: outFile, unsigned: out, blob, fuse: SENTINEL_FUSE });
    } catch (err) {
      // signExecutable has put the unsigned exe back.
      throw new Error(`${err.message}\n${outFile} is NOT signed (the unsigned exe is left there), and no .sha256 file was written.`);
    }
    signed = true;
  }

  // 9. The exe is a program for the target's CPU (also when it can't run here), and a quick
  //    self-test when it can.
  if (platform === 'win32') {
    let machine;
    try {
      machine = peMachine(out);
    } catch (err) {
      throw new Error(`${fileName} is not a valid Windows program (${err.message}). No .sha256 file was written.`);
    }
    if (machine !== PE_MACHINES[opts.target]) {
      throw new Error(`${fileName} is not a ${opts.target} program (PE machine 0x${machine.toString(16)}). No .sha256 file was written.`);
    }
  }
  let selfTest = 'not run (the exe is for another platform)';
  let exitCode = 0;
  if (platform === process.platform && opts.target.endsWith(process.arch)) {
    const help = spawnSync(outFile, ['help'], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
    // Node hides the Win32 error of a refused start: ask Windows why (a policy, or a broken file).
    const start = refusedToStart(help) ? windowsStartError(outFile) : null;
    if (!help.error && help.status === 0 && help.stdout.includes(`Lyren Plan ${version}`)) {
      selfTest = 'passed';
      console.log(`Self-test passed (${fileName} help)`);
    } else if (blockedByWindows(help, process.platform, start)) {
      selfTest = `skipped: Windows blocked the exe (${describeRun(help)}; ${describeStartError(start)})`;
      console.warn('');
      for (const line of blockedExplanation({ fileName, outFile, signed, start })) console.warn(line);
      if (opts.requireSelfTest) exitCode = EXIT_SELF_TEST_BLOCKED;
    } else {
      const output = runOutput(help);
      const why = start ? `\n${describeStartError(start)}` : '';
      throw new Error(`Self-test (${fileName} help) failed: ${describeRun(help)}${why}\n${output || '(no output)'}\nNo .sha256 file was written.`);
    }
  }

  const digest = sha256(out);
  fs.writeFileSync(`${outFile}.sha256`, `${digest}  ${fileName}\n`);
  console.log('');
  console.log(`Output:    ${outFile}`);
  console.log(`Size:      ${mib(out.length)} (${out.length} bytes)`);
  console.log(`SHA-256:   ${digest}  (also in ${fileName}.sha256)`);
  if (platform === 'win32') console.log(`Signed:    ${signed ? 'yes (LYREN_SIGN_CMD)' : 'no'}`);
  console.log(`Self-test: ${selfTest}`);
  console.log(`Done in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  if (exitCode !== 0) {
    console.error(`\npackage: --require-self-test: the self-test could not run (exit code ${exitCode}); the build itself is complete.`);
    process.exitCode = exitCode;
  }
}

main().catch((err) => {
  console.error(`\npackage: ${err.message}`);
  process.exit(1);
});
