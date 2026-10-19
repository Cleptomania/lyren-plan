// Administration → Overview (design §12.12): where the data lives (the accounts' lyren.db, a database per
// space in spaces/, the snapshots in backups/), command-line backups (backup sets, .tar), the restore
// command and password resets by email address, for the distribution that serves this client. The Node
// build and Docker get the self-hosting notes, with the PUBLIC_URL and mail settings; the single-file
// desktop app (AuthStatusDTO.desktopData) gets its data folder and its own commands instead, with no
// Docker, cron or `node dist/server.mjs`. (Design §9.7, §9.9.)

import { Check, Copy } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { DesktopDataDTO } from '@shared/types';
import { IconButton, toast } from '../../components/ui';
import {
  commandShell,
  dataTarget,
  desktopCommand,
  ps51ArgText,
  psQuote,
  shellName,
  shellProgram,
  stopHow,
  stopStep,
  targetOption,
  type CommandShell,
  type CommandTarget,
} from '../auth/desktopCommands';

// ---------------------------------------------------------------------------
// Copyable command snippets
// ---------------------------------------------------------------------------

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall back below */
  }
  // Plain-HTTP self-hosted instances have no async clipboard API.
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

function Command({ children, label }: { children: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex min-w-0 items-start gap-1 rounded-md border border-border bg-surface-2 py-1 pl-3 pr-1">
      <code className="min-w-0 flex-1 py-1.5 font-mono text-xs leading-5 whitespace-pre-wrap text-fg [overflow-wrap:anywhere]">{children}</code>
      <IconButton
        aria-label={copied ? 'Copied' : `Copy ${label}`}
        icon={copied ? <Check className="text-success" /> : <Copy />}
        size="sm"
        onClick={async () => {
          if (await copyText(children)) {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          } else {
            toast.error('Could not copy — select the text and copy it manually');
          }
        }}
      />
    </div>
  );
}

function Note({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <h4 className="text-[13px] font-semibold text-fg">{title}</h4>
      <div className="flex min-w-0 flex-col gap-2 text-[13px] leading-relaxed text-fg-muted">{children}</div>
    </div>
  );
}

export const Path = ({ children }: { children: ReactNode }) => (
  <code className="rounded bg-surface-2 px-1 py-px font-mono text-[12px] text-fg">{children}</code>
);

// ---------------------------------------------------------------------------
// Node build and Docker
// ---------------------------------------------------------------------------

