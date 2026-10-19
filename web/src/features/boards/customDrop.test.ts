import { describe, expect, it } from 'vitest';
import { buildFilterContext } from '@shared/filter';
import type { TagDTO } from '@shared/types';
import { buildLookups } from '../../api/bootstrap';
import { epic, project, status } from '../../components/domain/fixtures.test-utils';
import { dropPatchFromMatch, dropPatchWarnings } from './customDrop';

const tag = (id: number, name: string): TagDTO => ({ id, name, color: '#000000', taskCount: 0, createdAt: '' });
const statuses = [status(1, 'unstarted', 0), status(2, 'started', 1), status(3, 'started', 2), status(4, 'completed', 3)];
const projects = [project(1, 'WEB'), project(2, 'ME')];
const lookups = buildLookups({
  user: { id: 1, displayName: 'O' },
  space: { id: '7k2m9q4w8x1c3v5b', name: 'Space', role: 'owner' },
  people: [],
  settings: { estimateUnit: 'points', defaultBoardId: null },
  version: 't',
  statuses,
  tags: [tag(10, 'bug'), tag(11, 'idea')],
  projects,
  milestones: [],
  epics: [epic(20, 1, null), epic(21, 2, null)],
  boards: [],
});
const fctx = buildFilterContext({ statuses, projects, today: '2026-10-14', weekStartsOn: 1 });
const ctx = { lookups, fctx };

describe('dropPatchFromMatch', () => {
  it('pins single values', () => {
    expect(dropPatchFromMatch({ statusIds: [2] }, lookups)).toEqual({ statusId: 2 });
    expect(dropPatchFromMatch({ statusIds: [2, 3] }, lookups)).toEqual({});
    expect(dropPatchFromMatch({ statusCategories: ['started'] }, lookups)).toEqual({ statusId: 2 });
    expect(dropPatchFromMatch({ priorities: [4] }, lookups)).toEqual({ priority: 4 });
    expect(dropPatchFromMatch({ priorities: [4, 3] }, lookups)).toEqual({});
    expect(dropPatchFromMatch({ epicIds: [null] }, lookups)).toEqual({ epicId: null });
    expect(dropPatchFromMatch({ epicIds: [20], projectIds: [1] }, lookups)).toEqual({ projectId: 1, epicId: 20 });
    expect(dropPatchFromMatch({ epicIds: [21], projectIds: [1] }, lookups)).toEqual({ projectId: 1 });
    expect(dropPatchFromMatch({ tagIds: [10] }, lookups)).toEqual({ addTagIds: [10] });
    expect(dropPatchFromMatch({ tagIds: [10, 11] }, lookups)).toEqual({});
    expect(dropPatchFromMatch({ tagIds: [10, 11, null], tagMode: 'all' }, lookups)).toEqual({ addTagIds: [10, 11] });
    expect(dropPatchFromMatch({ due: ['tomorrow'] }, lookups)).toEqual({ due: 'tomorrow' });
    expect(dropPatchFromMatch({ due: ['no_date'] }, lookups)).toEqual({ due: 'clear' });
    expect(dropPatchFromMatch({ due: ['overdue'] }, lookups)).toEqual({});
    expect(dropPatchFromMatch({ archived: 'only' }, lookups)).toEqual({ archived: true });
  });
});

describe('dropPatchWarnings', () => {
  it('is quiet when the drop lands the task in the group', () => {
    expect(dropPatchWarnings({ priorities: [4, 3] }, { priority: 4 }, ctx)).toEqual([]);
    expect(dropPatchWarnings({ statusCategories: ['started'] }, { statusId: 3 }, ctx)).toEqual([]);
    expect(dropPatchWarnings({ tagIds: [10, 11] }, { addTagIds: [11] }, ctx)).toEqual([]);
    expect(dropPatchWarnings({ due: ['this_week'] }, { due: 'today' }, ctx)).toEqual([]);
    expect(dropPatchWarnings({}, {}, ctx)).toEqual([]);
  });

  it('warns about criteria the drop leaves to the task', () => {
    expect(dropPatchWarnings({ priorities: [4] }, {}, ctx)).toEqual([
      'Dropped tasks keep their priority, so they land here only if it already matches.',
    ]);
  });

  it('warns when the drop sets a non-matching value', () => {
    expect(dropPatchWarnings({ statusIds: [2] }, { statusId: 4 }, ctx)).toEqual([
      'The drop sets the status to a value this group doesn’t match.',
    ]);
    expect(dropPatchWarnings({ tagIds: [10, 11], tagMode: 'all' }, { addTagIds: [10] }, ctx)).toHaveLength(1);
    expect(dropPatchWarnings({ excludeTagIds: [10] }, { addTagIds: [10] }, ctx)).toHaveLength(1);
    expect(dropPatchWarnings({ due: ['overdue'] }, { due: 'today' }, ctx)).toHaveLength(1);
    expect(dropPatchWarnings({ statusCategories: ['started'], closedWithinDays: 0 }, { statusId: 4 }, ctx)).toHaveLength(1);
    expect(dropPatchWarnings({ search: 'x' }, {}, ctx)).toEqual(['A drop can’t make a task match the search text.']);
  });
});
