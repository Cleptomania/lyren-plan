// Optional Authenticode signing of the Windows exe (scripts/package.mjs, step 8) and the checks
// around it. Unit-tested in scripts/test/sign.test.mjs.
//
// LYREN_SIGN_CMD is a command template, run WITHOUT a shell:
//   - plain text is split at spaces and tabs; "double" or 'single' quotes keep spaces together and
//     are removed; there are no escape characters, so Windows paths keep their backslashes;
//   - or a JSON array of strings (when the value starts with "["), taken as is;
//   - {file} stands for the exe and must appear; {out}, if used, is a separate output file that
//     replaces the exe afterwards (osslsigncode writes its result to a new file).
// No variables, pipes, redirections or globbing: the template's words become the program and its
// arguments exactly. For more than one program, put the steps in a PowerShell script and run it as
// `powershell.exe -NoProfile -ExecutionPolicy Bypass -File sign.ps1 {file}`: PowerShell hands the
// path to the script as it is. A .cmd/.bat file can't be started without a shell (Node refuses
// it), and `cmd.exe /d /c sign.cmd {file}` parses the command line again, splitting a path at & |
// < > ^ and expanding %...%, so that form is refused when the exe's path has such a character.
//
// The value may hold a secret (a PFX password): no message quotes it, only the program's name.
//
// When signing fails, the unsigned exe is put back, so dist/ never holds a half-signed one.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { certificateTable, peLayout } from './pe.mjs';

const WIN_CERT_REVISION_2_0 = 0x0200;
const WIN_CERT_TYPE_PKCS_SIGNED_DATA = 0x0002;

/** Split a LYREN_SIGN_CMD value into words (see the header). Throws on an unusable value. */
export function parseCommandTemplate(text) {
  const value = String(text ?? '').trim();
  if (value === '') throw new Error('LYREN_SIGN_CMD is empty');
  if (value.startsWith('[')) {
    let words;
    try {
      words = JSON.parse(value);
    } catch (err) {
      // Not err.message: V8 quotes the text around the mistake, which may be part of a password.
      const at = /\bposition (\d+)/.exec(String(err?.message ?? ''));
      throw new Error(
        `LYREN_SIGN_CMD starts with "[" but is not valid JSON${at ? ` (the mistake is near character ${Number(at[1]) + 1})` : ''}: ` +
          'check the double quotes, the commas between the strings and the doubled backslashes',
      );
    }
    if (!Array.isArray(words) || words.length === 0 || !words.every((w) => typeof w === 'string') || words[0] === '') {
      throw new Error('LYREN_SIGN_CMD starts with "[" but is not a non-empty JSON array of strings');
    }
    return words;
  }
  const words = [];
  let word = '';
  let inWord = false;
  let quote = null;
  for (const ch of value) {
    if (quote) {
      if (ch === quote) quote = null;
      else word += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      inWord = true;
    } else if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      if (inWord) words.push(word);
      word = '';
      inWord = false;
    } else {
      word += ch;
      inWord = true;
    }
  }
  if (quote) throw new Error(`LYREN_SIGN_CMD has an unterminated ${quote} quote`);
  if (inWord) words.push(word);
  return words;
}

/**
 * Characters that make cmd.exe misread a path it gets on its command line: & | < > ^ split or escape
 * it (Node quotes an argument only when it has a space, a tab or a quote), % expands variables even
 * inside quotes, and , ; = separate a batch file's arguments (%1).
 */
const CMD_SPECIAL = /[&|<>^%,;=]/;

/** The program is Command Prompt (cmd or cmd.exe, with or without a folder). */
const isCmd = (program) => /^cmd(\.exe)?$/i.test(path.win32.basename(program));

/**
 * The program and arguments for signing `file`: {file} and {out} replaced in every word.
 * `usesOut` tells the caller to move `out` over `file` afterwards. Refuses cmd.exe when the paths
 * have a character it would misread (CMD_SPECIAL).
 */
export function expandSignCommand(words, { file, out }) {
  if (!words.some((w) => w.includes('{file}'))) {
    throw new Error('LYREN_SIGN_CMD must contain {file}, which stands for the exe to sign');
  }
  const usesOut = words.some((w) => w.includes('{out}'));
  if (isCmd(words[0])) {
    const bad = [file, ...(usesOut ? [out] : [])].map((p) => CMD_SPECIAL.exec(p)?.[0]).find(Boolean);
    if (bad) {
      throw new Error(
        `LYREN_SIGN_CMD runs cmd.exe, which would misread the path of the exe at the "${bad}" in it:\n  ${file}\n` +
          'Put the signing steps in a PowerShell script and set LYREN_SIGN_CMD to\n' +
          '  powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\\path\\to\\sign.ps1 {file}\n' +
          'or build in a folder whose path has none of & | < > ^ % , ; =',
      );
    }
  }
  const expanded = words.map((w) => w.replaceAll('{file}', file).replaceAll('{out}', out));
  return { command: expanded[0], args: expanded.slice(1), usesOut };
}

