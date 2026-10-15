import { describe, expect, it } from 'vitest';
import type { StatusCategory } from '@shared/constants';
import type { StatusDTO } from '@shared/types';
import { checkImportFile } from './importFile';
import { passwordStrength } from './passwordStrength';
import {
  displayOrder,
  groupStatuses,
  needsNormalizing,
  orderAfterMove,
  orderAfterStep,
  storedOrder,
  suggestedReassignTarget,
  withPositions,
} from './statusOrder';
import { describeUserAgent } from './userAgent';

describe('describeUserAgent', () => {
  const cases: Array<[string, string, string]> = [
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
      'Chrome on Windows',
      'desktop',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0',
      'Edge on Windows',
      'desktop',
    ],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15', 'Safari on macOS', 'desktop'],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0', 'Firefox on Linux', 'desktop'],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
      'Safari on iOS',
      'mobile',
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0 Mobile/15E148 Safari/604.1',
      'Chrome on iOS',
      'mobile',
    ],
    ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36', 'Chrome on Android', 'mobile'],
    ['Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36', 'Chrome on Android', 'tablet'],
    [
      'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
      'Safari on iPadOS',
      'tablet',
    ],
    ['Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0 Mobile Safari/537.36', 'Samsung Internet on Android', 'mobile'],
    ['curl/8.5.0', 'curl', 'desktop'],
  ];
  it.each(cases)('%s', (ua, label, kind) => {
    expect(describeUserAgent(ua)).toMatchObject({ label, kind });
  });

  it('handles missing and unknown agents', () => {
    expect(describeUserAgent(null).label).toBe('Unknown device');
    expect(describeUserAgent('').label).toBe('Unknown device');
    expect(describeUserAgent('SomeBot/1.0').label).toBe('Unknown device');
  });
});

describe('passwordStrength', () => {
  it('requires the minimum length', () => {
    expect(passwordStrength('')).toMatchObject({ score: 0, label: '' });
    expect(passwordStrength('abc12')).toMatchObject({ score: 0, label: 'Too short' });
  });
  it('rewards length and variety', () => {
    expect(passwordStrength('mxkqvbtz').label).toBe('Weak');
    expect(passwordStrength('mxkqvbtzwplr').label).toBe('Fair');
    expect(passwordStrength('Mxkq-vbtz-wp1r').label).toBe('Good');
    expect(passwordStrength('orbit cactus lantern plum').label).toBe('Strong');
  });
  it('penalises common words and patterns', () => {
    expect(passwordStrength('password1234567890').score).toBe(1);
    expect(passwordStrength('abcdefghij').score).toBe(1);
    expect(passwordStrength('aaaaaaaaaaaaaaaaaaaaaa').score).toBe(1);
    expect(passwordStrength('87654321').score).toBe(1);
  });
});

function status(id: number, category: StatusCategory, position: number): StatusDTO {
  return { id, name: `S${id}`, category, color: '#64748b', position, taskCount: 0 };
}

describe('statusOrder', () => {
  // Stored order interleaves categories: 3 (started) sits before 2 (unstarted).
  const statuses = [
    status(1, 'backlog', 0),
    status(3, 'started', 1),
    status(2, 'unstarted', 2),
    status(4, 'started', 3),
    status(5, 'completed', 4),
    status(6, 'cancelled', 5),
    status(7, 'started', 6),
  ];

  it('groups by category in the fixed order, each by position', () => {
    const groups = groupStatuses(statuses);
    expect(groups.map((g) => [g.category, g.statuses.map((s) => s.id)])).toEqual([
      ['backlog', [1]],
      ['unstarted', [2]],
      ['started', [3, 4, 7]],
      ['completed', [5]],
      ['cancelled', [6]],
    ]);
    expect(groupStatuses([status(1, 'started', 0)]).map((g) => g.statuses.length)).toEqual([0, 0, 1, 0, 0]);
  });

  it('compares display and stored order', () => {
    expect(displayOrder(statuses)).toEqual([1, 2, 3, 4, 7, 5, 6]);
    expect(storedOrder(statuses)).toEqual([1, 3, 2, 4, 5, 6, 7]);
    expect(needsNormalizing(statuses)).toBe(true);
    expect(needsNormalizing(withPositions(statuses, displayOrder(statuses)))).toBe(false);
  });

  it('moves within a group only and always returns the full display order', () => {
    expect(orderAfterMove(statuses, 7, 3)).toEqual([1, 2, 7, 3, 4, 5, 6]);
    expect(orderAfterMove(statuses, 3, 7)).toEqual([1, 2, 4, 7, 3, 5, 6]);
    expect(orderAfterMove(statuses, 3, 2)).toBeNull();
    expect(orderAfterMove(statuses, 3, 3)).toBeNull();
    expect(orderAfterMove(statuses, 99, 3)).toBeNull();
  });

  it('steps up and down inside the group', () => {
    expect(orderAfterStep(statuses, 4, -1)).toEqual([1, 2, 4, 3, 7, 5, 6]);
    expect(orderAfterStep(statuses, 4, 1)).toEqual([1, 2, 3, 7, 4, 5, 6]);
    expect(orderAfterStep(statuses, 3, -1)).toBeNull();
    expect(orderAfterStep(statuses, 7, 1)).toBeNull();
    expect(orderAfterStep(statuses, 2, 1)).toBeNull();
  });

  it('suggests a sibling, else an unstarted status, else any other', () => {
    expect(suggestedReassignTarget(statuses, 4)?.id).toBe(3);
    expect(suggestedReassignTarget(statuses, 5)?.id).toBe(2);
    expect(suggestedReassignTarget([status(1, 'completed', 0), status(2, 'cancelled', 1)], 1)?.id).toBe(2);
    expect(suggestedReassignTarget([status(1, 'completed', 0)], 1)).toBeUndefined();
  });
});

describe('checkImportFile', () => {
  const minimal = {
    format: 'lyren-plan-export',
    formatVersion: 1,
    exportedAt: '2026-01-01T00:00:00.000Z',
    appVersion: '1.0.0',
    settings: { weekStartsOn: 1, estimateUnit: 'points', defaultBoardId: null, homePage: 'dashboard' },
    statuses: [{ id: 1, name: 'Todo', category: 'unstarted', color: '#64748b', position: 0 }],
    tags: [],
    projects: [],
    milestones: [],
    epics: [],
    tasks: [],
    comments: [],
    worklogs: [],
    activity: [],
    boards: [],
  };

  it('summarises a valid export and keeps the raw payload', () => {
    const res = checkImportFile(JSON.stringify(minimal));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.payload).toEqual(minimal);
    expect(res.summary.appVersion).toBe('1.0.0');
    expect(res.summary.counts.find((c) => c.key === 'statuses')?.count).toBe(1);
    expect(res.summary.counts.find((c) => c.key === 'tasks')?.count).toBe(0);
  });

  it('explains what is wrong', () => {
    expect(checkImportFile('{nope')).toMatchObject({ ok: false, error: expect.stringMatching(/not valid JSON/) });
    expect(checkImportFile('[]')).toMatchObject({ ok: false, error: expect.stringMatching(/not a Lyren Plan export/) });
    expect(checkImportFile(JSON.stringify({ ...minimal, formatVersion: 2 }))).toMatchObject({
      ok: false,
      error: expect.stringMatching(/version 2/),
    });
    const bad = checkImportFile(JSON.stringify({ ...minimal, statuses: [], tags: [{ id: 'x' }] }));
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.problems.length).toBeGreaterThan(1);
    expect(bad.problems.some((p) => p.startsWith('statuses'))).toBe(true);
  });
});
