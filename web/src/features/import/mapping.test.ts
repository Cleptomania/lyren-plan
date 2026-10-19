import { describe, expect, it } from 'vitest';
import type { ImportAnalysisDTO } from '@shared/types';
import {
  DAILY_LIMIT_TEXT,
  fitText,
  importFit,
  initialChoices,
  mappingInput,
  mappingReducer,
  PLACEHOLDER_LABEL,
  referencesText,
  replaceReady,
  targetKey,
  targetOfKey,
  targetOptions,
  targetText,
  unmappedUsers,
} from './mapping';

const refs = (tasks = 0, comments = 0, worklogs = 0, activity = 0) => ({ tasks, comments, worklogs, activity });

const analysis: ImportAnalysisDTO = {
  mode: 'new',
  format: 'lyren-plan-space/2',
  exportedAt: '2026-10-18T12:00:00.000Z',
  appVersion: '1.1.0',
  spaceName: 'Team space',
  counts: { statuses: 6, tags: 2, projects: 1, milestones: 0, epics: 0, tasks: 12, comments: 4, worklogs: 2, activity: 40, boards: 1 },
  users: [
    { archiveId: 3, displayName: 'Alice', email: 'alice@example.com', kind: 'account', references: refs(10, 2, 2, 30) },
    { archiveId: 9, displayName: 'Bob', email: null, kind: 'account', references: refs(2, 2, 0, 10) },
    { archiveId: -1, displayName: 'Carol', email: null, kind: 'placeholder', references: refs(0, 1) },
  ],
  candidates: [
    { userId: 7, displayName: 'Dana', email: 'dana@example.com', isYou: false },
    { userId: 1, displayName: 'Owner', email: 'owner@example.com', isYou: true },
    { userId: 5, displayName: 'Alice A.', email: 'alice@example.com', isYou: false },
  ],
  suggestions: [
    { archiveId: 3, target: { kind: 'user', userId: 5 } },
    { archiveId: 9, target: { kind: 'user', userId: 1 } },
    { archiveId: -1, target: { kind: 'placeholder' } },
  ],
  estimate: { rowWrites: 900, rowWritesWithoutActivity: 700, limit: null, dailyLeft: null },
};

describe('the mapping reducer', () => {
  it('starts from the suggestions, so everyone is mapped before Import enables', () => {
    const choices = initialChoices(analysis);
    expect([...choices]).toEqual(analysis.suggestions.map((s) => [s.archiveId, s.target]));
    expect(unmappedUsers(analysis, choices)).toEqual([]);
  });

  it('changes one person’s target, and resets to the suggestions', () => {
    const start = initialChoices(analysis);
    const next = mappingReducer(start, { type: 'choose', archiveId: 9, target: { kind: 'placeholder' } });
    expect(next.get(9)).toEqual({ kind: 'placeholder' });
    expect(start.get(9)).toEqual({ kind: 'user', userId: 1 });
    expect(mappingReducer(next, { type: 'reset', analysis })).toEqual(start);
  });

  it('counts a person without a target, or with an account that is no candidate, as unmapped', () => {
    const missing = new Map([...initialChoices(analysis)].filter(([id]) => id !== 3));
    expect(unmappedUsers(analysis, missing).map((u) => u.archiveId)).toEqual([3]);
    const stranger = mappingReducer(initialChoices(analysis), { type: 'choose', archiveId: -1, target: { kind: 'user', userId: 99 } });
    expect(unmappedUsers(analysis, stranger).map((u) => u.archiveId)).toEqual([-1]);
  });

  it('builds the commit’s mapping for the archive’s users, with skipActivity only when chosen', () => {
    const choices = initialChoices(analysis);
    expect(mappingInput(analysis, choices, false)).toEqual({ mapping: analysis.suggestions });
    expect(mappingInput(analysis, choices, true)).toEqual({ mapping: analysis.suggestions, skipActivity: true });
    // A v1 file names nobody: an empty mapping.
    expect(mappingInput({ users: [] }, new Map(), false)).toEqual({ mapping: [] });
  });
});

describe('targets', () => {
  it('keys a target for the picker and back', () => {
    expect(targetKey({ kind: 'placeholder' })).toBe('placeholder');
    expect(targetKey({ kind: 'user', userId: 12 })).toBe('user:12');
    expect(targetOfKey('user:12')).toEqual({ kind: 'user', userId: 12 });
    expect(targetOfKey('placeholder')).toEqual({ kind: 'placeholder' });
  });

  it('offers keeping the name first, then the importer, then the others, with their addresses', () => {
    expect(targetOptions(analysis.candidates)).toEqual([
      { value: 'placeholder', label: PLACEHOLDER_LABEL, group: 'Keep the name' },
      { value: 'user:1', label: 'Owner (you)', hint: 'owner@example.com', group: 'Accounts' },
      { value: 'user:7', label: 'Dana', hint: 'dana@example.com', group: 'Accounts' },
      { value: 'user:5', label: 'Alice A.', hint: 'alice@example.com', group: 'Accounts' },
    ]);
    expect(targetOptions([{ userId: 2, displayName: 'Legacy', email: null, isYou: false }])[1]).toEqual({ value: 'user:2', label: 'Legacy', group: 'Accounts' });
  });

  it('names the chosen target on its button', () => {
    expect(targetText({ kind: 'placeholder' }, analysis.candidates)).toBe('Former member (name only)');
    expect(targetText({ kind: 'user', userId: 1 }, analysis.candidates)).toBe('Owner (you)');
    expect(targetText({ kind: 'user', userId: 5 }, analysis.candidates)).toBe('Alice A.');
    expect(targetText({ kind: 'user', userId: 99 }, analysis.candidates)).toBe('Choose…');
    expect(targetText(undefined, analysis.candidates)).toBe('Choose…');
  });

  it('says how many entries name a person', () => {
    expect(referencesText(refs(10, 2, 2, 30))).toBe('10 tasks, 2 comments, 2 work logs, 30 activity entries');
    expect(referencesText(refs(1, 0, 1, 1))).toBe('1 task, 1 work log, 1 activity entry');
    expect(referencesText(refs(0, 1200))).toBe('1,200 comments');
    expect(referencesText(refs())).toBe('Named in no entry');
  });
});

