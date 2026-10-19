// Fold columns (design §3.4): Unicode case-insensitive uniqueness, search with the semantics of the
// lyren_lower() queries they replaced, token lists that never grow a statement's parameters, and every
// write keeping the folds current.

import { describe, expect, it } from 'vitest';
import { searchTokens } from '@shared/filter';
import type { EpicDTO, MilestoneDTO, ProjectDTO, SearchResultDTO, TaskDTO, TaskQueryResult } from '@shared/types';
import { fold } from '../../src/core/fold';
import { checkOpenedStacks, createTestContext } from '../helpers';
import { createDb } from '../services.fixtures';
import { downloadArchive, replaceImport } from '../support/archive';
import { assertFoldsConsistent, checkRegisteredFolds } from '../support/folds';
import { createSpaceHarness, type SpaceTestClient } from '../support/spaceHarness';

/** What a lyren_lower() query matched: every token occurs in the lower-cased text (JS toLowerCase). */
const matchesAll = (text: string, tokens: readonly string[]) => tokens.every((t) => text.toLowerCase().includes(t));

async function seed(client: SpaceTestClient) {
  const web = (await client.post<ProjectDTO>('/api/projects', { name: 'Überprüfung Web', key: 'WEB', description: 'Straße & Café' })).body;
  const ops = (await client.post<ProjectDTO>('/api/projects', { name: 'Opérations', key: 'OPS', description: 'ΟΔΟΣ' })).body;
  const titles: Array<[number, string, string]> = [
    [web.id, 'ÜBERPRÜFEN der Rechnung', ''],
    [web.id, 'Straße reparieren', 'mit Kies'],
    [web.id, 'ΟΔΟΣ ΚΑΙ ΣΑΣ', ''],
    [ops.id, 'İstanbul trip', 'Flüge buchen'],
    [ops.id, 'Café crème', 'CAFÉ CRÈME'],
    [ops.id, 'the quick brown fox jumps over the lazy dog', ''],
    [ops.id, 'plain ascii 100%', 'with_under\\score'],
    [web.id, 'Description only', 'überprüfen später'],
  ];
  const tasks: TaskDTO[] = [];
  for (const [projectId, title, description] of titles) {
    tasks.push((await client.post<TaskDTO>('/api/tasks', { projectId, title, description })).body);
  }
  await client.patch(`/api/tasks/${tasks[6]!.id}`, { archived: true });
  await client.patch(`/api/projects/${ops.id}`, { status: 'archived' });
  const milestones = [
    (await client.post<MilestoneDTO>('/api/milestones', { projectId: web.id, name: 'Ärger-Phase', description: 'ÉCOLE' })).body,
    (await client.post<MilestoneDTO>('/api/milestones', { projectId: ops.id, name: 'Plain', description: 'ärger' })).body,
  ];
  const epics = [
    (await client.post<EpicDTO>('/api/epics', { projectId: web.id, name: 'École', description: 'Σίσυφος' })).body,
    (await client.post<EpicDTO>('/api/epics', { projectId: ops.id, name: 'Other', description: 'école' })).body,
  ];
  return { web, ops, tasks, milestones, epics };
}

const QUERIES = [
  'überprüfen',
  'ÜBERPRÜFEN',
  'strasse',
  'straße',
  'οδος',
  'ΟΔΟΣ ΣΑΣ',
  'σασ',
  'istanbul',
  'İSTANBUL',
  'café crème',
  'CAFÉ',
  'web-1',
  'WEB',
  'ops',
  'ärger',
  'école',
  'σίσυφος',
  '%',
  'with_under\\score',
  'a e i o u',
];

