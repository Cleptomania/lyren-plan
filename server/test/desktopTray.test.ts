// The Windows app without a console window (server/src/desktop: mode.ts, powershell.ts, scripts.ts,
// tray.ts, dialog.ts, relaunch.ts, log.ts, runtime.ts) and the `stop` command (instance.ts, main.ts).
// Windows itself is faked here (processes, PowerShell); the real thing is exercised on a Windows
// desktop by hand (SPEC §12.1, test hooks).

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import { Console } from 'node:console';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { CliExit, lockoutAdvice, resetPassword } from '../src/cli';
import { bannerLines, bannerNotices, commandLine, commandShell, howToRun, ps51ArgText, psArg, psQuote, shellArg, stopLines, type BannerInfo } from '../src/desktop/console';
import { commandTargetOption } from '../src/runtime/node/desktop';
import { folderCommand, FolderTooLongError, MAX_EXPLORER_PATH } from '../src/desktop/browser';
import { desktopFiles, readStateOf } from '../src/desktop/files';
import { dialogText, MAX_DIALOG_TEXT, reportProblem, showDialog, type DialogDeps } from '../src/desktop/dialog';
import { NO_TEST_HOOKS, testHooks } from '../src/desktop/hooks';
import { acquireInstanceLock, instanceProof, requestStop, stopProof } from '../src/desktop/instance';
import { captureOutput, LogFile, LOG_FILE_NAME, OLD_LOG_FILE_NAME, oldLogName, REDACTED, timestamp } from '../src/desktop/log';
import {
  commandMode,
  decideMode,
  DETACHED_CONSOLE_BUILD,
  isRedirected,
  parseTasklist,
  parseTasklistSession,
  processImage,
  processSession,
  stdioState,
  UNATTENDED_PARENTS,
  windowsBuild,
  type ModeInput,
} from '../src/desktop/mode';
import {
  BOOT_TAG,
  BOOTSTRAP,
  bootstrapCommand,
  directLaunch,
  lineSplitter,
  parseScriptLine,
  powershellPath,
  SCRIPT_END,
  scriptInput,
  outsideJobLaunch,
  type Launch,
} from '../src/desktop/powershell';
import { ARGS_VAR, consoleRelaunchCommand, EXE_VAR, MESSAGE_VAR, REF_VAR, relaunchInConsole, takeRelaunchVariables } from '../src/desktop/relaunch';
import { DIALOG_SCRIPT, TRAY_SCRIPT } from '../src/desktop/scripts';
import { createRuntime, consoleRuntime, fitsMessageBox, type DesktopRuntime } from '../src/desktop/runtime';
import { installShutdown, noBrowserReason, runningHint, unusableInstanceMessage, waitingMessage } from '../src/desktop/serve';
import { MAX_RESTARTS, TrayHost, trayMenu, trayTooltip, type HelperProcess, type TrayOptions } from '../src/desktop/tray';
import { directoryWithOwner, ownerPasswordHash } from './support/directoryFile';
import { ROOT, tsxCommand, tsxEnv } from './tsxNode';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
function tmp(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** Values a path, address, label or message could hold that a shell or PowerShell would read as code. */
const HOSTILE = [`Dana's`, 'Dana’s ‘x’ ‚y‛', '$(Remove-Item C:\\)', '`whoami`', 'say "hi"', 'a\nb\r\nc', 'R&D | x > y', '100% %PATH% !x!', '^caret', 'ü 漢字 🙂', "'; exit; '"];

// ---- Mode ---------------------------------------------------------------------------------------

describe('how serve shows itself (mode.ts)', () => {
  const base: ModeInput = {
    windowsApp: true,
    forceConsole: false,
    hasConsole: false,
    redirected: false,
    build: 26200,
    relaunched: false,
    parentImage: () => {
      throw new Error('asked only on older Windows');
    },
  };

  it('Linux, macOS, from source: always the console', () => {
    for (const input of [{ ...base, windowsApp: false }, { ...base, windowsApp: false, hasConsole: true, forceConsole: true }]) {
      expect(decideMode(input)).toBe('console');
    }
  });

  it('Windows 11 24H2 and later: double-click -> tray, a terminal -> terminal (console and icon)', () => {
    expect(decideMode(base)).toBe('tray');
    expect(decideMode({ ...base, hasConsole: true })).toBe('terminal');
    expect(decideMode({ ...base, hasConsole: true, build: DETACHED_CONSOLE_BUILD })).toBe('terminal');
  });

  it('--console: the console window as before; without one (a shortcut) a new console window', () => {
    expect(decideMode({ ...base, forceConsole: true, hasConsole: true })).toBe('console');
    expect(decideMode({ ...base, forceConsole: true })).toBe('relaunch-console');
    expect(decideMode({ ...base, forceConsole: true, redirected: true })).toBe('console');
  });

  it('output redirected without a console (a script, a service wrapper): the console behaviour, no icon', () => {
    expect(decideMode({ ...base, redirected: true })).toBe('console');
  });

  it('older Windows: a console Windows opened for a double-click is left at once; a terminal keeps it', () => {
    const old = { ...base, hasConsole: true, build: 19045 };
    expect(decideMode({ ...old, parentImage: () => 'explorer.exe' })).toBe('relaunch-hidden');
    expect(decideMode({ ...old, parentImage: () => null })).toBe('relaunch-hidden'); // parent gone
    expect(decideMode({ ...old, parentImage: () => 'cmd.exe' })).toBe('terminal');
    expect(decideMode({ ...old, parentImage: () => 'powershell.exe' })).toBe('terminal');
    expect(decideMode({ ...old, parentImage: () => 'unknown' })).toBe('terminal');
    // The copy started hidden never relaunches again (no loop), and without a console it is the tray.
    expect(decideMode({ ...old, relaunched: true, parentImage: () => 'explorer.exe' })).toBe('terminal');
    expect(decideMode({ ...old, hasConsole: false, relaunched: true })).toBe('tray');
  });

  it('other commands without a console: unattended only in session 0 or started by Task Scheduler, a service or WMI; else a box (FV-3)', () => {
    const asked: string[] = [];
    const start = (session: number | null, image: string | null) => ({
      session: () => {
        asked.push(`session ${session}`);
        return session;
      },
      parentImage: () => {
        asked.push(`parent ${image}`);
        return image;
      },
    });
    const cmd = { windowsApp: true, hasConsole: false, redirected: false };
    // Any start a person may have made: Explorer (a shortcut, Win+R), another file manager or launcher,
    // Start-Process in a PowerShell window, a script's node.exe, a parent that has ended, tasklist failing.
    for (const image of ['explorer.exe', 'totalcmd64.exe', 'powertoys.powerlauncher.exe', 'powershell.exe', 'pwsh.exe', 'cmd.exe', 'node.exe', null, 'unknown']) {
      expect(commandMode({ ...cmd, ...start(1, image) }), String(image)).toBe('tray');
    }
    // An unknown session (tasklist failing) is not session 0: the parent decides.
    expect(commandMode({ ...cmd, ...start(null, 'explorer.exe') })).toBe('tray');
    expect(commandMode({ ...cmd, ...start(null, 'svchost.exe') })).toBe('unattended');
    // Task Scheduler (svchost.exe; taskhostw.exe, and taskhost.exe / taskhostex.exe / taskeng.exe on older
    // Windows), the service control manager and WMI, in any session (case as tasklist prints it, lowered).
    for (const image of ['svchost.exe', 'taskhostw.exe', 'taskhost.exe', 'taskhostex.exe', 'taskeng.exe', 'services.exe', 'wmiprvse.exe']) {
      expect(UNATTENDED_PARENTS.has(image), image).toBe(true);
      expect(commandMode({ ...cmd, ...start(1, image) }), image).toBe('unattended');
    }
    // Session 0 (services; "Run whether user is logged on or not"; no desktop): unattended whatever the
    // parent, which is then not asked. (Not reproducible on a desktop without changing the system: covered here.)
    asked.length = 0;
    expect(commandMode({ ...cmd, ...start(0, 'explorer.exe') })).toBe('unattended');
    expect(asked).toEqual(['session 0']);
    asked.length = 0;
    expect(commandMode({ ...cmd, ...start(2, 'explorer.exe') })).toBe('tray'); // another person's session (RDP)
    expect(asked).toEqual(['session 2', 'parent explorer.exe']);
    // A console or redirected output: printed as always, nothing is asked.
    asked.length = 0;
    expect(commandMode({ ...cmd, hasConsole: true, ...start(0, 'svchost.exe') })).toBe('console');
    expect(commandMode({ ...cmd, redirected: true, ...start(0, 'svchost.exe') })).toBe('console');
    expect(commandMode({ ...cmd, windowsApp: false, ...start(0, 'svchost.exe') })).toBe('console');
    expect(asked).toEqual([]);
  });

  it('redirected: a file or a pipe, not NUL (a character device) and not a console', () => {
    const file = path.join(tmp('lyren-stdio-'), 'f');
    fs.writeFileSync(file, '');
    expect(isRedirected(fs.statSync(file))).toBe(true);
    // A Windows pipe: mode 0o010000, isFIFO() false (fs.constants has no S_IFIFO there).
    expect(isRedirected({ isCharacterDevice: () => false })).toBe(true);
    expect(isRedirected({ isCharacterDevice: () => true })).toBe(false); // NUL
    expect(isRedirected(null)).toBe(false);
    if (process.platform !== 'win32') expect(isRedirected(fs.statSync('/dev/null'))).toBe(false);
    // Under the test runner stdout is a pipe.
    expect(stdioState().redirected || stdioState().hasConsole).toBe(true);
  });

  it('the Windows build and the parent process (tasklist)', () => {
    expect(windowsBuild('10.0.26200')).toBe(26200);
    expect(windowsBuild('10.0.19045')).toBe(19045);
    expect(windowsBuild('6.2')).toBe(0);
    expect(windowsBuild('garbage')).toBe(0);
    expect(parseTasklist('"explorer.exe","5544","Console","1","123,456 K"\r\n')).toBe('explorer.exe');
    expect(parseTasklist('"CMD.EXE","1","Console","1","1 K"')).toBe('cmd.exe');
    expect(parseTasklist('INFO: No tasks are running which match the specified criteria.\r\n')).toBeNull();
    expect(parseTasklist('INFO: Es werden keine Aufgaben mit den angegebenen Kriterien ausgeführt.')).toBeNull();
    const calls: string[][] = [];
    const image = processImage(77, (file, args) => {
      calls.push([file, ...args]);
      return { status: 0, stdout: '"explorer.exe","77","Console","1","9 K"' };
    }, { SystemRoot: 'C:\\Windows' });
    expect(image).toBe('explorer.exe');
    expect(calls).toEqual([['C:\\Windows\\System32\\tasklist.exe', '/FI', 'PID eq 77', '/FO', 'CSV', '/NH']]);
    expect(processImage(77, () => ({ status: 1, stdout: '' }))).toBe('unknown');
  });

  it('the session of a process (tasklist Session#), for commandMode', () => {
    expect(parseTasklistSession('"lyren-plan-0.1.0-win-x64.exe","5544","Console","1","123,456 K"\r\n')).toBe(1);
    expect(parseTasklistSession('"svchost.exe","1234","Services","0","9.876 K"')).toBe(0);
    expect(parseTasklistSession('"x.exe","7","RDP-Tcp#3","12","1 K"')).toBe(12);
    expect(parseTasklistSession('INFO: No tasks are running which match the specified criteria.\r\n')).toBeNull();
    expect(parseTasklistSession('"x.exe","7"')).toBeNull();
    expect(parseTasklistSession('"x.exe","7","Console","N/A","1 K"')).toBeNull();
    const calls: string[][] = [];
    expect(
      processSession(4242, (file, args) => {
        calls.push([file, ...args]);
        return { status: 0, stdout: '"lyren.exe","4242","Services","0","9 K"\r\n' };
      }, { SystemRoot: 'D:\\Win' }),
    ).toBe(0);
    expect(calls).toEqual([['D:\\Win\\System32\\tasklist.exe', '/FI', 'PID eq 4242', '/FO', 'CSV', '/NH']]);
    expect(processSession(4242, () => ({ status: 1, stdout: '' }))).toBeNull(); // unknown: not session 0
  });
});

// ---- PowerShell launch ------------------------------------------------------------------------------

describe('Windows PowerShell launch (powershell.ts)', () => {
  const env = { SystemRoot: 'C:\\Windows' };

  it('by absolute path, -NoProfile -NonInteractive, no ExecutionPolicy, no EncodedCommand, no file', () => {
    expect(powershellPath(env)).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    const direct = directLaunch(false, env);
    expect(direct).toEqual({ file: powershellPath(env), args: ['-NoProfile', '-NonInteractive', '-Command', BOOTSTRAP], verbatim: false, cwd: 'C:\\Windows\\System32' });
    const tray = outsideJobLaunch(false, env);
    expect(tray.file).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(tray.verbatim).toBe(true);
    // Never the app's working folder: in a network folder cmd.exe would warn about it on stderr.
    expect(tray.cwd).toBe('C:\\Windows\\System32');
    expect(tray.args).toEqual(['/d', '/s', '/c', `""${powershellPath(env)}" -NoProfile -NonInteractive -Command "${BOOTSTRAP}""`]);
    for (const launch of [direct, tray]) expect(launch.args.join(' ')).not.toMatch(/ExecutionPolicy|EncodedCommand|-File/i);
  });

  it('the bootstrap passes through cmd.exe unchanged: no double quote, % or !', () => {
    for (const constrained of [false, true]) expect(bootstrapCommand(constrained)).not.toMatch(/["%!]/);
    expect(BOOTSTRAP.startsWith(`'${BOOT_TAG} ' + $ExecutionContext.SessionState.LanguageMode;`)).toBe(true);
    expect(BOOTSTRAP).toContain(`-ne '${SCRIPT_END}'`);
    // The test hook switches the session to ConstrainedLanguage before anything else runs.
    expect(bootstrapCommand(true)).toBe(`$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'; ${BOOTSTRAP}`);
    expect(outsideJobLaunch(true, env).args[3]).toContain("LanguageMode = 'ConstrainedLanguage'");
    expect(() => outsideJobLaunch(false, { SystemRoot: 'C:\\100%' })).toThrow(/must not contain/);
  });

  it('scripts travel as text lines with an end marker; values only as JSON data', () => {
    expect(scriptInput('a\r\nb\n\n')).toBe(`a\nb\n${SCRIPT_END}\n`);
    expect(() => scriptInput(`x\n${SCRIPT_END}\ny`)).toThrow(/end marker/);
    for (const script of [TRAY_SCRIPT, DIALOG_SCRIPT]) {
      expect(script.split('\n')).not.toContain(SCRIPT_END);
      // Nothing is evaluated from data: no Invoke-Expression, no ScriptBlock made from a message.
      expect(script).not.toMatch(/Invoke-Expression|\biex\b|ScriptBlock\]::Create|Add-Type -TypeDefinition/i);
      expect(script).toContain('ConvertFrom-Json');
      expect(script).toMatch(/^param\(\[System\.IO\.TextReader\]\$Reader\)$/m);
      expect(script).not.toMatch(/Out-File|Set-Content|WriteAllText|\$env:TEMP/i); // writes no files
    }
    // The icon comes as base64 data and is read from memory, never from a temporary file.
    expect(TRAY_SCRIPT).toContain('[Convert]::FromBase64String([string]$Init.icon)');
    expect(TRAY_SCRIPT).toContain('(New-Object System.Drawing.IconConverter).ConvertFrom($bytes)');
    // The bold default item, the left click, the session end, and the icon removed on every way out.
    expect(TRAY_SCRIPT).toContain('$menuItem.DefaultItem = $true');
    expect(TRAY_SCRIPT).toContain('[System.Windows.Forms.MouseButtons]::Left');
    expect(TRAY_SCRIPT).toContain('add_SessionEnding');
    expect(TRAY_SCRIPT).toMatch(/finally \{[\s\S]*\$script:notify\.Visible = \$false; \$script:notify\.Dispose\(\)/);
    // Test operations only when the app asked for them (LYREN_TEST_TRAY_CONTROL).
    expect(TRAY_SCRIPT).toContain("'test' { if ($script:testHooks) { Invoke-Test ([string]$m.op) } }");
  });

  it('no word PowerShell logs as suspicious (event 4104 warnings, which security tools watch)', () => {
    // Windows PowerShell's list of "suspicious" words (substrings, any case). FromBase64String is on
    // later lists but is not logged by 5.1 (measured), and the icon arrives as base64.
    const SUSPICIOUS_WORDS = [
      'Add-Type', 'DllImport', 'DefineDynamicAssembly', 'DefineDynamicModule', 'DefineType', 'DefineConstructor', 'CreateType',
      'DefineLiteral', 'DefineEnum', 'DefineField', 'ILGenerator', 'Emit', 'UnverifiableCodeAttribute', 'DefinePInvokeMethod',
      'GetTypes', 'GetAssemblies', 'Methods', 'Properties', 'GetConstructor', 'GetDefaultMembers', 'GetEvent', 'GetField',
      'GetInterface', 'GetMember', 'GetMethod', 'GetNestedType', 'GetProperties', 'GetProperty', 'InvokeMember', 'MakeArrayType',
      'MakeByRefType', 'MakeGenericType', 'MakePointerType', 'DeclaringMethod', 'DeclaringType', 'ReflectedType', 'TypeHandle',
      'TypeInitializer', 'UnderlyingSystemType', 'InteropServices', 'Marshal', 'AllocHGlobal', 'PtrToStructure', 'StructureToPtr',
      'FreeHGlobal', 'IntPtr', 'MemoryStream', 'DeflateStream', 'EncodedCommand', 'Bypass', 'ToBase64String', 'ExpandString',
      'GetPowerShell', 'OpenProcess', 'VirtualAlloc', 'VirtualFree', 'WriteProcessMemory', 'CreateUserThread', 'CloseHandle',
      'GetDelegateForFunctionPointer', 'kernel32', 'CreateThread', 'memcpy', 'LoadLibrary', 'GetModuleHandle', 'GetProcAddress',
      'VirtualProtect', 'FreeLibrary', 'ReadProcessMemory', 'CreateRemoteThread', 'AdjustTokenPrivileges', 'WriteByte', 'WriteInt32',
      'OpenThreadToken', 'PtrToString', 'OpenProcessToken', 'GetTokenInformation', 'SetThreadToken', 'ImpersonateLoggedOnUser',
      'RevertToSelf', 'GetLogonSessionData', 'CreateProcessWithToken', 'DuplicateTokenEx', 'OpenWindowStation', 'OpenDesktop',
      'MiniDumpWriteDump', 'AddSecurityPackage', 'EnumerateSecurityPackages', 'GetProcessHandle', 'DangerousGetHandle',
      'CryptoServiceProvider', 'Cryptography', 'RijndaelManaged', 'SHA1Managed', 'CryptoStream', 'CreateEncryptor', 'CreateDecryptor',
      'TransformFinalBlock', 'DeviceIoControl', 'SetInformationProcess', 'PasswordDeriveBytes', 'GetAsyncKeyState',
      'GetKeyboardState', 'GetForegroundWindow', 'BindingFlags', 'NonPublic', 'ScriptBlockLogging', 'LogPipelineExecutionDetails',
      'ProtectedEventLogging',
    ];
    for (const [name, script] of [['TRAY_SCRIPT', TRAY_SCRIPT], ['DIALOG_SCRIPT', DIALOG_SCRIPT], ['BOOTSTRAP', bootstrapCommand(true)]] as const) {
      const lower = script.toLowerCase();
      expect(SUSPICIOUS_WORDS.filter((w) => lower.includes(w.toLowerCase())), name).toEqual([]);
    }
    // The assemblies by their full names (what Add-Type -AssemblyName loads).
    expect(TRAY_SCRIPT).toContain("[System.Reflection.Assembly]::Load('System.Windows.Forms, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089')");
    expect(TRAY_SCRIPT).toContain("[System.Reflection.Assembly]::Load('System.Drawing, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a')");
    expect(DIALOG_SCRIPT).toContain("[System.Reflection.Assembly]::Load('System.Windows.Forms, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089')");
  });

  it('reads lines: partial chunks, CRLF, blank lines, a runaway line', () => {
    const lines: string[] = [];
    const push = lineSplitter((l) => lines.push(l), 20);
    push('{"type":"he');
    push('llo"}\r\n\r\n  \n{"type":"ready"}\n');
    push('x'.repeat(30));
    push('still the long line\nafter\n');
    expect(lines).toEqual(['{"type":"hello"}', '{"type":"ready"}', 'after']);
  });

  it('parses the boot line, messages, and anything else as noise', () => {
    expect(parseScriptLine(`${BOOT_TAG} FullLanguage`)).toEqual({ type: 'boot', languageMode: 'FullLanguage' });
    expect(parseScriptLine(`${BOOT_TAG} ConstrainedLanguage\r`)).toEqual({ type: 'boot', languageMode: 'ConstrainedLanguage' });
    expect(parseScriptLine('{"type":"action","id":"open","via":"menu"}')).toEqual({ type: 'action', id: 'open', via: 'menu' });
    for (const noise of ['garbage', '[1,2]', '{"id":"open"}', '{"type":5}', 'null', 'At line:1 char:1', '{"type":"x"']) {
      expect(parseScriptLine(noise).type, noise).toBe('noise');
    }
  });
});

// ---- Tray host ------------------------------------------------------------------------------------

/** A fake helper process: records what the app writes, and says what a helper would. */
class FakeHelper {
  readonly pid = 4000 + Math.floor(Math.random() * 1000);
  written = '';
  ended = false;
  killed = false;
  private out: ((chunk: string) => void) | null = null;
  private err: ((chunk: string) => void) | null = null;
  private exits: Array<(code: number | null) => void> = [];
  readonly stdin = {
    write: (text: string) => {
      this.written += text;
    },
    end: () => {
      this.ended = true;
    },
    on: () => undefined,
  };
  readonly stdout = { setEncoding: () => undefined, on: (_e: 'data', fn: (chunk: string) => void) => (this.out = fn) };
  readonly stderr = { setEncoding: () => undefined, on: (_e: 'data', fn: (chunk: string) => void) => (this.err = fn) };
  on(event: string, fn: (arg: never) => void) {
    if (event === 'exit') this.exits.push(fn as (code: number | null) => void);
    return this;
  }
  kill() {
    this.killed = true;
    return true;
  }
  say(text: string) {
    this.out?.(text);
  }
  sayJson(message: object) {
    this.say(`${JSON.stringify(message)}\n`);
  }
  complain(text: string) {
    this.err?.(text);
  }
  exit(code: number | null) {
    for (const fn of this.exits) fn(code);
  }
  /** The JSON messages written after the script and its end marker. */
  messages(): Array<Record<string, unknown>> {
    const after = this.written.split(`${SCRIPT_END}\n`)[1] ?? '';
    return after
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }
  /** Boot, hello and ready, as a working helper does. */
  start() {
    this.say(`${BOOT_TAG} FullLanguage\r\n`);
    this.sayJson({ type: 'hello', languageMode: 'FullLanguage', ps: '5.1.26100.1', pid: this.pid + 1 });
  }
}

/** Timers run by hand. */
function manualTimers() {
  const pending = new Set<{ fn: () => void; ms: number }>();
  return {
    deps: {
      setTimeout: (fn: () => void, ms: number) => {
        const t = { fn, ms };
        pending.add(t);
        return t;
      },
      clearTimeout: (t: unknown) => void pending.delete(t as { fn: () => void; ms: number }),
    },
    /** Run every pending timer (once), shortest first; returns their delays. */
    runAll() {
      const list = [...pending].sort((a, b) => a.ms - b.ms);
      pending.clear();
      for (const t of list) t.fn();
      return list.map((t) => t.ms);
    },
    count: () => pending.size,
  };
}

function trayHarness(options: Partial<TrayOptions> = {}, psExists = true) {
  const helpers: FakeHelper[] = [];
  const launches: Launch[] = [];
  const killedPids: number[] = [];
  const timers = manualTimers();
  const events: string[] = [];
  const failed = vi.fn();
  const tray = new TrayHost({
    tooltip: trayTooltip(null),
    menu: trayMenu({ lan: false }),
    icon: Buffer.from('ICO'),
    parentPid: 1234,
    onAction: (id, via) => events.push(`action ${id} ${via}`),
    onSessionEnding: (reason) => events.push(`session-ending ${reason}`),
    onFailed: failed,
    log: (line) => events.push(line),
    ...options,
    deps: {
      launch: (spec) => {
        launches.push(spec);
        const h = new FakeHelper();
        helpers.push(h);
        return h as unknown as HelperProcess;
      },
      killPid: (pid) => killedPids.push(pid),
      powershellExists: () => psExists,
      ...timers.deps,
    },
  });
  return { tray, helpers, launches, killedPids, timers, events, failed, last: () => helpers.at(-1)! };
}

describe('the tray helper host (tray.ts)', () => {
  it('menu and tooltip: Open (default), data folder, the LAN address with --lan, Quit; at most 63 characters', () => {
    expect(trayMenu({ lan: false })).toEqual([
      { id: 'open', text: 'Open Lyren Plan', default: true },
      { id: 'folder', text: 'Open data folder' },
      { separator: true },
      { id: 'quit', text: 'Quit Lyren Plan' },
    ]);
    expect(trayMenu({ lan: true }).map((i) => ('id' in i ? i.id : '-'))).toEqual(['open', 'folder', 'copy-lan', '-', 'quit']);
    expect(trayTooltip('http://127.0.0.1:43770/')).toBe('Lyren Plan - http://127.0.0.1:43770/');
    const long = trayTooltip(`http://[fd00:1234:5678:9abc:def0:1234:5678:9abc]:43770/`);
    expect(long.length).toBe(63);
    expect(long.endsWith('…')).toBe(true);
  });

  it('starts the helper through cmd.exe, sends the script, then init as JSON on hello; ready settles', async () => {
    const h = trayHarness({ tooltip: trayTooltip(null) });
    h.tray.start();
    expect(h.launches).toHaveLength(1);
    expect(h.launches[0]!.file).toMatch(/cmd\.exe$/);
    const helper = h.last();
    expect(helper.written.startsWith(scriptInput(TRAY_SCRIPT))).toBe(true);
    const settled = h.tray.settled(5000);
    helper.start();
    const [init] = helper.messages();
    expect(init).toEqual({
      type: 'init',
      parentPid: 1234,
      tooltip: 'Lyren Plan (starting)',
      icon: Buffer.from('ICO').toString('base64'),
      menu: trayMenu({ lan: false }),
      testHooks: false,
    });
    helper.sayJson({ type: 'ready', iconSize: 16, dpi: 96 });
    expect(await settled).toBe('ready');
    expect(h.tray.state).toBe('ready');
    expect(h.events).toContain('Tray: icon shown (16 px at 96 dpi).');
    // Actions, the end of the session; garbage, partial lines and unknown messages change nothing.
    helper.say('{"type":"act');
    helper.say('ion","id":"open","via":"left-click"}\nnot json\n{"type":"from-the-future","x":1}\n[1]\n');
    helper.sayJson({ type: 'action', id: 'quit', via: 'menu' });
    helper.sayJson({ type: 'action', id: 42 });
    helper.sayJson({ type: 'session-ending', reason: 'Logoff' });
    expect(h.events.filter((e) => !e.startsWith('Tray:'))).toEqual(['action open left-click', 'action quit menu', 'session-ending Logoff']);
    expect(h.failed).not.toHaveBeenCalled();
  });

  it('every value goes to the helper as JSON data (hostile tooltips, addresses)', () => {
    const h = trayHarness();
    h.tray.start();
    h.last().start();
    h.last().sayJson({ type: 'ready' });
    for (const text of HOSTILE) {
      h.tray.setTooltip(text);
      h.tray.copy(text);
    }
    const sent = h.last().messages().slice(1);
    expect(sent.filter((m) => m.type === 'tooltip').map((m) => m.text)).toEqual(HOSTILE);
    expect(sent.filter((m) => m.type === 'copy').map((m) => m.text)).toEqual(HOSTILE);
    // One message per line: a newline in a value never starts a new message.
    expect(h.last().written.split(`${SCRIPT_END}\n`)[1]!.split('\n').filter(Boolean)).toHaveLength(1 + 2 * HOSTILE.length);
  });

  it('test operations only with the test hook', () => {
    const off = trayHarness();
    off.tray.start();
    off.last().start();
    off.last().sayJson({ type: 'ready' });
    off.tray.test('click:quit');
    expect(off.last().messages().some((m) => m.type === 'test')).toBe(false);
    const on = trayHarness({ testHooks: true });
    on.tray.start();
    on.last().start();
    expect(on.last().messages()[0]).toMatchObject({ type: 'init', testHooks: true });
    on.last().sayJson({ type: 'ready' });
    on.tray.test('click:quit');
    expect(on.last().messages().at(-1)).toEqual({ type: 'test', op: 'click:quit' });
  });

  it('ConstrainedLanguage: fails at once without restarts, and closes the helper stdin', async () => {
    const h = trayHarness();
    h.tray.start();
    const settled = h.tray.settled(5000);
    h.last().say(`${BOOT_TAG} ConstrainedLanguage\n`);
    expect(await settled).toBe('failed');
    expect(h.failed).toHaveBeenCalledTimes(1);
    expect(h.failed.mock.calls[0]![0]).toMatch(/ConstrainedLanguage mode/);
    expect(h.last().ended).toBe(true);
    h.last().exit(1);
    h.timers.runAll();
    expect(h.launches).toHaveLength(1);
  });

  it('PowerShell missing: fails without starting anything', () => {
    const h = trayHarness({}, false);
    h.tray.start();
    expect(h.launches).toHaveLength(0);
    expect(h.failed).toHaveBeenCalledWith(expect.stringMatching(/Windows PowerShell was not found/));
  });

  it(`a helper that keeps exiting is started again ${MAX_RESTARTS} times (1, 2, 3 s apart), then the tray fails once`, () => {
    const h = trayHarness();
    h.tray.start();
    const delays: number[] = [];
    for (let i = 0; i < MAX_RESTARTS; i++) {
      h.last().complain('Add-Type : Cannot add type.\r\n');
      h.last().exit(1);
      expect(h.failed).not.toHaveBeenCalled();
      delays.push(...h.timers.runAll().filter((ms) => ms < 15_000));
    }
    expect(delays).toEqual([1000, 2000, 3000]);
    expect(h.launches).toHaveLength(1 + MAX_RESTARTS);
    h.last().complain('Add-Type : Cannot add type.\r\n');
    h.last().exit(1);
    expect(h.failed).toHaveBeenCalledTimes(1);
    expect(h.failed.mock.calls[0]![0]).toMatch(/exited \(code 1\): Add-Type : Cannot add type\.; gave up after 3 restarts/);
    h.timers.runAll();
    expect(h.launches).toHaveLength(1 + MAX_RESTARTS);
  });

  it('no ready in time: the PowerShell process is ended (not just cmd.exe) and started again', () => {
    const h = trayHarness({ readyTimeoutMs: 15_000 });
    h.tray.start();
    const first = h.last();
    first.start(); // hello names the PowerShell process
    expect(h.timers.runAll()).toEqual([15_000]);
    expect(h.killedPids).toEqual([first.pid + 1]);
    expect(first.killed).toBe(true);
    expect(h.events.some((e) => /did not report ready within 15 s; starting it again \(1 of 3\)/.test(e))).toBe(true);
    h.timers.runAll(); // the 1 s backoff
    expect(h.launches).toHaveLength(2);
  });

  it('a helper that dies after it was ready is started again; restarts count for the whole run', () => {
    const h = trayHarness();
    h.tray.start();
    h.last().start();
    h.last().sayJson({ type: 'ready' });
    h.last().exit(null);
    h.timers.runAll();
    expect(h.launches).toHaveLength(2);
    expect(h.tray.state).toBe('starting');
    h.last().start();
    h.last().sayJson({ type: 'ready' });
    expect(h.tray.state).toBe('ready');
  });

  it('close(): tells the helper to exit and waits; a helper that hangs is ended after the timeout', async () => {
    const h = trayHarness();
    h.tray.start();
    h.last().start();
    h.last().sayJson({ type: 'ready' });
    const closed = h.tray.close();
    expect(h.last().messages().at(-1)).toEqual({ type: 'exit' });
    expect(h.last().ended).toBe(true);
    h.last().sayJson({ type: 'bye', reason: 'exit' });
    h.last().exit(0);
    await closed;
    expect(h.tray.state).toBe('closed');
    expect(h.killedPids).toEqual([]);
    expect(h.events).toContain('Tray: icon removed (exit).');
    // A hanging one.
    const hung = trayHarness();
    hung.tray.start();
    hung.last().start();
    hung.last().sayJson({ type: 'ready' });
    const done = hung.tray.close(3000);
    expect(hung.timers.runAll()).toEqual([3000]);
    await done;
    expect(hung.killedPids).toEqual([hung.last().pid + 1]);
    expect(hung.events.some((e) => e.includes('may stay until the mouse passes over it'))).toBe(true);
    // Closing a failed or never started tray resolves at once.
    await trayHarness({}, false).tray.close();
  });

  it('settled() gives up waiting after its time with the state then', async () => {
    const h = trayHarness();
    h.tray.start();
    const settled = h.tray.settled(3000);
    h.timers.runAll();
    expect(await settled).toBe('starting');
  });

  it('the address set between the helper’s hello and its ready still reaches the icon (a slow start)', () => {
    const h = trayHarness();
    h.tray.start();
    h.tray.setTooltip('Lyren Plan - early'); // before hello: goes with init
    h.last().start();
    expect(h.last().messages()).toEqual([expect.objectContaining({ type: 'init', tooltip: 'Lyren Plan - early' })]);
    h.tray.setTooltip('Lyren Plan - http://127.0.0.1:43770/'); // init sent, not ready yet
    h.last().sayJson({ type: 'ready', iconSize: 16, dpi: 96 });
    expect(h.tray.state).toBe('ready');
    expect(h.last().messages().at(-1)).toEqual({ type: 'tooltip', text: 'Lyren Plan - http://127.0.0.1:43770/' });
    // A helper started again gets the latest text with its init, nothing before its hello.
    h.last().exit(1);
    h.timers.runAll();
    h.tray.setTooltip('Lyren Plan - http://127.0.0.1:43771/');
    expect(h.last().messages()).toEqual([]);
    h.last().start();
    expect(h.last().messages()).toEqual([expect.objectContaining({ type: 'init', tooltip: 'Lyren Plan - http://127.0.0.1:43771/' })]);
  });
});

// ---- Message boxes ----------------------------------------------------------------------------------

function dialogHarness(behaviour: 'shows' | 'stays' | 'hangs' | 'clm' | 'dies' | 'spawn-error') {
  const launches: Launch[] = [];
  const helpers: FakeHelper[] = [];
  const killed: number[] = [];
  const released: FakeHelper[] = [];
  const deps: Partial<DialogDeps> = {
    hooks: NO_TEST_HOOKS,
    powershellExists: () => true,
    killPid: (pid) => killed.push(pid),
    release: (child) => released.push(child as unknown as FakeHelper),
    launch: (spec) => {
      launches.push(spec);
      if (behaviour === 'spawn-error') throw new Error('EPERM');
      const h = new FakeHelper();
      helpers.push(h);
      setTimeout(() => {
        if (behaviour === 'clm') return h.say(`${BOOT_TAG} ConstrainedLanguage\n`);
        h.say(`${BOOT_TAG} FullLanguage\n`);
        h.sayJson({ type: 'hello', pid: 7001 });
        if (behaviour === 'dies') return h.exit(1);
        if (behaviour === 'hangs') return; // never puts the box up
        h.sayJson({ type: 'showing', pid: 7001 });
        if (behaviour === 'stays') return; // the box stays until someone clicks OK
        setTimeout(() => {
          h.sayJson({ type: 'closed', result: 'OK' });
          h.exit(0);
        }, 5);
      }, 5);
      return h as unknown as HelperProcess;
    },
  };
  return { deps, launches, helpers, killed, released };
}

describe('message boxes (dialog.ts)', () => {
  it('PowerShell started directly, the script and then the message as one JSON line; hostile text stays data', async () => {
    const message = { title: 'Lyren Plan', text: HOSTILE.join('\n'), icon: 'Error' as const };
    const d = dialogHarness('shows');
    expect(await showDialog(message, { wait: true }, d.deps)).toBe('shown');
    expect(d.launches[0]!.file).toMatch(/powershell\.exe$/);
    expect(d.launches[0]!.verbatim).toBe(false);
    const written = d.helpers[0]!.written;
    expect(written.startsWith(scriptInput(DIALOG_SCRIPT))).toBe(true);
    expect(d.helpers[0]!.messages()).toEqual([message]);
    expect(d.helpers[0]!.ended).toBe(true);
  });

  it('not shown: ConstrainedLanguage, PowerShell exiting first, a start error, PowerShell missing', async () => {
    const message = { title: 'T', text: 'x', icon: 'Error' as const };
    for (const behaviour of ['clm', 'dies', 'spawn-error'] as const) {
      expect(await showDialog(message, { wait: true }, dialogHarness(behaviour).deps), behaviour).toBe('unavailable');
    }
    expect(await showDialog(message, { wait: true }, { ...dialogHarness('shows').deps, powershellExists: () => false })).toBe('unavailable');
    // Not waiting: resolved as soon as it is up.
    expect(await showDialog(message, { wait: false }, dialogHarness('shows').deps)).toBe('shown');
  });

  it('a box that outlives the app (a command\'s result): through cmd.exe, outside the job; let go of once it is up (FV-3)', async () => {
    const message = { title: 'Lyren Plan', text: 'Backup written to D:\\b.db', icon: 'Information' as const };
    const d = dialogHarness('stays');
    // Resolved as soon as the box is up, although nobody has closed it.
    expect(await showDialog(message, { wait: false, outlive: true }, d.deps)).toBe('shown');
    expect(d.launches[0]!.file).toMatch(/\\cmd\.exe$/i);
    expect(d.launches[0]!.verbatim).toBe(true);
    expect(d.launches[0]!.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(d.launches[0]!.args[3]).toMatch(/powershell\.exe" -NoProfile -NonInteractive -Command "/);
    expect(d.helpers[0]!.messages()).toEqual([message]);
    // Its process and pipes no longer keep the app alive; nothing was killed.
    expect(d.released).toEqual([d.helpers[0]]);
    expect(d.killed).toEqual([]);
    expect(d.helpers[0]!.killed).toBe(false);
    // The boxes of serve end with the app: PowerShell started directly, never let go of.
    const direct = dialogHarness('stays');
    expect(await showDialog(message, { wait: false }, direct.deps)).toBe('shown');
    expect(direct.launches[0]!.file).toMatch(/powershell\.exe$/i);
    expect(direct.released).toEqual([]);
    // Waited for (closed), or not shown: never let go of.
    const waited = dialogHarness('shows');
    expect(await showDialog(message, { wait: true, outlive: true }, waited.deps)).toBe('shown');
    expect(waited.released).toEqual([]);
    for (const behaviour of ['clm', 'dies'] as const) {
      const failed = dialogHarness(behaviour);
      expect(await showDialog(message, { wait: false, outlive: true }, failed.deps), behaviour).toBe('unavailable');
      expect(failed.released, behaviour).toEqual([]);
    }
  });

  it('a box that is not up within 30 s counts as not shown; the PowerShell behind cmd.exe is ended too', async () => {
    vi.useFakeTimers();
    try {
      const d = dialogHarness('hangs');
      const result = showDialog({ title: 'T', text: 'x', icon: 'Error' }, { wait: false, outlive: true }, d.deps);
      await vi.advanceTimersByTimeAsync(29_000);
      expect(d.killed).toEqual([]);
      await vi.advanceTimersByTimeAsync(1_500);
      expect(await result).toBe('unavailable');
      expect(d.killed).toEqual([7001]); // the pid from its hello: killing cmd.exe would not end it
      expect(d.helpers[0]!.killed).toBe(true);
      expect(d.released).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to a console window with the text only when no box could be shown', async () => {
    const message = { title: 'Lyren Plan', text: 'Port 1 is in use.', icon: 'Error' as const };
    const fallback = vi.fn(async () => true);
    expect(await reportProblem(message, fallback, dialogHarness('shows').deps)).toBe('dialog');
    expect(fallback).not.toHaveBeenCalled();
    expect(await reportProblem(message, fallback, dialogHarness('clm').deps)).toBe('console');
    expect(fallback).toHaveBeenCalledWith('Port 1 is in use.');
    expect(await reportProblem(message, () => false, dialogHarness('dies').deps)).toBe('none');
  });

  it('LYREN_TEST_DIALOG_LOG records the box instead of showing it', async () => {
    const file = path.join(tmp('lyren-dlg-'), 'dialogs.jsonl');
    const d = dialogHarness('shows');
    const message = { title: 'Lyren Plan', text: 'a\nb', icon: 'Warning' as const };
    expect(await showDialog(message, { wait: true }, { ...d.deps, hooks: { ...NO_TEST_HOOKS, dialogLog: file } })).toBe('shown');
    expect(d.launches).toHaveLength(0);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(message);
  });

  it('long texts are cut, pointing to the log file', () => {
    expect(dialogText('  short\n', null)).toBe('short');
    const long = dialogText('x'.repeat(MAX_DIALOG_TEXT + 10), 'C:\\d\\logs\\lyren-plan.log');
    expect(long.startsWith('x'.repeat(MAX_DIALOG_TEXT) + '…')).toBe(true);
    expect(long).toContain('The rest is in C:\\d\\logs\\lyren-plan.log.');
  });

  it('test hooks come from the environment and are inert unless set', () => {
    expect(testHooks({})).toEqual(NO_TEST_HOOKS);
    expect(testHooks({ LYREN_TEST_BROWSER_LOG: ' ', LYREN_TEST_POWERSHELL_CLM: 'yes' })).toEqual(NO_TEST_HOOKS);
    expect(testHooks({ LYREN_TEST_BROWSER_LOG: 'b.txt', LYREN_TEST_DIALOG_LOG: 'd.txt', LYREN_TEST_TRAY_CONTROL: 'c.txt', LYREN_TEST_POWERSHELL_CLM: '1' })).toEqual({
      browserLog: 'b.txt',
      dialogLog: 'd.txt',
      trayControl: 'c.txt',
      powershellClm: true,
    });
  });
});

// ---- Relaunch ---------------------------------------------------------------------------------------

describe('starting again in a console window (relaunch.ts)', () => {
  const env = { SystemRoot: 'C:\\Windows' };

  it('a fixed command line: a variable whose value names the program variable (conhost.exe expands it), the arguments as JSON', () => {
    const args = ['--data-dir', 'D:\\100% & more\\', '--port', '19121', '--console'];
    const cmd = consoleRelaunchCommand('C:\\Apps\\R&D (x)\\Lyren Plan.exe', args, env);
    expect(cmd.file).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(cmd.args).toEqual(['/d', '/v:off', '/c', `start "Lyren Plan" "C:\\Windows\\System32\\conhost.exe" "%${REF_VAR}%"`]);
    expect(cmd.env).toEqual({ [REF_VAR]: `%${EXE_VAR}%`, [EXE_VAR]: 'C:\\Apps\\R&D (x)\\Lyren Plan.exe', [ARGS_VAR]: JSON.stringify(args) });
  });

  it('hostile folder names never reach a command line (conhost.exe would expand %PATH% in one), and a program path with % works', () => {
    for (const value of [...HOSTILE, 'D:\\100%PATH%\\x', 'D:\\trailing\\']) {
      const cmd = consoleRelaunchCommand('C:\\x.exe', ['--data-dir', value], env);
      expect(cmd.args.join(' ')).not.toContain(value);
      const childEnv: NodeJS.ProcessEnv = { ...cmd.env };
      expect(takeRelaunchVariables(childEnv).args).toEqual(['--data-dir', value]);
    }
    // cmd.exe expands %LYREN_RELAUNCH_REF% once, to the text %LYREN_RELAUNCH_EXE%; conhost.exe expands
    // that once, to the path, and does not look into the result: '100% %PATH%' arrives as it is.
    const pct = consoleRelaunchCommand('C:\\Tools 100% %PATH%\\Lyren Plan.exe', [], env);
    expect(pct.args.join(' ')).not.toContain('Tools');
    expect(pct.env[EXE_VAR]).toBe('C:\\Tools 100% %PATH%\\Lyren Plan.exe');
    expect(() => consoleRelaunchCommand('C:\\a"b.exe', [], env)).toThrow(/double quote/);
  });

  it('runs cmd.exe verbatim with the variables, waits for it; the started copy takes and removes them', async () => {
    const run = vi.fn(async () => 0);
    expect(await relaunchInConsole('C:\\x.exe', ['--console'], { [MESSAGE_VAR]: 'Port 1 is in use.' }, run)).toBe(true);
    const [file, args, options] = run.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv; verbatim: boolean }];
    expect(file).toMatch(/cmd\.exe$/i);
    expect(args.slice(0, 3)).toEqual(['/d', '/v:off', '/c']);
    expect(options.verbatim).toBe(true);
    expect(options.env[MESSAGE_VAR]).toBe('Port 1 is in use.');
    expect(options.env[ARGS_VAR]).toBe('["--console"]');
    expect(options.env[EXE_VAR]).toBe('C:\\x.exe');
    expect(await relaunchInConsole('C:\\a"b.exe', [], {}, run)).toBe(false);
    expect(await relaunchInConsole('C:\\x.exe', [], {}, async () => 1)).toBe(false);
    const childEnv: NodeJS.ProcessEnv = { [EXE_VAR]: 'x', [REF_VAR]: `%${EXE_VAR}%`, [ARGS_VAR]: '["a"]', LYREN_DESKTOP_RELAUNCHED: '1', [MESSAGE_VAR]: 'hello', PATH: '/bin' };
    expect(takeRelaunchVariables(childEnv)).toEqual({ relaunched: true, message: 'hello', args: ['a'] });
    expect(childEnv).toEqual({ PATH: '/bin' });
    expect(takeRelaunchVariables({})).toEqual({ relaunched: false, message: null, args: null });
    // Anything but a list of strings is ignored.
    for (const bad of ['{"a":1}', '[1]', 'not json', '"x"']) expect(takeRelaunchVariables({ [ARGS_VAR]: bad }).args).toBeNull();
  });
});

// ---- Log file ---------------------------------------------------------------------------------------

describe('the log file (log.ts)', () => {
  const at = new Date(2026, 9, 15, 9, 5, 7);

  it('stamps lines, keeps what came before the folder existed, never throws', () => {
    const dir = tmp('lyren-log-');
    const log = new LogFile({ now: () => at });
    log.write('  Lyren Plan is starting');
    log.write('...\nsecond');
    log.write(' line\n');
    expect(log.file).toBeNull();
    expect(log.open(path.join(dir, 'logs'))).toBe(true);
    log.note('Tray: icon shown.');
    log.close();
    expect(timestamp(at)).toBe('2026-10-15 09:05:07 ');
    expect(fs.readFileSync(path.join(dir, 'logs', LOG_FILE_NAME), 'utf8')).toBe(
      '2026-10-15 09:05:07   Lyren Plan is starting...\n2026-10-15 09:05:07 second line\n2026-10-15 09:05:07 Tray: icon shown.\n',
    );
    // A folder that can't be created (a file in the way): nothing is written, nothing throws.
    const blocked = new LogFile();
    fs.writeFileSync(path.join(dir, 'file'), 'x');
    expect(blocked.open(path.join(dir, 'file', 'logs'))).toBe(false);
    blocked.write('lost\n');
    blocked.note('lost');
  });

  it('rotates at the size cap: lyren-plan.1.log keeps the previous part, the two stay under twice the cap', () => {
    const dir = tmp('lyren-logrot-');
    const log = new LogFile({ maxBytes: 200, now: () => at });
    log.open(dir);
    for (let i = 0; i < 40; i++) log.write(`line ${String(i).padStart(2, '0')} ${'x'.repeat(20)}\n`);
    log.close();
    const current = fs.readFileSync(path.join(dir, LOG_FILE_NAME), 'utf8');
    const old = fs.readFileSync(path.join(dir, OLD_LOG_FILE_NAME), 'utf8');
    expect(Buffer.byteLength(current)).toBeLessThanOrEqual(200);
    expect(Buffer.byteLength(old)).toBeLessThanOrEqual(200);
    expect(current).toContain('line 39');
    expect(old).not.toContain('line 39');
    expect(fs.readdirSync(dir).sort()).toEqual([OLD_LOG_FILE_NAME, LOG_FILE_NAME]);
    // An existing log is appended to after a restart.
    const again = new LogFile({ maxBytes: 10_000, now: () => at });
    again.open(dir);
    again.write('after restart\n');
    again.close();
    expect(fs.readFileSync(path.join(dir, LOG_FILE_NAME), 'utf8')).toBe(`${current}2026-10-15 09:05:07 after restart\n`);
  });

  it('plain text: colour escapes (the request log) are removed, the setup code never reaches the file', () => {
    const dir = tmp('lyren-logplain-');
    const log = new LogFile({ now: () => at });
    log.write('  Setup code:      4da84ba059c4  (before the folder exists)\n');
    log.open(dir);
    log.redact('4da84ba059c4');
    log.write('--> GET /api/health \x1b[32m200\x1b[0m 3ms\n');
    log.write('  Setup code:      4da84ba059c4  (already filled in on the page that opened)\n');
    log.write('\x1b[33m');
    log.close();
    const text = fs.readFileSync(path.join(dir, LOG_FILE_NAME), 'utf8');
    expect(text).not.toMatch(/\x1b/);
    expect(text).toContain('--> GET /api/health 200 3ms');
    expect(text).toContain(`  Setup code:      ${REDACTED}  (already filled in on the page that opened)`);
    expect(text.split('4da84ba059c4')).toHaveLength(2); // only the line written before redact()
    // Another database's log has its own name; it rotates to a name of its own too.
    expect(oldLogName('lyren-plan.log')).toBe(OLD_LOG_FILE_NAME);
    expect(oldLogName('work.db.log')).toBe('work.db.1.log');
  });

  it('link tokens (#t=…, §9.7) never reach the file; the console still shows the whole line', () => {
    const dir = tmp('lyren-logtoken-');
    const log = new LogFile({ now: () => at });
    log.open(dir);
    const token = 'a'.repeat(20) + 'B-_9'.repeat(5) + 'zzz';
    const line = `Invitation link: http://192.168.1.20:43770/invite#t=${token} (copy it)\n`;
    const realOut = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const capture = captureOutput(log, { echo: true });
    try {
      process.stdout.write(line);
      process.stdout.write('Reset: /reset#t=short and /verify#t=Q1w2E3r4\n');
    } finally {
      capture.restore();
    }
    expect(realOut).toHaveBeenCalledWith(line, undefined, undefined);
    realOut.mockRestore();
    log.close();
    const text = fs.readFileSync(path.join(dir, LOG_FILE_NAME), 'utf8');
    expect(text).toBe(
      `2026-10-15 09:05:07 Invitation link: http://192.168.1.20:43770/invite#t=${REDACTED} (copy it)\n` +
        `2026-10-15 09:05:07 Reset: /reset#t=${REDACTED} and /verify#t=${REDACTED}\n`,
    );
    expect(text).not.toContain(token);
  });

  it('a link token printed in two pieces, or percent-encoded in a query string, never reaches the file either', () => {
    const dir = tmp('lyren-logsplit-');
    const log = new LogFile({ now: () => at });
    log.open(dir);
    const token = 'AbCdEfGhIjKlMnOpQrSt' + 'UvWxYz0123456789_-abcde';
    log.write(`split: /invite#t=${token.slice(0, 20)}`);
    log.write(`${token.slice(20)} (copy it)\n`);
    log.write(`next: /login?next=%2Finvite%23t%3D${token}&x=1\n`);
    log.write(`lower: %23T%3d${token}\n`);
    // A secret split in two, and a last line without a line break (written at close).
    log.redact('4da84ba059c4');
    log.write('  Setup code: 4da84');
    log.write('ba059c4\nlast: #t=');
    log.write(token);
    log.close();
    const text = fs.readFileSync(path.join(dir, LOG_FILE_NAME), 'utf8');
    expect(text).toBe(
      `2026-10-15 09:05:07 split: /invite#t=${REDACTED} (copy it)\n` +
        `2026-10-15 09:05:07 next: /login?next=%2Finvite%23t%3D${REDACTED}&x=1\n` +
        `2026-10-15 09:05:07 lower: %23T%3d${REDACTED}\n` +
        `2026-10-15 09:05:07   Setup code: ${REDACTED}\n` +
        `2026-10-15 09:05:07 last: #t=${REDACTED}`,
    );
    expect(text).not.toContain(token.slice(20));
  });

  it('captureOutput: everything printed goes to the log, stderr is kept for message boxes; echo for terminals', () => {
    const dir = tmp('lyren-logcap-');
    const log = new LogFile({ now: () => at });
    log.open(dir);
    const realOut = vi.spyOn(process.stdout, 'write');
    const capture = captureOutput(log, { echo: false });
    try {
      // A console like the global one (vitest replaces the global console's methods).
      const out = new Console({ stdout: process.stdout, stderr: process.stderr });
      out.log('banner');
      out.error('Port 1 is in use.');
      process.stderr.write(Buffer.from('bytes too\n'));
    } finally {
      capture.restore();
    }
    expect(capture.stderrText()).toBe('Port 1 is in use.\nbytes too\n');
    expect(capture.allText()).toBe('banner\nPort 1 is in use.\nbytes too\n');
    expect(realOut).not.toHaveBeenCalledWith('banner\n', expect.anything());
    realOut.mockRestore();
    log.close();
    expect(fs.readFileSync(path.join(dir, LOG_FILE_NAME), 'utf8')).toBe(
      '2026-10-15 09:05:07 banner\n2026-10-15 09:05:07 Port 1 is in use.\n2026-10-15 09:05:07 bytes too\n',
    );
  });
});

// ---- Texts ---------------------------------------------------------------------------------------------

describe('texts for each mode', () => {
  const base: BannerInfo = {
    version: '1.2.3',
    url: 'http://127.0.0.1:43770/',
    lanUrls: [],
    lan: false,
    dataDir: 'C:\\Users\\ann\\AppData\\Local\\Lyren Plan',
    dbPath: null,
    setupCode: null,
    setupCodeFilledIn: false,
    browserOpened: true,
    skippedPorts: [],
    usualPort: null,
    warnings: [],
  };

  it('the banner says how to stop it: its window, the terminal and the icon, or the icon (log file)', () => {
    expect(bannerLines(base).join('\n')).toContain('Keep this window open while you use Lyren Plan. To stop it, close this window or press Ctrl+C.');
    const terminal = bannerLines({ ...base, stopVia: 'terminal' }).join('\n');
    expect(terminal).toContain('To stop it, press Ctrl+C or close this window,\n  or right-click the Lyren Plan icon in the notification area (near the clock) and choose Quit Lyren Plan.');
    const tray = bannerLines({ ...base, stopVia: 'tray', stopCommand: { shell: 'cmd', text: '"Lyren Plan.exe" stop' } }).join('\n');
    expect(tray).toContain('Lyren Plan keeps running in the notification area (near the clock). To stop it, right-click\n  its icon and choose Quit Lyren Plan, or run: "Lyren Plan.exe" stop');
    expect(tray).not.toContain('Keep this window open');
    expect(stopLines()).toEqual(stopLines('window'));
  });

  it('the notices a user without a console must see (port and folder warnings) are the banner’s own lines', () => {
    expect(bannerNotices(base)).toEqual([]);
    const info = { ...base, url: 'http://127.0.0.1:43772/', usualPort: 43771, skippedPorts: [{ port: 43771, code: 'EADDRINUSE' }], warnings: ['Warning: the folder is open'] };
    const notices = bannerNotices(info);
    expect(notices.join('\n')).toContain("Warning: Lyren Plan's usual address http://127.0.0.1:43771/ is used by another program,");
    expect(notices.join('\n')).toContain('  Warning: the folder is open');
    const banner = bannerLines(info).join('\n');
    for (const line of notices) expect(banner).toContain(line);
  });

  it('the stop command it prints reaches this database: with --data-dir or --db-path as the app was started', () => {
    // Which option (paths of this host, as the app would have them).
    const def = path.resolve('/home/ann/.local/share/lyren-plan');
    const at = (dataDir: string, dbPath = path.join(dataDir, 'lyren.db')) => ({ dataDir, dbPath });
    const win = process.platform === 'win32';
    expect(commandTargetOption(at(def), def, win)).toBeNull();
    expect(commandTargetOption(at(path.resolve('/srv/lyren')), def, win)).toEqual({ name: '--data-dir', value: path.resolve('/srv/lyren') });
    expect(commandTargetOption(at(def, path.resolve('/srv/db/work.db')), def, win)).toEqual({ name: '--db-path', value: path.resolve('/srv/db/work.db') });
    // How it is typed in Command Prompt (always quoted; a trailing backslash doubled) and in a POSIX shell.
    const winStop = (value: string | null, exe = 'lyren.exe') => commandLine(exe, 'stop', value ? { name: '--data-dir', value } : null, 'win32');
    expect(winStop(null)).toEqual({ shell: 'cmd', text: 'lyren.exe stop' });
    expect(winStop('D:\\Lyren', 'Lyren Plan.exe').text).toBe('"Lyren Plan.exe" stop --data-dir "D:\\Lyren"');
    expect(winStop('D:\\R&D ^x !y (z)').text).toBe('lyren.exe stop --data-dir "D:\\R&D ^x !y (z)"');
    expect(winStop('D:\\').text).toBe('lyren.exe stop --data-dir "D:\\\\"'); // "D:\" would hand over D:"
    expect(commandLine('lyren.exe', 'stop', { name: '--db-path', value: 'E:\\db\\work.db' }, 'win32').text).toBe('lyren.exe stop --db-path "E:\\db\\work.db"');
    expect(commandLine('lyren-plan', 'stop', { name: '--data-dir', value: "/srv/ann's plans" }, 'linux')).toEqual({
      shell: 'posix',
      text: "./lyren-plan stop --data-dir '/srv/ann'\\''s plans'",
    });
    expect(shellArg('/srv/plans', 'posix')).toBe('/srv/plans');
    // What a second start and the log's banner say with it.
    expect(runningHint('tray', winStop('D:\\Lyren'))).toContain('or run: lyren.exe stop --data-dir "D:\\Lyren"');
    expect(bannerLines({ ...base, stopVia: 'tray', stopCommand: winStop('D:\\Lyren') }).join('\n')).toContain('or run: lyren.exe stop --data-dir "D:\\Lyren"');
  });

  it('a % would be changed by Command Prompt even inside quotes: such a command is printed for PowerShell (RCK-1)', () => {
    // Folder names an earlier round tested, and more that Command Prompt would expand (%PATH%, %=C:%, %%PATH%%).
    const names = ['D:\\R&D 100%PATH% ^x !y (z)', 'D:\\100%% done', 'D:\\a %=C:% b', "D:\\O'Neil’s ‘x’ ‚y‛ 1%", 'D:\\$env:PATH `b` $(x) %USERPROFILE%', 'D:\\trailing %'];
    for (const dir of names) {
      const stop = commandLine('lyren.exe', 'stop', { name: '--data-dir', value: dir }, 'win32');
      expect(stop.shell, dir).toBe('powershell');
      expect(stop.text, dir).toBe(`& '.\\lyren.exe' stop --data-dir ${psQuote(dir)}`);
      expect(howToRun(stop)).toBe(`run in PowerShell: ${stop.text}`);
      // Single-quoted: PowerShell takes the text as it is, once each quotation mark is doubled.
      expect(psQuote(dir).slice(1, -1).replace(/(['‘’‚‛])\1/g, '$1')).toBe(dir);
    }
    expect(psQuote("O'Neil’s ‘x’ ‚y‛")).toBe("'O''Neil’’s ‘‘x’’ ‚‚y‛‛'");
    // The program's own name with a %, a database file with a %; anything without a % stays in Command Prompt.
    expect(commandLine('Lyren 100%.exe', 'stop', null, 'win32')).toEqual({ shell: 'powershell', text: "& '.\\Lyren 100%.exe' stop" });
    expect(commandLine('lyren.exe', 'stop', { name: '--db-path', value: 'E:\\%x%\\work.db' }, 'win32').text).toBe("& '.\\lyren.exe' stop --db-path 'E:\\%x%\\work.db'");
    expect(commandShell(['lyren.exe', "D:\\R&D ^x !y (z) O'Neil’s"], 'win32')).toBe('cmd');
    expect(commandShell(['lyren', '/srv/100%'], 'linux')).toBe('posix'); // a POSIX shell leaves % alone
    // The banner (log file) and a second start label it.
    const ps = commandLine('lyren.exe', 'stop', { name: '--data-dir', value: 'D:\\R&D 100%PATH%' }, 'win32');
    expect(bannerLines({ ...base, stopVia: 'tray', stopCommand: ps }).join('\n')).toContain(
      "its icon and choose Quit Lyren Plan, or run in PowerShell: & '.\\lyren.exe' stop --data-dir 'D:\\R&D 100%PATH%'",
    );
    expect(runningHint('tray', ps)).toContain("or run in PowerShell: & '.\\lyren.exe' stop --data-dir 'D:\\R&D 100%PATH%'");
  });

  it('PowerShell: a trailing backslash survives Windows PowerShell 5.1, which quotes an argument with whitespace without escaping it (FV-1)', () => {
    // The root of a share keeps its backslash when config.ts resolves it.
    const share = path.win32.resolve('\\\\nas\\Lyren 100%');
    expect(share).toBe('\\\\nas\\Lyren 100%\\');
    const stop = (value: string, exe = 'lyren-plan-0.1.0-win-x64.exe') => commandLine(exe, 'stop', { name: '--data-dir', value }, 'win32');
    // 5.1 hands the program "\\nas\Lyren 100%\\" for this, which it reads as \\nas\Lyren 100%\ (measured; the
    // single backslash arrived as \\nas\Lyren 100%" ).
    expect(stop(share)).toEqual({ shell: 'powershell', text: "& '.\\lyren-plan-0.1.0-win-x64.exe' stop --data-dir '\\\\nas\\Lyren 100%\\\\'" });
    // Without whitespace 5.1 passes the text as it is: unchanged (also a drive root in PowerShell).
    expect(stop('\\\\nas\\Lyren100%\\').text).toBe("& '.\\lyren-plan-0.1.0-win-x64.exe' stop --data-dir '\\\\nas\\Lyren100%\\'");
    expect(stop('D:\\', 'Lyren 100%.exe').text).toBe("& '.\\Lyren 100%.exe' stop --data-dir 'D:\\'");
    expect(shellArg('\\\\nas\\Lyren 100%\\', 'powershell')).toBe(psArg('\\\\nas\\Lyren 100%\\'));
    // Whitespace for which 5.1 quotes (.NET char.IsWhiteSpace, measured): tab, NBSP, U+1680, U+2000-U+200A,
    // U+2028, U+2029, U+202F, U+205F, U+3000, U+0085; not U+180E, U+200B or U+FEFF.
    for (const ws of ['\t', '\u00A0', '\u1680', '\u2000', '\u200A', '\u2028', '\u2029', '\u202F', '\u205F', '\u3000', '\u0085']) {
      expect(ps51ArgText(`\\\\nas\\a${ws}b\\`), JSON.stringify(ws)).toBe(`\\\\nas\\a${ws}b\\\\`);
    }
    for (const other of ['\u180E', '\u200B', '\uFEFF']) expect(ps51ArgText(`\\\\nas\\a${other}b\\`), JSON.stringify(other)).toBe(`\\\\nas\\a${other}b\\`);
    // Only a trailing run is doubled (every backslash of it); elsewhere a backslash never precedes the quote.
    expect(ps51ArgText('D:\\a b\\c')).toBe('D:\\a b\\c');
    expect(ps51ArgText('\\\\nas\\a b\\\\')).toBe('\\\\nas\\a b\\\\\\\\');
    // With the typographic quotes doubled too.
    expect(psArg('\\\\nas\\Dana’s 100%\\')).toBe("'\\\\nas\\Dana’’s 100%\\\\'");
    // What PowerShell 7 hands over instead (it escapes correctly): the doubled backslash, which resolves the same.
    expect(path.win32.resolve('\\\\nas\\Lyren 100%\\\\')).toBe(share);
    // Command Prompt doubles a trailing backslash always (unchanged).
    expect(commandLine('lyren.exe', 'stop', { name: '--data-dir', value: '\\\\nas\\Lyren 1\\' }, 'win32').text).toBe('lyren.exe stop --data-dir "\\\\nas\\Lyren 1\\\\"');
  });

  it('a second start says how the running one is stopped', () => {
    const cmd = (text: string) => ({ shell: 'cmd' as const, text });
    expect(runningHint(undefined, cmd('x stop'))).toBe('It runs in its other window; close that window to stop it.');
    expect(runningHint('tray', cmd('lyren-plan.exe stop'))).toBe(
      'It runs in the notification area (near the clock); to stop it, right-click its icon and choose Quit Lyren Plan, or run: lyren-plan.exe stop',
    );
    expect(runningHint('terminal', cmd('x'))).toBe('It runs in another window; to stop it, press Ctrl+C there or choose Quit Lyren Plan from its icon in the notification area.');
  });

  it('a second start waiting for the running one promises the browser only when it will open it (RCK-3)', () => {
    const where = 'the data folder D:\\Lyren';
    expect(waitingMessage(where, null)).toBe(
      'Lyren Plan is already running with the data folder D:\\Lyren, but has not answered yet.\n\nIt opens in your browser as soon as it answers (this can take a while, e.g. after an update).',
    );
    const noBrowser = waitingMessage(where, '--no-browser');
    expect(noBrowser).toContain('Lyren Plan is already running with the data folder D:\\Lyren, but has not answered yet.');
    expect(noBrowser).toContain('This start opens no browser (--no-browser), so nothing else happens once it answers.');
    expect(noBrowser).not.toMatch(/opens in your browser/);
  });

  it('the waiting box names what turned the browser off: --no-browser, or OPEN_BROWSER from the environment (FV-4)', () => {
    expect(noBrowserReason(true, false, { OPEN_BROWSER: 'yes' })).toBeNull();
    expect(noBrowserReason(false, true, { OPEN_BROWSER: 'false' })).toBe('--no-browser'); // the option sets the variable and wins
    expect(noBrowserReason(false, false, { OPEN_BROWSER: 'false' })).toBe('OPEN_BROWSER=false');
    expect(noBrowserReason(false, false, { OPEN_BROWSER: ' 0 ' })).toBe('OPEN_BROWSER=0');
    const fromEnv = waitingMessage('the data folder D:\\Lyren', noBrowserReason(false, false, { OPEN_BROWSER: 'no' }));
    expect(fromEnv).toContain('This start opens no browser (OPEN_BROWSER=no), so nothing else happens once it answers.');
    expect(fromEnv).not.toContain('--no-browser');
  });

  it('reset-password lock-out advice: the command clears lock-outs itself, so nothing needs a restart (§9.6)', () => {
    expect(lockoutAdvice()).toBe('Any lock-out from failed sign-ins has been cleared.');
  });
});

// ---- Shutdown -----------------------------------------------------------------------------------------

describe('shutdown for other reasons than signals', () => {
  it('the returned stop runs the same graceful shutdown; beforeExit (the icon) runs before exit 0', async () => {
    const events = new Map<string, (arg?: unknown) => void>();
    const order: string[] = [];
    const deps = {
      server: { close: vi.fn((cb?: () => void) => cb && setTimeout(cb, 0)), closeIdleConnections: vi.fn() },
      db: { close: vi.fn(() => order.push('db')) },
      lock: { close: vi.fn(() => order.push('lock')) },
      timer: setInterval(() => undefined, 1_000_000),
      proc: { on: (event: string, fn: (arg?: unknown) => void) => events.set(event, fn), exit: vi.fn((code: number) => order.push(`exit ${code}`)) },
      onStopping: vi.fn(),
      beforeExit: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 10));
        order.push('icon removed');
      }),
    };
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const stop = installShutdown(deps);
      stop('Quit in the notification area');
      stop('stop command'); // a second request changes nothing
      events.get('SIGINT')!();
      await new Promise((r) => setTimeout(r, 1700)); // past the grace timer: still one exit
      expect(out).toHaveBeenCalledWith('Stopping Lyren Plan (Quit in the notification area)...');
      expect(out).toHaveBeenCalledTimes(1);
      expect(order).toEqual(['db', 'lock', 'icon removed', 'exit 0']);
      expect(deps.beforeExit).toHaveBeenCalledTimes(1);
      // The start learns at once that it must not go on (open the browser, print the banner).
      expect(deps.onStopping).toHaveBeenCalledTimes(1);
    } finally {
      out.mockRestore();
      clearInterval(deps.timer);
    }
  });
});

describe('without a console: what is shown (runtime.ts)', () => {
  /** A tray-mode runtime whose message boxes go to a file; `run` gets a Console bound to the captured streams. */
  async function trayRun(run: (out: Console, runtime: DesktopRuntime) => Promise<void>, consoleWindow = false, consoles: string[] = []) {
    const dialogLog = path.join(tmp('lyren-rt-'), 'dialogs.jsonl');
    const relaunch = async (_exe: string, _args: readonly string[], env: Record<string, string> = {}) => {
      consoles.push(env[MESSAGE_VAR] ?? '');
      return consoleWindow;
    };
    const runtime = createRuntime({ mode: 'tray', exePath: 'C:\\x\\lyren.exe', args: [], hooks: { ...NO_TEST_HOOKS, dialogLog }, trayIcon: () => null, relaunch });
    try {
      // A console like the global one (vitest replaces the global console's methods).
      await run(new Console({ stdout: process.stdout, stderr: process.stderr }), runtime);
    } finally {
      runtime.restoreOutput();
    }
    return fs.existsSync(dialogLog)
      ? fs.readFileSync(dialogLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { text: string; icon: string })
      : [];
  }

  it('a crash shows its own message, not the oldest stderr of the run (earlier request errors)', async () => {
    const boxes = await trayRun(async (out, runtime) => {
      // Earlier request errors (http/errors.ts prints each with its stack): far more than a box holds.
      for (let i = 0; i < 12; i++) out.error('[lyren] Unhandled error:', new Error(`request error #${i}`));
      const events = new Map<string, (arg?: unknown) => void>();
      let exited: (code: number) => void = () => undefined;
      const exit = new Promise<number>((r) => (exited = r));
      const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => out.error(...a));
      try {
        installShutdown({
          server: { close: () => undefined, closeAllConnections: () => undefined },
          db: { close: () => undefined },
          lock: { close: () => undefined },
          timer: setInterval(() => undefined, 1_000_000),
          proc: { on: (event, fn) => events.set(event, fn), exit: (code) => exited(code) },
          waitForEnter: (message) => runtime.fatal(message),
        });
        events.get('uncaughtException')!(new Error('THE REAL CRASH: database is locked'));
        expect(await exit).toBe(1);
      } finally {
        spy.mockRestore();
      }
    });
    expect(boxes).toHaveLength(1);
    expect(boxes[0]!.icon).toBe('Error');
    expect(boxes[0]!.text.startsWith('Lyren Plan stopped because of an unexpected error:\nError: THE REAL CRASH: database is locked')).toBe(true);
    expect(boxes[0]!.text).not.toContain('request error');
  });

  it('a command started without a console shows what it printed: a box, or a console window when long', async () => {
    const short = await trayRun(async (out, runtime) => {
      out.log('New password for owner: abcDEF123');
      out.log('If you were locked out by too many attempts, wait 15 minutes.');
      await runtime.showOutput('Information', '(Ctrl+C copies the text of this message.)');
    });
    expect(short).toEqual([
      {
        title: 'Lyren Plan',
        text: 'New password for owner: abcDEF123\nIf you were locked out by too many attempts, wait 15 minutes.\n\n(Ctrl+C copies the text of this message.)',
        icon: 'Information',
      },
    ]);
    // An error, and what went to stdout and stderr in order.
    const failed = await trayRun(async (out, runtime) => {
      out.error('Unknown option: --data-dri');
      out.error('To see the options, run: lyren.exe help');
      await runtime.showOutput('Error');
    });
    expect(failed).toEqual([{ title: 'Lyren Plan', text: 'Unknown option: --data-dri\nTo see the options, run: lyren.exe help', icon: 'Error' }]);
    // Long (help): a console window that waits for Enter; a shortened box only where none can be opened.
    expect(fitsMessageBox('x\n'.repeat(29))).toBe(true);
    expect(fitsMessageBox('x\n'.repeat(31))).toBe(false);
    const help = async (out: Console, runtime: DesktopRuntime) => {
      for (let i = 0; i < 40; i++) out.log(`help line ${i}`);
      await runtime.showOutput('Information');
    };
    const consoles: string[] = [];
    expect(await trayRun(help, true, consoles)).toEqual([]);
    expect(consoles).toHaveLength(1);
    expect(consoles[0]).toMatch(/^help line 0\n[\s\S]*help line 39$/);
    const noConsole = await trayRun(help, false);
    expect(noConsole).toHaveLength(1);
    expect(noConsole[0]!.text).toContain('help line 39');
    // A short text whose box can't be shown goes to a console window.
    const fallback: string[] = [];
    await trayRun(
      async (out, runtime) => {
        out.log('Backup written to D:\\b.db');
        runtime.hooks.dialogLog = path.join(tmp('lyren-rt-'), 'missing', 'dialogs.jsonl'); // can't be written: no box
        await runtime.showOutput('Information');
      },
      true,
      fallback,
    );
    expect(fallback).toEqual(['Backup written to D:\\b.db']);
    // Elsewhere (a console) it was printed: nothing to show.
    const consoleRt = consoleRuntime();
    await consoleRt.showOutput('Information');
  });

  it('a command\'s result box never keeps it running: resolved once the box is up, the box stays (FV-3)', async () => {
    const run = async (behaviour: 'stays' | 'clm', print: (out: Console) => void, icon: 'Information' | 'Error', note?: string) => {
      const d = dialogHarness(behaviour);
      const consoles: string[] = [];
      const relaunch = async (_exe: string, _args: readonly string[], env: Record<string, string> = {}) => {
        consoles.push(env[MESSAGE_VAR] ?? '');
        return true; // cmd.exe's `start` returned: the console window is another process
      };
      const runtime = createRuntime({ mode: 'tray', exePath: 'C:\\x\\lyren.exe', args: [], hooks: { ...NO_TEST_HOOKS }, trayIcon: () => null, relaunch, dialog: d.deps });
      try {
        print(new Console({ stdout: process.stdout, stderr: process.stderr }));
        // 'stays': the box is never closed; showOutput must resolve anyway.
        await runtime.showOutput(icon, note);
      } finally {
        runtime.restoreOutput();
      }
      return { ...d, consoles };
    };
    const pw = await run('stays', (out) => out.log('New password for owner: abcDEF123'), 'Information', '(Ctrl+C copies the text of this message.)');
    expect(pw.helpers[0]!.messages()).toEqual([
      { title: 'Lyren Plan', text: 'New password for owner: abcDEF123\n\n(Ctrl+C copies the text of this message.)', icon: 'Information' },
    ]);
    expect(pw.launches[0]!.file).toMatch(/\\cmd\.exe$/i); // outside the app's job: it stays after the exit
    expect(pw.released).toEqual([pw.helpers[0]]);
    expect(pw.consoles).toEqual([]);
    const failed = await run('stays', (out) => out.error('Lyren Plan is not running with the data folder D:\\x.'), 'Error');
    expect(failed.helpers[0]!.messages()).toEqual([{ title: 'Lyren Plan', text: 'Lyren Plan is not running with the data folder D:\\x.', icon: 'Error' }]);
    expect(failed.released).toHaveLength(1);
    // No box possible: the text goes to a console window (a new copy of the app), not waited for either.
    const clm = await run('clm', (out) => out.log('Backup written to D:\\b.db'), 'Information');
    expect(clm.consoles).toEqual(['Backup written to D:\\b.db']);
  });

  it('unattended (session 0, Task Scheduler, a service): no box, no console window, nothing waited for; the output goes to the log (RCK-2)', async () => {
    const dir = tmp('lyren-unattended-');
    const dialogLog = path.join(dir, 'dialogs.jsonl');
    const consoles: string[] = [];
    const relaunch = async (_exe: string, _args: readonly string[], env: Record<string, string> = {}) => {
      consoles.push(env[MESSAGE_VAR] ?? '');
      return true;
    };
    const runtime = createRuntime({ mode: 'unattended', exePath: 'C:\\x\\lyren.exe', args: [], hooks: { ...NO_TEST_HOOKS, dialogLog }, trayIcon: () => null, relaunch });
    const out = new Console({ stdout: process.stdout, stderr: process.stderr });
    try {
      runtime.log!.note('Lyren Plan started (unattended mode)');
      runtime.log!.open(path.join(dir, 'logs'));
      out.log('Backup written to D:\\b.db');
      out.error('Backup failed: disk full');
      for (let i = 0; i < 40; i++) out.log(`long line ${i}`); // would go to a console window in tray mode
      const t0 = Date.now();
      await runtime.showOutput('Information');
      await runtime.showOutput('Error');
      await runtime.fatal();
      await runtime.notify('a notice', 'Warning', { wait: true });
      expect(Date.now() - t0).toBeLessThan(100);
    } finally {
      runtime.restoreOutput();
      runtime.log!.close();
    }
    expect(fs.existsSync(dialogLog)).toBe(false);
    expect(consoles).toEqual([]);
    const logged = fs.readFileSync(path.join(dir, 'logs', LOG_FILE_NAME), 'utf8');
    expect(logged).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d Lyren Plan started \(unattended mode\)\n/);
    expect(logged).toContain(' Backup written to D:\\b.db\n');
    expect(logged).toContain(' Backup failed: disk full\n');
    expect(logged).toContain(' long line 39\n');
  });

  it('unattended reset-password: no random password nobody could read; nothing is changed (RCK-2)', async () => {
    const dir = tmp('lyren-unattended-pw-');
    const hash = await directoryWithOwner(path.join(dir, 'lyren.db'));
    const tty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true }); // nothing piped
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logs = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const saved = { ...process.env };
    try {
      process.env.DATA_DIR = dir;
      delete process.env.DB_PATH;
      const err = await resetPassword('owner', undefined, { noDatabaseHint: '', noRandomPassword: ['nobody would see it', 'run it in a terminal'] }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CliExit);
      expect((err as CliExit).code).toBe(2);
      expect(errors.mock.calls.map((c) => c[0])).toEqual(['nobody would see it', 'run it in a terminal']);
      expect(logs).not.toHaveBeenCalled();
    } finally {
      process.env = saved;
      errors.mockRestore();
      logs.mockRestore();
      if (tty) Object.defineProperty(process.stdin, 'isTTY', tty);
      else delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
    expect(ownerPasswordHash(path.join(dir, 'lyren.db'))).toBe(hash);
  });
});

