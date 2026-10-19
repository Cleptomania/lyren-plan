// Query keys are scoped per space (design §12.4): every key of a space's data starts with
// ['space', spaceId], the helpers touch the space they are given only, and a space that was left or
// lost is forgotten (its queries and the directory's about it).

import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { invalidateStructure, invalidateTasks, invalidateTimeline, qk, spaceOfKey } from './keys';
import { forgetLostSpaces, forgetSpace } from './spaces';

const A = '7k2m9q4w8x1c3v5b';
const B = '0123456789abcdef';

/** Every factory of a space's key, called for `sid`. */
const spaceKeys = (sid: string): ReadonlyArray<readonly unknown[]> => [
  qk.space(sid),
  qk.bootstrap(sid),
  qk.tasksAll(sid),
  qk.taskQueries(sid),
  qk.taskQuery(sid, { limit: 5 }),
  qk.taskDetails(sid),
  qk.task(sid, 1),
  qk.taskByRef(sid, 'web-1'),
  qk.timeline(sid, 1),
  qk.activityAll(sid),
  qk.activity(sid, { projectId: 1 }),
  qk.worklogsAll(sid),
  qk.worklogs(sid, { from: '2026-10-01', to: '2026-10-31' }),
  qk.dashboardAll(sid),
  qk.dashboard(sid, '2026-10-18', 1),
  qk.searchAll(sid),
  qk.search(sid, 'x|10'),
];

describe('qk', () => {
  it('starts every key of a space with [space, id]', () => {
    for (const key of spaceKeys(A)) {
      expect(key.slice(0, 2)).toEqual(['space', A]);
      expect(spaceOfKey(key)).toBe(A);
    }
    // Every function of qk is covered above, or is a directory key (no space in it).
    const factories = Object.entries(qk).filter(([, v]) => typeof v === 'function').map(([k]) => k);
    const directory = ['linkPreview', 'spaceDetail', 'members', 'invitations', 'adminUsers', 'adminUser', 'adminSpaces'];
    expect(factories.filter((k) => !directory.includes(k))).toHaveLength(spaceKeys(A).length);
  });

  it('keeps the directory’s keys out of the spaces', () => {
    const admin = [qk.adminAll, qk.adminOverview, qk.adminUsers('x', false), qk.adminUser(1), qk.adminInvitations, qk.adminSpaces(A)];
    const account = [qk.linkPreview('invitation', 'x'.repeat(43)), qk.pendingInvitations, qk.invitations(A)];
    for (const key of [qk.authStatus, qk.sessions, qk.securityEvents, qk.spaces, qk.deletedSpaces, qk.spaceDetail(A), qk.members(A), ...account, ...admin]) {
      expect(['auth', 'account', 'spaces', 'admin']).toContain(key[0]);
      expect(spaceOfKey(key)).toBeNull();
    }
  });

  it('the same ids in two spaces are two keys', () => {
    expect(qk.task(A, 1)).not.toEqual(qk.task(B, 1));
    expect(qk.taskByRef(A, 'WEB-1')).not.toEqual(qk.taskByRef(B, 'WEB-1'));
  });
});

function twoSpaces() {
  const qc = new QueryClient();
  for (const sid of [A, B]) for (const key of spaceKeys(sid).slice(1)) qc.setQueryData(key, { sid });
  qc.setQueryData(qk.authStatus, { user: { id: 1 } });
  return qc;
}
const invalidated = (qc: QueryClient, sid: string) =>
  spaceKeys(sid)
    .slice(1)
    .filter((key) => qc.getQueryState(key)?.isInvalidated)
    .map((key) => key.slice(2).join('/'));

describe('the invalidation helpers', () => {
  it('invalidateTasks touches its space only', async () => {
    const qc = twoSpaces();
    await invalidateTasks(qc, A);
    expect(invalidated(qc, A).length).toBeGreaterThan(0);
    expect(invalidated(qc, B)).toEqual([]);
    expect(qc.getQueryState(qk.authStatus)?.isInvalidated).toBe(false);
  });

  it('invalidateStructure and invalidateTimeline touch their space only', async () => {
    const qc = twoSpaces();
    await invalidateStructure(qc, B, { tasks: true });
    await invalidateTimeline(qc, B, 1);
    expect(invalidated(qc, A)).toEqual([]);
    expect(invalidated(qc, B)).toContain('bootstrap');
    expect(invalidated(qc, B)).toContain('tasks/timeline/1');
  });
});

describe('forgetting a space', () => {
  it('forgetSpace removes its queries and the directory’s about it', () => {
    const qc = twoSpaces();
    qc.setQueryData(qk.members(A), []);
    qc.setQueryData(qk.spaceDetail(A), {});
    qc.setQueryData(qk.invitations(A), []);
    qc.setQueryData(qk.members(B), []);
    qc.setQueryData(qk.spaces, []);
    forgetSpace(qc, A);
    expect(spaceKeys(A).every((key) => qc.getQueryData(key) === undefined)).toBe(true);
    expect(qc.getQueryData(qk.members(A))).toBeUndefined();
    expect(qc.getQueryData(qk.spaceDetail(A))).toBeUndefined();
    expect(qc.getQueryData(qk.invitations(A))).toBeUndefined();
    expect(qc.getQueryData(qk.bootstrap(B))).toEqual({ sid: B });
    expect(qc.getQueryData(qk.members(B))).toEqual([]);
    expect(qc.getQueryData(qk.spaces)).toEqual([]);
    expect(qc.getQueryData(qk.authStatus)).toBeDefined();
  });

  it('forgetLostSpaces forgets every cached space the account no longer has', () => {
    const qc = twoSpaces();
    forgetLostSpaces(qc, [B]);
    expect(qc.getQueryData(qk.bootstrap(A))).toBeUndefined();
    expect(qc.getQueryData(qk.bootstrap(B))).toEqual({ sid: B });
    forgetLostSpaces(qc, []);
    expect(qc.getQueryData(qk.bootstrap(B))).toBeUndefined();
    expect(qc.getQueryData(qk.authStatus)).toBeDefined();
  });
});
