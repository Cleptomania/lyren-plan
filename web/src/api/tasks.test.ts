import { MutationObserver, QueryClient, QueryObserver } from '@tanstack/react-query';
import type { TaskUpdateInput } from '@shared/schemas';
import type { BootstrapDTO, TaskDTO, TaskQueryResult } from '@shared/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { epic, project, status, task } from '../components/domain/fixtures.test-utils';
import { qk } from './keys';
import { applyTaskPatch, findCachedTask, findCachedTaskByKey, forgetDeletedTasks, inverseTaskPatch, updateTaskOptions, type TaskUpdateVariables } from './tasks';

// After a delete, the deleted task's own queries must not be refetched (that is a 404 while the
// drawer / task page is still closing); everything else under ['tasks'] must be.
describe('forgetDeletedTasks', () => {
  const clients: QueryClient[] = [];
  afterEach(() => clients.splice(0).forEach((qc) => qc.clear()));

  function setup() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    clients.push(qc);
    const calls: string[] = [];
    const observe = (queryKey: readonly unknown[], data: unknown) => {
      qc.setQueryData(queryKey, data);
      const obs = new QueryObserver(qc, {
        queryKey,
        queryFn: async () => {
          calls.push(JSON.stringify(queryKey));
          return data;
        },
      });
      return obs.subscribe(() => undefined);
    };
    return { qc, calls, observe };
  }

  it('keeps observed queries of the deleted task without refetching, drops unobserved ones', async () => {
    const { qc, calls, observe } = setup();
    const unsubs = [
      observe(qk.task(5), { id: 5 }), // the open drawer
      observe(qk.timeline(5), { comments: [] }), // its timeline
      observe(qk.task(6), { id: 6 }), // another open task
      observe(qk.taskQuery({}), { tasks: [], total: 0 }), // an open list
    ];
    qc.setQueryData(qk.taskByRef('WEB-5'), { id: 5 }); // unobserved caches of the deleted task
    qc.setQueryData(qk.task(7), { id: 7 });

    await forgetDeletedTasks(qc, [5]);

    expect(calls.sort()).toEqual([JSON.stringify(qk.task(6)), JSON.stringify(qk.taskQuery({}))].sort());
    expect(qc.getQueryData(qk.task(5))).toEqual({ id: 5 });
    expect(qc.getQueryData(qk.taskByRef('WEB-5'))).toBeUndefined();
    expect(qc.getQueryState(qk.task(7))?.isInvalidated).toBe(true);
    unsubs.forEach((u) => u());
  });

  it('handles several ids (bulk delete)', async () => {
    const { qc, calls, observe } = setup();
    const unsubs = [observe(qk.task(1), { id: 1 }), observe(qk.task(2), { id: 2 }), observe(qk.task(3), { id: 3 })];
    qc.setQueryData(qk.timeline(2), { comments: [] });
    await forgetDeletedTasks(qc, [1, 2]);
    expect(calls).toEqual([JSON.stringify(qk.task(3))]);
    expect(qc.getQueryData(qk.timeline(2))).toBeUndefined();
    unsubs.forEach((u) => u());
  });
});

// ---- useUpdateTask (optimistic edits) ------------------------------------------------------

interface Deferred {
  resolve: (task: TaskDTO) => void;
  fail: (status?: number) => void;
}

