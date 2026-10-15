// Test-only hooks of the desktop app (SPEC §12.1): environment variables that let an automated test
// on a real Windows desktop see what the app would open or show without opening the user's browser
// or leaving dialogs on the screen, and drive the tray icon's menu through its real menu code
// without synthetic mouse input. Each is inert unless set; nothing a user does sets them.
//
//   LYREN_TEST_BROWSER_LOG=<file>    append each address the app would open in the browser to <file>
//                                    (one per line) instead of starting the browser
//   LYREN_TEST_DIALOG_LOG=<file>     append each message box as a JSON line to <file> instead of
//                                    showing it (it counts as shown and closed)
//   LYREN_TEST_TRAY_CONTROL=<file>   read test operations for the tray helper from <file> (polled,
//                                    then deleted): `click:<menu item id>` runs that menu item's Click
//                                    handler (MenuItem.PerformClick), `describe` logs the menu as built
//   LYREN_TEST_POWERSHELL_CLM=1      start Windows PowerShell (tray helper, dialogs) in
//                                    ConstrainedLanguage mode, as an application-control policy would

export interface TestHooks {
  browserLog: string | null;
  dialogLog: string | null;
  trayControl: string | null;
  powershellClm: boolean;
}

export const NO_TEST_HOOKS: TestHooks = { browserLog: null, dialogLog: null, trayControl: null, powershellClm: false };

export function testHooks(env: Record<string, string | undefined> = process.env): TestHooks {
  const file = (name: string) => (env[name]?.trim() ? env[name]!.trim() : null);
  return {
    browserLog: file('LYREN_TEST_BROWSER_LOG'),
    dialogLog: file('LYREN_TEST_DIALOG_LOG'),
    trayControl: file('LYREN_TEST_TRAY_CONTROL'),
    powershellClm: env.LYREN_TEST_POWERSHELL_CLM === '1',
  };
}
