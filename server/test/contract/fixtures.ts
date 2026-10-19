// Direct-database fixtures for the space service tests (no HTTP), on any Db: a space database set up as
// createDb does (design §14.3, §14.4), and inserts through the same helpers the routes use for numbering
// and ranks, writing the fold columns as the routes do. The contract suites (services.*.contract.ts) get
// their databases from a WithSpaceDb, which runs a synchronous body on a fresh space database of the
// adapter under test (server/test/services.fixtures.ts on NodeDb, server/test-workers on DoDb) and checks
// its folds, tag lists and task counts when the body is done.

import type { EpicStatus, MilestoneStatus, Priority, ProjectStatus, StatusCategory } from '@shared/constants';
import type { RankPosition } from '@shared/schemas';
import { fold } from '../../src/core/fold';
import { migrate } from '../../src/core/migrate';
import { APP_VERSION } from '../../src/core/version';
import type { Db } from '../../src/db';
import { ensureDefaults } from '../../src/db/seed';
import { nextPosition, nextTaskNumber } from '../../src/services/entities';
import { rankForNewTask } from '../../src/services/rank';
import type { StatusRow, TaskRow } from '../../src/services/rows';
import { SPACE_MIGRATIONS } from '../../src/space/schema';
import { assertFoldsConsistent, assertTagListsConsistent, assertTaskCountsConsistent } from '../support/folds';

export const T0 = '2026-03-01T09:00:00.000Z';

export interface SpaceDb {
  db: Db;
  userId: number;
}

/** Runs `body` on a fresh space database of the adapter under test and returns its result. */
export type WithSpaceDb = <T>(body: (space: SpaceDb) => T) => Promise<T>;

/** Makes `db` (empty) a space database (migrate(SPACE)) with the owner's mirror row (id 1) and the defaults. */
export function initTestSpace(db: Db): SpaceDb {
  migrate(db, SPACE_MIGRATIONS, { appVersion: APP_VERSION });
  const userId = 1;
  db.run(
    `INSERT INTO users (id, kind, display_name, email, is_member, updated_at)
     VALUES (:userId, 'account', 'Owner', 'owner@example.com', 1, :t)`,
    { userId, t: T0 },
  );
  ensureDefaults(db);
  return { db, userId };
}

/** What a WithSpaceDb checks once its body is done: the fold columns and the tasks' tag lists. */
export function checkSpaceDb(db: Db): void {
  assertFoldsConsistent(db);
  assertTagListsConsistent(db);
  assertTaskCountsConsistent(db);
}

export function statusIdByName(db: Db, name: string): number {
  return db.get<{ id: number }>('SELECT id FROM statuses WHERE name = :name', { name })!.id;
}

export function insertStatus(db: Db, name: string, category: StatusCategory, position?: number): number {
  return db.run(
    `INSERT INTO statuses (name, name_fold, category, color, position, created_at, updated_at)
     VALUES (:name, :nameFold, :category, '#64748b', :position, :t, :t)`,
    { name, nameFold: fold(name), category, position: position ?? nextPosition(db, 'statuses'), t: T0 },
  ).lastInsertRowid;
}

export function insertProject(
  db: Db,
  key: string,
  opts: { name?: string; status?: ProjectStatus } = {},
): number {
  const name = opts.name ?? `Project ${key}`;
  return db.run(
    `INSERT INTO projects (key, name, name_fold, description_fold, color, status, position, created_at, updated_at)
     VALUES (:key, :name, :nameFold, '', '#6366f1', :status, :position, :t, :t)`,
    { key, name, nameFold: fold(name), status: opts.status ?? 'active', position: nextPosition(db, 'projects'), t: T0 },
  ).lastInsertRowid;
}