function updateHarness(initial: TaskDTO[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  const listKey = qk.taskQuery({});
  qc.setQueryData<TaskQueryResult>(listKey, { tasks: initial, total: initial.length });
  /** PATCH requests in the order they were sent; settle them from the test. */
  const patches: Array<{ id: number; body: unknown } & Deferred> = [];
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    const m = /^\/api\/tasks\/(\d+)$/.exec(url);
    if (!m || init.method !== 'PATCH') return Promise.reject(new TypeError('unexpected ' + url));
    return new Promise<Response>((resolve, reject) => {
      patches.push({
        id: Number(m[1]),
        body: JSON.parse(String(init.body)),
        resolve: (task) => resolve(Response.json(task)),
        fail: (status) =>
          status ? resolve(Response.json({ error: { code: 'internal', message: 'boom' } }, { status })) : reject(new TypeError('Failed to fetch')),
      });
    });
  });
  const update = (vars: TaskUpdateVariables) => {
    const observer = new MutationObserver(qc, updateTaskOptions(qc));
    const done = observer.mutate(vars).then(
      () => 'ok' as const,
      () => 'error' as const,
    );
    return done;
  };
  const sent = (i: number) => {
    const p = patches[i];
    if (!p) throw new Error(`PATCH #${i} was not sent`);
    return p;
  };
  const shown = (id: number) => qc.getQueryData<TaskQueryResult>(listKey)?.tasks.find((t) => t.id === id);
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { qc, listKey, sent, update, shown, flush };
}

describe('updateTaskOptions', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('settles a failed edit at once even while the follow-up refetch cannot run (offline)', async () => {
    const { qc, listKey, sent, update, shown, flush } = updateHarness([task({ id: 9, priority: 1 })]);
    // An open list whose refetch would hang (offline: refetches pause until the network returns).
    const obs = new QueryObserver(qc, { queryKey: listKey, queryFn: () => new Promise<TaskQueryResult>(() => undefined) });
    const unsub = obs.subscribe(() => undefined);
    const done = update({ id: 9, priority: 4 });
    await flush();
    expect(shown(9)?.priority).toBe(4);
    sent(0).fail();
    const outcome = await Promise.race([done, new Promise((r) => setTimeout(() => r('still pending'), 200))]);
    expect(outcome).toBe('error');
    expect(shown(9)?.priority).toBe(1);
    expect(qc.isMutating()).toBe(0);
    unsub();
  });

  it('an older response does not overwrite a newer pending edit of the same task', async () => {
    const { sent, update, shown, flush } = updateHarness([task({ id: 9, priority: 1, title: 'T' })]);
    const a = update({ id: 9, priority: 4 });
    await flush();
    const b = update({ id: 9, priority: 3 });
    await flush();
    expect(shown(9)?.priority).toBe(3);
    // A returns first (server fields such as the ref come from it), B still pending.
    sent(0).resolve(task({ id: 9, priority: 4, title: 'T', ref: 'NEW-9', updatedAt: '2026-10-02T00:00:00.000Z' }));
    expect(await a).toBe('ok');
    expect(shown(9)?.priority).toBe(3);
    expect(shown(9)?.ref).toBe('NEW-9');
    sent(1).resolve(task({ id: 9, priority: 3, title: 'T', ref: 'NEW-9', updatedAt: '2026-10-02T00:00:01.000Z' }));
    expect(await b).toBe('ok');
    expect(shown(9)?.priority).toBe(3);
  });

  it('a failed older edit rolls back only its own change, not a newer pending one', async () => {
    const { sent, update, shown, flush } = updateHarness([task({ id: 9, priority: 1, title: 'T' })]);
    const a = update({ id: 9, title: 'Renamed' });
    await flush();
    const b = update({ id: 9, priority: 3 });
    await flush();
    sent(0).fail(500);
    expect(await a).toBe('error');
    expect(shown(9)).toMatchObject({ title: 'T', priority: 3 });
    // B then fails too: back to the original.
    sent(1).fail(500);
    expect(await b).toBe('error');
    expect(shown(9)).toMatchObject({ title: 'T', priority: 1 });
  });

  it('a failure after an older success restores the server copy, not the pre-edit state', async () => {
    const { sent, update, shown, flush } = updateHarness([task({ id: 9, priority: 1, title: 'T' })]);
    const a = update({ id: 9, title: 'Renamed' });
    await flush();
    const b = update({ id: 9, priority: 3 });
    await flush();
    sent(0).resolve(task({ id: 9, priority: 1, title: 'Renamed', updatedAt: '2026-10-02T00:00:00.000Z' }));
    expect(await a).toBe('ok');
    expect(shown(9)).toMatchObject({ title: 'Renamed', priority: 3 });
    sent(1).fail(500);
    expect(await b).toBe('error');
    expect(shown(9)).toMatchObject({ title: 'Renamed', priority: 1 });
  });

  it('rolling back one task keeps another task’s concurrent edit', async () => {
    const { sent, update, shown, flush } = updateHarness([task({ id: 1, priority: 1 }), task({ id: 2, priority: 1 })]);
    const one = update({ id: 1, priority: 4 });
    await flush();
    const two = update({ id: 2, priority: 2 });
    await flush();
    sent(0).fail(500);
    expect(await one).toBe('error');
    expect(shown(1)?.priority).toBe(1);
    expect(shown(2)?.priority).toBe(2);
    sent(1).resolve(task({ id: 2, priority: 2 }));
    expect(await two).toBe('ok');
  });

  it('starts from the freshest cached copy, not a stale inactive detail entry', async () => {
    const { qc, sent, update, shown, flush } = updateHarness([task({ id: 9, title: 'Renamed elsewhere', updatedAt: '2026-10-05T00:00:00.000Z' })]);
    qc.setQueryData(qk.task(9), task({ id: 9, title: 'Old title', updatedAt: '2026-10-01T00:00:00.000Z' }));
    expect(findCachedTask(qc, 9)?.title).toBe('Renamed elsewhere');
    const done = update({ id: 9, priority: 2 });
    await flush();
    expect(shown(9)).toMatchObject({ title: 'Renamed elsewhere', priority: 2 });
    expect(qc.getQueryData<TaskDTO>(qk.task(9))?.title).toBe('Renamed elsewhere');
    sent(0).resolve(task({ id: 9, title: 'Renamed elsewhere', priority: 2, updatedAt: '2026-10-06T00:00:00.000Z' }));
    expect(await done).toBe('ok');
  });

  it('prefers the detail entry when it is the fresher copy', () => {
    const { qc } = updateHarness([task({ id: 9, title: 'List copy', updatedAt: '2026-10-01T00:00:00.000Z' })]);
    qc.setQueryData(qk.task(9), task({ id: 9, title: 'Detail copy', updatedAt: '2026-10-03T00:00:00.000Z' }));
    expect(findCachedTask(qc, 9)?.title).toBe('Detail copy');
  });
});