describe('File Explorer and the files next to the database', () => {
  const env = { SystemRoot: 'C:\\Windows' };

  it('Open data folder: the folder always in quotes (a comma would split it), a drive root as it is, too long refused', () => {
    expect(folderCommand('D:\\Lyren,2026', env)).toEqual({ file: 'C:\\Windows\\explorer.exe', args: ['"D:\\Lyren,2026"'], verbatim: true });
    expect(folderCommand('D:\\Plans; v2=x', env).args).toEqual(['"D:\\Plans; v2=x"']);
    expect(folderCommand('D:\\', env).args).toEqual(['D:\\']);
    const longest = `C:\\${'x'.repeat(MAX_EXPLORER_PATH - 3)}`;
    expect(folderCommand(longest, env).args).toEqual([`"${longest}"`]);
    expect(() => folderCommand(`${longest}y`, env)).toThrow(FolderTooLongError);
    expect(() => folderCommand('relative\\dir', env)).toThrow(/absolute/);
  });

  it('desktop.json and the log are named after a database that is not lyren.db, so two in one folder never share them', () => {
    expect(desktopFiles('C:\\Users\\ann\\AppData\\Local\\Lyren Plan\\lyren.db', 'win32')).toEqual({
      stateFile: 'C:\\Users\\ann\\AppData\\Local\\Lyren Plan\\desktop.json',
      legacyStateFile: null,
      logDir: 'C:\\Users\\ann\\AppData\\Local\\Lyren Plan\\logs',
      logName: 'lyren-plan.log',
    });
    expect(desktopFiles('D:\\X\\LYREN.DB', 'win32').stateFile).toBe('D:\\X\\desktop.json');
    expect(desktopFiles('D:\\Plans\\work.db', 'win32')).toEqual({
      stateFile: 'D:\\Plans\\work.db.desktop.json',
      legacyStateFile: 'D:\\Plans\\desktop.json',
      logDir: 'D:\\Plans\\logs',
      logName: 'work.db.log',
    });
    expect(desktopFiles('/srv/LYREN.DB', 'linux').logName).toBe('LYREN.DB.log');
  });

  it("an older version's desktop.json is read until the database's own file exists, unless it belongs to lyren.db", () => {
    const dir = tmp('lyren-files-');
    const legacy = { port: 43771, secret: 'a'.repeat(64) };
    fs.writeFileSync(path.join(dir, 'desktop.json'), JSON.stringify(legacy));
    const work = desktopFiles(path.join(dir, 'work.db'));
    expect(readStateOf(work)).toEqual(legacy);
    fs.writeFileSync(work.stateFile, JSON.stringify({ secret: 'b'.repeat(64) }));
    expect(readStateOf(work)).toEqual({ secret: 'b'.repeat(64) });
    fs.rmSync(work.stateFile);
    fs.writeFileSync(path.join(dir, 'lyren.db'), '');
    expect(readStateOf(work)).toEqual({});
    expect(readStateOf(desktopFiles(path.join(dir, 'lyren.db')))).toEqual(legacy);
  });
});