describe('fold columns', () => {
  it('make tag and status names unique without regard to case, Unicode included', async () => {
    const h = createSpaceHarness();
    const owner = h.owner.client;
    const tag = (await owner.post<{ id: number }>('/api/tags', { name: 'Ärger' })).body;
    expect((await owner.post('/api/tags', { name: 'ärger' })).status).toBe(409);
    expect((await owner.post('/api/tags', { name: 'ÄRGER' })).status).toBe(409);
    expect((await owner.patch(`/api/tags/${tag.id}`, { name: 'ÄRGER' })).status).toBe(200); // its own case-only rename
    expect((await owner.post('/api/tags', { name: 'Bug' })).status).toBe(201);
    expect((await owner.post('/api/tags', { name: 'bug' })).status).toBe(409);
    expect((await owner.post('/api/tags', { name: 'Ärgernis' })).status).toBe(201);

    const status = (await owner.post<{ id: number }>('/api/statuses', { name: 'Überprüfung', category: 'started' })).body;
    expect((await owner.post('/api/statuses', { name: 'überprüfung', category: 'started' })).status).toBe(409);
    expect((await owner.patch(`/api/statuses/${status.id}`, { name: 'ÜBERPRÜFUNG' })).status).toBe(200);
    expect(h.db.get('SELECT name, name_fold FROM statuses WHERE id = :id', { id: status.id })).toEqual({
      name: 'ÜBERPRÜFUNG',
      name_fold: 'überprüfung',
    });
    assertFoldsConsistent(h.db);
  });

  it('search matches exactly what lyren_lower() matched', async () => {
    const h = createSpaceHarness();
    const owner = h.owner.client;
    const { web, ops, tasks, milestones, epics } = await seed(owner);
    const keyOf = (projectId: number) => (projectId === web.id ? 'WEB' : 'OPS');
    const projects = [web, ops];
    for (const q of QUERIES) {
      const tokens = searchTokens(q);
      const res = await owner.get<SearchResultDTO>(`/api/search?limit=50&q=${encodeURIComponent(q)}`);
      expect(res.status, q).toBe(200);
      const ids = (rows: Array<{ id: number }>) => rows.map((r) => r.id).sort((a, b) => a - b);
      expect(ids(res.body.tasks), `tasks for ${q}`).toEqual(
        ids(tasks.filter((t) => matchesAll(`${t.title}\n${t.description}\n${keyOf(t.projectId)}-${t.number}`, tokens))),
      );
      expect(ids(res.body.projects), `projects for ${q}`).toEqual(
        ids(projects.filter((p) => matchesAll(`${p.name}\n${p.key}\n${p.description}`, tokens))),
      );
      expect(ids(res.body.milestones), `milestones for ${q}`).toEqual(
        ids(milestones.filter((m) => matchesAll(`${m.name}\n${m.description}`, tokens))),
      );
      expect(ids(res.body.epics), `epics for ${q}`).toEqual(ids(epics.filter((e) => matchesAll(`${e.name}\n${e.description}`, tokens))));

      // The task filter's search uses the same columns.
      const query = await owner.post<TaskQueryResult>('/api/tasks/query', {
        filter: { search: q, includeArchivedProjects: true, archived: 'include' },
        limit: 50,
      });
      expect(ids(query.body.tasks), `tasks/query for ${q}`).toEqual(ids(res.body.tasks));
    }
  });

  it('search ranks the exact ref first, then title hits', async () => {
    const h = createSpaceHarness();
    const owner = h.owner.client;
    const { tasks } = await seed(owner);
    const ref = tasks[1]!.ref.toLowerCase();
    expect((await owner.get<SearchResultDTO>(`/api/search?q=${ref}`)).body.tasks[0]!.id).toBe(tasks[1]!.id);
    // tasks[0] has 'überprüfen' in its title; tasks[7] only in its description, and was updated later.
    const ranked = (await owner.get<SearchResultDTO>('/api/search?q=%C3%BCberpr%C3%BCfen')).body.tasks.map((t) => t.id);
    expect(ranked).toEqual([tasks[0]!.id, tasks[7]!.id]);
    expect((await owner.get<SearchResultDTO>('/api/search?q=ops')).body.projects.map((p) => p.key)).toEqual(['OPS']);
  });

  it('bind a token list as one parameter, so a query of more than 60 tokens works', async () => {
    const h = createSpaceHarness();
    const owner = h.owner.client;
    const { tasks } = await seed(owner);
    // 99 one-letter tokens (199 characters): bound one per token twice, as before, they were 198 parameters.
    const q = Array.from({ length: 99 }, (_, i) => String.fromCharCode(97 + (i % 26))).join(' ');
    expect(searchTokens(q)).toHaveLength(99);
    const search = await owner.get<SearchResultDTO>(`/api/search?q=${encodeURIComponent(q)}`);
    expect(search.status).toBe(200);
    expect(search.body.tasks.map((t) => t.id)).toEqual([tasks[5]!.id]); // the pangram
    const query = await owner.post<TaskQueryResult>('/api/tasks/query', {
      filter: { search: q, includeArchivedProjects: true },
    });
    expect(query.status).toBe(200);
    expect(query.body.tasks.map((t) => t.id)).toEqual([tasks[5]!.id]);
  });

  it('stay current through every write', async () => {
    const h = createSpaceHarness({ sampleData: true });
    const owner = h.owner.client;
    assertFoldsConsistent(h.db);
    const { web, ops, tasks, milestones, epics } = await seed(owner);
    await owner.patch(`/api/projects/${web.id}`, { name: 'ÜBERARBEITET', description: 'NEU' });
    await owner.patch(`/api/milestones/${milestones[0]!.id}`, { name: 'ZWEITE PHASE', description: 'Ära' });
    await owner.patch(`/api/epics/${epics[0]!.id}`, { name: 'ÉTÉ', description: 'Ὀδυσσεύς' });
    await owner.patch(`/api/tasks/${tasks[0]!.id}`, { title: 'GROSS', description: 'ÄÖÜ' });
    await owner.patch(`/api/tasks/${tasks[1]!.id}`, { projectId: ops.id });
    await owner.post(`/api/tasks/${tasks[2]!.id}/duplicate`);
    await owner.post('/api/tasks/bulk', { ids: [tasks[3]!.id, tasks[4]!.id], patch: { priority: 2 } });
    const tag = (await owner.post<{ id: number }>('/api/tags', { name: 'Éclair' })).body;
    await owner.patch(`/api/tags/${tag.id}`, { name: 'ÉCLAIR' });
    const status = (await owner.post<{ id: number }>('/api/statuses', { name: 'Prüfung', category: 'started' })).body;
    await owner.patch(`/api/statuses/${status.id}`, { name: 'PRÜFUNG' });
    assertFoldsConsistent(h.db);

    const file = (await downloadArchive(owner)).archive!;
    const target = createSpaceHarness();
    const mapping = { mapping: [{ archiveId: h.owner.userId, target: { kind: 'user', userId: target.owner.userId } }] };
    expect((await replaceImport(target.owner.client, file, { mapping })).status).toBe(200);
    assertFoldsConsistent(target.db);
    expect(target.db.get('SELECT COUNT(*) AS n FROM tasks')).toEqual(h.db.get('SELECT COUNT(*) AS n FROM tasks'));
  });

  it('a forgotten fold is caught, also by the checks after each test', async () => {
    const h = createSpaceHarness({ sampleData: true });
    h.db.run("UPDATE tasks SET title = 'Changed' WHERE id = 1");
    expect(() => assertFoldsConsistent(h.db)).toThrow(/tasks 1: title_fold is .*, not fold\("Changed"\)/);
    // The space harness and the service fixtures register their databases; the Node harness checks its stacks.
    expect(() => checkRegisteredFolds()).toThrow(/tasks 1: title_fold/);
    const fixture = createDb().db;
    const ctx = createTestContext();
    await ctx.signedIn();
    h.db.run("UPDATE tasks SET title_fold = :f WHERE id = 1", { f: fold('Changed') });
    fixture.run("UPDATE statuses SET name = 'Erledigt' WHERE id = 1");
    expect(() => checkRegisteredFolds()).toThrow(/statuses 1: name_fold/);
    ctx.db.run("UPDATE statuses SET name = 'Erledigt' WHERE id = 1");
    expect(() => checkOpenedStacks()).toThrow(/statuses 1: name_fold/);
    // Repaired, so that the checks after this test pass.
    for (const db of [fixture, ctx.db]) db.run("UPDATE statuses SET name_fold = :f WHERE id = 1", { f: fold('Erledigt') });
    checkRegisteredFolds();
    checkOpenedStacks();
  });
});
