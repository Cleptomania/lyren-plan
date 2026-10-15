// Optional signing of the Windows exe (scripts/lib/sign.mjs), with a stand-in signing command: a
// small Node script that appends an Authenticode-shaped certificate table, as signtool does.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { certificateTable, peChecksum, peLayout, updatePeChecksum } from '../lib/pe.mjs';
import { expandSignCommand, parseCommandTemplate, signExecutable, verifySignedImage } from '../lib/sign.mjs';

const PE_MJS = pathToFileURL(fileURLToPath(new URL('../lib/pe.mjs', import.meta.url))).href;
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const BLOB = Buffer.from('pretend SEA blob: lyren-plan.cjs and the web client '.repeat(8));

const dirs = [];
afterAll(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lyren-sign-'));
  dirs.push(d);
  return d;
}

/** A minimal unsigned PE32+ image (odd length, so a signer has to pad) holding the blob and the set fuse. */
function unsignedExe() {
  const buf = Buffer.alloc(4097);
  buf.write('MZ', 0, 'latin1');
  buf.writeUInt32LE(0x80, 0x3c);
  buf.writeUInt32LE(0x00004550, 0x80);
  buf.writeUInt16LE(0x20b, 0x80 + 24);
  buf.writeUInt32LE(16, 0x80 + 24 + 108);
  for (let i = 0x200; i < buf.length; i++) buf[i] = (i * 7) & 0xff;
  BLOB.copy(buf, 0x400);
  buf.write(`${FUSE}:1`, 0xa00, 'latin1');
  updatePeChecksum(buf);
  return buf;
}

/** What a signer does: pad to 8 bytes, append a WIN_CERTIFICATE, point the directory entry at it, fix the checksum. */
function fakeSign(buf, { revision = 0x0200 } = {}) {
  const pad = (8 - (buf.length % 8)) % 8;
  const cert = Buffer.alloc(8 + 120, 0x5a);
  cert.writeUInt32LE(cert.length, 0);
  cert.writeUInt16LE(revision, 4);
  cert.writeUInt16LE(0x0002, 6);
  const signed = Buffer.concat([buf, Buffer.alloc(pad), cert]);
  const { securityEntry } = peLayout(signed);
  signed.writeUInt32LE(buf.length + pad, securityEntry);
  signed.writeUInt32LE(cert.length, securityEntry + 4);
  updatePeChecksum(signed);
  return signed;
}

/** The stand-in signing tool: `node stub.mjs <mode> <file> [<out>]`. */
function writeStub(dir) {
  const stub = path.join(dir, 'stub-sign.mjs');
  fs.writeFileSync(
    stub,
    `import fs from 'node:fs';
import { peLayout, updatePeChecksum } from ${JSON.stringify(PE_MJS)};
const [mode, file, out] = process.argv.slice(2);
if (mode === 'fail') { console.error('stub: signing failed on purpose'); process.exit(2); }
if (mode === 'none') process.exit(0);
const buf = fs.readFileSync(file);
const pad = (8 - (buf.length % 8)) % 8;
const cert = Buffer.alloc(8 + 64, 0x5a);
cert.writeUInt32LE(cert.length, 0);
cert.writeUInt16LE(0x0200, 4);
cert.writeUInt16LE(0x0002, 6);
const signed = Buffer.concat([buf, Buffer.alloc(pad), cert]);
const { securityEntry } = peLayout(signed);
signed.writeUInt32LE(buf.length + pad, securityEntry);
signed.writeUInt32LE(cert.length, securityEntry + 4);
if (mode === 'tamper') signed[0x300] ^= 0xff;
updatePeChecksum(signed);
fs.writeFileSync(mode === 'out' || mode === 'out-then-fail' ? out : file, signed);
// Signed, then a later step (e.g. the timestamp server) failed.
if (mode.endsWith('-then-fail')) { console.error('stub: signed, then failed'); process.exit(1); }
`,
  );
  return stub;
}

