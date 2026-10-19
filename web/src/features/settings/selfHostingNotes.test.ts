// Administration → Overview's notes for each distribution (SelfHostingNotes, design §12.12), rendered to
// HTML without a DOM: the Node build and Docker get the self-hosting notes (backup sets, restore,
// reset-password by email, PUBLIC_URL and mail); the desktop app gets its data folder and its own
// commands, without Docker, cron or `node dist/server.mjs`.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DesktopDataDTO } from '@shared/types';
import { signOutDescription } from './AccountSettings';
import { backupFileArg, psLiteral, psQuote, SelfHostingNotes, scheduledBackupArguments, selfHostingTitle } from './SelfHostingNotes';

function textOf(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replaceAll('&quot;', '"')
    .replaceAll('&#x27;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
    .replace(/\s+/g, ' ');
}

const render = (desktop: DesktopDataDTO | undefined, mail = false) =>
  textOf(renderToStaticMarkup(createElement(SelfHostingNotes, { username: 'dana@example.com', mail, desktop, today: '2026-10-14' })));

const WIN: DesktopDataDTO = {
  exe: 'lyren-plan-0.1.0-win-x64.exe',
  windows: true,
  dataDir: 'C:\\Users\\dana\\AppData\\Local\\Lyren Plan',
  dbPath: null,
  customDataDir: false,
  exeFolder: 'C:\\Users\\dana\\Apps',
};

const LINUX: DesktopDataDTO = {
  exe: 'lyren-plan-0.1.0-linux-x64',
  windows: false,
  dataDir: '/home/dana/.local/share/lyren-plan',
  dbPath: null,
  customDataDir: false,
  exeFolder: '/home/dana/bin',
};

describe('Administration → Overview notes', () => {
  it('Node build and Docker: data directory, cron and Docker, node dist/server.mjs', () => {
    const text = render(undefined);
    expect(selfHostingTitle(undefined)).toBe('Self-hosting notes');
    expect(text).toContain('DATA_DIR (default ./data , /data in Docker)');
    expect(text).toContain('0 3 * * * docker exec lyren-plan node dist/server.mjs backup /data/backups/lyren-$(date +\\%F).tar');
    expect(text).toContain('It holds lyren.db (the accounts and the list of spaces), spaces/ (one database per space) and backups/ .');
    expect(text).toContain('DATA_DIR=/path/to/data node dist/server.mjs restore /path/to/backups/lyren-2026-10-14.tar');
    expect(text).toContain('Restart the server.');
    expect(text).toContain('docker exec lyren-plan node dist/server.mjs restore /data/backups/lyren-2026-10-14.tar , then docker restart lyren-plan');
    expect(text).toContain('backups/before-restore-<time>/');
    expect(text).toContain('node dist/server.mjs reset-password dana@example.com');
    expect(text).toContain('docker exec -it lyren-plan');
  });

  it('Node build and Docker: PUBLIC_URL, and whether this server sends email', () => {
    const text = render(undefined);
    expect(text).toContain('Set PUBLIC_URL to the address people open Lyren Plan at, for example https://plan.example.com');
    expect(text).toContain('passkeys need it to be an https address');
    expect(text).toContain('This server sends no email: MAIL_TRANSPORT is log , the default');
    expect(text).toContain('Forgotten passwords are then reset with the command below.');
    const mailing = render(undefined, true);
    expect(mailing).toContain('This server sends email through the transport MAIL_TRANSPORT names.');
    expect(mailing).not.toContain('sends no email');
  });

  it('desktop app on Windows: its data folder and commands, nothing about servers, Docker or cron', () => {
    const text = render(WIN);
    expect(selfHostingTitle(WIN)).toBe('Data folder and commands');
    expect(text).toContain('Everything is stored in this folder on the computer that runs Lyren Plan: C:\\Users\\dana\\AppData\\Local\\Lyren Plan');
    expect(text).toContain(
      'It holds lyren.db (the accounts and the list of spaces), spaces\\ (one database per space) and backups\\ , where safety snapshots',
    );
    expect(text).toContain('run in Command Prompt, in the folder that holds lyren-plan-0.1.0-win-x64.exe ( C:\\Users\\dana\\Apps )');
    expect(text).toContain('type cmd in the address bar and press Enter');
    expect(text).toContain(
      '"lyren-plan-0.1.0-win-x64.exe" backup "%USERPROFILE%\\Documents\\Lyren Plan backups\\lyren-2026-10-14.tar"',
    );
    expect(text).toContain('Windows Task Scheduler');
    expect(text).toContain(
      `-NoProfile -Command "& 'C:\\Users\\dana\\Apps\\lyren-plan-0.1.0-win-x64.exe' backup ($env:USERPROFILE + '\\Documents\\Lyren Plan backups\\lyren-' + (Get-Date -Format yyyy-MM-dd) + '.tar')"`,
    );
    expect(text).toContain(
      'Run the restore command: "lyren-plan-0.1.0-win-x64.exe" restore "%USERPROFILE%\\Documents\\Lyren Plan backups\\lyren-2026-10-14.tar" Close the Lyren Plan window. Start Lyren Plan again.',
    );
    expect(text).toContain('backups\\before-restore-<time>');
    expect(text).toContain('"lyren-plan-0.1.0-win-x64.exe" reset-password dana@example.com');
    expect(text).toContain('clears any lock-out from failed sign-ins');
    expect(text).not.toMatch(/docker|cron|node dist|DATA_DIR|\.\/data|server|--data-dir/i);
  });

  it('desktop app with its own data folder: every command passes --data-dir', () => {
    const text = render({ ...WIN, dataDir: 'D:\\Lyren', customDataDir: true });
    expect(text).toContain('Lyren Plan: D:\\Lyren');
    expect(text).toContain('"lyren-plan-0.1.0-win-x64.exe" reset-password dana@example.com --data-dir "D:\\Lyren"');
    expect(text).toContain('lyren-2026-10-14.tar" --data-dir "D:\\Lyren"');
    expect(text).toContain(`+ '.tar') --data-dir 'D:\\Lyren'"`);
  });

  it('desktop app with DB_PATH: names the database file, and every command and the restore use it (R6REV-1, W6-1)', () => {
    const text = render({ ...WIN, dbPath: 'E:\\db\\plan.db' });
    expect(text).toContain('The accounts are in E:\\db\\plan.db (set with DB_PATH ), the spaces in plan.db.spaces\\ next to it.');
    // Every snapshot is next to the database, the pre-import ones too (§9.5).
    expect(text).toContain(
      'The backups\\ folder next to it keeps every safety snapshot, those taken before imports (a space’s in backups\\spaces\\<id> ) and those taken before upgrades',
    );
    // A Command Prompt opened later has no DB_PATH: without --db-path the commands would open
    // lyren.db in the default data folder, another database.
    expect(text).toContain('"lyren-plan-0.1.0-win-x64.exe" reset-password dana@example.com --db-path "E:\\db\\plan.db"');
    expect(text).toContain('lyren-2026-10-14.tar" --db-path "E:\\db\\plan.db"');
    expect(text).toContain(`+ '.tar') --db-path 'E:\\db\\plan.db'"`);
    expect(text).toContain('restore "%USERPROFILE%\\Documents\\Lyren Plan backups\\lyren-2026-10-14.tar" --db-path "E:\\db\\plan.db"');
    expect(text).not.toMatch(/lyren\.db(?!-)/i);
    expect(text).not.toContain('--data-dir');
  });

  it('desktop app with DB_PATH in the data folder under another name: still named (W6-1)', () => {
    const dataDir = 'D:\\Lyren';
    const text = render({ ...WIN, dataDir, customDataDir: true, dbPath: 'D:\\Lyren\\plan.db' });
    expect(text).toContain('The accounts are in D:\\Lyren\\plan.db (set with DB_PATH ), the spaces in plan.db.spaces\\ next to it.');
    expect(text).toContain('"lyren-plan-0.1.0-win-x64.exe" reset-password dana@example.com --db-path "D:\\Lyren\\plan.db"');
    expect(text).toContain('restore "%USERPROFILE%\\Documents\\Lyren Plan backups\\lyren-2026-10-14.tar" --db-path "D:\\Lyren\\plan.db"');
    expect(text).not.toContain('lyren.db (the accounts');
  });

  it('desktop app on Linux with DB_PATH: --db-path for the shell, the file name from the path', () => {
    const text = render({ ...LINUX, dbPath: '/srv/lyren db/plan.db' });
    expect(text).toContain("./lyren-plan-0.1.0-linux-x64 reset-password dana@example.com --db-path '/srv/lyren db/plan.db'");
    expect(text).toContain('the spaces in plan.db.spaces/ next to it.');
    expect(text).toContain("./lyren-plan-0.1.0-linux-x64 restore ~/lyren-2026-10-14.tar --db-path '/srv/lyren db/plan.db'");
  });

  it('desktop app run from source: no program folder and no Task Scheduler entry', () => {
    const text = render({ ...WIN, exe: 'lyren-plan', exeFolder: null });
    expect(text).toContain('in the folder that holds lyren-plan .');
    expect(text).not.toContain('Task Scheduler');
  });

  it('desktop app on Linux: a terminal, ./<program>, no Windows tools', () => {
    const text = render(LINUX);
    expect(text).toContain('/home/dana/.local/share/lyren-plan');
    expect(text).toContain('run in a terminal, in the folder that holds lyren-plan-0.1.0-linux-x64 ( /home/dana/bin )');
    expect(text).toContain('./lyren-plan-0.1.0-linux-x64 backup ~/lyren-2026-10-14.tar');
    expect(text).toContain('./lyren-plan-0.1.0-linux-x64 reset-password dana@example.com');
    expect(text).toContain('Close the Lyren Plan window.');
    expect(text).not.toMatch(/Command Prompt|Task Scheduler|PowerShell|cmd|docker|cron|node dist|server/i);
  });

  it('stopping and the lock-out follow how the app runs: its window, the notification area, a terminal', () => {
    const windowed = render(WIN);
    expect(windowed).toContain('Stop Lyren Plan Close the Lyren Plan window, or press Ctrl+C in it.');
    expect(windowed).toContain('"lyren-plan-0.1.0-win-x64.exe" stop');
    expect(windowed).toContain('Close the Lyren Plan window.');
    expect(windowed).not.toMatch(/notification area/);

    const tray = render({ ...WIN, stopMode: 'tray' });
    expect(tray).toContain(
      'Right-click the Lyren Plan icon in the notification area (near the clock; Windows may put it under the ^ arrow) and choose Quit Lyren Plan. Or run this command',
    );
    expect(tray).toContain('"lyren-plan-0.1.0-win-x64.exe" stop');
    expect(tray).toContain('Quit Lyren Plan: right-click its icon in the notification area (near the clock) and choose Quit Lyren Plan.');
    expect(tray).not.toMatch(/Close the Lyren Plan window|server/i);

    const terminal = render({ ...WIN, stopMode: 'terminal' });
    expect(terminal).toContain('Stop Lyren Plan: press Ctrl+C in its window, or right-click its icon in the notification area (near the clock) and choose Quit Lyren Plan.');

    // The stop command names the same database as the other commands.
    expect(render({ ...WIN, dataDir: 'D:\\Lyren', customDataDir: true, stopMode: 'tray' })).toContain('"lyren-plan-0.1.0-win-x64.exe" stop --data-dir "D:\\Lyren"');
    expect(render(LINUX)).toContain('./lyren-plan-0.1.0-linux-x64 stop');
  });

  it('Task Scheduler arguments: PowerShell single quotes are doubled', () => {
    expect(scheduledBackupArguments("C:\\Users\\O'Neil\\lyren.exe", { dataDir: "D:\\O'Neil", dbPath: null })).toBe(
      `-NoProfile -Command "& 'C:\\Users\\O''Neil\\lyren.exe' backup ($env:USERPROFILE + '\\Documents\\Lyren Plan backups\\lyren-' + (Get-Date -Format yyyy-MM-dd) + '.tar') --data-dir 'D:\\O''Neil'"`,
    );
    expect(scheduledBackupArguments('C:\\a\\lyren.exe', { dataDir: null, dbPath: null })).toBe(
      `-NoProfile -Command "& 'C:\\a\\lyren.exe' backup ($env:USERPROFILE + '\\Documents\\Lyren Plan backups\\lyren-' + (Get-Date -Format yyyy-MM-dd) + '.tar')"`,
    );
  });

  it('Task Scheduler arguments: typographic apostrophes end a PowerShell string too, so they are doubled (R6REV-3)', () => {
    // PowerShell treats ‘ ’ ‚ ‛ like ', e.g. in "Dana’s Apps" typed on a phone or auto-corrected.
    expect(psQuote('C:\\Dana\u2019s Apps\\x.exe')).toBe("'C:\\Dana\u2019\u2019s Apps\\x.exe'");
    expect(psQuote("a'b\u2018c\u2019d\u201Ae\u201Bf")).toBe("'a''b\u2018\u2018c\u2019\u2019d\u201A\u201Ae\u201B\u201Bf'");
    expect(psQuote('C:\\plain "double" \u201Cquotes\u201D')).toBe('\'C:\\plain "double" \u201Cquotes\u201D\'');
    const args = scheduledBackupArguments('C:\\Dana\u2019s Apps\\x.exe', { dataDir: null, dbPath: 'D:\\Dana\u2019s data\\plan.db' });
    expect(args).toContain("& 'C:\\Dana\u2019\u2019s Apps\\x.exe' backup");
    expect(args).toContain("--db-path 'D:\\Dana\u2019\u2019s data\\plan.db'\"");
  });

  it('a % in the data folder: Command Prompt would expand it even in quotes, so every command is for PowerShell (RCK-1)', () => {
    const dataDir = "D:\\R&D 100%PATH% ^x !y (z) O'Neil’s";
    const text = render({ ...WIN, dataDir, customDataDir: true, stopMode: 'tray' });
    const dir = "'D:\\R&D 100%PATH% ^x !y (z) O''Neil’’s'";
    expect(text).toContain('The commands below run in PowerShell, in the folder that holds lyren-plan-0.1.0-win-x64.exe ( C:\\Users\\dana\\Apps ).');
    expect(text).toContain('Not in Command Prompt: it would change the % in the path of the data folder.');
    expect(text).toContain('To open PowerShell there, go to that folder in File Explorer, type powershell in the address bar and press Enter.');
    expect(text).toContain(`& '.\\lyren-plan-0.1.0-win-x64.exe' stop --data-dir ${dir}`);
    expect(text).toContain(`& '.\\lyren-plan-0.1.0-win-x64.exe' reset-password dana@example.com --data-dir ${dir}`);
    expect(text).toContain(
      `& '.\\lyren-plan-0.1.0-win-x64.exe' backup "$env:USERPROFILE\\Documents\\Lyren Plan backups\\lyren-2026-10-14.tar" --data-dir ${dir}`,
    );
    // Task Scheduler gets no % at all (it may expand %NAME% in a task's arguments).
    expect(text).toContain(`--data-dir ('D:\\R&D 100' + [char]37 + 'PATH' + [char]37 + ' ^x !y (z) O''Neil’’s')"`);
    expect(text).not.toMatch(/Command Prompt,|type cmd|"lyren-plan-0\.1\.0-win-x64\.exe"|%USERPROFILE%/);
    // A database file with a %, and a program renamed with one.
    expect(render({ ...WIN, dbPath: 'E:\\100%\\plan.db' })).toContain("it would change the % in the path of the database. ");
    expect(render({ ...WIN, dbPath: 'E:\\100%\\plan.db' })).toContain("& '.\\lyren-plan-0.1.0-win-x64.exe' stop --db-path 'E:\\100%\\plan.db'");
    const renamed = render({ ...WIN, exe: 'Lyren 100%.exe' });
    expect(renamed).toContain('it would change the % in the name of the program.');
    expect(renamed).toContain("& '.\\Lyren 100%.exe' reset-password dana@example.com");
    expect(renamed).toContain(`-NoProfile -Command "& ('C:\\Users\\dana\\Apps\\Lyren 100' + [char]37 + '.exe') backup`);
    // Without a %: Command Prompt as before, even with names cmd treats specially inside quotes.
    const plain = render({ ...WIN, dataDir: "D:\\R&D ^x !y (z) O'Neil’s", customDataDir: true });
    expect(plain).toContain(`"lyren-plan-0.1.0-win-x64.exe" stop --data-dir "D:\\R&D ^x !y (z) O'Neil’s"`);
    expect(plain).not.toContain('PowerShell,');
  });

  it('Task Scheduler arguments: a share root\'s trailing backslash survives Windows PowerShell 5.1 (FV-1)', () => {
    // PowerShell evaluates the expression and passes the value on: with a space 5.1 quotes it without
    // escaping the trailing backslash, so it is doubled in the text (with the % as [char]37 as before).
    expect(scheduledBackupArguments('C:\\a\\lyren.exe', { dataDir: '\\\\nas\\Lyren 100%\\', dbPath: null })).toBe(
      `-NoProfile -Command "& 'C:\\a\\lyren.exe' backup ($env:USERPROFILE + '\\Documents\\Lyren Plan backups\\lyren-' + (Get-Date -Format yyyy-MM-dd) + '.tar') --data-dir ('\\\\nas\\Lyren 100' + [char]37 + '\\\\')"`,
    );
    expect(scheduledBackupArguments('C:\\a\\lyren.exe', { dataDir: '\\\\nas\\Lyren data\\', dbPath: null })).toContain(`--data-dir '\\\\nas\\Lyren data\\\\'"`);
    // Without whitespace: as it is.
    expect(scheduledBackupArguments('C:\\a\\lyren.exe', { dataDir: '\\\\nas\\Lyren\\', dbPath: null })).toContain(`--data-dir '\\\\nas\\Lyren\\'"`);
    // In Administration → Overview.
    const text = render({ ...WIN, dataDir: '\\\\nas\\Lyren 100%\\', customDataDir: true });
    expect(text).toContain("& '.\\lyren-plan-0.1.0-win-x64.exe' stop --data-dir '\\\\nas\\Lyren 100%\\\\'");
    expect(text).toContain(`--data-dir ('\\\\nas\\Lyren 100' + [char]37 + '\\\\')"`);
  });

  it('psLiteral: a PowerShell expression without a % sign; backupFileArg for each shell', () => {
    expect(psLiteral('D:\\Lyren')).toBe("'D:\\Lyren'");
    expect(psLiteral("100%PATH%'s")).toBe("('100' + [char]37 + 'PATH' + [char]37 + '''s')");
    expect(psLiteral('%')).toBe("('' + [char]37 + '')");
    expect(psLiteral('a%%b')).not.toContain('%');
    expect(backupFileArg('cmd', '2026-10-14')).toBe('"%USERPROFILE%\\Documents\\Lyren Plan backups\\lyren-2026-10-14.tar"');
    expect(backupFileArg('powershell', '2026-10-14')).toBe('"$env:USERPROFILE\\Documents\\Lyren Plan backups\\lyren-2026-10-14.tar"');
    expect(backupFileArg('posix', '2026-10-14')).toBe('~/lyren-2026-10-14.tar');
  });

  it('Account settings → Profile, Sign out: the server for the Node build, the data folder for the desktop app (W6-3)', () => {
    expect(signOutDescription(false)).toBe('Sign out of Lyren Plan on this device. Your data stays on the server.');
    expect(signOutDescription(true)).toBe(
      'Sign out of Lyren Plan on this device. Your data stays in the data folder on the computer that runs Lyren Plan.',
    );
  });
});
