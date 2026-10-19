// Demo content for first-run setup (SPEC §11). Dates are relative to the server's
// current date; history (activity) is written in chronological order.

import { defaultBoardConfig, type BoardConfigInput } from '@shared/board';
import { isClosedCategory, type EpicStatus, type MilestoneStatus, type Priority } from '@shared/constants';
import { addDays } from '@shared/dates';
import type { ActivityData } from '@shared/types';
import { fold } from '../core/fold';
import type { Db } from '../db';
import { commentExcerpt, recordActivity, type ActivityEntry } from './activity';
import { defaultStatusId, nextPosition, nextTaskNumber, uniqueProjectKey } from './entities';
import { rankForNewTask } from './rank';
import type { StatusRow, TagRow } from './rows';
import { serverToday } from './sql';

type StatusSlot = 'backlog' | 'todo' | 'doing' | 'review' | 'done' | 'cancelled';
type TagName = 'bug' | 'idea' | 'blocked' | 'quick win';

interface SampleTask {
  title: string;
  description?: string;
  epic?: string;
  status: StatusSlot;
  priority: Priority;
  /** Days relative to today. */
  start?: number;
  due?: number;
  estimate?: number;
  tags?: TagName[];
  createdDaysAgo: number;
  /** Closed tasks: when the status changed to done/cancelled. */
  closedDaysAgo?: number;
  archivedDaysAgo?: number;
  comments?: Array<{ body: string; daysAgo: number }>;
  /** day: offset from today (<= 0). */
  worklogs?: Array<{ day: number; minutes: number; note: string }>;
}

interface SampleProject {
  key: string;
  name: string;
  description: string;
  color: string;
  createdDaysAgo: number;
  milestones: Array<{ name: string; description: string; status: MilestoneStatus; start: number; due: number }>;
  epics: Array<{ name: string; milestone: string | null; color: string; status: EpicStatus; start?: number; due?: number }>;
  tasks: SampleTask[];
}

const TAG_COLORS: Record<TagName, string> = {
  bug: '#ef4444',
  idea: '#a855f7',
  blocked: '#f97316',
  'quick win': '#22c55e',
};