describe('the limits', () => {
  const estimate = (limit: number | null, dailyLeft: number | null) => ({ rowWrites: 52_000, rowWritesWithoutActivity: 41_000, limit, dailyLeft });

  it('fits without limits (Node by default)', () => {
    expect(importFit(estimate(null, null), false)).toEqual({ rowWrites: 52_000, fits: true, reason: null, offerSkip: false });
    expect(fitText(estimate(null, null), importFit(estimate(null, null), false))).toBeNull();
  });

  it('offers to leave the activity out when that brings it under the per-import limit', () => {
    const e = estimate(50_000, 60_000);
    const fit = importFit(e, false);
    expect(fit).toEqual({ rowWrites: 52_000, fits: false, reason: 'per_import', offerSkip: true });
    expect(fitText(e, fit)).toBe('This import needs about 52,000 row writes; this instance allows 50,000 per import. Without its activity history it needs about 41,000.');
    expect(importFit(e, true)).toEqual({ rowWrites: 41_000, fits: true, reason: null, offerSkip: true });
  });

  it('says so when even without the activity it is too large', () => {
    const e = estimate(40_000, null);
    const fit = importFit(e, true);
    expect(fit).toEqual({ rowWrites: 41_000, fits: false, reason: 'per_import', offerSkip: false });
    expect(fitText(e, fit)).toBe('This import needs about 41,000 row writes; this instance allows 40,000 per import.');
  });

  it('says that today’s import limit is reached only when nothing is left of it, else what is left', () => {
    const spent = estimate(50_000, 0);
    expect(fitText(spent, importFit(spent, true))).toBe(DAILY_LIMIT_TEXT);
    // 1,000 left: smaller imports still go through, so the limit is not "reached".
    const low = estimate(50_000, 1_000);
    expect(fitText(low, importFit(low, true))).toBe(
      'About 1,000 row writes are left of today’s import limit, and this import needs about 41,000. Try again after 00:00 UTC.',
    );
    expect(fitText(low, importFit(low, false))).toBe(
      'This import needs about 52,000 row writes; this instance allows 50,000 per import. Without its activity history it needs about 41,000, but only about 1,000 are left of today’s import limit. Try again after 00:00 UTC.',
    );
    const short = estimate(null, 45_000);
    const fit = importFit(short, false);
    expect(fit).toEqual({ rowWrites: 52_000, fits: false, reason: 'daily', offerSkip: true });
    expect(fitText(short, fit)).toBe(
      'About 45,000 row writes are left of today’s import limit, and this import needs about 52,000. Without its activity history it needs about 41,000.',
    );
    expect(importFit(short, true).fits).toBe(true);
    const tight = estimate(null, 30_000);
    expect(fitText(tight, importFit(tight, false))).toBe(
      'About 30,000 row writes are left of today’s import limit, and this import needs about 52,000. Even without its activity history it needs about 41,000. Try again after 00:00 UTC.',
    );
  });

  it('names both limits when the per-import one is passed and today’s leaves no way', () => {
    const both = estimate(50_000, 0);
    const fit = importFit(both, false);
    expect(fit).toEqual({ rowWrites: 52_000, fits: false, reason: 'per_import', offerSkip: false });
    expect(fitText(both, fit)).toBe(`This import needs about 52,000 row writes; this instance allows 50,000 per import. ${DAILY_LIMIT_TEXT}`);
    expect(fitText(both, importFit(both, true))).toBe(DAILY_LIMIT_TEXT);
    // The review's case: over the per-import limit, and without the activity over what is left today.
    const review = { rowWrites: 64_852, rowWritesWithoutActivity: 43_838, limit: 50_000, dailyLeft: 13_922 };
    expect(fitText(review, importFit(review, false))).toBe(
      'This import needs about 64,852 row writes; this instance allows 50,000 per import. Without its activity history it needs about 43,838, but only about 13,922 are left of today’s import limit. Try again after 00:00 UTC.',
    );
  });

  it('enables Replace once everyone is mapped and it fits, on Cloudflare only after the download began', () => {
    expect(replaceReady({ mapped: true, fits: true, needsDownload: false, downloaded: false })).toBe(true);
    expect(replaceReady({ mapped: true, fits: true, needsDownload: true, downloaded: false })).toBe(false);
    expect(replaceReady({ mapped: true, fits: true, needsDownload: true, downloaded: true })).toBe(true);
    expect(replaceReady({ mapped: false, fits: true, needsDownload: false, downloaded: true })).toBe(false);
    expect(replaceReady({ mapped: true, fits: false, needsDownload: false, downloaded: true })).toBe(false);
  });
});
