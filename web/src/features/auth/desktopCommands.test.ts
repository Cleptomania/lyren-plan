// The sign-in page's "Forgot your password?" hint for each distribution, and the desktop app's
// command lines (desktopCommands.ts), rendered to HTML without a DOM.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DesktopAppDTO } from '@shared/types';
import { commandShell, desktopCommand, programCommand, ps51ArgText, shellArg, shellName, stopHow, stopStep } from './desktopCommands';
import { PasswordResetHint } from './PasswordResetHint';

/** The visible text of rendered HTML. */
function textOf(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replaceAll('&quot;', '"')
    .replaceAll('&#x27;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

const hint = (desktop: DesktopAppDTO | undefined) => textOf(renderToStaticMarkup(createElement(PasswordResetHint, { desktop })));

const WIN: DesktopAppDTO = { exe: 'lyren-plan-0.1.0-win-x64.exe', windows: true };
const LINUX: DesktopAppDTO = { exe: 'lyren-plan-0.1.0-linux-x64', windows: false };

describe('sign-in page: forgot your password', () => {
  it('Node build and Docker (no desktop field): the server command, as before', () => {
    expect(hint(undefined)).toBe('Forgot your password? On the server run node dist/server.mjs reset-password <email-or-username>');
  });

  it('desktop app on Windows: Command Prompt in the folder of the exe, with its quoted file name', () => {
    const text = hint(WIN);
    expect(text).toContain(
      'On the computer that runs Lyren Plan, open Command Prompt in the folder that holds lyren-plan-0.1.0-win-x64.exe',
    );
    expect(text).toContain('type cmd in that folder’s address bar and press Enter');
    expect(text).toContain('"lyren-plan-0.1.0-win-x64.exe" reset-password <email-or-username>');
    expect(text).toContain('It prints a new password and signs you out everywhere.');
    expect(text).not.toMatch(/node|dist\/server|docker|on the server/i);
  });

  it('desktop app on Linux: a terminal and ./<program>', () => {
    const text = hint(LINUX);
    expect(text).toContain('open a terminal in the folder that holds lyren-plan-0.1.0-linux-x64');
    expect(text).toContain('./lyren-plan-0.1.0-linux-x64 reset-password <email-or-username>');
    expect(text).not.toMatch(/Command Prompt|cmd|node|docker/i);
  });

  it('a renamed program keeps working in the command', () => {
    expect(hint({ exe: 'Lyren Plan.exe', windows: true })).toContain('"Lyren Plan.exe" reset-password <email-or-username>');
    expect(hint({ exe: "Dana's Lyren", windows: false })).toContain(`'./Dana'\\''s Lyren' reset-password <email-or-username>`);
  });
});

describe('desktop command lines', () => {
  it('quotes the program for its shell', () => {
    expect(programCommand(WIN)).toBe('"lyren-plan-0.1.0-win-x64.exe"');
    expect(programCommand(LINUX)).toBe('./lyren-plan-0.1.0-linux-x64');
    expect(programCommand({ exe: 'lyren plan', windows: false })).toBe("'./lyren plan'");
  });

  it('adds --data-dir only when given, quoted for the shell', () => {
    expect(desktopCommand(WIN, 'reset-password dana')).toBe('"lyren-plan-0.1.0-win-x64.exe" reset-password dana');
    expect(desktopCommand(WIN, 'reset-password dana', { dataDir: 'D:\\My Lyren', dbPath: null })).toBe(
      '"lyren-plan-0.1.0-win-x64.exe" reset-password dana --data-dir "D:\\My Lyren"',
    );
    expect(desktopCommand(LINUX, 'backup ~/x.db', { dataDir: '/media/usb/my lyren', dbPath: null })).toBe(
      "./lyren-plan-0.1.0-linux-x64 backup ~/x.db --data-dir '/media/usb/my lyren'",
    );
  });

  it('adds --db-path when DB_PATH chose the database file, instead of --data-dir (R6REV-1)', () => {
    expect(desktopCommand(WIN, 'reset-password dana', { dataDir: null, dbPath: 'E:\\db\\plan.db' })).toBe(
      '"lyren-plan-0.1.0-win-x64.exe" reset-password dana --db-path "E:\\db\\plan.db"',
    );
    // The commands open only the database file, so the folder is not needed as well.
    expect(desktopCommand(WIN, 'reset-password dana', { dataDir: 'D:\\Lyren', dbPath: 'D:\\Lyren\\plan.db' })).toBe(
      '"lyren-plan-0.1.0-win-x64.exe" reset-password dana --db-path "D:\\Lyren\\plan.db"',
    );
    expect(desktopCommand(LINUX, 'backup ~/x.db', { dataDir: null, dbPath: "/srv/dana's db/plan.db" })).toBe(
      `./lyren-plan-0.1.0-linux-x64 backup ~/x.db --db-path '/srv/dana'\\''s db/plan.db'`,
    );
  });

  it('Command Prompt: a trailing backslash would escape the closing quote, so it is doubled', () => {
    expect(shellArg('D:\\', 'cmd')).toBe('"D:\\\\"');
    expect(shellArg('D:\\Lyren', 'cmd')).toBe('"D:\\Lyren"');
    expect(shellArg('/srv/lyren', 'posix')).toBe('/srv/lyren');
    expect(shellArg('D:\\', 'powershell')).toBe("'D:\\'");
  });

  it('a % goes to PowerShell: Command Prompt expands %NAME% even inside double quotes (RCK-1)', () => {
    const hostile = ['D:\\R&D 100%PATH% ^x !y (z)', 'D:\\100%% done', 'D:\\a %=C:% b', "D:\\O'Neil’s ‘x’ 1%", 'D:\\$env:X `b` %USERPROFILE%'];
    for (const dataDir of hostile) {
      const target = { dataDir, dbPath: null };
      expect(commandShell(WIN, target), dataDir).toBe('powershell');
      const line = desktopCommand(WIN, 'stop', target);
      expect(line.startsWith("& '.\\lyren-plan-0.1.0-win-x64.exe' stop --data-dir '"), line).toBe(true);
      // The single-quoted value is the folder once each doubled quotation mark is undone.
      expect(line.slice(line.indexOf("--data-dir '") + 12, -1).replace(/(['‘’‚‛])\1/g, '$1')).toBe(dataDir);
    }
    expect(commandShell(WIN, { dataDir: "D:\\R&D ^x !y (z) O'Neil’s", dbPath: null })).toBe('cmd');
    expect(commandShell(WIN, { dataDir: 'D:\\x', dbPath: 'E:\\100%\\a.db' })).toBe('powershell'); // --db-path is the one passed
    expect(commandShell(WIN, { dataDir: 'D:\\100%', dbPath: 'E:\\a.db' })).toBe('cmd');
    expect(commandShell({ exe: 'Lyren 100%.exe', windows: true })).toBe('powershell');
    expect(commandShell({ exe: 'lyren 100%', windows: false })).toBe('posix');
    expect(programCommand({ exe: 'Lyren 100%.exe', windows: true })).toBe("& '.\\Lyren 100%.exe'");
    expect(shellName('powershell')).toBe('PowerShell');
    expect(shellName('cmd')).toBe('Command Prompt');
    expect(shellName('posix')).toBe('a terminal');
  });

  it('PowerShell: a share root\'s trailing backslash survives Windows PowerShell 5.1 (FV-1)', () => {
    // 5.1 wraps an argument with whitespace in double quotes without escaping the backslash before the
    // closing quote: '\\nas\Lyren 100%\' arrived as \\nas\Lyren 100%" (measured); doubled it arrives intact.
    expect(desktopCommand(WIN, 'stop', { dataDir: '\\\\nas\\Lyren 100%\\', dbPath: null })).toBe(
      "& '.\\lyren-plan-0.1.0-win-x64.exe' stop --data-dir '\\\\nas\\Lyren 100%\\\\'",
    );
    // Without whitespace 5.1 passes it as it is.
    expect(desktopCommand(WIN, 'stop', { dataDir: '\\\\nas\\Lyren100%\\', dbPath: null })).toBe(
      "& '.\\lyren-plan-0.1.0-win-x64.exe' stop --data-dir '\\\\nas\\Lyren100%\\'",
    );
    expect(shellArg('D:\\', 'powershell')).toBe("'D:\\'");
    expect(shellArg('\\\\nas\\Dana’s 100%\\', 'powershell')).toBe("'\\\\nas\\Dana’’s 100%\\\\'");
    for (const ws of [' ', '\t', '\u00A0', '\u2007', '\u3000', '\u0085']) expect(ps51ArgText(`\\\\nas\\a${ws}b\\`), JSON.stringify(ws)).toBe(`\\\\nas\\a${ws}b\\\\`);
    for (const other of ['\u180E', '\u200B', '\uFEFF']) expect(ps51ArgText(`\\\\nas\\a${other}b\\`), JSON.stringify(other)).toBe(`\\\\nas\\a${other}b\\`);
    expect(ps51ArgText('D:\\a b\\c')).toBe('D:\\a b\\c');
    // Command Prompt: doubled always (unchanged).
    expect(desktopCommand(WIN, 'stop', { dataDir: '\\\\nas\\Lyren 1\\', dbPath: null })).toBe('"lyren-plan-0.1.0-win-x64.exe" stop --data-dir "\\\\nas\\Lyren 1\\\\"');
  });

  it('sign-in page: a program name with a % is given for PowerShell', () => {
    const text = hint({ exe: 'Lyren 100%PATH%.exe', windows: true });
    expect(text).toContain('open PowerShell in the folder that holds Lyren 100%PATH%.exe');
    expect(text).toContain('type powershell in that folder’s address bar and press Enter');
    expect(text).toContain("& '.\\Lyren 100%PATH%.exe' reset-password <email-or-username>");
  });
});

describe('how to stop the desktop app (stopMode)', () => {
  it('its window (and Linux, macOS, --console), the notification area, or a terminal with the icon', () => {
    expect(stopStep(WIN)).toBe('Close the Lyren Plan window.');
    expect(stopStep(LINUX)).toBe('Close the Lyren Plan window.');
    expect(stopStep({ ...WIN, stopMode: 'tray' })).toBe(
      'Quit Lyren Plan: right-click its icon in the notification area (near the clock) and choose Quit Lyren Plan.',
    );
    expect(stopStep({ ...WIN, stopMode: 'terminal' })).toMatch(/^Stop Lyren Plan: press Ctrl\+C in its window, or right-click its icon/);
    expect(stopHow({ ...WIN, stopMode: 'tray' })).toContain('Windows may put it under the ^ arrow');
    expect(stopHow(LINUX)).toBe('Close the Lyren Plan window, or press Ctrl+C in it.');
  });
});
