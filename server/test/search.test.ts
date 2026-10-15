import { describe, expect, it } from 'vitest';
import type { SearchResultDTO } from '@shared/types';
import { createTestContext } from './helpers';
import { insertEpic, insertMilestone, insertProject, insertTask, statusIdByName, T0 } from './services.fixtures';

async function setup() {
  const ctx = createTestContext();
  const { client } = await ctx.signedIn();
  const search = async (q: string, limit?: number) => {
    const res = await client.get<SearchResultDTO>(
      `/api/search?q=${encodeURIComponent(q)}${limit === undefined ? '' : `&limit=${limit}`}`,
    );
    expect(res.status).toBe(200);
    return res.body;
  };
  return { ...ctx, client, search };
}

const titles = (tasks: Array<{ title: string }>) => tasks.map((t) => t.title);
const names = (items: Array<{ name: string }>) => items.map((x) => x.name);
const at = (day: number) => `2026-03-${String(day).padStart(2, '0')}T12:00:00.000Z`;

describe('GET /api/search', () => {
  it('requires a session', async () => {
    const ctx = createTestContext();
    await ctx.signedIn();
    expect((await ctx.client().get('/api/search?q=web')).status).toBe(401);
  });

  it('validates q and limit', async () => {
    const { client } = await setup();
    const cases: Array<[string, string]> = [
      ['/api/search', 'query.q'],
      ['/api/search?q=', 'query.q'],
      ['/api/search?q=%20%20%20', 'query.q'],
      [`/api/search?q=${'x'.repeat(201)}`, 'query.q'],
      ['/api/search?q=web&limit=0', 'query.limit'],
      ['/api/search?q=web&limit=51', 'query.limit'],
      ['/api/search?q=web&limit=abc', 'query.limit'],
      ['/api/search?q=web&limit=2.5', 'query.limit'],
    ];
    for (const [url, path] of cases) {
      const res = await client.get(url);
      expect(res.status, url).toBe(400);
      expect(res.body.error.code).toBe('validation_error');
      expect(res.body.error.details[0].path).toBe(path);
    }
    expect((await client.get(`/api/search?q=${'x'.repeat(200)}&limit=50`)).status).toBe(200);
  });

  it('returns empty groups when nothing matches', async () => {
    const { db, search } = await setup();
    insertTask(db, { projectId: insertProject(db, 'WEB'), title: 'Something' });
    expect(await search('nothing-like-this')).toEqual({ tasks: [], projects: [], milestones: [], epics: [] });
  });

  it('requires every token in the title, description or ref, case-insensitively', async () => {
    const { db, search } = await setup();
    const web = insertProject(db, 'WEB');
    insertTask(db, { projectId: web, title: 'Login page', description: 'Uses OAuth' }); // WEB-1
    insertTask(db, { projectId: web, title: 'Signup page' }); // WEB-2
    insertTask(db, { projectId: web, title: 'Résumé upload', description: 'ÉCOLE import' }); // WEB-3
    insertTask(db, { projectId: web, title: 'Unrelated', description: 'nothing here' }); // WEB-4

    expect(titles((await search('PAGE')).tasks).sort()).toEqual(['Login page', 'Signup page']);
    expect(titles((await search('page oauth')).tasks)).toEqual(['Login page']); // title + description
    expect(titles((await search('web-2 page')).tasks)).toEqual(['Signup page']); // ref + title
    expect(titles((await search('école RÉSUMÉ')).tasks)).toEqual(['Résumé upload']); // Unicode folding
    expect((await search('page missing')).tasks).toEqual([]);
    const [task] = (await search('signup')).tasks;
    expect(task).toMatchObject({ ref: 'WEB-2', projectId: web, tags: [], commentCount: 0, worklogMinutes: 0 });
  });

  it('ranks the exact ref first, then title/ref matches, then description-only matches', async () => {
    const { db, search } = await setup();
    const web = insertProject(db, 'WEB');
    const me = insertProject(db, 'ME');
    // WEB-1 … WEB-12, later numbers updated more recently.
    for (let n = 1; n <= 12; n++) insertTask(db, { projectId: web, title: `Task ${n}`, updatedAt: at(n) });
    insertTask(db, { projectId: me, title: 'Notes', description: 'see web-1 for details', updatedAt: at(28) });

    const result = await search('WEB-1');
    expect(result.tasks.map((t) => t.ref)).toEqual(['WEB-1', 'WEB-12', 'WEB-11', 'WEB-10', 'ME-1']);
    expect((await search('web-12')).tasks.map((t) => t.ref)).toEqual(['WEB-12']);
  });

  it('puts title matches before description-only matches, then the most recently updated', async () => {
    const { db, search } = await setup();
    const p = insertProject(db, 'WEB');
    insertTask(db, { projectId: p, title: 'Login page', updatedAt: at(1) });
    insertTask(db, { projectId: p, title: 'Flow', description: 'the login flow', updatedAt: at(9) });
    insertTask(db, { projectId: p, title: 'Fix login bug', updatedAt: at(5) });
    insertTask(db, { projectId: p, title: 'Other', updatedAt: at(10) });
    expect(titles((await search('login')).tasks)).toEqual(['Fix login bug', 'Login page', 'Flow']);

    // More tokens in the title rank higher.
    insertTask(db, { projectId: p, title: 'Login', description: 'bug report', updatedAt: at(20) });
    insertTask(db, { projectId: p, title: 'Crash', description: 'login bug', updatedAt: at(21) });
    expect(titles((await search('login bug')).tasks)).toEqual(['Fix login bug', 'Login', 'Crash']);
  });

  it("treats '%', '_' and '\\' as plain characters", async () => {
    const { db, search } = await setup();
    const p = insertProject(db, 'WEB');
    insertTask(db, { projectId: p, title: '100% done' });
    insertTask(db, { projectId: p, title: '1000 done' });
    insertTask(db, { projectId: p, title: 'snake_case' });
    insertTask(db, { projectId: p, title: 'snakeXcase' });
    insertTask(db, { projectId: p, title: 'C:\\temp' });
    insertProject(db, 'PCT', { name: '50% off' });
    insertProject(db, 'PLN', { name: '50 off' });
    insertMilestone(db, p, { name: 'v1_0' });
    insertMilestone(db, p, { name: 'v100' });
    insertEpic(db, p, { name: 'a%b' });
    insertEpic(db, p, { name: 'aXb' });

    expect(titles((await search('100%')).tasks)).toEqual(['100% done']);
    expect(titles((await search('%')).tasks)).toEqual(['100% done']);
    expect(titles((await search('e_c')).tasks)).toEqual(['snake_case']);
    expect(titles((await search('_')).tasks)).toEqual(['snake_case']);
    expect(titles((await search('c:\\')).tasks)).toEqual(['C:\\temp']);
    expect(names((await search('%')).projects)).toEqual(['50% off']);
    expect(names((await search('1_0')).milestones)).toEqual(['v1_0']);
    expect(names((await search('a%b')).epics)).toEqual(['a%b']);
  });

  it('finds archived tasks (after live ones) and searches projects of every status', async () => {
    const { db, search } = await setup();
    const web = insertProject(db, 'WEB');
    const old = insertProject(db, 'OLD', { status: 'archived' });
    const hold = insertProject(db, 'HOLD', { status: 'on_hold' });
    // Most recently updated, but archived: ranks after the live tasks with the same relevance.
    const archived = insertTask(db, { projectId: web, title: 'Widget archived', archivedAt: T0, updatedAt: at(9) });
    insertTask(db, { projectId: old, title: 'Widget in archived project', updatedAt: at(3) });
    insertTask(db, { projectId: hold, title: 'Widget on hold', updatedAt: at(2) });
    insertTask(db, { projectId: web, title: 'Widget done', statusId: statusIdByName(db, 'Done'), updatedAt: at(1) });

    const found = (await search('widget')).tasks;
    expect(titles(found)).toEqual(['Widget in archived project', 'Widget on hold', 'Widget done', 'Widget archived']);
    expect(found.at(-1)!.archivedAt).not.toBeNull();
    // Relevance still wins: a title hit on an archived task beats a description-only live hit,
    // and an exact ref finds the archived task first.
    db.run("UPDATE tasks SET description = 'gadget' WHERE title = 'Widget on hold'");
    db.run("UPDATE tasks SET title = 'Gadget archived' WHERE id = :id", { id: archived });
    expect(titles((await search('gadget')).tasks)).toEqual(['Gadget archived', 'Widget on hold']);
    const ref = found.at(-1)!.ref;
    expect(titles((await search(ref)).tasks)[0]).toBe('Gadget archived');
  });

  it('finds projects by name, key and description with stats', async () => {
    const { db, search } = await setup();
    const me = insertProject(db, 'ME', { name: 'Personal' });
    db.run("UPDATE projects SET description = 'Some web errands' WHERE id = :id", { id: me });
    const web = insertProject(db, 'WEB', { name: 'Website relaunch' });
    insertProject(db, 'OLD', { name: 'Old web', status: 'archived' });
    insertProject(db, 'XYZ', { name: 'Unrelated' });
    insertTask(db, { projectId: web, title: 'one' });
    insertTask(db, { projectId: web, title: 'two', statusId: statusIdByName(db, 'Done') });

    const { projects } = await search('web');
    // Exact key first; then name/key matches (archived after active); description-only last.
    expect(projects.map((p) => p.key)).toEqual(['WEB', 'OLD', 'ME']);
    expect(projects[0]).toMatchObject({
      id: web,
      name: 'Website relaunch',
      status: 'active',
      stats: { tasksTotal: 2, tasksOpen: 1, tasksClosed: 1 },
    });
    expect((await search('errands')).projects.map((p) => p.key)).toEqual(['ME']);
    expect((await search('xyz')).projects.map((p) => p.key)).toEqual(['XYZ']);
  });

  it('finds milestones and epics by name and description, open ones first', async () => {
    const { db, search } = await setup();
    const p = insertProject(db, 'WEB');
    const m1 = insertMilestone(db, p, { name: 'MVP launch', status: 'completed' });
    const m2 = insertMilestone(db, p, { name: 'Launch party', status: 'active' });
    const m3 = insertMilestone(db, p, { name: 'Beta' });
    db.run("UPDATE milestones SET description = 'launch prep' WHERE id = :id", { id: m3 });
    insertMilestone(db, p, { name: 'Unrelated' });
    const e1 = insertEpic(db, p, { name: 'Design system', status: 'done', milestoneId: m1 });
    insertEpic(db, p, { name: 'System upgrade' });
    const e3 = insertEpic(db, p, { name: 'Perf' });
    db.run("UPDATE epics SET description = 'system wide' WHERE id = :id", { id: e3 });
    insertTask(db, { projectId: p, epicId: e1, estimate: 3 });

    const result = await search('launch');
    expect(result.milestones.map((m) => m.id)).toEqual([m2, m1, m3]);
    expect(result.milestones[1]).toMatchObject({ name: 'MVP launch', projectId: p, stats: { tasksTotal: 1, epicsTotal: 1, estimateTotal: 3 } });

    const epics = (await search('SYSTEM')).epics;
    expect(names(epics)).toEqual(['System upgrade', 'Design system', 'Perf']);
    expect(epics[1]).toMatchObject({ id: e1, milestoneId: m1, stats: { tasksTotal: 1, tasksClosed: 0 } });
  });

  it('limits each group (default 10)', async () => {
    const { db, search } = await setup();
    const p = insertProject(db, 'ALPHA', { name: 'alpha' });
    for (let i = 0; i < 4; i++) insertProject(db, `ALPHA${i}`, { name: `alpha ${i}` });
    for (let i = 0; i < 12; i++) insertTask(db, { projectId: p, title: `alpha task ${i}` });
    for (let i = 0; i < 4; i++) insertMilestone(db, p, { name: `alpha milestone ${i}` });
    for (let i = 0; i < 4; i++) insertEpic(db, p, { name: `alpha epic ${i}` });

    const limited = await search('alpha', 3);
    expect([limited.tasks.length, limited.projects.length, limited.milestones.length, limited.epics.length]).toEqual([3, 3, 3, 3]);
    expect(limited.projects[0]!.key).toBe('ALPHA'); // exact key

    const byDefault = await search('alpha');
    expect([byDefault.tasks.length, byDefault.projects.length, byDefault.milestones.length, byDefault.epics.length]).toEqual([10, 5, 4, 4]);
  });
});