// ---- stop ---------------------------------------------------------------------------------------------

describe('the stop protocol (instance.ts)', () => {
  const uniqueName = () =>
    process.platform === 'win32'
      ? `\\\\.\\pipe\\lyren-test-${randomBytes(8).toString('hex')}`
      : process.platform === 'linux'
        ? `\0lyren-test-${randomBytes(8).toString('hex')}`
        : path.join(tmp('lyren-sock-'), 's.sock');

  it('a client that knows the secret stops the server; the call returns once the name is free', async () => {
    const name = uniqueName();
    const secret = randomBytes(32).toString('hex');
    const held = await acquireInstanceLock({ name, secret, readSecret: () => secret });
    if (!held.held) throw new Error('expected to hold the name');
    const onStop = vi.fn(() => setTimeout(() => held.lock.close(), 50));
    held.lock.ready('http://127.0.0.1:43770/', { mode: 'tray', onStop });
    expect(await requestStop({ name, readSecret: () => secret })).toEqual({ result: 'stopped', url: 'http://127.0.0.1:43770/' });
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(await requestStop({ name, readSecret: () => secret })).toEqual({ result: 'not-running' });
  });

  it('a second start learns how the running one shows itself', async () => {
    const name = uniqueName();
    const secret = randomBytes(32).toString('hex');
    const held = await acquireInstanceLock({ name, secret, readSecret: () => secret });
    if (!held.held) throw new Error('expected to hold the name');
    held.lock.ready('http://127.0.0.1:43770/', { mode: 'terminal' });
    expect(await acquireInstanceLock({ name, secret: 'x', readSecret: () => secret })).toEqual({
      held: false,
      other: { url: 'http://127.0.0.1:43770/', mode: 'terminal' },
    });
    held.lock.close();
  });

  it('refused without the secret: a wrong proof, a replayed proof, no secret at all, an impostor', async () => {
    const name = uniqueName();
    const secret = randomBytes(32).toString('hex');
    const held = await acquireInstanceLock({ name, secret, readSecret: () => secret });
    if (!held.held) throw new Error('expected to hold the name');
    const onStop = vi.fn();
    held.lock.ready('http://127.0.0.1:43770/', { onStop });
    try {
      // A raw client that does not know the secret: it gets a nonce, but no proof it sends counts.
      const raw = async (proofFor: (nonce: string) => string) => {
        const socket = net.connect(name);
        await new Promise((r) => socket.once('connect', r));
        socket.setEncoding('utf8');
        let buf = '';
        const line = () =>
          new Promise<string>((resolve) => {
            const check = () => {
              const nl = buf.indexOf('\n');
              if (nl >= 0) {
                const l = buf.slice(0, nl);
                buf = buf.slice(nl + 1);
                socket.off('data', onData);
                resolve(l);
              }
            };
            const onData = (d: string) => {
              buf += d;
              check();
            };
            socket.on('data', onData);
            check();
          });
        socket.write(JSON.stringify({ challenge: 'ab'.repeat(16), stop: true }) + '\n');
        const answer = JSON.parse(await line()) as { nonce: string; proof: string; url: string };
        expect(answer.nonce).toMatch(/^[0-9a-f]{32}$/);
        expect(answer.proof).toBe(instanceProof(secret, 'ab'.repeat(16), answer.url));
        socket.write(JSON.stringify({ stop: proofFor(answer.nonce) }) + '\n');
        const reply = JSON.parse(await line()) as { stopping: boolean };
        socket.destroy();
        return { reply, nonce: answer.nonce };
      };
      expect((await raw(() => 'f'.repeat(64))).reply).toEqual({ stopping: false });
      expect((await raw((n) => stopProof('another secret', n))).reply).toEqual({ stopping: false });
      // A proof seen once (for an old nonce) is worthless: every connection gets a new nonce.
      const seen = await raw(() => 'x');
      expect((await raw(() => stopProof(secret, seen.nonce))).reply).toEqual({ stopping: false });
      expect(onStop).not.toHaveBeenCalled();
      // The `stop` client without the secret, or with a wrong one, never sends a request.
      expect(await requestStop({ name, readSecret: () => null })).toEqual({ result: 'no-secret' });
      expect(await requestStop({ name, readSecret: () => 'e'.repeat(64) })).toEqual({ result: 'unverified' });
      expect(onStop).not.toHaveBeenCalled();
      // With the secret: accepted.
      expect(await requestStop({ name, readSecret: () => secret, stopWaitMs: 300 })).toEqual({ result: 'still-running', url: 'http://127.0.0.1:43770/' });
      expect(onStop).toHaveBeenCalledTimes(1);
    } finally {
      held.lock.close();
    }
  });

  /** A raw server on `name` that answers each connection's first line with `answer(challenge)` and then does `then`. */
  async function rawServer(name: string, answer: (challenge: string) => object, then: (socket: net.Socket) => void = (sk) => sk.end()) {
    const server = net.createServer((socket) => {
      socket.setEncoding('utf8');
      let buf = '';
      let answered = false;
      socket.on('error', () => undefined);
      socket.on('data', (d: string) => {
        buf += d;
        if (answered || !buf.includes('\n')) return;
        answered = true;
        const { challenge } = JSON.parse(buf.slice(0, buf.indexOf('\n'))) as { challenge: string };
        socket.write(JSON.stringify(answer(challenge)) + '\n');
        then(socket);
      });
    });
    await new Promise<void>((r) => server.listen(name, r));
    return server;
  }

  it('a copy of a version before `stop` (a valid answer without a nonce) is named as such, not as an impostor', async () => {
    const name = uniqueName();
    const secret = randomBytes(32).toString('hex');
    const url = 'http://127.0.0.1:43770/';
    // What a server of the previous version answers: {app, url, proof}; it ignores `stop`.
    const old = await rawServer(name, (challenge) => ({ app: 'lyren-plan', url, proof: instanceProof(secret, challenge, url) }));
    try {
      expect(await requestStop({ name, readSecret: () => secret })).toEqual({ result: 'old-version', url });
      // Without the right secret it is still unverified.
      expect(await requestStop({ name, readSecret: () => 'c'.repeat(64) })).toEqual({ result: 'unverified' });
    } finally {
      await new Promise((r) => old.close(r));
    }
  });

  it('a stop whose connection is closed while the server shuts down (another stop, Quit) reports stopped', async () => {
    const name = uniqueName();
    const secret = randomBytes(32).toString('hex');
    const held = await acquireInstanceLock({ name, secret, readSecret: () => secret });
    if (!held.held) throw new Error('expected to hold the name');
    // The first request makes the server close its name at once, dropping the other connection.
    const onStop = vi.fn(() => held.lock.close());
    held.lock.ready('http://127.0.0.1:43770/', { onStop });
    const results = await Promise.all([requestStop({ name, readSecret: () => secret }), requestStop({ name, readSecret: () => secret })]);
    expect(results).toEqual([
      { result: 'stopped', url: 'http://127.0.0.1:43770/' },
      { result: 'stopped', url: 'http://127.0.0.1:43770/' },
    ]);
    expect(onStop).toHaveBeenCalled();
    // A server that drops the connection after the proof and keeps running: refused (after the wait).
    const keeps = await rawServer(
      name,
      (challenge) => ({ app: 'lyren-plan', url: 'http://127.0.0.1:43770/', proof: instanceProof(secret, challenge, 'http://127.0.0.1:43770/'), nonce: 'ab'.repeat(16) }),
      (socket) => socket.once('data', () => socket.destroy()),
    );
    try {
      expect(await requestStop({ name, readSecret: () => secret, stopWaitMs: 300 })).toEqual({ result: 'refused', url: 'http://127.0.0.1:43770/' });
    } finally {
      await new Promise((r) => keeps.close(r));
    }
    // Dropped before any answer by a server on its way out (it closes its name 100 ms later): stopped.
    const closing = net.createServer((socket) => socket.destroy());
    await new Promise<void>((r) => closing.listen(name, r));
    setTimeout(() => closing.close(), 100);
    expect(await requestStop({ name, readSecret: () => secret })).toEqual({ result: 'stopped', url: null });
    // One that keeps dropping connections and stays: no answer.
    const dropper = net.createServer((socket) => socket.destroy());
    await new Promise<void>((r) => dropper.listen(name, r));
    try {
      expect(await requestStop({ name, readSecret: () => secret, stopWaitMs: 300 })).toEqual({ result: 'no-answer' });
    } finally {
      await new Promise((r) => dropper.close(r));
    }
  });

  it('a name that is held but can never be asked (it drops every connection): unreachable, not an error', async () => {
    const name = uniqueName();
    const dropper = net.createServer((socket) => socket.destroy());
    await new Promise<void>((r) => dropper.listen(name, r));
    try {
      expect(await acquireInstanceLock({ name, secret: 'f'.repeat(64), readSecret: () => null, maxAttempts: 3 })).toEqual({
        held: false,
        other: { url: null, reason: 'unreachable' },
      });
    } finally {
      await new Promise((r) => dropper.close(r));
    }
    for (const reason of ['timeout', 'unverified', 'denied', 'unreachable'] as const) {
      const lines = unusableInstanceMessage(reason, 'the data folder D:\\L', 'win32');
      expect(lines.join(' '), reason).toContain('D:\\L');
      expect(lines.join(' '), reason).not.toMatch(/EADDRINUSE|undefined/);
    }
    expect(unusableInstanceMessage('denied', 'the data folder D:\\L', 'win32')[0]).toContain('started by another Windows account');
    expect(unusableInstanceMessage('timeout', 'the database /x/a.db', 'linux')).toEqual([
      'Lyren Plan is already running with the database /x/a.db but does not respond.',
      'Close the other Lyren Plan window (or end it in Task Manager) and start Lyren Plan again.',
    ]);
  });

  it('a server without a stop handler (an older version) refuses; one that never becomes ready does not answer', async () => {
    const name = uniqueName();
    const secret = randomBytes(32).toString('hex');
    const held = await acquireInstanceLock({ name, secret, readSecret: () => secret });
    if (!held.held) throw new Error('expected to hold the name');
    expect(await requestStop({ name, readSecret: () => secret, waitMs: 300 })).toEqual({ result: 'no-answer' });
    held.lock.ready('http://127.0.0.1:43770/');
    expect(await requestStop({ name, readSecret: () => secret })).toEqual({ result: 'refused', url: 'http://127.0.0.1:43770/' });
    held.lock.close();
  });
});

