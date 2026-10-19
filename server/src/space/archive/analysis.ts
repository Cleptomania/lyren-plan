// What an archive's users are, and where their rows can go (design §8.5): the users that rows reference (with
// how many rows of each kind), the suggestions for each, and the analysis an importer maps them with. A v1
// export has no users: everything becomes the importer's, and the analysis lists none.

import type { ArchiveUserDTO, ImportAnalysisDTO, ImportCandidateDTO, ImportCounts, ImportTarget } from '@shared/types';
import { normalizeEmail } from '@shared/email';
import type { ImportMode } from '@shared/schemas';
import type { ImportArchive, ImportUser } from './validate';
import { formatOf } from './validate';

type References = ArchiveUserDTO['references'];

/**
 * The archive users that rows reference (createdBy, authorId, actorId and importedBy), with the rows of each
 * kind that do (a row that names a user twice counts once), in the order of `users`. Empty for v1.
 */
export function referencedUsers(archive: ImportArchive): Map<number, { user: ImportUser; references: References }> {
  const counts = new Map<number, References>();
  const count = (kind: keyof References, ...refs: Array<number | null | undefined>) => {
    for (const ref of new Set(refs)) {
      if (ref === null || ref === undefined) continue;
      let c = counts.get(ref);
      if (!c) counts.set(ref, (c = { tasks: 0, comments: 0, worklogs: 0, activity: 0 }));
      c[kind] += 1;
    }
  };
  if (archive.version === 2) {
    for (const t of archive.tasks) count('tasks', t.createdBy);
    for (const cm of archive.comments) count('comments', cm.authorId, cm.importedBy);
    for (const w of archive.worklogs) count('worklogs', w.authorId, w.importedBy);
    for (const a of archive.activity) count('activity', a.actorId, a.importedBy);
  }
  const out = new Map<number, { user: ImportUser; references: References }>();
  for (const user of archive.users) {
    const references = counts.get(user.id);
    if (references) out.set(user.id, { user, references });
  }
  return out;
}

/** The normalized addresses of the referenced users, which candidates are matched by. */
export function referencedEmailKeys(archive: ImportArchive): string[] {
  return [...referencedUsers(archive).values()].flatMap(({ user }) => (user.emailKey === null ? [] : [user.emailKey]));
}

/**
 * The suggestion for each referenced user (§8.5): the candidate whose address matches; else the importer when
 * only one user is referenced, or for the user who exported the archive; else a placeholder.
 */
export function suggestTargets(
  archive: ImportArchive,
  candidates: readonly ImportCandidateDTO[],
  importerId: number,
): Array<{ archiveId: number; target: ImportTarget }> {
  const referenced = referencedUsers(archive);
  const byEmail = new Map<string, number>();
  for (const c of candidates) {
    // A candidate's address as the directory keeps it; its normal form is what an archive's key is compared to.
    const key = c.email === null ? null : normalizeKey(c.email);
    if (key !== null && !byEmail.has(key)) byEmail.set(key, c.userId);
  }
  const exportedBy = archive.space?.exportedBy ?? null;
  return [...referenced.values()].map(({ user }) => {
    const matched = user.emailKey === null ? undefined : byEmail.get(user.emailKey);
    const target: ImportTarget =
      matched !== undefined
        ? { kind: 'user', userId: matched }
        : referenced.size === 1 || user.id === exportedBy
          ? { kind: 'user', userId: importerId }
          : { kind: 'placeholder' };
    return { archiveId: user.id, target };
  });
}

/** An address's normalizeEmail key, or null. */
function normalizeKey(address: string): string | null {
  const normalized = normalizeEmail(address);
  return normalized.ok ? normalized.key : null;
}

/** The rows an import writes, per table (activity: none with skipActivity). */
export function importCounts(archive: ImportArchive, o: { skipActivity?: boolean } = {}): ImportCounts {
  return {
    statuses: archive.statuses.length,
    tags: archive.tags.length,
    projects: archive.projects.length,
    milestones: archive.milestones.length,
    epics: archive.epics.length,
    tasks: archive.tasks.length,
    comments: archive.comments.length,
    worklogs: archive.worklogs.length,
    activity: o.skipActivity ? 0 : archive.activity.length,
    boards: archive.boards.length,
  };
}

/** POST …/data/import/analyze's answer. */
export function importAnalysis(o: {
  archive: ImportArchive;
  mode: ImportMode;
  candidates: ImportCandidateDTO[];
  importerId: number;
  estimate: ImportAnalysisDTO['estimate'];
}): ImportAnalysisDTO {
  const { archive } = o;
  return {
    mode: o.mode,
    format: formatOf(archive),
    exportedAt: archive.exportedAt,
    appVersion: archive.appVersion,
    spaceName: archive.space?.name ?? null,
    counts: importCounts(archive),
    users: [...referencedUsers(archive).values()].map(({ user, references }) => ({
      archiveId: user.id,
      displayName: user.displayName,
      email: user.email,
      kind: user.kind,
      references,
    })),
    candidates: o.candidates,
    suggestions: suggestTargets(archive, o.candidates, o.importerId),
    estimate: o.estimate,
  };
}
