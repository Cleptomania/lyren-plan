// Who can read the data folder on Windows. It holds the database (every project and the password
// hash) and desktop.json (the instance secret, see instance.ts). On Linux and macOS the app creates
// it with mode 0700. On Windows modes do nothing: a new folder inherits its parent's permissions,
// and the root of a drive (D:\) lets every local account read (BUILTIN\Users) and even change
// (Authenticated Users) what is created below it. So on Windows:
//   - a data folder the app creates gets a protected ACL: no inheritance, full control for the
//     user, SYSTEM and Administrators only, the same people as for %LOCALAPPDATA%;
//   - for an existing data folder the app changes nothing but warns when other accounts can read
//     or change it, with the command that makes it private.
// icacls.exe and whoami.exe are run by absolute path without a shell; their output is read in
// locale-independent forms (SDDL, SIDs). icacls gets a folder path of MAX_PATH (260) characters or
// more as \\?\<path> (icaclsPath): with the plain path it fails ("Failed processing 1 files"), and
// `/save` even succeeds with an empty file.

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commandShell, psArg, psQuote, shellArg, type ShellCommand } from './console';

/** Runs a program and returns its exit status and output (injectable for tests). */
export type Run = (file: string, args: string[]) => { status: number | null; stdout: string };

const defaultRun: Run = (file, args) => {
  const res = spawnSync(file, args, { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  return { status: res.status, stdout: res.stdout ?? '' };
};

function system32(env: Record<string, string | undefined> = process.env): string {
  return path.win32.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32');
}

const SYSTEM = 'S-1-5-18';
const ADMINISTRATORS = 'S-1-5-32-544';

/**
 * Windows' MAX_PATH: icacls (which is not long-path aware) fails on a folder path of this many
 * characters or more (measured on Windows 11 25H2: 259 works, 260 fails), unless it is given in the
 * \\?\ form, which Windows passes on without the limit.
 */
export const MAX_PATH = 260;

/**
 * `dir` as icacls needs it: as it is when shorter than MAX_PATH, else `\\?\C:\...` (a UNC path
 * `\\server\share\...` as `\\?\UNC\server\share\...`). `dir` is absolute and normalized (config.ts
 * resolves DATA_DIR), as the \\?\ form requires.
 */
export function icaclsPath(dir: string): string {
  if (dir.length < MAX_PATH || dir.startsWith('\\\\?\\')) return dir;
  return dir.startsWith('\\\\') ? `\\\\?\\UNC\\${dir.slice(2)}` : `\\\\?\\${dir}`;
}

/** The SID of the user running this process, from `whoami /user /fo csv /nh`, or null. */
export function parseWhoamiSid(stdout: string): string | null {
  return /"(S-1-5-[0-9-]+)"\s*$/m.exec(stdout.trim())?.[1] ?? null;
}

/** icacls arguments that make `dir` (and what is created in it) private to `sid`, SYSTEM and Administrators. */
export function privateAclArgs(dir: string, sid: string): string[] {
  return [icaclsPath(dir), '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, `*${SYSTEM}:(OI)(CI)F`, `*${ADMINISTRATORS}:(OI)(CI)F`];
}

/**
 * Trustees that stand for other people: Everyone, Users, Authenticated Users, Interactive, Domain
 * Users, Guests (SDDL aliases and their SIDs).
 */
const OTHERS: Record<string, string> = {
  WD: 'Everyone',
  'S-1-1-0': 'Everyone',
  BU: 'Users',
  'S-1-5-32-545': 'Users',
  AU: 'Authenticated Users',
  'S-1-5-11': 'Authenticated Users',
  IU: 'Interactive users',
  'S-1-5-4': 'Interactive users',
  DU: 'Domain Users',
  BG: 'Guests',
  'S-1-5-32-546': 'Guests',
};

/** Whether an ACE's rights include reading or changing file contents (not just creating subfolders). */
function readsOrWrites(rights: string): boolean {
  if (/^0x[0-9a-f]+$/i.test(rights)) {
    // FILE_READ_DATA 0x1, FILE_WRITE_DATA 0x2, GENERIC_ALL / WRITE / READ 0x1000_0000, 0x4000_0000, 0x8000_0000
    return (Number.parseInt(rights.slice(2), 16) & 0xd0000003) !== 0;
  }
  // Two-letter codes: file all / read / write, generic all / read / write.
  return (rights.match(/[A-Z]{2}/g) ?? []).some((code) => ['FA', 'FR', 'FW', 'GA', 'GR', 'GW'].includes(code));
}

/**
 * The other people (see OTHERS) an SDDL string (from `icacls /save`) allows to read or change the
 * object, or to whom it passes such rights on to files created in it.
 */
export function othersWithAccess(saved: string): string[] {
  // `icacls /save` writes the object's name on one line and its SDDL on the next.
  const sddl = saved.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() ?? '';
  const dacl = /D:[A-Z]*((?:\([^)]*\))*)/.exec(sddl)?.[1] ?? '';
  const found = new Set<string>();
  for (const [, ace] of dacl.matchAll(/\(([^)]*)\)/g)) {
    const [type, , rights = '', , , trustee = ''] = ace!.split(';');
    if (type !== 'A') continue;
    const who = OTHERS[trustee] ?? (/^S-1-5-21-[0-9-]+-513$/.test(trustee) ? 'Domain Users' : undefined);
    if (who && readsOrWrites(rights)) found.add(who);
  }
  return [...found];
}

/** The SDDL of `dir` via `icacls <dir> /save <file>` (written as UTF-16), or null. */
function readSddl(dir: string, run: Run): string | null {
  const file = path.join(os.tmpdir(), `lyren-acl-${randomBytes(6).toString('hex')}.txt`);
  try {
    if (run(path.win32.join(system32(), 'icacls.exe'), [icaclsPath(dir), '/save', file, '/c']).status !== 0) return null;
    const saved = fs.readFileSync(file).toString('utf16le');
    return saved.trim() ? saved : null; // nothing saved: not read, so no verdict
  } catch {
    return null;
  } finally {
    fs.rmSync(file, { force: true });
  }
}

function currentUserSid(run: Run): string | null {
  const res = run(path.win32.join(system32(), 'whoami.exe'), ['/user', '/fo', 'csv', '/nh']);
  return res.status === 0 ? parseWhoamiSid(res.stdout) : null;
}

/**
 * The command that makes `dir` private, for the warning: for Command Prompt, or for PowerShell when
 * the folder's path has a % in it, which Command Prompt would change (console.ts commandShell). A
 * long path in the \\?\ form (icaclsPath), as icacls needs it typed too. A trailing backslash (the
 * root of a drive or a share) is doubled where the shell would otherwise eat it: in Command Prompt
 * always, in PowerShell when the path has whitespace (psArg).
 */
export function privateAclCommand(dir: string, sid: string | null): ShellCommand {
  const target = icaclsPath(dir);
  const shell = commandShell([target], 'win32');
  const grants = [`*${SYSTEM}:(OI)(CI)F`, `*${ADMINISTRATORS}:(OI)(CI)F`];
  if (shell === 'powershell') {
    const user = sid ? psQuote(`*${sid}:(OI)(CI)F`) : '"${env:USERNAME}:(OI)(CI)F"';
    return { shell, text: `icacls ${psArg(target)} /inheritance:r /grant:r ${user} ${grants.map(psQuote).join(' ')}` };
  }
  const user = sid ? `*${sid}` : '%USERNAME%';
  return { shell, text: `icacls ${shellArg(target, 'cmd')} /inheritance:r /grant:r "${user}:(OI)(CI)F" ${grants.map((g) => `"${g}"`).join(' ')}` };
}

/**
 * Make the data folder the app has just created private (Windows). Returns warnings for the
 * console when that was not possible (e.g. a FAT-formatted USB drive has no permissions at all).
 */
export function protectNewDataFolder(dir: string, run: Run = defaultRun): string[] {
  const sid = currentUserSid(run);
  const res = sid ? run(path.win32.join(system32(), 'icacls.exe'), privateAclArgs(dir, sid)) : null;
  if (res?.status === 0) return [];
  return [
    `Warning: could not make the data folder ${dir} private to your Windows account,`,
    'so other accounts on this computer may be able to read it.',
  ];
}

/** Warnings when other Windows accounts can read or change an existing data folder. */
export function checkExistingDataFolder(dir: string, run: Run = defaultRun): string[] {
  const sddl = readSddl(dir, run);
  if (sddl === null) return [];
  const others = othersWithAccess(sddl);
  if (others.length === 0) return [];
  const command = privateAclCommand(dir, currentUserSid(run));
  return [
    `Warning: other Windows accounts on this computer can open the data folder ${dir}`,
    `(it gives access to ${others.join(', ')}), and with it your projects and password hash.`,
    `To make it private to you, run this once in ${command.shell === 'powershell' ? 'PowerShell' : 'Command Prompt'}:`,
    `  ${command.text}`,
  ];
}
