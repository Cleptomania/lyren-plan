// The cost budget (design §11.2, §14.4): what a Durable Object bills for the operations of §11.2, in a space
// shaped as the platform review's (2,000 tasks, 40 epics, 12 tags, 300 comments), measured with DoDb's meter
// (entry.ts's objectDbs: the rows the platform bills, index entries included) through the real Worker.
// The targets are asserted; every measured operation is printed as one line ("[cost] …"), the table
// docs/cloudflare.md holds. The import's rows written against its estimate: importCost.test.ts.
//
// The space is built as the review built it: the sample data, three projects of three milestones with four
// epics each and eight more tags over HTTP; the tasks (createTaskRow, as POST /api/tasks writes them, activity
// included) and the comments (as POST …/comments writes them) inside the space object, since 2,000 HTTP
// creates would spend its daily write budget. The object is evicted afterwards, so the measurements start from
// a fresh instance after one warm-up request. Two later shapes check what the review's could not show
// (Appendix D 46, 47): a small project among many epics, whose board pays for looking its epics and tags up,
// and a project whose every task has three comments and two work logs, whose lists must cost no more for it.

import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { taskCreateInput } from '@shared/schemas';
import type { BootstrapDTO, SpaceSummaryDTO, TaskDTO } from '@shared/types';
import { DoDb } from '../src/runtime/cloudflare/doDb';
import { commentExcerpt, recordActivity } from '../src/services/activity';
import { createTaskRow } from '../src/services/taskMutations';
import { directoryCalls, objectDbs, spaceCalls } from './entry';
import { OWNER_EMAIL, PASSWORD, WorkerClient, type WorkerResponse } from './support';

const TODAY = '2026-10-17';
const TASKS = 2_000;
const COMMENTS = 300;

let owner: WorkerClient;
let spaceId: string;
let projectIds: number[] = [];
let created: number[] = [];
let tasksOf: Map<number, number>;
let statusIds: number[] = [];
let tagIds: number[] = [];
let sampleComments = 0;

interface Cost {
  label: string;
  status: number;
  read: number;
  written: number;
  objectRequests: number;
  ms: number;
}

const costs: Cost[] = [];

const spaceMeter = () => objectDbs.spaces.get(spaceId)!.meter;
const directoryMeter = () => objectDbs.directory!.meter;
/** The directory's rows and every space's, for requests that make a space (its new object's migrations included). */
const everyMeter = () =>
  [objectDbs.directory, ...objectDbs.spaces.values()].reduce(
    (sum, db) => ({ rowsRead: sum.rowsRead + (db?.meter.rowsRead ?? 0), rowsWritten: sum.rowsWritten + (db?.meter.rowsWritten ?? 0) }),
    { rowsRead: 0, rowsWritten: 0 },
  );
const objectRequests = () =>
  Object.values(directoryCalls).reduce((a, b) => a + b, 0) +
  [...spaceCalls.values()].reduce((sum, calls) => sum + Object.values(calls).reduce((a, b) => a + b, 0), 0);

/** One request, with the rows the object it is about read and wrote, and the Durable Object requests it made. */
async function measure<T>(
  label: string,
  call: () => Promise<WorkerResponse<T>>,
  meter: () => { rowsRead: number; rowsWritten: number } = spaceMeter,
): Promise<WorkerResponse<T> & { cost: Cost }> {
  const before = { ...meter() };
  const requests = objectRequests();
  const started = performance.now();
  const res = await call();
  const ms = performance.now() - started;
  const after = meter();
  const cost: Cost = {
    label,
    status: res.status,
    read: after.rowsRead - before.rowsRead,
    written: after.rowsWritten - before.rowsWritten,
    objectRequests: objectRequests() - requests,
    ms,
  };
  costs.push(cost);
  console.log(
    `[cost] ${label}: ${res.status}, rows read ${cost.read}, rows written ${cost.written}, DO requests ${cost.objectRequests}, ${ms.toFixed(1)} ms`,
  );
  return { ...res, cost };
}

const s = (path: string) => `/api/s/${spaceId}${path}`;