const WEB: SampleProject = {
  key: 'WEB',
  name: 'Website Relaunch',
  description:
    'Rebuild the marketing site on the new design system.\n\n' +
    '- **Goal:** faster pages, easier editing, consistent look\n' +
    '- **Launch:** end of the MVP milestone',
  color: '#6366f1',
  createdDaysAgo: 30,
  milestones: [
    {
      name: 'MVP launch',
      description: 'New design, migrated content and redirects live.',
      status: 'active',
      start: -28,
      due: 21,
    },
    {
      name: 'Post-launch polish',
      description: 'Performance work and the follow-ups we parked for launch.',
      status: 'planned',
      start: 22,
      due: 60,
    },
  ],
  epics: [
    { name: 'Design system', milestone: 'MVP launch', color: '#ec4899', status: 'in_progress', start: -28, due: 7 },
    { name: 'Content migration', milestone: 'MVP launch', color: '#f59e0b', status: 'in_progress', start: -20, due: 18 },
    { name: 'Performance', milestone: 'Post-launch polish', color: '#06b6d4', status: 'open', start: 22, due: 45 },
    { name: 'Analytics', milestone: null, color: '#84cc16', status: 'open' },
  ],
  tasks: [
    {
      title: 'Define color tokens and typography scale',
      description: 'Agree on semantic tokens (`surface`, `fg-muted`, `accent` …) and a modular type scale.',
      epic: 'Design system',
      status: 'done',
      priority: 3,
      due: -10,
      estimate: 3,
      createdDaysAgo: 27,
      closedDaysAgo: 9,
      worklogs: [{ day: -11, minutes: 120, note: 'Token naming workshop' }],
    },
    {
      title: 'Build button, input and select components',
      epic: 'Design system',
      status: 'done',
      priority: 2,
      due: -5,
      estimate: 5,
      createdDaysAgo: 26,
      closedDaysAgo: 4,
      worklogs: [
        { day: -6, minutes: 180, note: 'Buttons and text inputs' },
        { day: -5, minutes: 90, note: 'Select component and tests' },
      ],
    },
    {
      title: 'Dark mode for all components',
      description: 'Every component must read well in both themes. Check contrast with the token pairs.',
      epic: 'Design system',
      status: 'review',
      priority: 2,
      start: -3,
      due: 2,
      estimate: 3,
      createdDaysAgo: 20,
      comments: [{ body: 'Muted text in dark mode needs another contrast pass — see the card footer.', daysAgo: 1 }],
    },
    {
      title: 'Focus ring missing in Safari',
      description: 'Keyboard users get no visible focus on links inside cards.',
      epic: 'Design system',
      status: 'doing',
      priority: 4,
      due: 0,
      estimate: 1,
      tags: ['bug'],
      createdDaysAgo: 3,
      comments: [{ body: 'Reproducible in Safari 17 with keyboard navigation only; mouse focus is fine.', daysAgo: 2 }],
      worklogs: [{ day: 0, minutes: 45, note: 'Investigated :focus-visible behaviour' }],
    },
    {
      title: 'Document component usage',
      epic: 'Design system',
      status: 'todo',
      priority: 1,
      due: 6,
      estimate: 2,
      tags: ['idea'],
      createdDaysAgo: 15,
    },
    {
      title: 'Inventory existing pages and redirects',
      epic: 'Content migration',
      status: 'done',
      priority: 3,
      due: -14,
      estimate: 2,
      createdDaysAgo: 25,
      closedDaysAgo: 12,
    },
    {
      title: 'Migrate blog posts to Markdown',
      description: 'About 120 posts. Galleries need manual work.',
      epic: 'Content migration',
      status: 'doing',
      priority: 3,
      start: -6,
      due: -2,
      estimate: 8,
      tags: ['blocked'],
      createdDaysAgo: 18,
      comments: [
        { body: 'Blocked on the CMS export — IT promised it for Thursday.', daysAgo: 4 },
        { body: 'Exported 40 of 120 posts; the rest have embedded galleries.', daysAgo: 1 },
      ],
      worklogs: [{ day: -2, minutes: 150, note: 'Migrated the first batch of posts' }],
    },
    {
      title: 'Set up 301 redirects for old URLs',
      epic: 'Content migration',
      status: 'todo',
      priority: 4,
      due: 1,
      estimate: 2,
      createdDaysAgo: 12,
    },
    {
      title: 'Proofread About and Team pages',
      epic: 'Content migration',
      status: 'todo',
      priority: 1,
      due: 4,
      estimate: 1,
      tags: ['quick win'],
      createdDaysAgo: 10,
    },
    {
      title: 'Merge duplicate press-release pages',
      epic: 'Content migration',
      status: 'cancelled',
      priority: 0,
      createdDaysAgo: 16,
      closedDaysAgo: 6,
      comments: [{ body: 'Not needed — the old press section is being dropped entirely.', daysAgo: 6 }],
    },
    {
      title: 'Lazy-load below-the-fold images',
      epic: 'Performance',
      status: 'backlog',
      priority: 2,
      due: 40,
      estimate: 2,
      tags: ['quick win'],
      createdDaysAgo: 14,
    },
    {
      title: 'Hero image causes layout shift on mobile',
      epic: 'Performance',
      status: 'todo',
      priority: 3,
      due: -1,
      estimate: 1,
      tags: ['bug'],
      createdDaysAgo: 5,
    },
    {
      title: 'Add a performance budget to CI',
      epic: 'Performance',
      status: 'backlog',
      priority: 1,
      estimate: 3,
      tags: ['idea'],
      createdDaysAgo: 9,
    },
    {
      title: 'Choose a privacy-friendly analytics setup',
      description: 'Self-hosted, no cookies, no third-party requests.',
      epic: 'Analytics',
      status: 'doing',
      priority: 2,
      due: 3,
      estimate: 2,
      createdDaysAgo: 8,
    },
    {
      title: 'Define the key conversion events',
      epic: 'Analytics',
      status: 'backlog',
      priority: 0,
      tags: ['idea'],
      createdDaysAgo: 7,
    },
    {
      title: 'Contact form sends duplicate emails',
      status: 'todo',
      priority: 4,
      due: -3,
      estimate: 2,
      tags: ['bug', 'blocked'],
      createdDaysAgo: 6,
    },
    {
      title: 'Landing page A/B experiment',
      status: 'done',
      priority: 0,
      createdDaysAgo: 29,
      closedDaysAgo: 24,
      archivedDaysAgo: 20,
    },
  ],
};

