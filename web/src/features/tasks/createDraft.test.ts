import { describe, expect, it } from 'vitest';
import { taskCreateInput } from '@shared/schemas';
import {
  defaultProjectId,
  draftHasContent,
  draftToInput,
  initialDraft,
  parseStoredDraft,
  sanitizeDraft,
  withProject,
  type CreateDraft,
  type DraftLookups,
} from './createDraft';

const lookups: DraftLookups = {
  projects: [
    { id: 1, status: 'archived' },
    { id: 2, status: 'active' },
    { id: 3, status: 'on_hold' },
  ],
  epicById: new Map([
    [10, { id: 10, projectId: 2 }],
    [11, { id: 11, projectId: 3 }],
  ]),
  defaultStatusId: 5,
};

describe('defaultProjectId', () => {
  it('prefers the prefill, then the last used project, then the first active one', () => {
    expect(defaultProjectId(3, 2, lookups.projects)).toBe(3);
    expect(defaultProjectId(undefined, 3, lookups.projects)).toBe(3);
    expect(defaultProjectId(undefined, 99, lookups.projects)).toBe(2);
    expect(defaultProjectId(undefined, 1, lookups.projects)).toBe(2); // archived last-used is skipped
    expect(defaultProjectId(1, null, lookups.projects)).toBe(1); // explicit prefill of an archived project
    expect(defaultProjectId(99, null, lookups.projects)).toBe(2);
    expect(defaultProjectId(undefined, null, [])).toBeNull();
  });
});

describe('initialDraft', () => {
  it('applies the prefill', () => {
    const d = initialDraft({ projectId: 2, epicId: 10, statusId: 7, priority: 3, dueDate: '2026-10-20', tagIds: [4, 4] }, lookups, null);
    expect(d).toEqual({
      title: '',
      description: '',
      projectId: 2,
      epicId: 10,
      statusId: 7,
      priority: 3,
      tagIds: [4],
      startDate: null,
      dueDate: '2026-10-20',
      estimate: null,
    });
  });

  it('derives the project from the epic and drops mismatching epics', () => {
    expect(initialDraft({ epicId: 11 }, lookups, null)).toMatchObject({ projectId: 3, epicId: 11, statusId: 5 });
    expect(initialDraft({ projectId: 2, epicId: 11 }, lookups, null)).toMatchObject({ projectId: 2, epicId: null });
    expect(initialDraft({}, lookups, 3)).toMatchObject({ projectId: 3 });
  });
});

describe('editing', () => {
  const base = initialDraft({ projectId: 2, epicId: 10 }, lookups, null);
  it('keeps the epic only within its project', () => {
    expect(withProject(base, 3, lookups.epicById)).toMatchObject({ projectId: 3, epicId: null });
    expect(withProject(base, 2, lookups.epicById)).toMatchObject({ projectId: 2, epicId: 10 });
  });

  it('detects typed content', () => {
    expect(draftHasContent(base)).toBe(false);
    expect(draftHasContent({ ...base, title: '  ' })).toBe(false);
    expect(draftHasContent({ ...base, description: 'x' })).toBe(true);
  });

  it('builds a valid API input', () => {
    const draft: CreateDraft = { ...base, title: '  Fix\n  the bug ', description: 'Body\n\n', tagIds: [1], estimate: 2 };
    const input = draftToInput(draft, { position: 'top' });
    expect(input).toEqual({
      title: 'Fix the bug',
      priority: 0,
      projectId: 2,
      epicId: 10,
      statusId: 5,
      description: 'Body',
      tagIds: [1],
      estimate: 2,
      position: 'top',
    });
    expect(taskCreateInput.safeParse(input).success).toBe(true);
    expect(taskCreateInput.safeParse(draftToInput({ ...draft, projectId: null }, {})).success).toBe(false);
  });
});

describe('stored drafts', () => {
  const draft = initialDraft({ projectId: 2, epicId: 10 }, lookups, null);
  it('round-trips through JSON and rejects malformed values', () => {
    expect(parseStoredDraft(JSON.parse(JSON.stringify({ ...draft, title: 'x' })))).toEqual({ ...draft, title: 'x' });
    expect(parseStoredDraft(null)).toBeNull();
    expect(parseStoredDraft('x')).toBeNull();
    expect(parseStoredDraft({ ...draft, priority: 9 })).toBeNull();
    expect(parseStoredDraft({ ...draft, tagIds: ['a'] })).toBeNull();
    expect(parseStoredDraft({ ...draft, dueDate: '2026-13-01' })).toBeNull();
    expect(parseStoredDraft({ ...draft, projectId: -1 })).toBeNull();
  });

  it('drops references to deleted entities', () => {
    const stale: CreateDraft = { ...draft, projectId: 99, epicId: 10, statusId: 42, tagIds: [1, 2] };
    const clean = sanitizeDraft(stale, { ...lookups, statusIds: new Set([5]), tagIds: new Set([2]) }, null);
    expect(clean).toMatchObject({ projectId: 2, epicId: 10, statusId: 5, tagIds: [2] });
  });
});
