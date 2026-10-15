import { describe, expect, it } from 'vitest';
import type { EpicDTO, MilestoneDTO } from '@shared/types';
import {
  buildHierarchy,
  isDueSoon,
  isOverdue,
  moveWithinSubset,
  nextMilestone,
  reorderSubset,
} from './hierarchy';
import { baseProjectKey, normalizeKeyInput, projectKeyError, suggestProjectKey } from './projectKey';

const projects = [
  { id: 1, key: 'WEB', name: 'Website' },
  { id: 2, key: 'WEB2', name: 'Website 2' },
  { id: 3, key: 'ME', name: 'Personal' },
];

describe('project keys', () => {
  it('derives the base key like the server (SPEC §5.1)', () => {
    expect(baseProjectKey('Website')).toBe('WEB');
    expect(baseProjectKey('Lyren plan web app extra')).toBe('LPWA');
    expect(baseProjectKey('42 things')).toBe('P4T');
    expect(baseProjectKey('A')).toBe('AX');
    expect(baseProjectKey('Évènement')).toBe('EVE');
    expect(baseProjectKey('  ')).toBe('');
    expect(baseProjectKey('!!!')).toBe('');
  });

  it('suggests a unique key with a numeric suffix', () => {
    expect(suggestProjectKey('Website', projects)).toBe('WEB3');
    expect(suggestProjectKey('website', [{ id: 9, key: 'web', name: 'x' }])).toBe('WEB2');
    expect(suggestProjectKey('Mobile', projects)).toBe('MOB');
    expect(suggestProjectKey('', projects)).toBe('');
    const long = [{ id: 1, key: 'ABCDEFGHIJ', name: 'x' }];
    expect(baseProjectKey('A b c d')).toBe('ABCD');
    expect(suggestProjectKey('abcdefghij', long)).toBe('ABC');
  });

  it('normalizes typed keys and validates format and uniqueness', () => {
    expect(normalizeKeyInput('we-b 1x!')).toBe('WEB1X');
    expect(normalizeKeyInput('abcdefghijklmn')).toBe('ABCDEFGHIJ');
    expect(projectKeyError('WEB', projects)).toBe('Already used by “Website”');
    expect(projectKeyError('web', projects, 1)).toBeUndefined();
    expect(projectKeyError('NEW', projects)).toBeUndefined();
    expect(projectKeyError('1AB', projects)).toMatch(/start with a letter/);
    expect(projectKeyError('A', projects)).toMatch(/2-10/);
  });
});

const milestone = (id: number, position: number, status: MilestoneDTO['status'] = 'planned'): MilestoneDTO => ({
  id,
  projectId: 1,
  name: `M${id}`,
  description: '',
  status,
  startDate: null,
  dueDate: null,
  position,
  completedAt: null,
  createdAt: '',
  updatedAt: '',
  stats: { tasksTotal: 0, tasksClosed: 0, estimateTotal: 0, estimateClosed: 0, epicsTotal: 0, epicsDone: 0 },
});

const epic = (id: number, position: number, milestoneId: number | null): EpicDTO => ({
  id,
  projectId: 1,
  milestoneId,
  name: `E${id}`,
  description: '',
  color: '#8b5cf6',
  status: 'open',
  startDate: null,
  dueDate: null,
  position,
  completedAt: null,
  createdAt: '',
  updatedAt: '',
  stats: { tasksTotal: 0, tasksClosed: 0, estimateTotal: 0, estimateClosed: 0 },
});

describe('hierarchy', () => {
  it('groups epics under milestones in position order, with loose epics separately', () => {
    const h = buildHierarchy(
      [milestone(10, 1), milestone(11, 0)],
      [epic(1, 3, 10), epic(2, 0, 10), epic(3, 1, null), epic(4, 2, 99), epic(5, 4, 11)],
    );
    expect(h.sections.map((s) => [s.milestone.id, s.epics.map((e) => e.id)])).toEqual([
      [11, [5]],
      [10, [2, 1]],
    ]);
    expect(h.loose.map((e) => e.id)).toEqual([3, 4]);
  });

  it('finds the next open milestone', () => {
    expect(nextMilestone([milestone(1, 0, 'completed'), milestone(2, 2), milestone(3, 1, 'active')])?.id).toBe(3);
    expect(nextMilestone([milestone(1, 0, 'cancelled')])).toBeUndefined();
  });

  it('overdue / due soon ignore closed items and missing dates', () => {
    expect(isOverdue('2026-01-01', false, '2026-01-02')).toBe(true);
    expect(isOverdue('2026-01-02', false, '2026-01-02')).toBe(false);
    expect(isOverdue('2026-01-01', true, '2026-01-02')).toBe(false);
    expect(isOverdue(null, false, '2026-01-02')).toBe(false);
    expect(isDueSoon('2026-01-08', false, '2026-01-02')).toBe(true);
    expect(isDueSoon('2026-01-09', false, '2026-01-02')).toBe(false);
    expect(isDueSoon('2026-01-01', false, '2026-01-02')).toBe(false);
  });
});

describe('reorderSubset', () => {
  const full = [1, 2, 3, 4, 5, 6];

  it('moves within the full list when everything is visible', () => {
    expect(reorderSubset(full, full, 1, 4)).toEqual([2, 3, 4, 1, 5, 6]);
    expect(reorderSubset(full, full, 5, 2)).toEqual([1, 5, 2, 3, 4, 6]);
  });

  it('keeps hidden items in place', () => {
    // visible = 2, 4, 6 (e.g. active projects); hidden 1, 3, 5 stay put
    expect(reorderSubset(full, [2, 4, 6], 6, 2)).toEqual([1, 6, 3, 2, 5, 4]);
    expect(reorderSubset(full, [2, 4, 6], 2, 4)).toEqual([1, 4, 3, 2, 5, 6]);
  });

  it('returns null for no-ops and unknown ids', () => {
    expect(reorderSubset(full, full, 3, 3)).toBeNull();
    expect(reorderSubset(full, [2, 4], 3, 4)).toBeNull();
    expect(reorderSubset(full, [2, 4], 2, 9)).toBeNull();
  });

  it('moves up/down within the subset', () => {
    expect(moveWithinSubset(full, [2, 4, 6], 4, -1)).toEqual([1, 4, 3, 2, 5, 6]);
    expect(moveWithinSubset(full, [2, 4, 6], 4, 1)).toEqual([1, 2, 3, 6, 5, 4]);
    expect(moveWithinSubset(full, [2, 4, 6], 2, -1)).toBeNull();
    expect(moveWithinSubset(full, [2, 4, 6], 6, 1)).toBeNull();
    expect(moveWithinSubset(full, [2, 4, 6], 5, 1)).toBeNull();
  });
});
