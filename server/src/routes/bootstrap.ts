// GET /api/bootstrap — every small lookup list the web client needs, in one request: the viewer, the
// space and the viewer's role in it, the people its content can name (the users mirror), the space's
// settings, and the lookup lists, whose statistics come from one scan of the tasks (spaceStats).

import { Hono } from 'hono';
import { z } from 'zod';
import { isoDateSchema } from '@shared/schemas';
import type { BootstrapDTO } from '@shared/types';
import { APP_VERSION } from '../core/version';
import type { AppEnv, Deps } from '../env';
import { readQuery } from '../http/validate';
import {
  listBoards,
  listEpics,
  listMilestones,
  listPeople,
  listProjects,
  listStatuses,
  listTags,
} from '../services/entities';
import { getSettings } from '../services/settings';
import { serverToday } from '../services/sql';
import { spaceStats } from '../services/stats';
import { currentIdentity } from '../space/context';

const bootstrapQuery = z.object({
  /** Client's local date (drives project stats.tasksOverdue); defaults to the server's UTC date. */
  today: isoDateSchema.optional(),
});

export function bootstrapRoutes({ db, space }: Deps) {
  const r = new Hono<AppEnv>();

  r.get('/', (c) => {
    const { today = serverToday() } = readQuery(c, bootstrapQuery);
    const identity = currentIdentity(c);
    const stats = spaceStats(db, today);
    const body: BootstrapDTO = {
      user: { id: identity.userId, displayName: identity.displayName },
      space: { id: space.id, name: identity.space.name, role: identity.role },
      people: listPeople(db),
      settings: getSettings(db),
      version: APP_VERSION,
      statuses: listStatuses(db, stats.statuses),
      tags: listTags(db, stats.tags),
      projects: listProjects(db, today, stats.projects),
      milestones: listMilestones(db, undefined, stats.milestones),
      epics: listEpics(db, undefined, stats.epics),
      boards: listBoards(db),
    };
    return c.json(body);
  });

  return r;
}
