// /api/data — JSON export, JSON import (replace everything) and SQLite backup download.
//
// Export: every domain row with original ids (ExportDTO). Internal '_' settings, users and
// sessions are never exported.
// Import (SPEC §5.10): shape validation (exportSchema) → referential-integrity checks → safety
// snapshot (DATA_DIR/backups/pre-import-<ts>.db; older ones beyond SNAPSHOT_KEEP are deleted,
// see db/snapshots.ts) → ONE transaction replacing all domain rows.
// Any validation failure is a 400 listing the problems, and nothing is changed.
// Backup (SPEC §7): VACUUM INTO a temp file in DATA_DIR, strip sessions from the copy, stream it,
// and always remove the temp file (also when the download is aborted).

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Hono, type Context } from 'hono';
import { parseBoardConfigLenient } from '@shared/board';
import { isClosedCategory, type StatusCategory } from '@shared/constants';
import { exportSchema, IMPORT_INT_MAX, sanitizeActivityData, type ExportParsed } from '@shared/export';
import type { ExportDTO } from '@shared/types';
import { currentUser } from '../auth/context';
import { APP_VERSION } from '../config';
import { stripSessions, type Db } from '../db';
import { logPrune, pruneSnapshots, snapshotStamp } from '../db/snapshots';
import type { AppEnv, Deps } from '../env';
import { badRequest, validationError } from '../http/errors';
import { parseJson, toBoardDTO } from '../services/mappers';
import { renormalizeRanks } from '../services/rank';
import type {
  ActivityRow,
  BoardRow,
  CommentRow,
  EpicRow,
  MilestoneRow,
  ProjectRow,
  StatusRow,
  TagRow,
  TaskRow,
  WorklogRow,
} from '../services/rows';
import { getSettings, saveSettings } from '../services/settings';
import { nowIso, serverToday } from '../services/sql';

/** Problems listed in a 400 response at most (the message states the total). */
const MAX_PROBLEMS = 50;

type Problem = { path: string; message: string };