describe('findCachedTaskByKey', () => {
  const OLD = '2026-10-01T00:00:00.000Z';
  const NEW = '2026-10-05T00:00:00.000Z';

  it('finds a task by id like findCachedTask', () => {
    const qc = new QueryClient();
    qc.setQueryData(qk.task(3), task({ id: 3, ref: 'WEB-3', epicId: 7 }));
    expect(findCachedTaskByKey(qc, { id: 3 })?.epicId).toBe(7);
    expect(findCachedTaskByKey(qc, { id: 4 })).toBeUndefined();
  });

  it('resolves a ref to the freshest copy of that task, not the stale by-ref entry', () => {
    const qc = new QueryClient();
    // A task page: the by-ref entry from the first load, and the detail entry edits update.
    qc.setQueryData(qk.taskByRef('WEB-3'), task({ id: 3, ref: 'WEB-3', epicId: null, updatedAt: OLD }));
    qc.setQueryData(qk.task(3), task({ id: 3, ref: 'WEB-3', epicId: 7, updatedAt: NEW }));
    expect(findCachedTaskByKey(qc, { ref: 'web-3' })).toMatchObject({ id: 3, epicId: 7 });
  });

  it('finds a ref in detail entries and lists when there is no by-ref entry', () => {
    const qc = new QueryClient();
    qc.setQueryData(qk.task(5), task({ id: 5, ref: 'ME-2', title: 'Detail' }));
    expect(findCachedTaskByKey(qc, { ref: 'ME-2' })?.title).toBe('Detail');
    qc.setQueryData<TaskQueryResult>(qk.taskQuery({ limit: 5 }), { tasks: [task({ id: 6, ref: 'ME-3', title: 'Listed' })], total: 1 });
    expect(findCachedTaskByKey(qc, { ref: 'ME-3' })?.title).toBe('Listed');
    expect(findCachedTaskByKey(qc, { ref: 'ME-4' })).toBeUndefined();
  });
});

