// The directory app (design §2.1, §2.5): accounts, sessions, spaces and memberships, instance settings,
// throttling and security events, next to the directory database. It is runtime-neutral: Node runs it
// in-process behind the gateway (NodeDirectoryClient.serve → app.fetch(request, { meta })), Cloudflare
// inside DirectoryDO, which decodes the meta the Worker sent. The app never reads TrustedMeta from a
// header itself, and it owns the session cookie (it reads and sets it; space requests never do).

import { Hono } from 'hono';
import type { DesktopAppDTO, DesktopDataDTO } from '@shared/types';
import type { DirectoryConfig } from '../core/config';
import type { Db } from '../core/db';
import type { SpaceAdminClient, TrustedMeta } from '../core/ports';
import type { Clock, Defer, RuntimeInfo } from '../core/runtime';
import { errorBody, handleError } from '../http/errors';
import type { MailTransport } from '../mail/transport';
import { orphanedPasskeysWarning } from './admin';
import type { DirectoryContext } from './context';
import { createMailer } from './mailer';
import { authGate, bodyLimits, sessionMiddleware } from './middleware';
import { PasswordHasher } from './passwords';
import { accountRoutes } from './routes/account';
import { adminRoutes } from './routes/admin';
import { authRoutes } from './routes/auth';
import { emailRoutes } from './routes/email';
import { invitationRoutes } from './routes/invitations';
import { memberRoutes } from './routes/members';
import { passkeyAccountRoutes, passkeyAuthRoutes } from './routes/passkeys';
import { resetRoutes } from './routes/reset';
import { signupRoutes } from './routes/signup';
import { spaceRoutes } from './routes/spaces';
import { createDirectoryService, type DirectoryService } from './service';
import type { SessionRow } from './sessions';
import { logSetupCode, SetupCode, seedInstanceSettings, seedWarnings } from './settings';
import { Throttle } from './throttle';
import type { UserRow } from './users';

export interface DirectoryDeps {
  db: Db;
  /** Appendix B: everything auth, mail and quota related. */
  config: DirectoryConfig;
  spaces: SpaceAdminClient;
  mail: MailTransport;
  defer: Defer;
  clock: Clock;
  runtime: RuntimeInfo;
  /** Node only (openNodeStack provides it; this is what capabilities.backupDownload means): §9.5. */
  backup?: { create(): Promise<{ body: ReadableStream<Uint8Array>; size: number; filename: string }> };
  /**
   * Node only: the size of a space's database files (`<id>.db` and its `-wal`) without opening them, for the
   * admin list (AdminSpaceDTO.bytes); null when there is none. Cloudflare has no such cheap answer (a request
   * per space).
   */
  spaceBytes?: (spaceId: string) => number | null;
  /**
   * Node desktop app only, computed by the Node stack (the directory app never sees the Node Config).
   * `app` is read for every response, so a getter can change it (the tray icon's stopMode).
   */
  desktop?: { readonly app: DesktopAppDTO; data(): DesktopDataDTO };
  /** Origins that work from other devices, for copied links (§5.8.8, §9.7). */
  shareOrigins(): string[];
  /**
   * Announces a setup code generated while the app runs (§5.8.1). Default: `  Setup code: <code>` on
   * stdout on Node, `[lyren] Setup code: <code>` on Cloudflare. The desktop app passes its own (it keeps
   * the code out of its log file, updates its setup link and desktop.json, and prints the line).
   */
  onSetupCode?: (code: string) => void;
  /** The failure padding's timer (§5.5; default setTimeout). Tests pass one that moves their clock. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The space paths of the client before spaces (they moved under /api/s/<id>/, §7.3). Only a browser tab
 * left open across the upgrade still asks for them, signed in by a session from before (Appendix A);
 * it shows a 404's message, so the message says what helps.
 */
const OLD_CLIENT_PATH = /^\/api\/(?:bootstrap|projects|milestones|epics|tasks|comments|worklogs|activity|boards|tags|statuses|settings|data|dashboard|search|people)(?:\/|$)/;
export const OLD_CLIENT_TEXT = 'Lyren Plan has been updated. Reload the page to continue.';

export interface DirectoryEnv {
  Bindings: { meta: TrustedMeta };
  Variables: { user: UserRow | null; session: SessionRow | null };
}

/**
 * Builds the directory service (DirectoryClient's non-HTTP methods + maintenance) and its Hono app; `ctx`
 * is what the routes share (tests call the services with it).
 */
export function createDirectoryApp(deps: DirectoryDeps): { app: Hono<DirectoryEnv>; service: DirectoryService; ctx: DirectoryContext } {
  const { db, config } = deps;
  const { seededPolicy } = seedInstanceSettings(db, config);
  const throttle = new Throttle(db, deps.clock);
  const now = () => deps.clock.now();
  const ctx: DirectoryContext = {
    deps,
    db,
    config,
    throttle,
    passwords: new PasswordHasher({
      target: { kdf: config.passwordKdf, scryptP: config.passwordScryptP },
      clock: deps.clock,
      sleep: deps.sleep,
      // Cloudflare's clock moves only at I/O (§5.5, Appendix D 38).
      ioClock: deps.runtime.kind === 'cloudflare',
    }),
    setupCode: new SetupCode(db, config, deps.runtime.kind, deps.onSetupCode ?? logSetupCode(deps.runtime.kind)),
    mailer: createMailer({ db, config, throttle, transport: deps.mail, defer: deps.defer, now, shareOrigins: deps.shareOrigins }),
    now,
  };
  // The startup log also names the accounts a domain move left without a passkey that works here (§5.6), on
  // Node: counting them reads every passkey, and a Durable Object starts again after each idle spell (any
  // request can start it), so Cloudflare logs it from the hourly alarm instead (Appendix D 59).
  const orphaned = deps.runtime.kind === 'node' ? orphanedPasskeysWarning(ctx) : null;
  const service = createDirectoryService(ctx, [...seedWarnings(config, seededPolicy), ...(orphaned === null ? [] : [orphaned])]);

  const app = new Hono<DirectoryEnv>();
  app.onError(handleError);
  app.notFound((c) => c.json(errorBody('not_found', OLD_CLIENT_PATH.test(c.req.path) ? OLD_CLIENT_TEXT : 'Not found'), 404));
  app.use('/api/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });
  // Sessions and the auth gate before the body limit: a request that will be refused is refused
  // before any of its body is read (bodyLimit buffers a body without Content-Length first).
  app.use('/api/*', sessionMiddleware(ctx));
  app.use('/api/*', authGate);
  app.use('/api/*', bodyLimits(ctx));

  app.route('/api/auth', authRoutes(ctx));
  app.route('/api/auth', signupRoutes(ctx));
  app.route('/api/auth', resetRoutes(ctx));
  app.route('/api/auth', passkeyAuthRoutes(ctx));
  app.route('/api', emailRoutes(ctx));
  app.route('/api/account', accountRoutes(ctx));
  app.route('/api/account', passkeyAccountRoutes(ctx));
  app.route('/api/spaces', spaceRoutes(ctx));
  app.route('/api/spaces', memberRoutes(ctx));
  app.route('/api', invitationRoutes(ctx));
  app.route('/api/admin', adminRoutes(ctx));
  return { app, service, ctx };
}
