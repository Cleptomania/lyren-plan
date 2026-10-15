// Builds the Hono application: security middleware, /api routes and the static UI.

import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { compress } from 'hono/compress';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { APP_VERSION } from './config';
import type { AppEnv, Deps } from './env';
import { requireAuth, requireCsrfHeader, sessionMiddleware } from './auth/middleware';
import { authRoutes } from './auth/routes';
import { errorBody, handleError } from './http/errors';
import { staticSite } from './http/static';
import { boardRoutes } from './routes/boards';
import { bootstrapRoutes } from './routes/bootstrap';
import { dashboardRoutes } from './routes/dashboard';
import { dataRoutes } from './routes/data';
import { epicRoutes } from './routes/epics';
import { milestoneRoutes } from './routes/milestones';
import { projectRoutes } from './routes/projects';
import { searchRoutes } from './routes/search';
import { settingsRoutes } from './routes/settings';
import { statusRoutes } from './routes/statuses';
import { tagRoutes } from './routes/tags';
import { taskRoutes } from './routes/tasks';
import { timelineRoutes } from './routes/timeline';

/** Paths under /api reachable without a session. */
const PUBLIC_API_PATHS = new Set(['/api/health', '/api/auth/status', '/api/auth/setup', '/api/auth/login', '/api/auth/logout']);
const IMPORT_PATH = '/api/data/import';
/**
 * Body limit of the public endpoints (setup / login / logout take a few short strings). They are
 * the only POSTs reachable without a session, so they must not accept megabytes from anyone.
 */
export const AUTH_BODY_LIMIT = 64 * 1024;

export function createApp(deps: Deps) {
  const { config } = deps;
  const app = new Hono<AppEnv>();

  app.onError(handleError);
  app.notFound((c) =>
    c.req.path.startsWith('/api') ? c.json(errorBody('not_found', 'Not found'), 404) : c.text('Not found', 404),
  );

  if (config.logRequests) app.use('*', logger());

  app.use(
    '*',
    secureHeaders({
      strictTransportSecurity: false, // leave HSTS to the TLS-terminating reverse proxy
      xFrameOptions: 'DENY',
      referrerPolicy: 'same-origin',
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        // No remote images: the app never makes third-party requests (Markdown renders them as links).
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        manifestSrc: ["'self'"],
        workerSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    }),
  );

  // ---- API ---------------------------------------------------------------
  app.use('/api/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });
  // Refuse before reading: none of the CSRF, session and auth checks touches the body, and they
  // run before the body limit, because bodyLimit reads a chunked (no Content-Length) body into
  // memory before calling next(). Requests without the CSRF header or a session are therefore
  // rejected without buffering a byte of their body.
  app.use('/api/*', requireCsrfHeader);
  app.use('/api/*', sessionMiddleware(deps));
  app.use('/api/*', (c, next) => (PUBLIC_API_PATHS.has(c.req.path) ? next() : requireAuth(c, next)));
  const defaultLimit = bodyLimit({ maxSize: config.bodyLimit });
  const importLimit = bodyLimit({ maxSize: config.importBodyLimit });
  const authLimit = bodyLimit({ maxSize: Math.min(config.bodyLimit, AUTH_BODY_LIMIT) });
  app.use('/api/*', (c, next) => {
    const path = c.req.path;
    if (path === IMPORT_PATH) return importLimit(c, next);
    if (PUBLIC_API_PATHS.has(path)) return authLimit(c, next);
    return defaultLimit(c, next);
  });
  const gzip = compress();
  app.use('/api/*', (c, next) => (c.req.path === '/api/data/backup' ? next() : gzip(c, next)));

  app.get('/api/health', (c) => c.json({ ok: true, version: APP_VERSION }));
  app.route('/api/auth', authRoutes(deps));
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
  app.route('/api/dashboard', dashboardRoutes(deps));
  app.route('/api/search', searchRoutes(deps));

  // ---- Web UI ------------------------------------------------------------
  const web = deps.web !== undefined ? deps.web : config.webDir;
  if (web) app.use('*', staticSite(web));

  return app;
}
