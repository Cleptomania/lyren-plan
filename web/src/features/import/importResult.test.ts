import { describe, expect, it } from 'vitest';
import { ApiError, ReauthDeclinedError } from '../../api/errors';
import {
  failureTitle,
  IMPORT_INVITES_STATE,
  importFailure,
  importInvitees,
  inviteeNames,
  invitesFromState,
  resultHeadline,
  replaceFailureTitle,
  resultRows,
  undoHint,
} from './importResult';

const counts = { statuses: 6, tags: 2, projects: 1, milestones: 0, epics: 3, tasks: 1200, comments: 4, worklogs: 2, activity: 40, boards: 1 };

describe('importFailure', () => {
  it('lists the problems of a refused file', () => {
    const err = new ApiError(400, 'validation_error', 'Invalid export file (2 problems): tasks.0.title: Required', [
      { path: 'tasks.0.title', message: 'Required' },
      { path: '', message: '…and more problems' },
    ]);
    expect(importFailure(err)).toEqual({
      message: 'Invalid export file (2 problems): tasks.0.title: Required',
      problems: ['tasks.0.title: Required', '…and more problems'],
      retry: false,
    });
  });

  it('keeps the server’s text for limits and refusals, and says when trying again may help', () => {
    expect(importFailure(new ApiError(413, 'payload_too_large', 'The archive is larger than 4 MB unpacked'))).toEqual({
      message: 'The archive is larger than 4 MB unpacked',
      problems: [],
      retry: false,
    });
    expect(importFailure(new ApiError(429, 'rate_limited', "This instance has reached today's import limit. It resets at 00:00 UTC."))).toMatchObject({ retry: true });
    expect(importFailure(new ApiError(503, 'unavailable', 'Another import is running. Try again in a minute.'))).toEqual({
      message: 'Another import is running. Try again in a minute.',
      problems: [],
      retry: true,
    });
    expect(importFailure(new ApiError(0, 'network_error', 'Could not reach the server.'))).toMatchObject({ retry: true });
    // A refusal with details that are no list of problems keeps them out.
    expect(importFailure(new ApiError(409, 'conflict', 'This space has already been imported', [{ path: 'x', message: 'y' }]))).toMatchObject({ problems: [] });
    expect(importFailure(new Error('boom'))).toEqual({ message: 'boom', problems: [], retry: false });
  });

  it('says nothing when the re-auth dialog was closed', () => {
    expect(importFailure(new ReauthDeclinedError(403, 'reauth_required', 'Confirm it’s you to continue'))).toBeNull();
  });
});

