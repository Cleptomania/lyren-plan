// GET /api/search?q&limit — global search for the command palette.
//
// Matching uses the task filter's token semantics: the query is split on whitespace and EVERY
// token must occur (case-insensitive: the stored *_fold columns, i.e. JS toLowerCase) in the searched
// text. Matching is by instr(), so '%', '_' and '\' are ordinary characters, and the tokens travel as
// one JSON parameter per statement (design §3.4), however many there are.
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
import { serverToday } from '../services/sql';
import {
  emptyMilestoneStats,
  emptyProgressStats,
  emptyProjectStats,
  epicStats,
  milestoneStats,
  projectStats,
} from '../services/stats';
import {
  allTokensSql,
  buildTaskWhere,
  hydrateTasks,
  TASK_FROM,
  TASK_REF_FOLD_SQL,
  tokenHitsSql,
} from '../services/tasks';

export const SEARCH_LIMIT_DEFAULT = 10;

type Params = Record<string, SqlValue>;

function searchTasks(db: Db, q: string, tokens: readonly string[], limit: number): TaskDTO[] {
  // Search reaches tasks of every project, archived tasks included (ranked after live ones). Its
  // filter has no due presets, so the week start does not matter.
  const where = buildTaskWhere(
    { search: q, includeArchivedProjects: true, archived: 'include' },
    { today: serverToday(), weekStartsOn: 1, nowMs: Date.now() },
  );
  const params: Params = { ...where.params, exactRef: q.toLowerCase(), tokens: JSON.stringify(tokens), limit };
  const rows = db.all<TaskRow>(
    `SELECT t.* FROM ${TASK_FROM}
      WHERE ${where.sql}
      ORDER BY ${TASK_REF_FOLD_SQL} = :exactRef DESC,
               ${tokenHitsSql(`t.title_fold || char(10) || ${TASK_REF_FOLD_SQL}`, ':tokens')} DESC,
               t.archived_at IS NOT NULL, t.updated_at DESC, t.id DESC
      LIMIT :limit`,
    params,
  );
  return hydrateTasks(db, rows);
}

function searchProjects(db: Db, q: string, tokens: readonly string[], limit: number): ProjectDTO[] {
  const params: Params = { exactKey: q.toLowerCase(), tokens: JSON.stringify(tokens), limit };
  const rows = db.all<ProjectRow>(
    `SELECT p.* FROM projects p
      WHERE ${allTokensSql('p.name_fold || char(10) || lower(p.key) || char(10) || p.description_fold', ':tokens')}
      ORDER BY lower(p.key) = :exactKey DESC,
               ${tokenHitsSql('p.name_fold || char(10) || lower(p.key)', ':tokens')} DESC,
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
  const params: Params = { tokens: JSON.stringify(tokens), limit };
  const rows = db.all<MilestoneRow>(
    `SELECT m.* FROM milestones m JOIN projects p ON p.id = m.project_id
      WHERE ${allTokensSql('m.name_fold || char(10) || m.description_fold', ':tokens')}
      ORDER BY ${tokenHitsSql('m.name_fold', ':tokens')} DESC,
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
  const params: Params = { tokens: JSON.stringify(tokens), limit };
  const rows = db.all<EpicRow>(
    `SELECT e.* FROM epics e JOIN projects p ON p.id = e.project_id
      WHERE ${allTokensSql('e.name_fold || char(10) || e.description_fold', ':tokens')}
      ORDER BY ${tokenHitsSql('e.name_fold', ':tokens')} DESC,
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