function ServerNotes({ username, mail }: { username: string; mail: boolean }) {
  return (
    <div className="flex flex-col gap-5">
      <Note title="Address and email">
        <p>
          Set <Path>PUBLIC_URL</Path> to the address people open Lyren Plan at, for example{' '}
          <Path>https://plan.example.com</Path> (behind a reverse proxy, the proxy’s address). Links that leave the
          browser, in emails and invitations, are built from it, and passkeys need it to be an https address.
        </p>
        <p>
          {mail ? (
            <>This server sends email through the transport <Path>MAIL_TRANSPORT</Path> names.</>
          ) : (
            <>
              This server sends no email: <Path>MAIL_TRANSPORT</Path> is <Path>log</Path>, the default, which only writes a
              line to the server’s log for each message. Forgotten passwords are then reset with the command below.
            </>
          )}
        </p>
      </Note>
      <Note title="Where your data lives">
        <p>
          Everything is stored in the server’s data directory: <Path>DATA_DIR</Path> (default <Path>./data</Path>,{' '}
          <Path>/data</Path> in Docker). It holds <Path>lyren.db</Path> (the accounts and the list of spaces),{' '}
          <Path>spaces/</Path> (one database per space) and <Path>backups/</Path>. Safety snapshots taken before imports and
          upgrades are kept there: the newest 10 of each kind (set <Path>SNAPSHOT_KEEP</Path> to change that, 0 keeps all).
          Copy or rename one to keep it; your own backups there are never deleted.
        </p>
      </Note>
      <Note title="Scheduled backups">
        <p>
          The backup command writes a backup set, one <Path>.tar</Path> file with the accounts and every space, and is safe
          while the server is running. For example, nightly from cron with Docker:
        </p>
        <Command label="cron line">{`0 3 * * * docker exec lyren-plan node dist/server.mjs backup /data/backups/lyren-$(date +\\%F).tar`}</Command>
        <p>Without Docker, run it from the app directory with the server’s data directory, as the user that owns it:</p>
        <Command label="backup command">{'DATA_DIR=/path/to/data node dist/server.mjs backup /path/to/backups/lyren-$(date +%F).tar'}</Command>
      </Note>
      <Note title="Restore a backup">
        <p>
          The restore command takes a backup set, or one space’s snapshot from <Path>backups/spaces/</Path> to undo an
          import. The server completes the restore when it starts the next time, after moving the current data to{' '}
          <Path>backups/before-restore-&lt;time&gt;/</Path>.
        </p>
        <ol className="list-decimal pl-5">
          <li>
            Run the restore command with the server’s data directory, as the user that owns it:
            <Command label="restore command">{'DATA_DIR=/path/to/data node dist/server.mjs restore /path/to/backups/lyren-2026-10-14.tar'}</Command>
          </li>
          <li>Restart the server.</li>
        </ol>
        <p>
          With Docker: <Path>docker exec lyren-plan node dist/server.mjs restore /data/backups/lyren-2026-10-14.tar</Path>,
          then <Path>docker restart lyren-plan</Path>.
        </p>
      </Note>
      <Note title="Forgot your password?">
        <p>
          Run this on the server with the account’s email address (or the username of an account from before email
          addresses); it prints a new random password, signs you out everywhere and clears any lock-out from failed
          sign-ins:
        </p>
        <Command label="reset-password command">{`node dist/server.mjs reset-password ${username}`}</Command>
        <p>
          With Docker: prefix it with <Path>docker exec -it lyren-plan</Path>.
        </p>
      </Note>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Single-file desktop app
// ---------------------------------------------------------------------------

export { psQuote };

/**
 * A PowerShell expression for the text `s` with no % sign in it: Task Scheduler may replace %NAME%
 * in a task's arguments with that variable's value before PowerShell sees them, so each % is
 * written as [char]37: `('D:\R&D 100' + [char]37 + ' done')`. Without a %: psQuote.
 */
export function psLiteral(s: string): string {
  return s.includes('%') ? `(${s.split('%').map(psQuote).join(' + [char]37 + ')})` : psQuote(s);
}

/**
 * Arguments of `powershell.exe` for a daily Task Scheduler task: a backup named after the day, in
 * the same folder as the backup command's example, of the database `target` names. (The backup
 * command never overwrites a file, and Task Scheduler can't put the date into a program's
 * arguments by itself.) powershell.exe as the program also gives the backup a console, so it
 * prints there and ends by itself; the program as the task's program would run unattended
 * (output in the log file only). The option's value has a trailing backslash doubled where Windows
 * PowerShell 5.1 would otherwise pass it on wrongly (ps51ArgText: a share's root with a space).
 */
export function scheduledBackupArguments(program: string, target: CommandTarget): string {
  const option = targetOption(target);
  return (
    `-NoProfile -Command "& ${psLiteral(program)} backup ` +
    `($env:USERPROFILE + '\\Documents\\Lyren Plan backups\\lyren-' + (Get-Date -Format yyyy-MM-dd) + '.tar')` +
    `${option ? ` ${option.name} ${psLiteral(ps51ArgText(option.value))}` : ''}"`
  );
}

/** The backup set of the commands' examples, for `shell`: in the user's Documents folder, named after `today`. */
export function backupFileArg(shell: CommandShell, today: string): string {
  const name = `Lyren Plan backups\\lyren-${today}.tar`;
  if (shell === 'cmd') return `"%USERPROFILE%\\Documents\\${name}"`;
  // PowerShell expands $env:USERPROFILE in a double-quoted string (and nothing in the rest of it).
  if (shell === 'powershell') return `"$env:USERPROFILE\\Documents\\${name}"`;
  return `~/lyren-${today}.tar`;
}

/** Why the commands are for PowerShell: what has the % that Command Prompt would change. */
function percentIn(app: DesktopDataDTO, target: CommandTarget): string {
  if (app.exe.includes('%')) return 'the name of the program';
  return target.dbPath !== null ? 'the path of the database' : 'the path of the data folder';
}

/** The last part of a path (Windows: after a backslash or a slash). */
const fileName = (file: string, windows: boolean) => file.split(windows ? /[\\/]/ : '/').pop() || file;

/**
 * The folder of the spaces next to the database file `dbPath` (the server's spacesDirFor): spaces for a
 * lyren.db (any case on Windows), else <file name>.spaces.
 */
export function spacesFolderName(dbPath: string | null, windows: boolean): string {
  if (dbPath === null) return 'spaces';
  const name = fileName(dbPath, windows);
  return (windows ? name.toLowerCase() : name) === 'lyren.db' ? 'spaces' : `${name}.spaces`;
}

/** Joins a folder and a file name with the separator the folder uses. */
const inFolder = (folder: string, name: string, windows: boolean) => {
  const sep = windows ? '\\' : '/';
  return folder.endsWith(sep) ? folder + name : folder + sep + name;
};

function DesktopNotes({ username, app, today }: { username: string; app: DesktopDataDTO; today: string }) {
  const { windows, exe, exeFolder, dbPath } = app;
  // The commands open lyren.db in the default data folder unless told otherwise.
  const target = dataTarget(app);
  // Command Prompt, or PowerShell when Command Prompt would change a command (a % in it).
  const shell = commandShell(app, target);
  const file = backupFileArg(shell, today);
  const backup = desktopCommand(app, `backup ${file}`, target);
  const restore = desktopCommand(app, `restore ${file}`, target);
  const reset = desktopCommand(app, `reset-password ${username}`, target);
  const stop = desktopCommand(app, 'stop', target);
  const sep = windows ? '\\' : '/';
  const spaces = `${spacesFolderName(dbPath, windows)}${sep}`;
  const backups = `backups${sep}`;
  return (
    <div className="flex flex-col gap-5">
      <Note title="Where your data lives">
        <p>Everything is stored in this folder on the computer that runs Lyren Plan:</p>
        <Command label="data folder">{app.dataDir}</Command>
        <p>
          {dbPath === null ? (
            <>
              It holds <Path>lyren.db</Path> (the accounts and the list of spaces), <Path>{spaces}</Path> (one database per
              space) and <Path>{backups}</Path>, where safety snapshots taken before imports and upgrades are kept: the newest 10
              of each kind.
            </>
          ) : (
            <>
              The accounts are in <Path>{dbPath}</Path> (set with <Path>DB_PATH</Path>), the spaces in <Path>{spaces}</Path>{' '}
              next to it. The <Path>{backups}</Path> folder next to it keeps every safety snapshot, those taken before imports
              (a space’s in <Path>{`${backups}spaces${sep}<id>`}</Path>) and those taken before upgrades: the newest 10 of each
              kind.
            </>
          )}{' '}
          Copy or rename one to keep it; your own backups there are never deleted. Moving, renaming or replacing the program
          file leaves the data folder alone.
        </p>
      </Note>
      <Note title="Commands">
        <p>
          The commands below run in {shellName(shell)}, in the folder that holds <Path>{exe}</Path>
          {exeFolder !== null && (
            <>
              {' '}
              (<Path>{exeFolder}</Path>)
            </>
          )}
          .
          {shell === 'powershell' && <> Not in Command Prompt: it would change the % in {percentIn(app, target)}.</>}
          {windows && (
            <>
              {' '}
              To open {shellName(shell)} there, go to that folder in File Explorer, type <Path>{shellProgram(shell)}</Path> in
              the address bar and press Enter.
            </>
          )}
        </p>
      </Note>
      <Note title="Stop Lyren Plan">
        <p>{stopHow(app)} Or run this command; it stops Lyren Plan the same way and waits until it has closed the database:</p>
        <Command label="stop command">{stop}</Command>
      </Note>
      <Note title="Back up from the command line">
        <p>
          Besides <span className="font-medium text-fg">Download backup</span> above, this command writes a backup set, one{' '}
          <Path>.tar</Path> file with the accounts and every space. It is safe while Lyren Plan is running and never
          overwrites a file:
        </p>
        <Command label="backup command">{backup}</Command>
        {windows && exeFolder !== null && (
          <>
            <p>
              To back up every day, create a task in Windows Task Scheduler: <span className="text-fg">Create Basic Task</span>,{' '}
              <span className="text-fg">Daily</span>, <span className="text-fg">Start a program</span>, with{' '}
              <Path>powershell.exe</Path> as the program and these arguments. Each run writes a file named after the day:
            </p>
            <Command label="Task Scheduler arguments">{scheduledBackupArguments(inFolder(exeFolder, exe, true), target)}</Command>
          </>
        )}
      </Note>
      <Note title="Restore a backup">
        <p>
          The restore command takes a backup set, or one space’s snapshot from <Path>{`${backups}spaces${sep}`}</Path> to undo
          an import. Lyren Plan completes the restore when it starts the next time, after moving the current data to{' '}
          <Path>{`${backups}before-restore-<time>`}</Path>.
        </p>
        <ol className="list-decimal pl-5">
          <li>
            Run the restore command:
            <Command label="restore command">{restore}</Command>
          </li>
          <li>{stopStep(app)}</li>
          <li>Start Lyren Plan again.</li>
        </ol>
      </Note>
      <Note title="Forgot your password?">
        <p>
          This command takes the account’s email address (or the username of an account from before email addresses). It
          prints a new random password, signs you out everywhere and clears any lock-out from failed sign-ins:
        </p>
        <Command label="reset-password command">{reset}</Command>
      </Note>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card content
// ---------------------------------------------------------------------------

export interface SelfHostingNotesProps {
  /** The signed-in user, for the reset-password example. */
  username: string;
  /** InstanceInfoDTO.mail: the mail transport delivers mail. */
  mail?: boolean;
  /** BootstrapDTO.desktop: set only by the single-file desktop app. */
  desktop: DesktopDataDTO | undefined;
  /** Today's local date (YYYY-MM-DD), for the backup file name. */
  today: string;
}

/** The card's title for the distribution that serves this client. */
export function selfHostingTitle(desktop: DesktopDataDTO | undefined): string {
  return desktop ? 'Data folder and commands' : 'Self-hosting notes';
}

export function SelfHostingNotes({ username, mail = false, desktop, today }: SelfHostingNotesProps) {
  return desktop ? <DesktopNotes username={username} app={desktop} today={today} /> : <ServerNotes username={username} mail={mail} />;
}