describe('the result', () => {
  it('lists the counts in the summary’s order, and says what came in', () => {
    expect(resultRows(counts).map((r) => [r.label, r.count])).toEqual([
      ['Projects', 1],
      ['Milestones', 0],
      ['Epics', 3],
      ['Tasks', 1200],
      ['Comments', 4],
      ['Work logs', 2],
      ['Tags', 2],
      ['Statuses', 6],
      ['Boards', 1],
      ['Activity entries', 40],
    ]);
    expect(resultHeadline(counts)).toBe('Imported 1 project and 1,200 tasks.');
    expect(resultHeadline({ projects: 0, tasks: 1 })).toBe('Imported 0 projects and 1 task.');
  });

  it('names the snapshot and the whole command that undoes a replace on Node', () => {
    const safety = { kind: 'file' as const, path: 'backups/spaces/s1/pre-import-2026.db', restoreCommand: 'restore "backups/spaces/s1/pre-import-2026.db"' };
    const admin = undoHint(safety, { instanceAdmin: true, desktop: false });
    expect(admin).toMatchObject({ path: safety.path, command: `DATA_DIR=/path/to/data node dist/server.mjs ${safety.restoreCommand}` });
    expect(admin.text).toMatch(/^A copy of the previous data was saved as backups\/spaces\/s1\/pre-import-2026\.db, in the folder that holds the database\./);
    expect(admin.text).toMatch(/then restart the server:$/);
    expect(admin.how).toMatch(/With Docker: docker exec lyren-plan node dist\/server\.mjs restore "backups\/spaces\/s1\/pre-import-2026\.db", then docker restart lyren-plan\.$/);
    const owner = undoHint(safety, { instanceAdmin: false, desktop: false });
    expect(owner).toMatchObject({ command: null, how: null });
    expect(owner.text).toMatch(/ask an administrator of this instance to run restore "backups\/spaces\/s1\/pre-import-2026\.db" and restart the server\.$/);
  });

  it('writes the desktop app’s own command, for the data it opened', () => {
    const safety = { kind: 'file' as const, path: 'backups/spaces/s1/pre-import-2026.db', restoreCommand: 'restore "backups/spaces/s1/pre-import-2026.db"' };
    const app = { exe: 'lyren-plan-1.1.0-win-x64.exe', windows: true, dataDir: 'D:\\Lyren', dbPath: null, customDataDir: true, exeFolder: 'C:\\Apps' };
    const desktop = undoHint(safety, { instanceAdmin: true, desktop: true, desktopData: app });
    expect(desktop.text).toMatch(/then quit Lyren Plan and start it again:$/);
    expect(desktop.command).toBe('"lyren-plan-1.1.0-win-x64.exe" restore "backups/spaces/s1/pre-import-2026.db" --data-dir "D:\\Lyren"');
    expect(desktop.how).toBe('In Command Prompt, in the folder that holds the program (C:\\Apps).');
    const linux = undoHint(safety, { instanceAdmin: true, desktop: true, desktopData: { ...app, windows: false, exe: 'lyren-plan-1.1.0-linux-x64', customDataDir: false } });
    expect(linux.command).toBe("./lyren-plan-1.1.0-linux-x64 restore backups/spaces/s1/pre-import-2026.db");
  });

  it('points to the downloaded archive where there is no snapshot (Cloudflare)', () => {
    expect(undoHint(null, { instanceAdmin: true, desktop: false })).toEqual({
      path: null,
      command: null,
      text: expect.stringMatching(/the archive you downloaded before replacing is the way back/),
      how: null,
    });
  });

  it('says what a refused import left: nothing, or the space that waits for an archive', () => {
    expect(failureTitle(null, { retry: false })).toBe('The archive was not imported. Nothing was changed.');
    expect(failureTitle('Team space', { retry: false })).toBe('Nothing was imported. Team space waits for an archive: try another file, or discard it.');
    // A 503 may follow a commit that was saved but not completed: the space waits all the same.
    expect(failureTitle('Team space', { retry: true })).toBe('Team space still waits for its archive.');
    expect(replaceFailureTitle({ retry: false }, true)).toBe('Nothing was changed.');
    expect(replaceFailureTitle({ retry: true }, false)).toBe('Nothing was changed.');
    expect(replaceFailureTitle({ retry: true }, true)).toBe('The replace did not finish.');
  });
});

describe('inviting the people who are not members', () => {
  const authors = [
    { userId: 4, displayName: 'Alice', email: 'alice@example.com', isYou: false },
    { userId: 6, displayName: 'Legacy', email: null, isYou: false },
  ];

  it('hands the names and addresses on, and reads them back from the router state', () => {
    const invitees = importInvitees(authors);
    expect(invitees).toEqual([
      { displayName: 'Alice', email: 'alice@example.com' },
      { displayName: 'Legacy', email: null },
    ]);
    expect(invitesFromState({ [IMPORT_INVITES_STATE]: invitees })).toEqual(invitees);
  });

  it('reads nothing else from the state', () => {
    expect(invitesFromState(null)).toEqual([]);
    expect(invitesFromState({ [IMPORT_INVITES_STATE]: 'x' })).toEqual([]);
    expect(invitesFromState({ [IMPORT_INVITES_STATE]: [{ displayName: 1 }, null, { displayName: 'B', email: 2 }, { displayName: 'C', email: null }] })).toEqual([
      { displayName: 'C', email: null },
    ]);
  });

  it('names a few, then counts the rest', () => {
    const p = (displayName: string) => ({ displayName, email: null });
    expect(inviteeNames([p('A')])).toBe('A');
    expect(inviteeNames([p('A'), p('B')])).toBe('A and B');
    expect(inviteeNames([p('A'), p('B'), p('C')])).toBe('A, B and C');
    expect(inviteeNames([p('A'), p('B'), p('C'), p('D'), p('E')])).toBe('A, B, C and 2 more');
  });
});