function attachment(c: Context, filename: string): void {
  c.header('Content-Disposition', `attachment; filename="${filename}"`);
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function buildExport(db: Db): ExportDTO {
  const tagIdsByTask = new Map<number, number[]>();
  for (const { task_id, tag_id } of db.all<{ task_id: number; tag_id: number }>(
    'SELECT task_id, tag_id FROM task_tags ORDER BY task_id, tag_id',
  )) {
    const list = tagIdsByTask.get(task_id);
    if (list) list.push(tag_id);
    else tagIdsByTask.set(task_id, [tag_id]);
  }

  return {
    format: 'lyren-plan-export',
    formatVersion: 1,
    exportedAt: nowIso(),
    appVersion: APP_VERSION,
    settings: getSettings(db),
    statuses: db.all<StatusRow>('SELECT * FROM statuses ORDER BY position, id').map((s) => ({
      id: s.id,
      name: s.name,
      category: s.category,
      color: s.color,
      position: s.position,
    })),
    tags: db.all<TagRow>('SELECT * FROM tags ORDER BY id').map((t) => ({
      id: t.id,
      name: t.name,
      color: t.color,
      createdAt: t.created_at,
    })),
    projects: db.all<ProjectRow>('SELECT * FROM projects ORDER BY position, id').map((p) => ({
      id: p.id,
      key: p.key,
      name: p.name,
      description: p.description,
      color: p.color,
      status: p.status,
      position: p.position,
      taskCounter: p.task_counter,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
    })),
    milestones: db.all<MilestoneRow>('SELECT * FROM milestones ORDER BY project_id, position, id').map((m) => ({
      id: m.id,
      projectId: m.project_id,
      name: m.name,
      description: m.description,
      status: m.status,
      startDate: m.start_date,
      dueDate: m.due_date,
      position: m.position,
      completedAt: m.completed_at,
      createdAt: m.created_at,
      updatedAt: m.updated_at,
    })),
    epics: db.all<EpicRow>('SELECT * FROM epics ORDER BY project_id, position, id').map((e) => ({
      id: e.id,
      projectId: e.project_id,
      milestoneId: e.milestone_id,
      name: e.name,
      description: e.description,
      color: e.color,
      status: e.status,
      startDate: e.start_date,
      dueDate: e.due_date,
      position: e.position,
      completedAt: e.completed_at,
      createdAt: e.created_at,
      updatedAt: e.updated_at,
    })),
    tasks: db.all<TaskRow>('SELECT * FROM tasks ORDER BY id').map((t) => ({
      id: t.id,
      projectId: t.project_id,
      number: t.number,
      epicId: t.epic_id,
      statusId: t.status_id,
      priority: t.priority,
      title: t.title,
      description: t.description,
      startDate: t.start_date,
      dueDate: t.due_date,
      estimate: t.estimate,
      rank: t.rank,
      completedAt: t.completed_at,
      archivedAt: t.archived_at,
      createdBy: t.created_by,
      createdAt: t.created_at,
      updatedAt: t.updated_at,
      tagIds: tagIdsByTask.get(t.id) ?? [],
    })),
    comments: db.all<CommentRow>('SELECT * FROM comments ORDER BY id').map((cm) => ({
      id: cm.id,
      taskId: cm.task_id,
      body: cm.body,
      authorId: cm.user_id,
      createdAt: cm.created_at,
      updatedAt: cm.updated_at,
      editedAt: cm.edited_at,
    })),
    worklogs: db.all<WorklogRow>('SELECT * FROM work_logs ORDER BY id').map((w) => ({
      id: w.id,
      taskId: w.task_id,
      date: w.date,
      minutes: w.minutes,
      note: w.note,
      authorId: w.user_id,
      createdAt: w.created_at,
      updatedAt: w.updated_at,
    })),
    activity: db.all<ActivityRow>('SELECT * FROM activity ORDER BY id').map((a) => {
      // Malformed stored data (only possible from older imports) is repaired so that every
      // export passes exportSchema and can be imported again.
      const data = sanitizeActivityData(parseJson(a.data, {}));
      return {
        id: a.id,
        action: a.action as ExportDTO['activity'][number]['action'],
        entityType: a.entity_type as ExportDTO['activity'][number]['entityType'],
        entityId: a.entity_id,
        projectId: a.project_id,
        taskId: a.task_id,
        data,
        actorId: a.user_id,
        createdAt: a.created_at,
      };
    }),
    boards: db
      .all<BoardRow>('SELECT * FROM boards ORDER BY project_id IS NOT NULL, project_id, position, id')
      .map(toBoardDTO),
  };
}

// ---------------------------------------------------------------------------
// Import: parsing and referential integrity
// ---------------------------------------------------------------------------

function tooMany(problems: Problem[]): Problem[] {
  if (problems.length <= MAX_PROBLEMS) return problems;
  return [
    ...problems.slice(0, MAX_PROBLEMS),
    { path: '', message: `…and ${problems.length - MAX_PROBLEMS} more problem(s)` },
  ];
}

async function readExport(c: Context): Promise<ExportParsed> {
  let body: unknown;
  try {
    body = JSON.parse(await c.req.text());
  } catch {
    throw badRequest('The file is not valid JSON');
  }
  if (!isPlainObject(body) || body.format !== 'lyren-plan-export') {
    throw badRequest('This is not a Lyren Plan export file', [
      { path: 'format', message: 'Expected "lyren-plan-export"' },
    ]);
  }
  if (body.formatVersion !== 1) {
    throw badRequest(`Unsupported export format version ${JSON.stringify(body.formatVersion)}`, [
      { path: 'formatVersion', message: 'Only version 1 is supported' },
    ]);
  }
  const parsed = exportSchema.safeParse(body);
  if (!parsed.success) {
    const v = validationError(parsed.error);
    const details = v.details ?? [];
    const count = details.length;
    throw badRequest(`Invalid export file (${count} problem${count === 1 ? '' : 's'}): ${v.message}`, tooMany(details));
  }
  return parsed.data;
}

interface ImportPlan {
  data: ExportParsed;
  /** Activity entries whose task/project still exist (dangling ones are dropped). */
  activity: ExportParsed['activity'];
  /** settings.defaultBoardId, or null when that board is not part of the import. */
  defaultBoardId: number | null;
}

/** Referential-integrity and value checks of SPEC §5.10. Throws 400 listing every problem found. */
function checkIntegrity(d: ExportParsed): ImportPlan {
  const problems: Problem[] = [];
  const add = (p: string, message: string) => problems.push({ path: p, message });

  function uniqueIds(table: keyof ExportParsed, rows: ReadonlyArray<{ id: number }>, label: string): Set<number> {
    const seen = new Set<number>();
    rows.forEach((row, i) => {
      if (seen.has(row.id)) add(`${table}.${i}.id`, `Duplicate ${label} id ${row.id}`);
      seen.add(row.id);
    });
    return seen;
  }

  function uniqueNames(table: keyof ExportParsed, rows: ReadonlyArray<Record<string, unknown>>, field: string, label: string) {
    const seen = new Set<string>();
    rows.forEach((row, i) => {
      const value = String(row[field]);
      const folded = value.toLowerCase();
      if (seen.has(folded)) add(`${table}.${i}.${field}`, `Duplicate ${label} “${value}”`);
      seen.add(folded);
    });
  }

  const statusIds = uniqueIds('statuses', d.statuses, 'status');
  uniqueNames('statuses', d.statuses, 'name', 'status name');
  const tagIds = uniqueIds('tags', d.tags, 'tag');
  uniqueNames('tags', d.tags, 'name', 'tag name');
  const projectIds = uniqueIds('projects', d.projects, 'project');
  uniqueNames('projects', d.projects, 'key', 'project key');
  uniqueIds('milestones', d.milestones, 'milestone');
  uniqueIds('epics', d.epics, 'epic');
  const taskIds = uniqueIds('tasks', d.tasks, 'task');
  uniqueIds('comments', d.comments, 'comment');
  uniqueIds('worklogs', d.worklogs, 'work log');
  uniqueIds('activity', d.activity, 'activity');
  const boardIds = uniqueIds('boards', d.boards, 'board');

  const milestoneProject = new Map<number, number>();
  d.milestones.forEach((m, i) => {
    if (!projectIds.has(m.projectId)) add(`milestones.${i}.projectId`, `Milestone ${m.id}: project ${m.projectId} does not exist`);
    milestoneProject.set(m.id, m.projectId);
  });

  const epicProject = new Map<number, number>();
  d.epics.forEach((e, i) => {
    if (!projectIds.has(e.projectId)) add(`epics.${i}.projectId`, `Epic ${e.id}: project ${e.projectId} does not exist`);
    if (e.milestoneId !== null) {
      const mp = milestoneProject.get(e.milestoneId);
      if (mp === undefined) add(`epics.${i}.milestoneId`, `Epic ${e.id}: milestone ${e.milestoneId} does not exist`);
      else if (mp !== e.projectId) {
        add(`epics.${i}.milestoneId`, `Epic ${e.id}: milestone ${e.milestoneId} belongs to another project`);
      }
    }
    epicProject.set(e.id, e.projectId);
  });

  const numbers = new Set<string>();
  d.tasks.forEach((t, i) => {
    if (!projectIds.has(t.projectId)) add(`tasks.${i}.projectId`, `Task ${t.id}: project ${t.projectId} does not exist`);
    if (!statusIds.has(t.statusId)) add(`tasks.${i}.statusId`, `Task ${t.id}: status ${t.statusId} does not exist`);
    if (t.epicId !== null) {
      const ep = epicProject.get(t.epicId);
      if (ep === undefined) add(`tasks.${i}.epicId`, `Task ${t.id}: epic ${t.epicId} does not exist`);
      else if (ep !== t.projectId) add(`tasks.${i}.epicId`, `Task ${t.id}: epic ${t.epicId} belongs to another project`);
    }
    const unknownTags = [...new Set(t.tagIds)].filter((id) => !tagIds.has(id));
    if (unknownTags.length > 0) {
      add(`tasks.${i}.tagIds`, `Task ${t.id}: unknown tag id${unknownTags.length > 1 ? 's' : ''} ${unknownTags.join(', ')}`);
    }
    const numberKey = `${t.projectId}:${t.number}`;
    if (numbers.has(numberKey)) add(`tasks.${i}.number`, `Task ${t.id}: number ${t.number} is used twice in project ${t.projectId}`);
    numbers.add(numberKey);
  });

  d.comments.forEach((cm, i) => {
    if (!taskIds.has(cm.taskId)) add(`comments.${i}.taskId`, `Comment ${cm.id}: task ${cm.taskId} does not exist`);
  });
  d.worklogs.forEach((w, i) => {
    if (!taskIds.has(w.taskId)) add(`worklogs.${i}.taskId`, `Work log ${w.id}: task ${w.taskId} does not exist`);
    // The rule every later edit re-checks on the merged row (SPEC §5.6).
    if (!((w.minutes ?? 0) > 0 || w.note.trim().length > 0)) {
      add(`worklogs.${i}.note`, `Work log ${w.id}: has neither time spent nor a note`);
    }
  });

  // startDate <= dueDate: every later edit of such a row (even a status change) re-checks it.
  const dateOrder = (table: 'tasks' | 'milestones' | 'epics', label: string) =>
    d[table].forEach((row, i) => {
      if (row.startDate !== null && row.dueDate !== null && row.startDate > row.dueDate) {
        add(`${table}.${i}.dueDate`, `${label} ${row.id}: due date ${row.dueDate} is before start date ${row.startDate}`);
      }
    });
  dateOrder('milestones', 'Milestone');
  dateOrder('epics', 'Epic');
  dateOrder('tasks', 'Task');
  d.boards.forEach((b, i) => {
    if (b.projectId !== null && !projectIds.has(b.projectId)) {
      add(`boards.${i}.projectId`, `Board ${b.id}: project ${b.projectId} does not exist`);
    }
  });

  if (problems.length > 0) {
    const n = problems.length;
    throw badRequest(
      `The export file is inconsistent (${n} problem${n === 1 ? '' : 's'}): ${problems[0]!.message}`,
      tooMany(problems),
    );
  }

  const activity = d.activity.filter(
    (a) => (a.taskId === null || taskIds.has(a.taskId)) && (a.projectId === null || projectIds.has(a.projectId)),
  );
  const { defaultBoardId } = d.settings;
  return { data: d, activity, defaultBoardId: defaultBoardId !== null && boardIds.has(defaultBoardId) ? defaultBoardId : null };
}

// ---------------------------------------------------------------------------
// Import: snapshot + replace
// ---------------------------------------------------------------------------

/**
 * VACUUM INTO DATA_DIR/backups/pre-import-<timestamp>.db, then delete the oldest pre-import
 * snapshots beyond `keep` (never the new one; 0 keeps all). Returns the path relative to DATA_DIR.
 */
function writeSafetySnapshot(db: Db, dataDir: string, keep: number): string {
  const stamp = snapshotStamp();
  const dir = path.join(dataDir, 'backups');
  let name = `pre-import-${stamp}.db`;
  for (let n = 2; fs.existsSync(path.join(dir, name)); n++) name = `pre-import-${stamp}-${n}.db`;
  db.backupTo(path.join(dir, name));
  logPrune('pre-import', dir, keep, pruneSnapshots(dir, 'pre-import', keep, name));
  return `backups/${name}`;
}

const DOMAIN_TABLES = [
  'activity',
  'comments',
  'work_logs',
  'task_tags',
  'tasks',
  'epics',
  'milestones',
  'boards',
  'projects',
  'tags',
  'statuses',
] as const;

/** Domain tables with an AUTOINCREMENT id (everything but task_tags). */
const SEQUENCED_TABLES = DOMAIN_TABLES.filter((t) => t !== 'task_tags');

/** completedAt invariant: set (kept, else now) while closed; NULL otherwise. */
const closedAt = (closed: boolean, completedAt: string | null, now: string) => (closed ? (completedAt ?? now) : null);

function replaceAll(db: Db, plan: ImportPlan, userId: number): Record<string, number> {
  const { data: d } = plan;
  return db.tx(() => {
    for (const table of DOMAIN_TABLES) db.run(`DELETE FROM ${table}`);
    db.run("DELETE FROM settings WHERE substr(key, 1, 1) <> '_'");

    const now = nowIso();
    // Every user reference belongs to the importing user (users are never imported).
    const user = (id: number | null) => (id === null ? null : userId);
    // Comments and work logs can only be edited by their author, so they always get one.
    const author = () => userId;

    const statusCategory = new Map<number, StatusCategory>();
    for (const s of d.statuses) {
      statusCategory.set(s.id, s.category);
      db.run(
        `INSERT INTO statuses (id, name, category, color, position, created_at, updated_at)
         VALUES (:id, :name, :category, :color, :position, :now, :now)`,
        { ...s, now },
      );
    }

    for (const t of d.tags) {
      db.run(
        `INSERT INTO tags (id, name, color, created_at, updated_at)
         VALUES (:id, :name, :color, :createdAt, :createdAt)`,
        t,
      );
    }

    const maxNumber = new Map<number, number>();
    for (const t of d.tasks) maxNumber.set(t.projectId, Math.max(maxNumber.get(t.projectId) ?? 0, t.number));
    for (const p of d.projects) {
      db.run(
        `INSERT INTO projects (id, key, name, description, color, status, position, task_counter, created_at, updated_at)
         VALUES (:id, :key, :name, :description, :color, :status, :position, :taskCounter, :createdAt, :updatedAt)`,
        { ...p, taskCounter: Math.max(p.taskCounter, maxNumber.get(p.id) ?? 0) },
      );
    }

    for (const m of d.milestones) {
      db.run(
        `INSERT INTO milestones (id, project_id, name, description, status, start_date, due_date, position,
                                 completed_at, created_at, updated_at)
         VALUES (:id, :projectId, :name, :description, :status, :startDate, :dueDate, :position,
                 :completedAt, :createdAt, :updatedAt)`,
        { ...m, completedAt: closedAt(m.status === 'completed' || m.status === 'cancelled', m.completedAt, now) },
      );
    }

    for (const e of d.epics) {
      db.run(
        `INSERT INTO epics (id, project_id, milestone_id, name, description, color, status, start_date, due_date,
                            position, completed_at, created_at, updated_at)
         VALUES (:id, :projectId, :milestoneId, :name, :description, :color, :status, :startDate, :dueDate,
                 :position, :completedAt, :createdAt, :updatedAt)`,
        { ...e, completedAt: closedAt(e.status === 'done' || e.status === 'cancelled', e.completedAt, now) },
      );
    }

    for (const { tagIds, ...t } of d.tasks) {
      const closed = isClosedCategory(statusCategory.get(t.statusId)!);
      db.run(
        `INSERT INTO tasks (id, project_id, number, epic_id, status_id, title, description, priority, start_date,
                            due_date, estimate, rank, completed_at, archived_at, created_by, created_at, updated_at)
         VALUES (:id, :projectId, :number, :epicId, :statusId, :title, :description, :priority, :startDate,
                 :dueDate, :estimate, :rank, :completedAt, :archivedAt, :createdBy, :createdAt, :updatedAt)`,
        { ...t, completedAt: closedAt(closed, t.completedAt, now), createdBy: user(t.createdBy) },
      );
      for (const tagId of new Set(tagIds)) {
        db.run('INSERT INTO task_tags (task_id, tag_id) VALUES (:taskId, :tagId)', { taskId: t.id, tagId });
      }
    }
    // Fresh, evenly spaced ranks in the exported (rank, id) order.
    renormalizeRanks(db);

    for (const cm of d.comments) {
      db.run(
        `INSERT INTO comments (id, task_id, user_id, body, created_at, updated_at, edited_at)
         VALUES (:id, :taskId, :userId, :body, :createdAt, :updatedAt, :editedAt)`,
        { ...cm, userId: author() },
      );
    }

    for (const w of d.worklogs) {
      db.run(
        `INSERT INTO work_logs (id, task_id, user_id, date, minutes, note, created_at, updated_at)
         VALUES (:id, :taskId, :userId, :date, :minutes, :note, :createdAt, :updatedAt)`,
        { ...w, userId: author() },
      );
    }

    for (const a of plan.activity) {
      db.run(
        `INSERT INTO activity (id, user_id, project_id, task_id, entity_type, entity_id, action, data, created_at)
         VALUES (:id, :userId, :projectId, :taskId, :entityType, :entityId, :action, :data, :createdAt)`,
        { ...a, userId: user(a.actorId), data: JSON.stringify(a.data) },
      );
    }

    for (const b of d.boards) {
      const parsed = parseBoardConfigLenient(b.config);
      // Project boards always show exactly their project (SPEC §8).
      const config = b.projectId === null ? parsed : { ...parsed, filter: { ...parsed.filter, projectIds: [b.projectId] } };
      db.run(
        `INSERT INTO boards (id, project_id, name, description, config, position, created_at, updated_at)
         VALUES (:id, :projectId, :name, :description, :config, :position, :createdAt, :updatedAt)`,
        { ...b, config: JSON.stringify(config) },
      );
    }

    saveSettings(db, { ...d.settings, defaultBoardId: plan.defaultBoardId });

    // Imported ids are capped (IMPORT_INT_MAX), but an earlier import may have pushed an
    // AUTOINCREMENT counter towards 2^53, where new ids can't be read back as JS numbers.
    // Deleting rows never lowers the counter, so heal over-limit counters here; normal ones are
    // left alone so ids are still never reused.
    for (const table of SEQUENCED_TABLES) {
      db.run(
        `UPDATE sqlite_sequence SET seq = (SELECT COALESCE(MAX(id), 0) FROM ${table})
          WHERE name = :table AND seq > :max`,
        { table, max: IMPORT_INT_MAX },
      );
    }

    const violations = db.all<{ table: string; rowid: number | null; parent: string }>('PRAGMA foreign_key_check');
    if (violations.length > 0) {
      throw badRequest(
        'The imported data failed the database integrity check',
        tooMany(violations.map((v) => ({ path: v.table, message: `Row ${v.rowid ?? '?'} references a missing ${v.parent} row` }))),
      );
    }

    return {
      statuses: d.statuses.length,
      tags: d.tags.length,
      projects: d.projects.length,
      milestones: d.milestones.length,
      epics: d.epics.length,
      tasks: d.tasks.length,
      comments: d.comments.length,
      worklogs: d.worklogs.length,
      activity: plan.activity.length,
      boards: d.boards.length,
    };
  });
}

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

async function removeQuietly(file: string): Promise<void> {
  await fs.promises.rm(file, { force: true }).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function dataRoutes({ db, config }: Deps) {
  const r = new Hono<AppEnv>();

  r.get('/export', (c) => {
    attachment(c, `lyren-export-${serverToday()}.json`);
    return c.json(buildExport(db));
  });

  r.get('/backup', async (c) => {
    // Hono routes HEAD here too. A HEAD response has no body, so a snapshot stream would never be
    // read or closed (leaking its fd and the unlinked copy's disk space): answer with headers only.
    if (c.req.method === 'HEAD') {
      attachment(c, `lyren-backup-${serverToday()}.db`);
      c.header('Content-Type', 'application/vnd.sqlite3');
      return c.body(null, 200);
    }
    const tmp = path.join(config.dataDir, `.backup-${randomBytes(8).toString('hex')}.db`);
    let handle: fs.promises.FileHandle | undefined;
    let size: number;
    try {
      db.backupTo(tmp);
      stripSessions(tmp);
      handle = await fs.promises.open(tmp, 'r');
      size = (await handle.stat()).size;
    } catch (err) {
      await handle?.close().catch(() => undefined);
      await removeQuietly(tmp);
      throw err;
    }
    // The open handle keeps the data readable after unlinking, so the temp file is gone even if
    // the download is aborted or the process dies mid-stream. Retry on close where unlinking an
    // open file is not allowed.
    await removeQuietly(tmp);
    const stream = fs.createReadStream(tmp, { fd: handle, autoClose: true });
    stream.once('close', () => void removeQuietly(tmp));
    attachment(c, `lyren-backup-${serverToday()}.db`);
    c.header('Content-Type', 'application/vnd.sqlite3');
    c.header('Content-Length', String(size));
    return c.body(Readable.toWeb(stream) as ReadableStream<Uint8Array>);
  });

  r.post('/import', async (c) => {
    const user = currentUser(c);
    const plan = checkIntegrity(await readExport(c));
    // Written only after validation passed, and before anything is replaced.
    const backupFile = writeSafetySnapshot(db, config.dataDir, config.snapshotKeep);
    const counts = replaceAll(db, plan, user.id);
    return c.json({ ok: true as const, counts, backupFile });
  });

  return r;
}
