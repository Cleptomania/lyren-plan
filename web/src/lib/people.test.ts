// Author and creator labels (design §12.9): members by name, "(former member)", "(deleted account)".
import { describe, expect, it } from 'vitest';
import type { PersonDTO } from '@shared/types';
import { canDisown, creatorText, importedText, movedText, personLabel, personText } from './people';

const person = (id: number, displayName: string, o: Partial<PersonDTO> = {}): [number, PersonDTO] => [
  id,
  { id, displayName, kind: 'account', isMember: true, deleted: false, ...o },
];
const people = new Map([
  person(1, 'Dana'),
  person(2, 'Lee', { isMember: false }),
  person(3, 'Sam', { isMember: false, deleted: true }),
  person(-4, 'Old Pat', { kind: 'placeholder', isMember: false }),
]);

describe('personLabel', () => {
  it('a member by name, without a note', () => {
    expect(personLabel({ id: 1, displayName: 'Dana' }, people)).toEqual({ name: 'Dana', note: null, gone: false });
  });

  it('someone who left, and a name an import kept, as former members', () => {
    expect(personLabel({ id: 2, displayName: 'Lee' }, people)).toEqual({ name: 'Lee', note: '(former member)', gone: false });
    expect(personLabel({ id: -4, displayName: 'Old Pat' }, people)).toEqual({ name: 'Old Pat', note: '(former member)', gone: false });
  });

  it('a deleted account', () => {
    expect(personLabel({ id: 3, displayName: 'Sam' }, people)).toEqual({ name: 'Sam', note: '(deleted account)', gone: true });
  });

  it('a row that lost its author, and someone the list does not know', () => {
    expect(personLabel(null, people)).toEqual({ name: 'Deleted account', note: null, gone: true });
    expect(personLabel({ id: 9, displayName: 'Ren' }, people)).toEqual({ name: 'Ren', note: null, gone: false });
  });

  it('personText joins name and note', () => {
    expect(personText({ id: 2, displayName: 'Lee' }, people)).toBe('Lee (former member)');
    expect(personText({ id: 1, displayName: 'Dana' }, people)).toBe('Dana');
  });
});

describe('creatorText (TaskDetail’s "Created by")', () => {
  it('names any creator the people list knows, with the note', () => {
    expect(creatorText(1, people)).toBe('Dana');
    expect(creatorText(2, people)).toBe('Lee (former member)');
    expect(creatorText(3, people)).toBe('Sam (deleted account)');
  });

  it('says nothing for no creator or an unknown one', () => {
    expect(creatorText(null, people)).toBeNull();
    expect(creatorText(42, people)).toBeNull();
  });
});

describe('imported entries (design §8.6)', () => {
  const at = '2026-10-12T09:00:00.000Z';
  const alice = { id: 5, displayName: 'Alice' };

  it('names the importer and the day, "you" for the viewer, and nothing for an entry written here', () => {
    expect(importedText({ importedBy: alice, importedAt: at }, 1, '2026-10-18')).toBe('Imported by Alice on Oct 12');
    expect(importedText({ importedBy: alice, importedAt: at }, 5, '2026-10-18')).toBe('Imported by you on Oct 12');
    expect(importedText({ importedBy: alice, importedAt: at }, 1, '2027-01-02')).toBe('Imported by Alice on Oct 12, 2026');
    expect(importedText({ importedBy: null, importedAt: at }, 1, '2026-10-18')).toBe('Imported on Oct 12');
    expect(importedText({ importedBy: null, importedAt: null }, 1)).toBeNull();
  });

  it('lets the person an import named give up its entries', () => {
    expect(canDisown({ author: { id: 1, displayName: 'Dana' }, importedBy: alice, importedAt: at }, 1)).toBe(true);
    expect(canDisown({ author: { id: 2, displayName: 'Lee' }, importedBy: alice, importedAt: at }, 1)).toBe(false);
    expect(canDisown({ author: { id: 1, displayName: 'Dana' }, importedBy: null, importedAt: null }, 1)).toBe(false);
  });

  it('says what moved', () => {
    expect(movedText({ tasks: 3, comments: 2, worklogs: 1, activity: 0 })).toBe('3 tasks, 2 comments and 1 work log');
    expect(movedText({ comments: 1 })).toBe('1 comment');
    expect(movedText({ comments: 0, worklogs: 0, activity: 1200 })).toBe('1,200 activity entries');
    expect(movedText({ tasks: 0, comments: 0, worklogs: 0, activity: 0 })).toBeNull();
  });
});
