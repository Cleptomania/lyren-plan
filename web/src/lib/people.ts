// How the people a space's content names are shown (design §12.9): the author of a comment or work
// log, the creator of a task. Everyone the content can name is in BootstrapDTO.people (the space's
// users mirror, §3.5): members, former members, placeholders an import kept by name, and deleted
// accounts. Entries an import (or a reassignment) attributed to someone carry "Imported by <importer> on
// <date>" (§8.6), and what moving entries between people moved is said in one sentence. Pure, so the labels
// are unit-tested (people.test.ts).

import type { PeopleReassignedDTO, PersonDTO, UserRef } from '@shared/types';
import { formatDate, isoToLocalDate } from './format';

export type PersonNote = '(former member)' | '(deleted account)';

export interface PersonLabel {
  name: string;
  /** Shown after the name, muted; null for a current member. */
  note: PersonNote | null;
  /** No account behind the name any more (shown muted). */
  gone: boolean;
}

type People = ReadonlyMap<number, Pick<PersonDTO, 'displayName' | 'isMember' | 'deleted'>>;

/**
 * The label of an author or creator: a current member by name; someone who left the space (or a
 * placeholder an import kept by name) with "(former member)"; a deleted account with "(deleted
 * account)". A row without anyone (an account deleted before spaces, whose rows lost their author)
 * reads "Deleted account".
 */
export function personLabel(ref: UserRef | null | undefined, people: People): PersonLabel {
  if (!ref) return { name: 'Deleted account', note: null, gone: true };
  const person = people.get(ref.id);
  const name = ref.displayName || person?.displayName || 'Unknown user';
  if (person?.deleted) return { name, note: '(deleted account)', gone: true };
  if (person && !person.isMember) return { name, note: '(former member)', gone: false };
  return { name, note: null, gone: false };
}

/** The label as one string ("Dana (former member)"). */
export function personText(ref: UserRef | null | undefined, people: People): string {
  const label = personLabel(ref, people);
  return label.note ? `${label.name} ${label.note}` : label.name;
}

/** A task's creator by id (TaskDTO.createdBy): its name from the people list, or null when unknown. */
export function creatorText(createdBy: number | null, people: People): string | null {
  if (createdBy === null) return null;
  const person = people.get(createdBy);
  if (!person) return null;
  return personText({ id: createdBy, displayName: person.displayName }, people);
}

/** A comment's, work log's or activity entry's provenance (design §8.6): who imported it under its author's name, and when. */
export interface Provenance {
  importedBy: UserRef | null;
  importedAt: string | null;
}

/**
 * "Imported by Alice on Oct 12" for an entry an import or a reassignment attributed to its author ("by you" for
 * the viewer's own; "Imported on …" once the importer's account is gone); null for an entry written here.
 */
export function importedText(entry: Provenance, viewerId: number, today?: string): string | null {
  if (entry.importedAt === null) return null;
  const date = formatDate(isoToLocalDate(entry.importedAt), today);
  if (entry.importedBy === null) return `Imported on ${date}`;
  return `Imported by ${entry.importedBy.id === viewerId ? 'you' : entry.importedBy.displayName} on ${date}`;
}

/** An imported entry the viewer may give up (disown, §8.6): attributed to them by someone's import. */
export function canDisown(entry: Provenance & { author: UserRef | null }, viewerId: number): boolean {
  return entry.importedAt !== null && entry.author?.id === viewerId;
}

/** What a reassignment or a disown moved: "3 tasks, 2 comments and 1 work log" (activity entries counted last). */
export function movedText(counts: Partial<PeopleReassignedDTO['counts']>): string | null {
  const parts = (
    [
      [counts.tasks ?? 0, 'task', 'tasks'],
      [counts.comments ?? 0, 'comment', 'comments'],
      [counts.worklogs ?? 0, 'work log', 'work logs'],
      [counts.activity ?? 0, 'activity entry', 'activity entries'],
    ] as const
  ).flatMap(([n, one, many]) => (n > 0 ? [`${n.toLocaleString('en-US')} ${n === 1 ? one : many}`] : []));
  if (parts.length === 0) return null;
  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}