const PERSONAL: SampleProject = {
  key: 'ME',
  name: 'Personal',
  description: 'Errands and personal to-dos.',
  color: '#10b981',
  createdDaysAgo: 21,
  milestones: [],
  epics: [],
  tasks: [
    { title: 'Renew passport', status: 'todo', priority: 3, due: 10, createdDaysAgo: 12 },
    { title: 'Book dentist appointment', status: 'todo', priority: 2, due: 2, tags: ['quick win'], createdDaysAgo: 4 },
    { title: 'Plan a weekend hiking trip', status: 'backlog', priority: 1, tags: ['idea'], createdDaysAgo: 3 },
    {
      title: 'File tax return',
      status: 'done',
      priority: 4,
      due: -7,
      createdDaysAgo: 19,
      closedDaysAgo: 8,
      worklogs: [{ day: -8, minutes: 60, note: 'Filled in the forms' }],
    },
  ],
};

/**
 * Create the demo projects (SPEC §11) for `userId`. Must run inside the caller's
 * transaction. Safe on a non-empty database: existing tags are reused and project keys
 * are made unique.
 */
export function buildSampleData(db: Db, userId: number, clientToday?: string): void {
  const nowMs = Date.now();
  const today = clientToday ?? serverToday();
  /** Timestamp `days` days before now, nudged back by `seq` minutes so entries keep their order. */
  const ago = (days: number, seq = 0): string => new Date(nowMs - days * 86_400_000 - seq * 60_000).toISOString();
  const day = (offset: number | undefined): string | null => (offset === undefined ? null : addDays(today, offset));
  const pendingActivity: ActivityEntry[] = [];
  const log = (entry: Omit<ActivityEntry, 'userId'>) => pendingActivity.push({ ...entry, userId });

  const statuses = db.all<StatusRow>('SELECT * FROM statuses ORDER BY position, id');
  const byCategory = (category: StatusRow['category']) => statuses.filter((s) => s.category === category);
  const fallback = defaultStatusId(db);
  const started = byCategory('started');
  const slotStatus: Record<StatusSlot, number> = {
    backlog: byCategory('backlog')[0]?.id ?? fallback,
    todo: fallback,
    doing: started[0]?.id ?? fallback,
    review: started[1]?.id ?? started[0]?.id ?? fallback,
    done: byCategory('completed')[0]?.id ?? fallback,
    cancelled: byCategory('cancelled')[0]?.id ?? byCategory('completed')[0]?.id ?? fallback,
  };
  const statusById = new Map(statuses.map((s) => [s.id, s]));

  const tagIds = new Map<TagName, number>();
  for (const name of Object.keys(TAG_COLORS) as TagName[]) {
    const existing = db.get<TagRow>('SELECT * FROM tags WHERE name = :name', { name });
    const id =
      existing?.id ??
      db.run(
        'INSERT INTO tags (name, name_fold, color, created_at, updated_at) VALUES (:name, :nameFold, :color, :now, :now)',
        { name, nameFold: fold(name), color: TAG_COLORS[name], now: ago(30) },
      ).lastInsertRowid;
    tagIds.set(name, id);
  }

  const projectIds: number[] = [];
  for (const project of [WEB, PERSONAL]) {
    const created = ago(project.createdDaysAgo);
    const key = uniqueProjectKey(db, project.key);
    const projectId = db.run(
      `INSERT INTO projects (key, name, name_fold, description, description_fold, color, status, position, created_at,
                             updated_at)
       VALUES (:key, :name, :nameFold, :description, :descriptionFold, :color, 'active', :position, :created, :created)`,
      {
        key,
        name: project.name,
        nameFold: fold(project.name),
        description: project.description,
        descriptionFold: fold(project.description),
        color: project.color,
        position: nextPosition(db, 'projects'),
        created,
      },
    ).lastInsertRowid;
    projectIds.push(projectId);
    log({
      projectId,
      taskId: null,
      entityType: 'project',
      entityId: projectId,
      action: 'project.created',
      data: { name: project.name },
      createdAt: created,
    });

    const milestoneIds = new Map<string, number>();
    project.milestones.forEach((m, i) => {
      const at = ago(project.createdDaysAgo, -(i + 1));
      const id = db.run(
        `INSERT INTO milestones (project_id, name, name_fold, description, description_fold, status, start_date, due_date,
                                position, created_at, updated_at)
         VALUES (:projectId, :name, :nameFold, :description, :descriptionFold, :status, :start, :due, :position, :at, :at)`,
        {
          ...m,
          nameFold: fold(m.name),
          descriptionFold: fold(m.description),
          projectId,
          start: day(m.start),
          due: day(m.due),
          position: i,
          at,
        },
      ).lastInsertRowid;
      milestoneIds.set(m.name, id);
      log({
        projectId,
        taskId: null,
        entityType: 'milestone',
        entityId: id,
        action: 'milestone.created',
        data: { name: m.name },
        createdAt: at,
      });
    });

    const epicIds = new Map<string, number>();
    project.epics.forEach((e, i) => {
      const at = ago(project.createdDaysAgo, -(10 + i));
      const id = db.run(
        `INSERT INTO epics (project_id, milestone_id, name, name_fold, description, description_fold, color, status,
                            start_date, due_date, position, created_at, updated_at)
         VALUES (:projectId, :milestoneId, :name, :nameFold, '', '', :color, :status, :start, :due, :position, :at, :at)`,
        {
          ...e,
          nameFold: fold(e.name),
          projectId,
          milestoneId: e.milestone === null ? null : (milestoneIds.get(e.milestone) ?? null),
          start: day(e.start),
          due: day(e.due),
          position: i,
          at,
        },
      ).lastInsertRowid;
      epicIds.set(e.name, id);
      log({
        projectId,
        taskId: null,
        entityType: 'epic',
        entityId: id,
        action: 'epic.created',
        data: { name: e.name },
        createdAt: at,
      });
    });

    project.tasks.forEach((t, i) => {
      const statusId = slotStatus[t.status];
      const status = statusById.get(statusId);
      const closed = status ? isClosedCategory(status.category) : false;
      const created = ago(t.createdDaysAgo, i);
      const completed = closed ? ago(t.closedDaysAgo ?? 0, i) : null;
      const archived = t.archivedDaysAgo === undefined ? null : ago(t.archivedDaysAgo, i);
      const updated = [created, completed, archived].filter((v): v is string => v !== null).sort().at(-1)!;
      const number = nextTaskNumber(db, projectId);
      const ref = `${key}-${number}`;
      const taskId = db.run(
        `INSERT INTO tasks (project_id, number, epic_id, status_id, title, title_fold, description, description_fold,
                            priority, start_date, due_date, estimate, rank, completed_at, archived_at, created_by,
                            created_at, updated_at)
         VALUES (:projectId, :number, :epicId, :statusId, :title, :titleFold, :description, :descriptionFold,
                 :priority, :start, :due, :estimate, :rank, :completed, :archived, :userId, :created, :updated)`,
        {
          projectId,
          number,
          epicId: t.epic === undefined ? null : (epicIds.get(t.epic) ?? null),
          statusId,
          title: t.title,
          titleFold: fold(t.title),
          description: t.description ?? '',
          descriptionFold: fold(t.description ?? ''),
          priority: t.priority,
          start: day(t.start),
          due: day(t.due),
          estimate: t.estimate ?? null,
          rank: rankForNewTask(db, 'bottom'),
          completed,
          archived,
          userId,
          created,
          updated,
        },
      ).lastInsertRowid;
      for (const tag of t.tags ?? []) {
        db.run('INSERT INTO task_tags (task_id, tag_id) VALUES (:taskId, :tagId)', { taskId, tagId: tagIds.get(tag)! });
      }
      const subject: ActivityData = { title: t.title, ref };
      const taskEvent = (action: ActivityEntry['action'], data: ActivityData, createdAt: string) =>
        log({ projectId, taskId, entityType: 'task', entityId: taskId, action, data, createdAt });
      taskEvent('task.created', subject, created);

      if (completed !== null && status && fallback !== statusId) {
        const from = statusById.get(fallback);
        taskEvent(
          'task.updated',
          {
            ...subject,
            changes: [
              { field: 'status', from: fallback, to: statusId, fromLabel: from?.name ?? null, toLabel: status.name },
            ],
          },
          completed,
        );
      }
      if (archived !== null) {
        taskEvent('task.updated', { ...subject, changes: [{ field: 'archived', from: false, to: true }] }, archived);
      }

      for (const c of t.comments ?? []) {
        const at = ago(c.daysAgo, i);
        const id = db.run(
          `INSERT INTO comments (task_id, user_id, body, created_at, updated_at)
           VALUES (:taskId, :userId, :body, :at, :at)`,
          { taskId, userId, body: c.body, at },
        ).lastInsertRowid;
        log({
          projectId,
          taskId,
          entityType: 'comment',
          entityId: id,
          action: 'comment.created',
          data: { excerpt: commentExcerpt(c.body), title: t.title, ref },
          createdAt: at,
        });
      }

      for (const w of t.worklogs ?? []) {
        // Logged in the evening of that day, but never in the future.
        const at = new Date(Math.min(nowMs - 60_000, Date.parse(`${addDays(today, w.day)}T17:30:00.000Z`))).toISOString();
        const date = addDays(today, w.day);
        const id = db.run(
          `INSERT INTO work_logs (task_id, user_id, date, minutes, note, created_at, updated_at)
           VALUES (:taskId, :userId, :date, :minutes, :note, :at, :at)`,
          { taskId, userId, date, minutes: w.minutes, note: w.note, at },
        ).lastInsertRowid;
        log({
          projectId,
          taskId,
          entityType: 'worklog',
          entityId: id,
          action: 'worklog.created',
          data: { minutes: w.minutes, date, note: w.note, title: t.title, ref },
          createdAt: at,
        });
      }
    });
  }

  // Activity ids follow time so feeds (newest first by id) read naturally.
  pendingActivity
    .sort((a, b) => (a.createdAt! < b.createdAt! ? -1 : a.createdAt! > b.createdAt! ? 1 : 0))
    .forEach((entry) => recordActivity(db, entry));

  const [webId] = projectIds as [number, number];
  const boardAt = ago(0, 1);
  const insertBoard = (projectId: number | null, name: string, description: string, config: BoardConfigInput) =>
    db.run(
      `INSERT INTO boards (project_id, name, description, config, position, created_at, updated_at)
       VALUES (:projectId, :name, :description, :config, :position, :at, :at)`,
      {
        projectId,
        name,
        description,
        config: JSON.stringify(defaultBoardConfig(config)),
        position: nextPosition(db, 'boards', projectId),
        at: boardAt,
      },
    );
  insertBoard(webId, 'WEB board', 'Status columns with one lane per epic.', {
    filter: { projectIds: [webId], closedWithinDays: 14 },
    columns: { groupBy: 'status' },
    swimlanes: { groupBy: 'epic' },
    // A project board with epic lanes: the project and epic chips would repeat on every card.
    card: { fields: { project: false, epic: false } },
  });
  insertBoard(null, 'Priority triage', 'Everything open across projects by priority; closed tasks hide after 7 days.', {
    filter: { closedWithinDays: 7 },
    columns: { groupBy: 'priority' },
    swimlanes: { groupBy: 'project' },
    card: { colorBy: 'project' },
  });
}
