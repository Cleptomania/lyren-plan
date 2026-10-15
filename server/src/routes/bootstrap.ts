// GET /api/bootstrap — every small lookup list the web client needs, in one request.

import { Hono } from 'hono';
import { z } from 'zod';
import { isoDateSchema } from '@shared/schemas';
import type { BootstrapDTO } from '@shared/types';
import { currentUser } from '../auth/context';
import { toUserDTO } from '../auth/users';
import { APP_VERSION } from '../config';
import type { AppEnv, Deps } from '../env';
import { readQuery } from '../http/validate';
import { listBoards, listEpics, listMilestones, listProjects, listStatuses, listTags } from '../services/entities';
import { getSettings } from '../services/settings';
import { serverToday } from '../services/sql';
import { desktopData } from './desktop';

const bootstrapQuery = z.object({
  /** Client's local date (drives project stats.tasksOverdue); defaults to the server's UTC date. */
  today: isoDateSchema.optional(),
});

export function bootstrapRoutes({ db, config, desktop }: Deps) {
  const r = new Hono<AppEnv>();

  r.get('/', (c) => {
    const { today = serverToday() } = readQuery(c, bootstrapQuery);
    const body: BootstrapDTO = {
      user: toUserDTO(currentUser(c)),
      settings: getSettings(db),
      version: APP_VERSION,
      statuses: listStatuses(db),
      tags: listTags(db),
      projects: listProjects(db, today),
      milestones: listMilestones(db),
      epics: listEpics(db),
      boards: listBoards(db),
      // Only the desktop app adds this; the Node build's and Docker's answer stays as it was.
      ...(desktop ? { desktop: desktopData(desktop, config) } : {}),
    };
    return c.json(body);
  });

  return r;
}
