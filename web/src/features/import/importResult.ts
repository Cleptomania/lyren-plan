// What an import's steps say (design §8.4, §8.8, §12.10, §12.11): a refused analysis or commit with the problems
// the server listed, the result's counts, the way back after a replace (Node's snapshot and the command that
// undoes the import; on Cloudflare the archive downloaded before), and the people rows were mapped to who are
// not members yet, handed to Settings → Invitations as prefilled forms (through the router's state). Pure, so it
// is unit-tested (importResult.test.ts).

import type { DesktopDataDTO, ImportCandidateDTO, ImportCounts, SafetyPointDTO } from '@shared/types';
import { ApiError, errorMessage, isReauthDeclined } from '../../api/errors';
import { commandShell, dataTarget, desktopCommand, shellArg, shellName } from '../auth/desktopCommands';
import { COUNTED } from './archiveFile';

export interface ImportFailure {
  message: string;
  /** The problems the server listed (a file it refused), "path: message". */
  problems: string[];
  /** Sending it again may work (a limit for now, another import running, the network). */
  retry: boolean;
}

/** How a refused analyze or commit reads; null when there is nothing to say (the re-auth dialog was closed). */
export function importFailure(err: unknown): ImportFailure | null {
  if (isReauthDeclined(err)) return null;
  if (!(err instanceof ApiError)) return { message: errorMessage(err), problems: [], retry: false };
  const problems = err.code === 'validation_error' ? err.details.map((d) => (d.path ? `${d.path}: ${d.message}` : d.message)) : [];
  const retry = err.status === 0 || err.status === 429 || err.status === 503;
  return { message: errorMessage(err), problems, retry };
}

/**
 * The title over a refused analysis or commit into a new space. Until Continue has made the space nothing exists;
 * after, the space does, waiting for an archive (/spaces lists it as "Import not finished"), so the title says so.
 * A refusal to try again later (`retry`) may also follow a commit that was saved but not completed (503): the
 * space still waits then too, and the message says what to do.
 */
export function failureTitle(waitingSpace: string | null, failure: Pick<ImportFailure, 'retry'>): string {
  if (waitingSpace === null) return 'The archive was not imported. Nothing was changed.';
  if (failure.retry) return `${waitingSpace} still waits for its archive.`;
  return `Nothing was imported. ${waitingSpace} waits for an archive: try another file, or discard it.`;
}

/**
 * The title over a refused replace. Its analysis changes nothing, and nor does a refused commit, except one to try
 * again later (`retry`), which may follow a replace that was saved but not completed (503, "Send it again").
 */
export function replaceFailureTitle(failure: Pick<ImportFailure, 'retry'>, committing: boolean): string {
  return committing && failure.retry ? 'The replace did not finish.' : 'Nothing was changed.';
}

const n = (v: number) => v.toLocaleString('en-US');

/** The result's counts, in the order the file summary lists the tables. */
export function resultRows(counts: ImportCounts): Array<{ key: keyof ImportCounts; label: string; count: number }> {
  return COUNTED.map(([key, label]) => ({ key, label, count: counts[key] }));
}

/** "Imported 2 projects and 120 tasks." */
export function resultHeadline(counts: Pick<ImportCounts, 'projects' | 'tasks'>): string {
  const projects = `${n(counts.projects)} ${counts.projects === 1 ? 'project' : 'projects'}`;
  const tasks = `${n(counts.tasks)} ${counts.tasks === 1 ? 'task' : 'tasks'}`;
  return `Imported ${projects} and ${tasks}.`;
}

export interface UndoHint {
  /** The snapshot's path, relative to the folder of the server's database; null where there is none. */
  path: string | null;
  /** The command that undoes the import, to copy (shown to instance admins). */
  command: string | null;
  text: string;
  /** Where and how to run `command`, under its field; null without one. */
  how: string | null;
}

/**
 * The way back after a replace: on Node the snapshot taken before (`safety`) and the command that puts it back,
 * `restore "<path>"` (§8.8) as a whole invocation, which an instance admin runs (then a restart; the desktop app
 * is started again): the desktop app's own program with the data it opened (`desktopData`, which instance admins
 * get), else the Node build's `node dist/server.mjs` with the server's DATA_DIR, and its Docker form. On
 * Cloudflare the archive the owner downloaded first.
 */
export function undoHint(
  safety: SafetyPointDTO | null,
  o: { instanceAdmin: boolean; desktop: boolean; desktopData?: DesktopDataDTO | null },
): UndoHint {
  if (safety === null) {
    return {
      path: null,
      command: null,
      text: 'This instance keeps no copy of the previous data: the archive you downloaded before replacing is the way back (replace the space with it again).',
      how: null,
    };
  }
  const where = `A copy of the previous data was saved as ${safety.path}, in the folder that holds the database.`;
  if (!o.instanceAdmin) {
    return {
      path: safety.path,
      command: null,
      text: `${where} To undo the import, ask an administrator of this instance to run ${safety.restoreCommand} and restart ${o.desktop ? 'Lyren Plan' : 'the server'}.`,
      how: null,
    };
  }
  const restart = o.desktop ? 'then quit Lyren Plan and start it again' : 'then restart the server';
  const text = `${where} To undo the import, run this command, ${restart}:`;
  const app = o.desktopData ?? null;
  if (o.desktop && app !== null) {
    const target = dataTarget(app);
    const shell = commandShell(app, target);
    return {
      path: safety.path,
      command: desktopCommand(app, `restore ${shellArg(safety.path, shell)}`, target),
      text,
      how: `In ${shellName(shell)}, in the folder that holds the program${app.exeFolder === null ? '' : ` (${app.exeFolder})`}.`,
    };
  }
  if (o.desktop) return { path: safety.path, command: safety.restoreCommand, text, how: 'Administration → Overview shows how to run commands.' };
  return {
    path: safety.path,
    command: `DATA_DIR=/path/to/data node dist/server.mjs ${safety.restoreCommand}`,
    text,
    how: `In the app’s folder, with the server’s data directory for /path/to/data, as the user that owns it. With Docker: docker exec lyren-plan node dist/server.mjs ${safety.restoreCommand}, then docker restart lyren-plan.`,
  };
}

// ---- Inviting the people rows were mapped to ----------------------------------------------------

export interface ImportInvitee {
  displayName: string;
  /** Their address here (null for an account without one, from before email addresses). */
  email: string | null;
}

/** The router state key that carries the invitees to Settings → Invitations. */
export const IMPORT_INVITES_STATE = 'importInvites';

/** The result's non-member authors as invitees. */
export function importInvitees(authors: readonly ImportCandidateDTO[]): ImportInvitee[] {
  return authors.map((a) => ({ displayName: a.displayName, email: a.email }));
}

/** "Alice, Bob and Carol" (the first three, then "and 4 more"). */
export function inviteeNames(invitees: readonly ImportInvitee[]): string {
  const names = invitees.map((i) => i.displayName);
  if (names.length <= 3) return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  return `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
}

/** The invitees a page was opened with (router state), checked: anything else gives none. */
export function invitesFromState(state: unknown): ImportInvitee[] {
  const list = (state as Record<string, unknown> | null)?.[IMPORT_INVITES_STATE];
  if (!Array.isArray(list)) return [];
  return list.flatMap((item: unknown) => {
    const { displayName, email } = (item ?? {}) as Record<string, unknown>;
    if (typeof displayName !== 'string' || (email !== null && typeof email !== 'string')) return [];
    return [{ displayName, email }];
  });
}
