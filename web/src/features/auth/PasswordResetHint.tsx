// "Forgot your password?" under the sign-in form: the reset-password command of the distribution
// that serves this page. The Node build and Docker don't send AuthStatusDTO.desktop; the
// single-file desktop app does, with the program's file name (never a folder: the page is public).

import type { DesktopAppDTO } from '@shared/types';
import { commandShell, programCommand, shellName, shellProgram } from './desktopCommands';

function Code({ children }: { children: string }) {
  return <code className="rounded bg-surface-2 px-1 font-mono text-fg-muted">{children}</code>;
}

export function PasswordResetHint({ desktop }: { desktop: DesktopAppDTO | undefined }) {
  if (!desktop) {
    return (
      <p className="break-words">
        Forgot your password? On the server run{' '}
        <code className="rounded bg-surface-2 px-1 font-mono text-fg-muted">node dist/server.mjs reset-password &lt;username&gt;</code>
      </p>
    );
  }
  // PowerShell when Command Prompt would change the program's name (a % in it, commandShell).
  const shell = commandShell(desktop);
  return (
    <div className="flex flex-col gap-1 break-words">
      <p>
        Forgot your password? On the computer that runs Lyren Plan, open {shellName(shell)} in the folder that holds{' '}
        <Code>{desktop.exe}</Code>
        {desktop.windows && (
          <>
            {' '}
            (in File Explorer, type <Code>{shellProgram(shell)}</Code> in that folder’s address bar and press Enter)
          </>
        )}{' '}
        and run:
      </p>
      <p>
        <Code>{`${programCommand(desktop, shell)} reset-password <username>`}</Code>
      </p>
      <p>It prints a new password and signs you out everywhere.</p>
    </div>
  );
}
