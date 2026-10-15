// GET /api/search?q&limit — global search for the command palette.
//
// Matching uses the task filter's token semantics: the query is split on whitespace and EVERY
// token must occur (case-insensitive via lyren_lower, i.e. JS toLowerCase) in the searched
// text. Matching is by instr(), so '%', '_' and '\' are ordinary characters.
//  - tasks: title / description / ref; tasks of every project, archived tasks included (so
//    archived work can be found and unarchived). Ranking: exact ref ('web-12') first, then by how
//    many tokens hit the title or ref (so title matches beat description-only matches), then
//    archived tasks last, then most recently updated.
//  - projects: name / key / description (exact key first, then name/key hits, archived last).
//  - milestones and epics: name / description (name hits first, closed ones last).
// Each group returns at most `limit` entries (default 10).

import { Hono } from 'hono';
import { searchTokens } from '@shared/filter';
import { searchQueryInput } from '@shared/schemas';
import type { EpicDTO, MilestoneDTO, ProjectDTO, SearchResultDTO, TaskDTO } from '@shared/types';
import type { Db, SqlValue } from '../db';
import type { AppEnv, Deps } from '../env';
import { readQuery } from '../http/validate';
import { toEpicDTO, toMilestoneDTO, toProjectDTO } from '../services/mappers';
import type { EpicRow, MilestoneRow, ProjectRow, TaskRow } from '../services/rows';
import { getSettings } from '../services/settings';
import { serverToday } from '../services/sql';
import {
  emptyMilestoneStats,
  emptyProgressStats,
  emptyProjectStats,
  epicStats,
  milestoneStats,
  projectStats,
} from '../services/stats';
import { buildTaskWhere, hydrateTasks, TASK_FROM, TASK_REF_SQL } from '../services/tasks';

export const SEARCH_LIMIT_DEFAULT = 10;

type Params = Record<string, SqlValue>;

/**
 * SQL helpers for one token list. Parameter names are `${prefix}${i}`; each call binds its own
 * names, so several expressions can share one params object.
 */
function tokenSql(tokens: readonly string[], params: Params) {
  let n = 0;
  const bind = (prefix: string, value: string): string => {
    const name = `${prefix}${n++}`;
    params[name] = value;
    return `:${name}`;
  };
  return {
    /** Every token occurs in `haystack`. */
    all: (haystack: string, prefix: string): string =>
      tokens.map((t) => `instr(lyren_lower(${haystack}), ${bind(prefix, t)}) > 0`).join(' AND '),
    /** Number of tokens occurring in `haystack` (0..tokens.length). */
    hits: (haystack: string, prefix: string): string =>
      `(${tokens.map((t) => `(instr(lyren_lower(${haystack}), ${bind(prefix, t)}) > 0)`).join(' + ')})`,
  };
}

function searchTasks(db: Db, q: string, tokens: readonly string[], limit: number): TaskDTO[] {
  // Search reaches tasks of every project, archived tasks included (ranked after live ones).
  const where = buildTaskWhere(
    { search: q, includeArchivedProjects: true, archived: 'include' },
    { today: serverToday(), weekStartsOn: getSettings(db).weekStartsOn, nowMs: Date.now() },
  );
  const params: Params = { ...where.params, exactRef: q.toLowerCase(), limit };
  const sql = tokenSql(tokens, params);
  const rows = db.all<TaskRow>(
    `SELECT t.* FROM ${TASK_FROM}
      WHERE ${where.sql}
      ORDER BY lyren_lower(${TASK_REF_SQL}) = :exactRef DESC,
               ${sql.hits(`t.title || char(10) || ${TASK_REF_SQL}`, 'th')} DESC,
               t.archived_at IS NOT NULL, t.updated_at DESC, t.id DESC
      LIMIT :limit`,
    params,
  );
  return hydrateTasks(db, rows);
}

function searchProjects(db: Db, q: string, tokens: readonly string[], limit: number): ProjectDTO[] {
  const params: Params = { exactKey: q.toLowerCase(), limit };
  const sql = tokenSql(tokens, params);
  const rows = db.all<ProjectRow>(
    `SELECT p.* FROM projects p
      WHERE ${sql.all("p.name || char(10) || p.key || char(10) || p.description", 'pm')}
      ORDER BY lyren_lower(p.key) = :exactKey DESC,
               ${sql.hits("p.name || char(10) || p.key", 'ph')} DESC,
               p.status = 'archived', p.position, p.id
      LIMIT :limit`,
    params,
  );
  if (rows.length === 0) return [];
  // Search has no client date; overdue counts use the server's date (the palette doesn't show them).
  const stats = projectStats(db, serverToday(), rows.map((r) => r.id));
  return rows.map((r) => toProjectDTO(r, stats.get(r.id) ?? emptyProjectStats()));
}

function searchMilestones(db: Db, tokens: readonly string[], limit: number): MilestoneDTO[] {
  const params: Params = { limit };
  const sql = tokenSql(tokens, params);
  const rows = db.all<MilestoneRow>(
    `SELECT m.* FROM milestones m JOIN projects p ON p.id = m.project_id
      WHERE ${sql.all('m.name || char(10) || m.description', 'mm')}
      ORDER BY ${sql.hits('m.name', 'mh')} DESC,
               m.status IN ('completed', 'cancelled'), p.status = 'archived',
               p.position, p.id, m.position, m.id
      LIMIT :limit`,
    params,
  );
  if (rows.length === 0) return [];
  const stats = milestoneStats(db, rows.map((r) => r.id));
  return rows.map((r) => toMilestoneDTO(r, stats.get(r.id) ?? emptyMilestoneStats()));
}

function searchEpics(db: Db, tokens: readonly string[], limit: number): EpicDTO[] {
  const params: Params = { limit };
  const sql = tokenSql(tokens, params);
  const rows = db.all<EpicRow>(
    `SELECT e.* FROM epics e JOIN projects p ON p.id = e.project_id
      WHERE ${sql.all('e.name || char(10) || e.description', 'em')}
      ORDER BY ${sql.hits('e.name', 'eh')} DESC,
               e.status IN ('done', 'cancelled'), p.status = 'archived',
               p.position, p.id, e.position, e.id
      LIMIT :limit`,
    params,
  );
  if (rows.length === 0) return [];
  const stats = epicStats(db, rows.map((r) => r.id));
  return rows.map((r) => toEpicDTO(r, stats.get(r.id) ?? emptyProgressStats()));
}

export function searchRoutes({ db }: Deps) {
  const r = new Hono<AppEnv>();

  r.get('/', (c) => {
    const { q, limit = SEARCH_LIMIT_DEFAULT } = readQuery(c, searchQueryInput);
    const tokens = searchTokens(q);
    const body: SearchResultDTO = {
      tasks: searchTasks(db, q, tokens, limit),
      projects: searchProjects(db, q, tokens, limit),
      milestones: searchMilestones(db, tokens, limit),
      epics: searchEpics(db, tokens, limit),
    };
    return c.json(body);
  });

  return r;
}