describe('inverseTaskPatch', () => {
  const boot = {
    statuses: [status(1, 'unstarted'), status(2, 'started'), status(3, 'completed')],
    projects: [project(1, 'WEB'), project(2, 'ME')],
    epics: [epic(4, 1, 9), epic(5, 1, null), epic(6, 2, null)],
    tags: [
      { id: 1, name: 'a', color: '#000000' },
      { id: 2, name: 'b', color: '#000000' },
      { id: 3, name: 'c', color: '#000000' },
    ],
  } as unknown as BootstrapDTO;
  const original = task({
    id: 7,
    statusId: 2,
    priority: 2,
    epicId: 4,
    milestoneId: 9,
    dueDate: '2026-10-20',
    tags: [{ id: 1, name: 'a', color: '#000000' }],
  });
  const keyFields = (t: TaskDTO) => ({
    statusId: t.statusId,
    priority: t.priority,
    projectId: t.projectId,
    epicId: t.epicId,
    milestoneId: t.milestoneId,
    dueDate: t.dueDate,
    archived: t.archivedAt !== null,
    tags: t.tags.map((x) => x.id),
  });

  it('touches only the fields the patch changed', () => {
    expect(inverseTaskPatch(original, { statusId: 3 })).toEqual({ statusId: 2 });
    expect(inverseTaskPatch(original, { priority: 4, dueDate: null })).toEqual({ priority: 2, dueDate: '2026-10-20' });
    expect(inverseTaskPatch(original, { archived: true })).toEqual({ archived: false });
    expect(inverseTaskPatch(original, {})).toEqual({});
  });

  it('restores project and epic together (an epic move can change the project, a project move clears the epic)', () => {
    expect(inverseTaskPatch(original, { epicId: null })).toEqual({ projectId: 1, epicId: 4 });
    expect(inverseTaskPatch(original, { epicId: 6 })).toEqual({ projectId: 1, epicId: 4 });
    expect(inverseTaskPatch(original, { projectId: 2 })).toEqual({ projectId: 1, epicId: 4 });
  });

  it('restores the full tag set after add / remove / replace', () => {
    expect(inverseTaskPatch(original, { addTagIds: [2] })).toEqual({ tagIds: [1] });
    expect(inverseTaskPatch(original, { removeTagIds: [1], addTagIds: [3] })).toEqual({ tagIds: [1] });
    expect(inverseTaskPatch(original, { tagIds: [] })).toEqual({ tagIds: [1] });
  });

  it('undoes a position with the old rank, which applyTaskPatch restores as is', () => {
    const ranked = { ...original, rank: 'a3' };
    expect(inverseTaskPatch(ranked, { statusId: 3, position: { afterId: 8, beforeId: null } })).toEqual({ statusId: 2, position: { rank: 'a3' } });
    expect(inverseTaskPatch(ranked, { position: 'top' })).toEqual({ position: { rank: 'a3' } });
    const moved = applyTaskPatch(ranked, { position: 'top' }, boot, { minRank: 'a0' });
    expect(moved.rank).not.toBe('a3');
    expect(applyTaskPatch(moved, inverseTaskPatch(ranked, { position: 'top' }), boot).rank).toBe('a3');
  });

  it('round-trips board drop patches', () => {
    const patches: TaskUpdateInput[] = [
      { statusId: 3, epicId: 5 },
      { epicId: null },
      { projectId: 2, epicId: 6 },
      { priority: 4, removeTagIds: [1], addTagIds: [2] },
      { dueDate: null, tagIds: [] },
    ];
    for (const patch of patches) {
      const moved = applyTaskPatch(original, patch, boot);
      expect(keyFields(moved)).not.toEqual(keyFields(original));
      const back = applyTaskPatch(moved, inverseTaskPatch(original, patch), boot);
      expect(keyFields(back)).toEqual(keyFields(original));
    }
  });
});