describe('a relaunched copy, from source', () => {
  it('takes its arguments from LYREN_RELAUNCH_ARGS, or only shows LYREN_DESKTOP_MESSAGE', () => {
    const run = (extra: Record<string, string>) =>
      spawnSync(...tsxCommand('server/src/sea.ts'), { cwd: ROOT, env: tsxEnv({ ...process.env, ...extra }), input: '', encoding: 'utf8', timeout: 60_000 });
    const help = run({ [ARGS_VAR]: JSON.stringify(['help']) });
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain('./lyren-plan stop');
    const message = run({ [MESSAGE_VAR]: 'Port 19123 is already in use by another program.\n$(not code) %PATH%' });
    expect(message.status).toBe(1);
    expect(message.stdout).toBe('Port 19123 is already in use by another program.\n$(not code) %PATH%\n');
  }, 90_000);
});

describe('stop, end to end from source (tsx server/src/sea.ts)', () => {
  async function freePort() {
    const probe = net.createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const { port } = probe.address() as net.AddressInfo;
    await new Promise((r) => probe.close(r));
    return port;
  }

  /**
   * Starts a copy on a free port and waits until it serves. The port is free only when probed: another test
   * file running alongside may take it before the copy listens, so a copy refused for that starts again on
   * another one.
   */
  async function startCopy(env: NodeJS.ProcessEnv, args: string[] = []) {
    for (let attempt = 1; ; attempt++) {
      const port = await freePort();
      const child = spawn(...tsxCommand('server/src/sea.ts', ['--port', String(port), ...args]), { cwd: ROOT, env });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
      const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
      let closed = false;
      const close = new Promise<void>((resolve) => child.once('close', () => resolve()));
      void close.then(() => (closed = true));
      const deadline = Date.now() + 30_000;
      while (!out.includes('Keep this window open') && !closed && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      if (closed && attempt < 3 && out.includes('is already in use')) continue;
      return { port, child, exited, out: () => out };
    }
  }

  it('stops the running app gracefully (exit 0, WAL checkpointed); refuses without the secret; nothing running is exit 1', async () => {
    const dir = tmp('lyren-stop-');
    const dataDir = path.join(dir, 'data');
    const env = tsxEnv({ ...process.env, DATA_DIR: dataDir, WEB_DIR: '', OPEN_BROWSER: 'false', DB_PATH: '', HOST: '' });
    const run = (args: string[], extra: Record<string, string> = {}) =>
      spawnSync(...tsxCommand('server/src/sea.ts', args), { cwd: ROOT, env: { ...env, ...extra }, encoding: 'utf8', timeout: 60_000 });

    const none = run(['stop']);
    expect(none.status).toBe(1);
    expect(none.stderr).toContain(`Lyren Plan is not running with the data folder ${dataDir}.`);

    const { port, child, exited, out } = await startCopy(env);
    try {
      expect(out()).toContain(`http://127.0.0.1:${port}/`);

      // Without the secret (another user, any program): refused, still running.
      const stateFile = path.join(dataDir, 'desktop.json');
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as { secret: string };
      fs.writeFileSync(stateFile, JSON.stringify({ ...state, secret: 'b'.repeat(64) }));
      const refused = run(['stop']);
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain(`Another program answers as Lyren Plan with the data folder ${dataDir}, but could not prove it. Nothing was stopped.`);
      fs.writeFileSync(stateFile, JSON.stringify({ ...state, secret: undefined }));
      const noSecret = run(['stop']);
      expect(noSecret.status).toBe(1);
      expect(noSecret.stderr).toContain("could not be read, so it can't be asked to stop.");
      expect((await fetch(`http://127.0.0.1:${port}/api/health`)).status).toBe(200);
      fs.writeFileSync(stateFile, JSON.stringify(state));

      // With it (the same --data-dir as a command prompt would give): stopped, and the database closed.
      const stopped = run(['stop', '--data-dir', dataDir], { DATA_DIR: '' });
      expect(stopped.status, stopped.stderr).toBe(0);
      expect(stopped.stdout).toContain(`Lyren Plan (http://127.0.0.1:${port}/) has stopped.`);
      expect(await exited).toBe(0);
      expect(out()).toContain('Stopping Lyren Plan (stop command)...');
      expect(fs.readdirSync(dataDir).sort()).toEqual(['desktop.json', 'lyren.db']);
    } finally {
      child.kill('SIGTERM');
      await exited;
    }
  }, 120_000);

  it('two databases in one folder (--db-path): each copy has its own desktop.json, and stop reaches the right one', async () => {
    const dir = path.join(tmp('lyren-stop2-'), 'plans');
    const env = tsxEnv({ ...process.env, DATA_DIR: dir, WEB_DIR: '', OPEN_BROWSER: 'false', DB_PATH: '', HOST: '' });
    const run = (args: string[]) => spawnSync(...tsxCommand('server/src/sea.ts', args), { cwd: ROOT, env, encoding: 'utf8', timeout: 60_000 });
    const copies = await Promise.all(
      ['a.db', 'b.db'].map(async (db) => ({ db, ...(await startCopy(env, ['--db-path', path.join(dir, db)])) })),
    );
    try {
      for (const c of copies) expect(c.out(), c.db).toContain(`http://127.0.0.1:${c.port}/`);
      expect(fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()).toEqual(['a.db.desktop.json', 'b.db.desktop.json']);
      const [a, b] = copies as [(typeof copies)[0], (typeof copies)[0]];
      const stopA = run(['stop', '--db-path', path.join(dir, 'a.db')]);
      expect(stopA.status, stopA.stderr).toBe(0);
      expect(stopA.stdout).toContain(`Lyren Plan (http://127.0.0.1:${a.port}/) has stopped.`);
      expect(await a.exited).toBe(0);
      expect((await fetch(`http://127.0.0.1:${b.port}/api/health`)).status).toBe(200);
      const stopB = run(['stop', '--db-path', path.join(dir, 'b.db')]);
      expect(stopB.status, stopB.stderr).toBe(0);
      expect(await b.exited).toBe(0);
    } finally {
      for (const c of copies) c.child.kill('SIGTERM');
      await Promise.all(copies.map((c) => c.exited));
    }
  }, 120_000);
});