const boardQuery = (projectId: number) => ({
  filter: { projectIds: [projectId], archived: 'exclude' },
  sort: { field: 'manual', dir: 'asc' },
  today: TODAY,
  limit: 5000,
});

/** The task list's request (web TaskList: pages of 200, its toolbar's archived and closed toggles off). */
const pageQuery = (field: string, projectId?: number) => ({
  filter: { ...(projectId === undefined ? {} : { projectIds: [projectId] }), archived: 'exclude', closedWithinDays: 0 },
  sort: { field, dir: 'asc' },
  today: TODAY,
  limit: 200,
});

/** `comments` comments (as POST …/comments writes them, activity included) and `worklogs` work logs on each task. */
function discuss(db: DoDb, userId: number, taskIds: readonly number[], comments: number, worklogs = 0): void {
  for (const id of taskIds) {
    db.tx(() => {
      const task = db.get<{ id: number; project_id: number; title: string }>('SELECT id, project_id, title FROM tasks WHERE id = :id', { id })!;
      const now = new Date().toISOString();
      for (let c = 0; c < comments; c++) {
        const body = `Comment ${c} on task ${id}, with some text`;
        const commentId = db.run(
          `INSERT INTO comments (task_id, user_id, body, created_at, updated_at, edited_at)
           VALUES (:taskId, :userId, :body, :now, :now, NULL)`,
          { taskId: task.id, userId, body, now },
        ).lastInsertRowid;
        recordActivity(db, {
          userId,
          projectId: task.project_id,
          taskId: task.id,
          entityType: 'comment',
          entityId: commentId,
          action: 'comment.created',
          data: { excerpt: commentExcerpt(body), title: task.title },
          createdAt: now,
        });
      }
      for (let w = 0; w < worklogs; w++) {
        db.run(
          `INSERT INTO work_logs (task_id, user_id, date, minutes, note, created_at, updated_at)
           VALUES (:taskId, :userId, :date, :minutes, '', :now, :now)`,
          { taskId: task.id, userId, date: TODAY, minutes: 15 * (w + 1), now },
        );
      }
    });
  }
}

beforeAll(async () => {
  owner = new WorkerClient();
  expect((await owner.get('/api/auth/status')).status).toBe(200); // the directory's object starts
  const setup = await measure(
    'POST auth/setup (the first account, and its space without sample data)',
    () => owner.post('/api/auth/setup', { email: OWNER_EMAIL, password: PASSWORD, displayName: 'Owner', setupCode: 'test' }),
    everyMeter,
  );
  expect(setup.status).toBe(201);
  const space = await owner.post<SpaceSummaryDTO>('/api/spaces', { name: 'Cost', createSampleData: true, today: TODAY });
  expect(space.status).toBe(201);
  spaceId = space.body.id;
  for (const name of ['Alpha', 'Beta', 'Gamma']) {
    const project = await owner.post<{ id: number }>(s('/projects'), { name });
    projectIds.push(project.body.id);
    for (let m = 0; m < 3; m++) {
      const milestone = await owner.post<{ id: number }>(s('/milestones'), { projectId: project.body.id, name: `${name} M${m}` });
      for (let e = 0; e < 4; e++) {
        await owner.post(s('/epics'), { projectId: project.body.id, name: `${name} E${m}.${e}`, milestoneId: milestone.body.id });
      }
    }
  }
  for (let i = 0; i < 8; i++) await owner.post(s('/tags'), { name: `tag${i}` });
  const boot = (await owner.get<BootstrapDTO>(s(`/bootstrap?today=${TODAY}`))).body;
  tagIds = boot.tags.map((t) => t.id);
  statusIds = boot.statuses.map((t) => t.id);
  const epicsOf = new Map(projectIds.map((p) => [p, boot.epics.filter((e) => e.projectId === p).map((e) => e.id)]));
  const userId = boot.user.id;

  ({ created, tasksOf, sampleComments } = await runInDurableObject(env.SPACES.getByName(spaceId), (_instance, state) => {
    const db = new DoDb(state.storage);
    const existing = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks')!.n;
    const comments = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM comments')!.n;
    const ids: number[] = [];
    for (let i = existing; i < TASKS; i++) {
      const projectId = projectIds[i % 3]!;
      const epics = epicsOf.get(projectId)!;
      ids.push(
        createTaskRow(
          db,
          { userId },
          taskCreateInput.parse({
            projectId,
            title: `Task ${i} implement the thing number ${i}`,
            description: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(4),
            epicId: i % 3 === 0 ? null : epics[i % epics.length],
            statusId: statusIds[i % statusIds.length],
            priority: i % 5,
            dueDate: i % 4 === 0 ? TODAY : null,
            estimate: i % 7,
            tagIds: [tagIds[i % tagIds.length], tagIds[(i * 3) % tagIds.length]],
          }),
        ),
      );
    }
    discuss(db, userId, Array.from({ length: COMMENTS }, (_, i) => ids[i * 5]!), 1);
    const perProject = db.all<{ id: number; n: number }>('SELECT project_id AS id, COUNT(*) AS n FROM tasks GROUP BY project_id');
    return { created: ids, tasksOf: new Map(perProject.map((r) => [r.id, r.n])), sampleComments: comments };
  }));
  await evictDurableObject(env.SPACES.getByName(spaceId));
  expect((await owner.get(s(`/bootstrap?today=${TODAY}`))).status).toBe(200); // the warm-up: a fresh instance
}, 120_000);

