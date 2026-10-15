// Settings → Data: where the data lives, command-line backups, restoring and password resets, for
// the distribution that serves this client. The Node build and Docker get the self-hosting notes;
// the single-file desktop app (BootstrapDTO.desktop) gets its data folder and its own commands
// instead, with no Docker, cron or `node dist/server.mjs`.

import { Check, Copy } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { DesktopDataDTO } from '@shared/types';
import { IconButton, toast } from '../../components/ui';
import {
  commandShell,
  desktopCommand,
  lockoutText,
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

function ServerNotes({ username }: { username: string }) {
  return (
    <div className="flex flex-col gap-5">
      <Note title="Where your data lives">
        <p>
          Everything is stored in <Path>lyren.db</Path> in the server’s data directory: <Path>DATA_DIR</Path> (default{' '}
          <Path>./data</Path>, <Path>/data</Path> in Docker). Safety snapshots taken before imports and upgrades are kept in{' '}
          <Path>DATA_DIR/backups/</Path>: the newest 10 of each kind (set <Path>SNAPSHOT_KEEP</Path> to change that, 0 keeps
          all). Copy or rename one to keep it; your own backups there are never deleted.
        </p>
      </Note>
      <Note title="Scheduled backups">
        <p>The backup command is safe while the server is running. For example, nightly from cron with Docker:</p>
        <Command label="cron line">{`0 3 * * * docker exec lyren-plan node dist/server.mjs backup /data/backups/lyren-$(date +\\%F).db`}</Command>
        <p>Without Docker, run it from the app directory with the server’s data directory:</p>
        <Command label="backup command">{'DATA_DIR=/path/to/data node dist/server.mjs backup /path/to/backups/lyren-$(date +%F).db'}</Command>
      </Note>
      <Note title="Restore a backup">
        <ol className="list-decimal pl-5">
          <li>Stop the server.</li>
          <li>
            Replace <Path>lyren.db</Path> in the data directory with the backup file.
          </li>
          <li>
            Delete <Path>lyren.db-wal</Path> and <Path>lyren.db-shm</Path> if they exist.
          </li>
          <li>Start the server again.</li>
        </ol>
      </Note>
      <Note title="Forgot your password?">
        <p>Run this on the server; it prints a new random password and signs you out everywhere:</p>
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
    `($env:USERPROFILE + '\\Documents\\Lyren Plan backups\\lyren-' + (Get-Date -Format yyyy-MM-dd) + '.db')` +
    `${option ? ` ${option.name} ${psLiteral(ps51ArgText(option.value))}` : ''}"`
  );
}

/** The backup file of the command's example, for `shell`: in the user's Documents folder, named after `today`. */
export function backupFileArg(shell: CommandShell, today: string): string {
  const name = `Lyren Plan backups\\lyren-${today}.db`;
  if (shell === 'cmd') return `"%USERPROFILE%\\Documents\\${name}"`;
  // PowerShell expands $env:USERPROFILE in a double-quoted string (and nothing in the rest of it).
  if (shell === 'powershell') return `"$env:USERPROFILE\\Documents\\${name}"`;
  return `~/lyren-${today}.db`;
}

/** Why the commands are for PowerShell: what has the % that Command Prompt would change. */
function percentIn(app: DesktopDataDTO, target: CommandTarget): string {
  if (app.exe.includes('%')) return 'the name of the program';
  return target.dbPath !== null ? 'the path of the database' : 'the path of the data folder';
}

/** The last part of a path (Windows: after a backslash or a slash). */
const fileName = (file: string, windows: boolean) => file.split(windows ? /[\\/]/ : '/').pop() || file;

/** Joins a folder and a file name with the separator the folder uses. */
const inFolder = (folder: string, name: string, windows: boolean) => {
  const sep = windows ? '\\' : '/';
  return folder.endsWith(sep) ? folder + name : folder + sep + name;
};

function DesktopNotes({ username, app, today }: { username: string; app: DesktopDataDTO; today: string }) {
  const { windows, exe, exeFolder, dbPath } = app;
  // The commands open lyren.db in the default data folder unless told otherwise: a command prompt
  // opened later knows nothing of the DATA_DIR or DB_PATH this copy was started with.
  const target: CommandTarget = { dataDir: app.customDataDir ? app.dataDir : null, dbPath };
  // Command Prompt, or PowerShell when Command Prompt would change a command (a % in it).
  const shell = commandShell(app, target);
  const backup = desktopCommand(app, `backup ${backupFileArg(shell, today)}`, target);
  const reset = desktopCommand(app, `reset-password ${username}`, target);
  const stop = desktopCommand(app, 'stop', target);
  // The file a restore replaces, and its write-ahead log files.
  const dbName = dbPath === null ? 'lyren.db' : fileName(dbPath, windows);
  return (
    <div className="flex flex-col gap-5">
      <Note title="Where your data lives">
        <p>Everything is stored in this folder on the computer that runs Lyren Plan:</p>
        <Command label="data folder">{app.dataDir}</Command>
        <p>
          {dbPath === null ? (
            <>
              The database is <Path>lyren.db</Path>. Safety snapshots taken before imports and upgrades are kept in the{' '}
              <Path>backups</Path> subfolder: the newest 10 of each kind.
            </>
          ) : (
            <>
              The database is <Path>{dbPath}</Path> (set with <Path>DB_PATH</Path>). Safety snapshots taken before imports
              are kept in the <Path>backups</Path> subfolder, those taken before upgrades in a <Path>backups</Path> folder
              next to the database: the newest 10 of each kind.
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
          Besides <span className="font-medium text-fg">Download backup</span> above, this command writes a backup. It is safe
          while Lyren Plan is running and never overwrites a file:
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
        <ol className="list-decimal pl-5">
          <li>{stopStep(app)}</li>
          <li>
            {dbPath === null ? (
              <>
                Replace <Path>lyren.db</Path> in the data folder with the backup file (rename the backup to{' '}
                <Path>lyren.db</Path>).
              </>
            ) : (
              <>
                Replace <Path>{dbPath}</Path> with the backup file (rename the backup to <Path>{dbName}</Path>).
              </>
            )}
          </li>
          <li>
            Delete <Path>{`${dbName}-wal`}</Path> and <Path>{`${dbName}-shm`}</Path>
            {dbPath === null ? '' : ' next to it'} if they exist.
          </li>
          <li>Start Lyren Plan again.</li>
        </ol>
      </Note>
      <Note title="Forgot your password?">
        <p>This command prints a new random password and signs you out everywhere:</p>
        <Command label="reset-password command">{reset}</Command>
        <p>{lockoutText(app)}</p>
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
  /** BootstrapDTO.desktop: set only by the single-file desktop app. */
  desktop: DesktopDataDTO | undefined;
  /** Today's local date (YYYY-MM-DD), for the backup file name. */
  today: string;
}

/** The card's title for the distribution that serves this client. */
export function selfHostingTitle(desktop: DesktopDataDTO | undefined): string {
  return desktop ? 'Data folder and commands' : 'Self-hosting notes';
}

export function SelfHostingNotes({ username, desktop, today }: SelfHostingNotesProps) {
  return desktop ? <DesktopNotes username={username} app={desktop} today={today} /> : <ServerNotes username={username} />;
}