export function insertMilestone(
  db: Db,
  projectId: number,
  opts: { name?: string; status?: MilestoneStatus } = {},
): number {
  const name = opts.name ?? 'Milestone';
  return db.run(
    `INSERT INTO milestones (project_id, name, name_fold, description_fold, status, position, created_at, updated_at)
     VALUES (:projectId, :name, :nameFold, '', :status, :position, :t, :t)`,
    {
      projectId,
      name,
      nameFold: fold(name),
      status: opts.status ?? 'planned',
      position: nextPosition(db, 'milestones', projectId),
      t: T0,
    },
  ).lastInsertRowid;
}

export function insertEpic(
  db: Db,
  projectId: number,
  opts: { milestoneId?: number | null; name?: string; status?: EpicStatus } = {},
): number {
  const name = opts.name ?? 'Epic';
  return db.run(
    `INSERT INTO epics (project_id, milestone_id, name, name_fold, description_fold, color, status, position, created_at,
                        updated_at)
     VALUES (:projectId, :milestoneId, :name, :nameFold, '', '#8b5cf6', :status, :position, :t, :t)`,
    {
      projectId,
      milestoneId: opts.milestoneId ?? null,
      name,
      nameFold: fold(name),
      status: opts.status ?? 'open',
      position: nextPosition(db, 'epics', projectId),
      t: T0,
    },
  ).lastInsertRowid;
}

export function insertTag(db: Db, name: string): number {
  return db.run(
    "INSERT INTO tags (name, name_fold, color, created_at, updated_at) VALUES (:name, :nameFold, '#64748b', :t, :t)",
    { name, nameFold: fold(name), t: T0 },
  ).lastInsertRowid;
}

export interface TaskFixture {
  projectId: number;
  statusId?: number;
  epicId?: number | null;
  title?: string;
  description?: string;
  priority?: Priority;
  startDate?: string | null;
  dueDate?: string | null;
  estimate?: number | null;
  completedAt?: string | null;
  archivedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
  tagIds?: number[];
  position?: RankPosition;
  rank?: string;
}

export function insertTask(db: Db, t: TaskFixture): number {
  const statusId =
    t.statusId ?? db.get<StatusRow>("SELECT * FROM statuses WHERE category = 'unstarted' ORDER BY position")!.id;
  const title = t.title ?? 'Task';
  const description = t.description ?? '';
  const id = db.run(
    `INSERT INTO tasks (project_id, number, epic_id, status_id, title, title_fold, description, description_fold,
                        priority, start_date, due_date, estimate, rank, completed_at, archived_at, created_by, created_at,
                        updated_at)
     VALUES (:projectId, :number, :epicId, :statusId, :title, :titleFold, :description, :descriptionFold,
             :priority, :startDate, :dueDate, :estimate, :rank, :completedAt, :archivedAt, NULL, :createdAt, :updatedAt)`,
    {
      projectId: t.projectId,
      number: nextTaskNumber(db, t.projectId),
      epicId: t.epicId ?? null,
      statusId,
      title,
      titleFold: fold(title),
      description,
      descriptionFold: fold(description),
      priority: t.priority ?? 0,
      startDate: t.startDate ?? null,
      dueDate: t.dueDate ?? null,
      estimate: t.estimate ?? null,
      rank: t.rank ?? rankForNewTask(db, t.position),
      completedAt: t.completedAt ?? null,
      archivedAt: t.archivedAt ?? null,
      createdAt: t.createdAt ?? T0,
      updatedAt: t.updatedAt ?? t.createdAt ?? T0,
    },
  ).lastInsertRowid;
  for (const tagId of t.tagIds ?? []) {
    db.run('INSERT INTO task_tags (task_id, tag_id) VALUES (:id, :tagId)', { id, tagId });
  }
  return id;
}

export function taskRow(db: Db, id: number): TaskRow {
  return db.get<TaskRow>('SELECT * FROM tasks WHERE id = :id', { id })!;
}

/** Deterministic PRNG (mulberry32) so randomized tests are reproducible. */
export function prng(seed: number) {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1));
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
  const chance = (p: number): boolean => next() < p;
  const subset = <T>(items: readonly T[], p = 0.4): T[] => items.filter(() => next() < p);
  return { next, int, pick, chance, subset };
}