/**
 * Check a freshly signed exe against the unsigned one it was made from: a certificate table was
 * appended (a WIN_CERTIFICATE holding PKCS#7 signed data), the image before it is unchanged apart
 * from the PE checksum and the certificate-table directory entry (the two fields Authenticode
 * excludes from its hash and a signer updates), and the SEA blob with the flipped fuse is still in
 * it. Returns {offset, size} of the table; throws when anything else changed.
 */
export function verifySignedImage(signed, unsigned, { blob, fuse } = {}) {
  let table;
  try {
    table = certificateTable(signed);
  } catch (err) {
    throw new Error(`The signed file is no longer a valid Windows program: ${err.message}`);
  }
  if (!table) throw new Error('The signing command left the exe without an Authenticode signature (no certificate table)');
  const { offset, size } = table;
  if (offset + size > signed.length) throw new Error('The certificate table extends past the end of the signed file');
  if (offset < unsigned.length) throw new Error('The certificate table overlaps the program image');
  if (offset % 8 !== 0) throw new Error('The certificate table is not 8-byte aligned');
  if (size < 8) throw new Error('The certificate table is too small to hold a signature');
  const dwLength = signed.readUInt32LE(offset);
  const wRevision = signed.readUInt16LE(offset + 4);
  const wCertificateType = signed.readUInt16LE(offset + 6);
  if (dwLength < 8 || dwLength > size || wRevision !== WIN_CERT_REVISION_2_0 || wCertificateType !== WIN_CERT_TYPE_PKCS_SIGNED_DATA) {
    throw new Error('The certificate table does not hold an Authenticode (PKCS#7) signature');
  }
  if (signed.subarray(unsigned.length, offset).some((b) => b !== 0)) {
    throw new Error('The signing command added data between the program image and its signature');
  }
  // Byte-for-byte equal up to the old end of file, except the two fields a signer rewrites.
  const { checksumOffset, securityEntry } = peLayout(unsigned);
  const skip = [
    [checksumOffset, checksumOffset + 4],
    [securityEntry, securityEntry + 8],
  ].sort((a, b) => a[0] - b[0]);
  let start = 0;
  for (const [from, to] of [...skip, [unsigned.length, unsigned.length]]) {
    if (!signed.subarray(start, from).equals(unsigned.subarray(start, from))) {
      throw new Error('The signing command changed the program itself, not only its signature');
    }
    start = to;
  }
  if (blob && signed.indexOf(blob) === -1) throw new Error('The signed exe no longer contains the app (SEA blob)');
  if (fuse && signed.indexOf(`${fuse}:1`) === -1) throw new Error('The signed exe no longer has the SEA fuse set');
  return { offset, size };
}

/**
 * Run LYREN_SIGN_CMD on `file` (an unsigned exe whose contents are `unsigned`) and verify the
 * result. Returns the signed file's contents. Output of the signing tool goes to the console
 * (stdio inherited: a hardware token may ask for its PIN). `run` is injectable for tests.
 *
 * On any failure `file` gets the unsigned bytes back and {out} is removed before the error is
 * thrown: a signer may have changed the exe before it failed (signed, then the timestamp server
 * was unreachable), and what is left in dist/ must be what the error says, the unsigned exe.
 */
export function signExecutable({ template, file, unsigned, blob, fuse, run = spawnSync, log = console.log }) {
  const words = parseCommandTemplate(template);
  const out = `${file}.signed`;
  const { command, args, usesOut } = expandSignCommand(words, { file, out });
  fs.rmSync(out, { force: true });
  log(`Signing with ${command} (LYREN_SIGN_CMD)`);
  try {
    const res = run(command, args, { stdio: 'inherit', shell: false, windowsHide: false });
    if (res.error) {
      const hint =
        res.error.code === 'ENOENT'
          ? ' (not found: give the full path of the program, or check PATH)'
          : res.error.code === 'EINVAL' && /\.(cmd|bat)$/i.test(command)
            ? ' (a .cmd or .bat file needs a shell: put the steps in a PowerShell script and use' +
              ' "powershell.exe -NoProfile -ExecutionPolicy Bypass -File <script.ps1> {file}")'
            : '';
      throw new Error(`Could not run the signing command ${command}: ${res.error.message}${hint}`);
    }
    if (res.status !== 0) throw new Error(`The signing command failed (${res.status === null ? `signal ${res.signal}` : `exit ${res.status}`})`);
    if (usesOut) {
      if (!fs.existsSync(out)) throw new Error(`The signing command did not write {out} (${out})`);
      fs.renameSync(out, file);
    }
    const signed = fs.readFileSync(file);
    const table = verifySignedImage(signed, unsigned, { blob, fuse });
    log(`Signed: Authenticode signature added (${table.size} bytes); the app inside is unchanged`);
    return signed;
  } catch (err) {
    try {
      fs.rmSync(out, { force: true });
      fs.writeFileSync(file, unsigned);
    } catch (restoreErr) {
      err.message += `\nPutting the unsigned exe back failed as well (${restoreErr.message}): delete ${file} and build again.`;
    }
    throw err;
  }
}
