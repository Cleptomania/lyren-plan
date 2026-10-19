// The space app (design §2.1, §2.5): today's domain routes for ONE space, behind the gate. Its space host
// (space/host.ts) has already authorized the request and rewritten /api/s/<id>/… to /api/…, and hands the
// identity over as bindings; the app never sees cookies.
//
// Middleware order: the gate first (§6.4; nothing runs before authorization, and it judges the route
// that will actually run; it also reads the body under its limit, BODY_LIMIT or IMPORT_BODY_LIMIT, and
// judges the request again once it has arrived), then the security headers and Cache-Control: no-store,
// as app.ts applied them before the split. CSRF, Content-Length pre-checks and compression are the gateway's.

import { Hono } from 'hono';
import type { AppEnv, Deps } from '../env';
import { securityHeaders } from '../http/headers';
import { errorBody, handleError } from '../http/errors';
import { boardRoutes } from '../routes/boards';
import { bootstrapRoutes } from '../routes/bootstrap';
import { dashboardRoutes } from '../routes/dashboard';
import { dataRoutes } from '../routes/data';
import { epicRoutes } from '../routes/epics';
import { milestoneRoutes } from '../routes/milestones';
import { projectRoutes } from '../routes/projects';
import { searchRoutes } from '../routes/search';
import { settingsRoutes } from '../routes/settings';
import { statusRoutes } from '../routes/statuses';
import { tagRoutes } from '../routes/tags';
import { taskRoutes } from '../routes/tasks';
import { timelineRoutes } from '../routes/timeline';
import { createGate } from './gate';
import { peopleRoutes } from './people';

export function createSpaceApp(deps: Deps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // A refusal by the gate ends the chain before the middleware below, so errors get no-store here.
  app.onError((err, c) => {
    const res = handleError(err, c);
    res.headers.set('Cache-Control', 'no-store');
    return res;
  });
  app.notFound((c) => c.json(errorBody('not_found', 'Not found'), 404, { 'Cache-Control': 'no-store' }));

  app.use('/api/*', createGate(deps));
  app.use('/api/*', securityHeaders());
  app.use('/api/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });

  app.route('/api/bootstrap', bootstrapRoutes(deps));
  app.route('/api/projects', projectRoutes(deps));
  app.route('/api/milestones', milestoneRoutes(deps));
  app.route('/api/epics', epicRoutes(deps));
  app.route('/api/tasks', taskRoutes(deps));
  app.route('/api', timelineRoutes(deps)); // /tasks/:id/timeline|comments|worklogs, /comments/:id, /worklogs, /activity
  app.route('/api/boards', boardRoutes(deps));
  app.route('/api/tags', tagRoutes(deps));
  app.route('/api/statuses', statusRoutes(deps));
  app.route('/api/settings', settingsRoutes(deps));
  app.route('/api/data', dataRoutes(deps));
  app.route('/api/people', peopleRoutes(deps));
  app.route('/api/dashboard', dashboardRoutes(deps));
  app.route('/api/search', searchRoutes(deps));

  return app;
}