afterAll(() => {
  console.log(
    `[cost] space: ${TASKS} tasks (${[...tasksOf.values()].join(' + ')} by project), 40 epics, 12 tags, ` +
      `${sampleComments} + ${COMMENTS} comments\n` +
      costs.map((c) => `[cost] | ${c.label} | ${c.objectRequests} | ${c.written} | ${c.read} |`).join('\n'),
  );
});

describe('the cost budget of §11.2 (a space of 2,000 tasks, 40 epics, 12 tags, 300 comments)', () => {
  it('has the shape of the platform review', async () => {
    const counts = await runInDurableObject(env.SPACES.getByName(spaceId), (_instance, state) =>
      new DoDb(state.storage).get<{ tasks: number; epics: number; tags: number; comments: number }>(
        `SELECT (SELECT COUNT(*) FROM tasks) AS tasks, (SELECT COUNT(*) FROM epics) AS epics,
                (SELECT COUNT(*) FROM tags) AS tags, (SELECT COUNT(*) FROM comments) AS comments`,
      ),
    );
    // The review added its 300 comments to the sample data's.
    expect(counts).toEqual({ tasks: TASKS, epics: 40, tags: 12, comments: sampleComments + COMMENTS });
  });

  it('bootstrap reads at most 8,000 rows (at most 4 per task), and its conditional re-read at most 1', async () => {
    const res = await measure('GET bootstrap', () => owner.get<BootstrapDTO>(s(`/bootstrap?today=${TODAY}`)));
    expect(res.status).toBe(200);
    expect(res.cost.read).toBeLessThanOrEqual(8_000);
    expect(res.cost.read).toBeLessThanOrEqual(4 * TASKS);
    expect(res.cost.written).toBe(0);
    const etag = res.headers.get('ETag')!;
    const again = await measure('GET bootstrap, If-None-Match (304)', () =>
      owner.get(s(`/bootstrap?today=${TODAY}`), { 'If-None-Match': etag }),
    );
    expect(again.status).toBe(304);
    expect(again.cost.read).toBeLessThanOrEqual(1);
    expect(again.cost.written).toBe(0);
  });

  it('the dashboard reads at most 8,000 rows', async () => {
    const res = await measure('GET dashboard', () => owner.get(s(`/dashboard?today=${TODAY}`)));
    expect(res.status).toBe(200);
    expect(res.cost.read).toBeLessThanOrEqual(8_000);
  });

  it("a project's board query reads at most 3 rows per task of the project, the all-tasks query 3 per task", async () => {
    const projectId = projectIds[0]!;
    const n = tasksOf.get(projectId)!;
    const board = await measure(`POST tasks/query, the board of one project (${n} tasks)`, () =>
      owner.post<{ tasks: TaskDTO[] }>(s('/tasks/query'), boardQuery(projectId)),
    );
    expect(board.status).toBe(200);
    expect(board.body.tasks).toHaveLength(n);
    expect(board.cost.read).toBeLessThanOrEqual(3 * n);
    const recent = await measure(`POST tasks/query, the board with closedWithinDays 14`, () =>
      owner.post<{ tasks: TaskDTO[] }>(s('/tasks/query'), {
        ...boardQuery(projectId),
        filter: { ...boardQuery(projectId).filter, closedWithinDays: 14 },
      }),
    );
    expect(recent.cost.read).toBeLessThanOrEqual(3 * n);
    const all = await measure('POST tasks/query, all tasks', () =>
      owner.post<{ tasks: TaskDTO[] }>(s('/tasks/query'), { filter: {}, sort: { field: 'manual', dir: 'asc' }, today: TODAY, limit: 5000 }),
    );
    expect(all.status).toBe(200);
    expect(all.body.tasks.length).toBeGreaterThan(TASKS - 50); // the sample data's archived project hides a few
    expect(all.cost.read).toBeLessThanOrEqual(3 * TASKS);
    // Another order than the manual one sorts every task (a row each); by status reads each task's status too.
    for (const field of ['dueDate', 'status'] as const) {
      const sorted = await measure(`POST tasks/query, all tasks by ${field}`, () =>
        owner.post(s('/tasks/query'), { filter: {}, sort: { field, dir: 'asc' }, today: TODAY, limit: 5000 }),
      );
      expect(sorted.status).toBe(200);
    }
  });

  it("the task list's pages (200 tasks) read at most 3 rows per task of the list's scope", async () => {
    // Appendix D 47: a page reads the ids of every match in order (the total), then its own rows by id.
    const scopes = [
      { label: 'all tasks', n: TASKS, projectId: undefined },
      { label: `one project (${tasksOf.get(projectIds[0]!)} tasks)`, n: tasksOf.get(projectIds[0]!)!, projectId: projectIds[0] },
    ];
    for (const { label, n, projectId } of scopes) {
      for (const field of ['manual', 'dueDate', 'priority'] as const) {
        const page = await measure(`POST tasks/query, a page of ${label} by ${field}`, () =>
          owner.post<{ tasks: TaskDTO[]; total: number }>(s('/tasks/query'), pageQuery(field, projectId)),
        );
        expect(page.status).toBe(200);
        expect(page.body.tasks).toHaveLength(200);
        expect(page.body.total).toBeGreaterThan(200);
        expect(page.cost.read).toBeLessThanOrEqual(3 * n);
      }
    }
    // "Show more" asks for 200 more.
    const more = await measure('POST tasks/query, two pages of all tasks by dueDate (limit 400)', () =>
      owner.post<{ tasks: TaskDTO[] }>(s('/tasks/query'), { ...pageQuery('dueDate'), limit: 400 }),
    );
    expect(more.body.tasks).toHaveLength(400);
    expect(more.cost.read).toBeLessThanOrEqual(3 * TASKS);
  });

  it('a task PATCH writes at most 15 rows (its write generation included)', async () => {
    const res = await measure('PATCH a task (title)', () => owner.patch(s(`/tasks/${created[10]}`), { title: 'Renamed task title' }));
    expect(res.status).toBe(200);
    expect(res.cost.written).toBeLessThanOrEqual(15);
    const current = (await owner.get<TaskDTO>(s(`/tasks/${created[11]}`))).body.statusId;
    const next = statusIds[(statusIds.indexOf(current) + 1) % statusIds.length];
    const status = await measure('PATCH a task (status)', () => owner.patch(s(`/tasks/${created[11]}`), { statusId: next }));
    expect(status.status).toBe(200);
    expect((status.body as TaskDTO).statusId).toBe(next);
    const before = (await owner.get<TaskDTO>(s(`/tasks/${created[12]}`))).body.tags.map((t) => t.id);
    const swapped = [before[0]!, tagIds.find((id) => !before.includes(id))!];
    const tags = await measure('PATCH a task (one of its two tags swapped)', () => owner.patch(s(`/tasks/${created[12]}`), { tagIds: swapped }));
    expect(tags.status).toBe(200);
    expect((tags.body as TaskDTO).tags.map((t) => t.id).sort()).toEqual([...swapped].sort());
    expect(status.cost.written).toBeLessThanOrEqual(15);
  });

  it('measures the other operations of §11.2', async () => {
    expect((await measure('GET search', () => owner.get(s(`/search?q=${encodeURIComponent('thing 1234')}`)))).status).toBe(200);
    const task = await measure('POST a task (with its activity)', () => owner.post(s('/tasks'), { projectId: projectIds[0], title: 'One more' }));
    expect(task.status).toBe(201);
    // Each tag a task gets also writes the task's tag list (tasks.tag_ids, Appendix D 42).
    const tagged = await measure('POST a task with two tags', () =>
      owner.post(s('/tasks'), { projectId: projectIds[0], title: 'Two tags', tagIds: tagIds.slice(0, 2) }),
    );
    expect(tagged.status).toBe(201);
    const comment = await measure('POST a comment', () => owner.post(s(`/tasks/${created[13]}/comments`), { body: 'hello' }));
    expect(comment.status).toBe(201);
    const worklog = await measure('POST a work log', () => owner.post(s(`/tasks/${created[13]}/worklogs`), { date: TODAY, minutes: 30 }));
    expect(worklog.status).toBe(201);

    expect((await owner.post('/api/account/reauth/password', { password: PASSWORD })).status).toBe(200);
    // Read as the bytes it is (a gzip archive: res.text() would make workerd warn that it is no text).
    const exported = await measure('GET data/export (archive v2, gzip)', async () => {
      const res = await owner.raw('GET', s('/data/export'));
      return { status: res.status, headers: res.headers, body: new Uint8Array(await res.arrayBuffer()) };
    });
    expect(exported.status).toBe(200);
    expect(exported.body.byteLength).toBeGreaterThan(0);
    expect((await measure('GET auth/status', () => owner.get('/api/auth/status'), directoryMeter)).status).toBe(200);
    const browser = new WorkerClient('192.0.2.77');
    const login = await measure(
      'POST auth/login (password)',
      () => browser.post('/api/auth/login', { identifier: 'owner@example.com', password: PASSWORD }),
      directoryMeter,
    );
    expect(login.status).toBe(200);
    // A new space: the directory's rows and the new object's (its schema included), and the init call.
    for (const createSampleData of [false, true]) {
      const made = await measure(
        `POST spaces (a new space${createSampleData ? ', with the sample data' : ''})`,
        () => owner.post('/api/spaces', { name: `Made ${createSampleData}`, createSampleData, today: TODAY }),
        everyMeter,
      );
      expect(made.status).toBe(201);
    }
  });

  it('a small project among many epics: its board reads at most 3 rows per task, and 2 per epic and tag it names', async () => {
    // The verifier's shape (Appendix D 47): 100 tasks over 32 epics and all 12 tags. A list looks up the epics
    // and tags its tasks name (two rows each), which a small list cannot spread over many tasks.
    const project = await owner.post<{ id: number }>(s('/projects'), { name: 'Delta' });
    const epics: number[] = [];
    for (let m = 0; m < 4; m++) {
      const milestone = await owner.post<{ id: number }>(s('/milestones'), { projectId: project.body.id, name: `Delta M${m}` });
      for (let e = 0; e < 8; e++) {
        const epic = await owner.post<{ id: number }>(s('/epics'), { projectId: project.body.id, name: `Delta E${m}.${e}`, milestoneId: milestone.body.id });
        epics.push(epic.body.id);
      }
    }
    const userId = (await owner.get<BootstrapDTO>(s(`/bootstrap?today=${TODAY}`))).body.user.id;
    await runInDurableObject(env.SPACES.getByName(spaceId), (_instance, state) => {
      const db = new DoDb(state.storage);
      for (let i = 0; i < 100; i++) {
        createTaskRow(
          db,
          { userId },
          taskCreateInput.parse({
            projectId: project.body.id,
            title: `Delta task ${i}`,
            epicId: epics[i % epics.length],
            statusId: statusIds[i % statusIds.length],
            tagIds: [tagIds[i % tagIds.length], tagIds[(i * 5) % tagIds.length]],
          }),
        );
      }
    });
    const board = await measure('POST tasks/query, the board of a project of 100 tasks over 32 epics', () =>
      owner.post<{ tasks: TaskDTO[] }>(s('/tasks/query'), boardQuery(project.body.id)),
    );
    const listed = board.body.tasks;
    expect(listed).toHaveLength(100);
    const named = new Set(listed.map((t) => t.epicId)).size + new Set(listed.flatMap((t) => t.tags.map((g) => g.id))).size;
    expect(board.cost.read).toBeLessThanOrEqual(3 * listed.length + 2 * named);
  });

  it('a project whose every task has three comments and two work logs: its lists cost what they did', async () => {
    // Appendix D 46: the counts are in the task rows, so a list reads no comment or work-log row.
    const projectId = projectIds[0]!;
    const before = {
      board: await measure('POST tasks/query, the board of one project (before its discussion)', () =>
        owner.post(s('/tasks/query'), boardQuery(projectId)),
      ),
      page: await measure('POST tasks/query, a page of all tasks by dueDate (before the discussion)', () =>
        owner.post(s('/tasks/query'), pageQuery('dueDate')),
      ),
    };
    const userId = (await owner.get<BootstrapDTO>(s(`/bootstrap?today=${TODAY}`))).body.user.id;
    const ids = await runInDurableObject(env.SPACES.getByName(spaceId), (_instance, state) => {
      const db = new DoDb(state.storage);
      const taskIds = db.all<{ id: number }>('SELECT id FROM tasks WHERE project_id = :projectId', { projectId }).map((r) => r.id);
      discuss(db, userId, taskIds, 3, 2);
      return taskIds;
    });
    const board = await measure(`POST tasks/query, the board of one project (${ids.length} tasks, 3 comments and 2 work logs each)`, () =>
      owner.post<{ tasks: TaskDTO[] }>(s('/tasks/query'), boardQuery(projectId)),
    );
    expect(board.body.tasks.every((t) => t.commentCount >= 3 && t.worklogMinutes >= 45)).toBe(true);
    expect(board.cost.read).toBe(before.board.cost.read);
    const page = await measure('POST tasks/query, a page of all tasks by dueDate (after the discussion)', () =>
      owner.post(s('/tasks/query'), pageQuery('dueDate')),
    );
    expect(page.cost.read).toBe(before.page.cost.read);
    const all = await measure('POST tasks/query, all tasks (after the discussion)', () =>
      owner.post(s('/tasks/query'), { filter: {}, sort: { field: 'manual', dir: 'asc' }, today: TODAY, limit: 5000 }),
    );
    expect(all.cost.read).toBeLessThanOrEqual(3 * TASKS);
    // The dashboard reads this week's work logs for its time logged (the 1,320 of today here), no more.
    const dashboard = await measure('GET dashboard (after the discussion)', () => owner.get(s(`/dashboard?today=${TODAY}`)));
    expect(dashboard.cost.read).toBeLessThanOrEqual(8_000);
  });

  it('a conditional read after an eviction', async () => {
    const etag = (await owner.get(s(`/bootstrap?today=${TODAY}`))).headers.get('ETag')!;
    await evictDurableObject(env.SPACES.getByName(spaceId));
    const requests = objectRequests();
    const started = performance.now();
    const res = await owner.get(s(`/bootstrap?today=${TODAY}`), { 'If-None-Match': etag });
    const ms = performance.now() - started;
    expect(res.status).toBe(304);
    // A fresh instance, whose meter started at zero: everything it read opening the space and answering.
    const { rowsRead: read, rowsWritten: written } = spaceMeter();
    const cost: Cost = { label: 'GET bootstrap, If-None-Match (304), after an eviction', status: res.status, read, written, objectRequests: objectRequests() - requests, ms };
    costs.push(cost);
    console.log(`[cost] ${cost.label}: ${res.status}, rows read ${read}, rows written ${written}, DO requests ${cost.objectRequests}`);
  });
});
