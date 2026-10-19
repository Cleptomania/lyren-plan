// A space archive v2 of the platform review's shape (design §11.2: 2,001 tasks with 4,002 tag rows, 40 epics,
// 12 tags, 306 comments, 2,417 activity entries, about 1.8 MB), made up from a fixed seed, for the import cost
// tests (server/test-workers/importCost.test.ts: the estimate against what a Durable Object bills) and the
// Node tests that need a large archive. Three accounts and a placeholder; some comments carry a provenance;
// estimates are decimals and ranks unsorted, so the import's REAL values and rank order are exercised.

import type { SpaceArchiveDTO } from '@shared/types';

export interface ReviewShape {
  tasks: number;
  comments: number;
  worklogs: number;
  /** Activity entries besides one task.created per task and one comment.created per comment. */
  extraActivity: number;
}

export const REVIEW_SHAPE: ReviewShape = { tasks: 2001, comments: 306, worklogs: 120, extraActivity: 110 };

const TS = '2026-10-01T09:00:00.000Z';
const at = (i: number) => new Date(Date.parse(TS) + i * 60_000).toISOString();
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** The archive (owner id 1, Bob 2, Carol 3, placeholder -1). */
export function reviewArchive(shape: ReviewShape = REVIEW_SHAPE): SpaceArchiveDTO {
  let seed = 20261018;
  const random = (n: number) => ((seed = (seed * 48271) % 2147483647), seed % n);
  const authors = [1, 1, 1, 2, 3, -1];
  const statuses = [
    { id: 1, name: 'Backlog', category: 'backlog' as const, color: '#94a3b8', position: 0 },
    { id: 2, name: 'Todo', category: 'unstarted' as const, color: '#64748b', position: 1 },
    { id: 3, name: 'In progress', category: 'started' as const, color: '#3b82f6', position: 2 },
    { id: 4, name: 'Done', category: 'completed' as const, color: '#22c55e', position: 3 },
    { id: 5, name: 'Cancelled', category: 'cancelled' as const, color: '#ef4444', position: 4 },
  ];
  const tags = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, name: `tag ${i + 1}`, color: '#336699', createdAt: TS }));
  const projects = Array.from({ length: 3 }, (_, i) => ({
    id: i + 1,
    key: `P${i + 1}X`,
    name: `Project ${i + 1}`,
    description: `The ${i + 1}. project, with a description long enough to fold.`,
    color: '#123456',
    status: 'active' as const,
    position: i,
    taskCounter: 0,
    createdAt: TS,
    updatedAt: TS,
  }));
  const milestones = Array.from({ length: 9 }, (_, i) => ({
    id: i + 1,
    projectId: (i % 3) + 1,
    name: `Milestone ${i + 1}`,
    description: '',
    status: 'active' as const,
    startDate: null,
    dueDate: '2026-12-31',
    position: i,
    completedAt: null,
    createdAt: TS,
    updatedAt: TS,
  }));
  const epics = Array.from({ length: 40 }, (_, i) => ({
    id: i + 1,
    projectId: (i % 3) + 1,
    // Every other epic in a milestone of its project (milestone k + 3j belongs to project k).
    milestoneId: i % 2 === 0 ? null : (i % 3) + 1 + 3 * (i % 3),
    name: `Epic ${i + 1}`,
    description: 'An epic',
    color: '#654321',
    status: 'open' as const,
    startDate: null,
    dueDate: null,
    position: i,
    completedAt: null,
    createdAt: TS,
    updatedAt: TS,
  }));
  const numbers = new Map<number, number>();
  const tasks = Array.from({ length: shape.tasks }, (_, i) => {
    const projectId = (i % 3) + 1;
    const number = (numbers.get(projectId) ?? 0) + 1;
    numbers.set(projectId, number);
    const status = statuses[random(5)]!;
    const closed = status.category === 'completed' || status.category === 'cancelled';
    const first = random(12) + 1;
    const second = ((first + random(11)) % 12) + 1;
    const epic = random(4) === 0 ? null : epics.filter((e) => e.projectId === projectId)[random(13)]?.id ?? null;
    return {
      id: i + 1,
      projectId,
      number,
      epicId: epic,
      statusId: status.id,
      priority: random(5) as 0 | 1 | 2 | 3 | 4,
      title: `Task ${i + 1}: ${['Fix', 'Ship', 'Écrire', 'Prüfen', 'Plan'][random(5)]} the ${random(1000)} widgets`,
      description: random(3) === 0 ? '' : `Details of task ${i + 1}. ${'Lorem ipsum dolor sit amet. '.repeat(random(4) + 1)}`,
      startDate: null,
      dueDate: random(4) === 0 ? `2026-11-${String(random(28) + 1).padStart(2, '0')}` : null,
      estimate: random(3) === 0 ? null : random(400) / 10 + 0.05 * random(3),
      rank: Array.from({ length: 3 + random(6) }, () => ALPHABET[random(62)]).join(''),
      completedAt: closed ? at(i) : null,
      archivedAt: random(20) === 0 ? at(i) : null,
      createdBy: authors[random(authors.length)]!,
      createdAt: at(i),
      updatedAt: at(i + 1),
      tagIds: [first, second],
    };
  });
  for (const p of projects) p.taskCounter = numbers.get(p.id) ?? 0;
  const comments = Array.from({ length: shape.comments }, (_, i) => {
    const authorId = authors[random(authors.length)]!;
    return {
      id: i + 1,
      taskId: random(shape.tasks) + 1,
      body: `Comment ${i + 1}: ${'some words '.repeat(random(8) + 1)}`,
      authorId,
      createdAt: at(i),
      updatedAt: at(i),
      editedAt: null,
      ...(authorId !== 1 && random(2) === 0 ? { importedBy: 1, importedAt: at(i + 5) } : {}),
    };
  });
  const worklogs = Array.from({ length: shape.worklogs }, (_, i) => ({
    id: i + 1,
    taskId: random(shape.tasks) + 1,
    date: `2026-10-${String(random(28) + 1).padStart(2, '0')}`,
    minutes: random(5) === 0 ? null : 15 * (random(8) + 1),
    note: 'Worked on it',
    authorId: authors[random(authors.length)]!,
    createdAt: at(i),
    updatedAt: at(i),
  }));
  const activity: SpaceArchiveDTO['activity'] = [];
  for (const t of tasks) {
    activity.push({
      id: activity.length + 1,
      action: 'task.created',
      entityType: 'task',
      entityId: t.id,
      projectId: t.projectId,
      taskId: t.id,
      data: { title: t.title, ref: `P${t.projectId}X-${t.number}` },
      actorId: t.createdBy,
      createdAt: t.createdAt,
    });
  }
  for (const c of comments) {
    activity.push({
      id: activity.length + 1,
      action: 'comment.created',
      entityType: 'comment',
      entityId: c.id,
      projectId: tasks[c.taskId - 1]!.projectId,
      taskId: c.taskId,
      data: { excerpt: c.body.slice(0, 40) },
      actorId: c.authorId,
      createdAt: c.createdAt,
    });
  }
  for (let i = 0; i < shape.extraActivity; i++) {
    const t = tasks[random(shape.tasks)]!;
    activity.push({
      id: activity.length + 1,
      action: 'task.updated',
      entityType: 'task',
      entityId: t.id,
      projectId: t.projectId,
      taskId: t.id,
      data: { changes: [{ field: 'priority', from: 1, to: 2 }] },
      actorId: authors[random(authors.length)]!,
      createdAt: at(i),
    });
  }
  const boards = [
    { id: 1, projectId: null, name: 'All tasks', description: '', config: { filter: { closedWithinDays: 14 } }, position: 0, createdAt: TS, updatedAt: TS },
    ...projects.map((p, i) => ({
      id: i + 2,
      projectId: p.id,
      name: `${p.name} board`,
      description: '',
      config: { filter: { projectIds: [p.id] }, columns: { groupBy: 'status' } },
      position: 0,
      createdAt: TS,
      updatedAt: TS,
    })),
  ] as unknown as SpaceArchiveDTO['boards'];
  return {
    format: 'lyren-plan-space',
    formatVersion: 2,
    exportedAt: TS,
    appVersion: 'fixture',
    space: { id: '7k2m9q4w8x1c3v5b', name: 'Review space', exportedBy: 1 },
    users: [
      { id: -1, kind: 'placeholder', displayName: 'Former member', email: null },
      { id: 1, kind: 'account', displayName: 'Owner', email: 'owner@example.com' },
      { id: 2, kind: 'account', displayName: 'Bob', email: 'bob@example.com' },
      { id: 3, kind: 'account', displayName: 'Carol', email: 'carol@example.com' },
    ],
    settings: { estimateUnit: 'points', defaultBoardId: 1 },
    statuses,
    tags,
    projects,
    milestones,
    epics,
    tasks,
    comments,
    worklogs,
    activity,
    boards,
  };
}