describe('LYREN_SIGN_CMD parsing', () => {
  it('splits at spaces; quotes group words and are removed; backslashes stay', () => {
    expect(parseCommandTemplate('signtool sign /fd SHA256 /tr http://timestamp.example /td SHA256 {file}')).toEqual([
      'signtool', 'sign', '/fd', 'SHA256', '/tr', 'http://timestamp.example', '/td', 'SHA256', '{file}',
    ]);
    expect(
      parseCommandTemplate('"C:\\Program Files (x86)\\Windows Kits\\10\\bin\\x64\\signtool.exe" sign /dlib "C:\\Tools\\Azure.CodeSigning.Dlib.dll" {file}'),
    ).toEqual(['C:\\Program Files (x86)\\Windows Kits\\10\\bin\\x64\\signtool.exe', 'sign', '/dlib', 'C:\\Tools\\Azure.CodeSigning.Dlib.dll', '{file}']);
    expect(parseCommandTemplate(" osslsigncode  sign\t-n 'Lyren Plan' -in {file} -out {out} ")).toEqual([
      'osslsigncode', 'sign', '-n', 'Lyren Plan', '-in', '{file}', '-out', '{out}',
    ]);
    expect(parseCommandTemplate('tool --name="Lyren Plan" -p \'\' {file}')).toEqual(['tool', '--name=Lyren Plan', '-p', '', '{file}']);
    // No shell: these are plain words, never expanded.
    expect(parseCommandTemplate('tool $HOME %USERPROFILE% `x` ; | > {file}')).toEqual(['tool', '$HOME', '%USERPROFILE%', '`x`', ';', '|', '>', '{file}']);
  });

  it('takes a JSON array of strings as is', () => {
    expect(parseCommandTemplate('["C:\\\\a b\\\\sign.exe", "--x", "{file}"]')).toEqual(['C:\\a b\\sign.exe', '--x', '{file}']);
    expect(() => parseCommandTemplate('[1, "{file}"]')).toThrow(/JSON array of strings/);
    expect(() => parseCommandTemplate('[]')).toThrow(/JSON array of strings/);
    expect(() => parseCommandTemplate('[not json')).toThrow(/not valid JSON/);
  });

  it('never quotes the value in an error: it may hold a password (R6REV-6)', () => {
    const secret = 'Hunter2SecretPass';
    const mistakes = [
      `["signtool","sign","/f","C:\\\\keys\\\\code.pfx","/p",${secret},"{file}"]`, // unquoted string
      `["signtool","sign","/p","${secret}" "{file}"]`, // missing comma
      `['signtool','sign','/p','${secret}','{file}']`, // single quotes
      `["signtool","sign","/p","${secret}","{file}",]`, // trailing comma
      `["signtool","sign","/p","${secret}","{file}"`, // no closing bracket
    ];
    for (const value of mistakes) {
      let message = '';
      try {
        parseCommandTemplate(value);
      } catch (err) {
        message = err.message;
      }
      expect(message).toMatch(/^LYREN_SIGN_CMD starts with "\[" but is not valid JSON/);
      for (const fragment of ['Hunt', 'Secret', 'Pass', 'signtool', 'keys']) expect(message).not.toContain(fragment);
    }
    expect(() => parseCommandTemplate(`sign /p "${secret}`)).toThrow(/^LYREN_SIGN_CMD has an unterminated " quote$/);
  });

  it('rejects empty values and open quotes', () => {
    expect(() => parseCommandTemplate('   ')).toThrow(/empty/);
    expect(() => parseCommandTemplate(undefined)).toThrow(/empty/);
    expect(() => parseCommandTemplate('sign "C:\\a b {file}')).toThrow(/unterminated " quote/);
  });

  it('fills in {file} and {out}, and insists on {file}', () => {
    expect(expandSignCommand(['signtool', 'sign', '{file}'], { file: 'C:\\d\\app.exe', out: 'C:\\d\\app.exe.signed' })).toEqual({
      command: 'signtool',
      args: ['sign', 'C:\\d\\app.exe'],
      usesOut: false,
    });
    expect(expandSignCommand(['t', '-in={file}', '-out', '{out}'], { file: '/d/a.exe', out: '/d/a.exe.signed' })).toEqual({
      command: 't',
      args: ['-in=/d/a.exe', '-out', '/d/a.exe.signed'],
      usesOut: true,
    });
    expect(() => expandSignCommand(['signtool', 'sign', 'app.exe'], { file: 'x', out: 'y' })).toThrow(/must contain \{file\}/);
  });

  it('refuses cmd.exe when it would misread the exe path, e.g. a checkout in C:\\R&D (R6REV-4)', () => {
    const cmd = ['cmd.exe', '/d', '/c', 'sign.cmd', '{file}'];
    const at = (file, words = cmd) => () => expandSignCommand(words, { file, out: `${file}.signed` });
    for (const ch of ['&', '|', '<', '>', '^', '%', ',', ';', '=']) {
      expect(at(`C:\\R${ch}D\\dist\\app.exe`)).toThrow(new RegExp(`misread the path of the exe at the "\\${ch}"`));
    }
    expect(at('C:\\R&D\\app.exe')).toThrow(/powershell\.exe -NoProfile -ExecutionPolicy Bypass -File .*sign\.ps1 \{file\}/);
    // Any spelling of Command Prompt.
    expect(at('C:\\R&D\\app.exe', ['C:\\Windows\\System32\\CMD.EXE', '/c', 's.cmd', '{file}'])).toThrow(/cmd\.exe/);
    expect(at('C:\\R&D\\app.exe', ['cmd', '/c', 's.cmd', '{file}'])).toThrow(/cmd\.exe/);
    // {out} counts only when it is used.
    expect(at('C:\\RnD\\app.exe', ['cmd', '/c', 's.cmd', '{file}', '{out}'])).not.toThrow();
    expect(() => expandSignCommand(['cmd', '/c', 's.cmd', '{file}', '{out}'], { file: 'C:\\a\\app.exe', out: 'C:\\b%x%\\o' })).toThrow(/"%"/);
    // Paths cmd.exe reads correctly (spaces and parentheses get quoted), and other programs, are fine.
    expect(at('C:\\Program Files (x86)\\My Builds\\app.exe')).not.toThrow();
    expect(at('C:\\R&D\\app.exe', ['powershell.exe', '-NoProfile', '-File', 'sign.ps1', '{file}'])).not.toThrow();
    expect(at('C:\\R&D\\app.exe', ['C:\\Tools\\cmdsign.exe', '{file}'])).not.toThrow();
  });
});

describe('verifySignedImage', () => {
  it('accepts an appended signature that leaves the program unchanged', () => {
    const unsigned = unsignedExe();
    const signed = fakeSign(unsigned);
    expect(signed.length % 8).toBe(0);
    expect(verifySignedImage(signed, unsigned, { blob: BLOB, fuse: FUSE })).toEqual(certificateTable(signed));
    expect(peChecksum(signed)).toBe(signed.readUInt32LE(peLayout(signed).checksumOffset));
  });

  it('refuses a missing, malformed or misplaced signature, and any change to the program', () => {
    const unsigned = unsignedExe();
    expect(() => verifySignedImage(Buffer.from(unsigned), unsigned)).toThrow(/without an Authenticode signature/);
    expect(() => verifySignedImage(fakeSign(unsigned, { revision: 0x0100 }), unsigned)).toThrow(/does not hold an Authenticode/);
    const tampered = fakeSign(unsigned);
    tampered[0x300] ^= 0xff;
    expect(() => verifySignedImage(tampered, unsigned)).toThrow(/changed the program itself/);
    const extra = fakeSign(Buffer.concat([unsigned, Buffer.from('injected')]));
    expect(() => verifySignedImage(extra, unsigned)).toThrow(/added data between/);
    const past = fakeSign(unsigned);
    past.writeUInt32LE(9999, peLayout(past).securityEntry + 4);
    expect(() => verifySignedImage(past, unsigned)).toThrow(/past the end/);
    // The blob and the fuse are looked for as well.
    expect(() => verifySignedImage(fakeSign(unsigned), unsigned, { blob: Buffer.from('another blob entirely') })).toThrow(/SEA blob/);
    expect(() => verifySignedImage(fakeSign(unsigned), unsigned, { fuse: 'NODE_SEA_FUSE_other' })).toThrow(/fuse/);
  });
});

describe('signExecutable with a stand-in signing command', () => {
  const node = JSON.stringify(process.execPath); // quoted: may contain spaces (C:\Program Files\nodejs)
  const quiet = () => {};

  it('signs in place, checks the result and returns the signed bytes', () => {
    const dir = tmp();
    const stub = writeStub(dir);
    const file = path.join(dir, 'Lyren Plan test.exe');
    const unsigned = unsignedExe();
    fs.writeFileSync(file, unsigned);
    const logs = [];
    const signed = signExecutable({ template: `${node} "${stub}" in-place {file}`, file, unsigned, blob: BLOB, fuse: FUSE, log: (l) => logs.push(l) });
    expect(signed.equals(fs.readFileSync(file))).toBe(true);
    expect(certificateTable(signed)).not.toBeNull();
    expect(logs.join('\n')).toMatch(/Signing with .*node/);
    expect(logs.join('\n')).toContain('Authenticode signature added');
  });

  it('moves {out} over the exe (osslsigncode style) and accepts the JSON form', () => {
    const dir = tmp();
    const stub = writeStub(dir);
    const file = path.join(dir, 'app.exe');
    const unsigned = unsignedExe();
    fs.writeFileSync(file, unsigned);
    const template = JSON.stringify([process.execPath, stub, 'out', '{file}', '{out}']);
    const signed = signExecutable({ template, file, unsigned, blob: BLOB, fuse: FUSE, log: quiet });
    expect(certificateTable(fs.readFileSync(file))).toEqual(certificateTable(signed));
    expect(fs.existsSync(`${file}.signed`)).toBe(false);
  });

  it('fails clearly when the command fails, cannot start, signs nothing or changes the program', () => {
    const dir = tmp();
    const stub = writeStub(dir);
    const file = path.join(dir, 'app.exe');
    const unsigned = unsignedExe();
    const attempt = (template) => {
      fs.writeFileSync(file, unsigned);
      return () => signExecutable({ template, file, unsigned, blob: BLOB, fuse: FUSE, log: quiet, run: (cmd, args, opts) => spawnQuiet(cmd, args, opts) });
    };
    expect(attempt(`${node} "${stub}" fail {file}`)).toThrow(/signing command failed \(exit 2\)/);
    expect(attempt(`${node} "${stub}" none {file}`)).toThrow(/without an Authenticode signature/);
    expect(attempt(`${node} "${stub}" tamper {file}`)).toThrow(/changed the program itself/);
    expect(attempt(`${node} "${stub}" none {file} {out}`)).toThrow(/did not write \{out\}/);
    expect(attempt(`"${path.join(dir, 'no-such-signtool')}" sign {file}`)).toThrow(/Could not run the signing command .*not found/);
    expect(attempt('signtool sign app.exe')).toThrow(/must contain \{file\}/);
  });

  it('puts the unsigned exe back when a signer changed it and then failed (R6REV-5)', () => {
    const dir = tmp();
    const stub = writeStub(dir);
    const file = path.join(dir, 'app.exe');
    const unsigned = unsignedExe();
    const sign = (mode, extra = '') => {
      fs.writeFileSync(file, unsigned);
      const template = `${node} "${stub}" ${mode} {file}${extra}`;
      return () => signExecutable({ template, file, unsigned, blob: BLOB, fuse: FUSE, log: quiet, run: spawnQuiet });
    };
    // Signed in place, then exit 1: the file in dist/ must not keep the signature the error denies.
    expect(sign('in-place-then-fail')).toThrow(/signing command failed \(exit 1\)/);
    expect(fs.readFileSync(file).equals(unsigned)).toBe(true);
    // Changed the program: rejected, and the change is undone.
    expect(sign('tamper')).toThrow(/changed the program itself/);
    expect(fs.readFileSync(file).equals(unsigned)).toBe(true);
    // Wrote {out}, then failed: {out} is removed as well.
    expect(sign('out-then-fail', ' {out}')).toThrow(/signing command failed/);
    expect(fs.readFileSync(file).equals(unsigned)).toBe(true);
    expect(fs.existsSync(`${file}.signed`)).toBe(false);
  });
});

/** spawnSync without the inherited console output (the failing stub writes to stderr). */
function spawnQuiet(cmd, args, opts) {
  return spawnSync(cmd, args, { ...opts, stdio: 'pipe' });
}
