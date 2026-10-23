// DirectoryDO (design §2.1, §10.3): the one Durable Object named 'directory'. It holds the directory
// database (DoDb over the object's SQLite storage), serves the directory app through fetch (the Worker
// puts the TrustedMeta in x-lyren-meta; the cookie travels with the request, the directory owns it), and
// offers the DirectoryService's space-facing methods over RPC, which SpaceDO calls through
// DoDirectoryClient (plain JSON-safe arguments and results). Spaces are reached through DoSpaceAdminClient.
//
// The constructor opens and migrates the database inside blockConcurrencyWhile, so nothing runs before it.
// Its errors (a configuration error, a migration that fails, a database from a newer build) are stored and
// logged once, never rethrown: a constructor that throws resets the object, and the next request would run
// it again, over and over, with nobody told why. Instead fetch answers 503 with the reason, and every RPC
// method throws it.
//
// The hourly alarm (instead of Cron Triggers) sets the next alarm first, then runs the maintenance of
// §9.8, whose tasks each run in their own try/catch (directory/service.ts; purges at most 20 a run), so a
// failing task stops neither the others nor the schedule, and logs §5.6's domain-move warning (the start
// logs only the configuration's warnings, which cost no rows read). Deferred work (mail, pushes) runs in
// ctx.waitUntil. Password checks pad their failures as Cloudflare's clock allows (directory/passwords.ts:
// the clock moves only at I/O; Appendix D 38).

import { DurableObject } from 'cloudflare:workers';
import type { Hono } from 'hono';
import { migrate } from '../../core/migrate';
import type { DirectoryClient, ImportCandidateDTO, ImportReservation, SpaceAuthResult, SpaceSyncPayload } from '../../core/ports';
import { APP_VERSION } from '../../core/version';
import { createDirectoryApp, type DirectoryEnv } from '../../directory/app';
import { DIRECTORY_MIGRATIONS } from '../../directory/schema';
import type { DirectoryService } from '../../directory/service';
import { errorResponse, unavailable } from '../../http/errors';
import { createMailTransport } from '../../mail/transport';
import { DoSpaceAdminClient } from './clients';
import { CF_RUNTIME, cfConfig, publicOrigins } from './config';
import { DoDb } from './doDb';
import type { Env } from './env';
import { errorAnswer, unavailableMessage, workerMeta } from './objects';
import { createCloudflareSmtpConnector } from './smtpConnector';

/** The first alarm after the object starts without one, and the interval of the next ones. */
const FIRST_ALARM_MS = 60_000;
const ALARM_INTERVAL_MS = 60 * 60_000;

export class DirectoryDO extends DurableObject<Env> {
  /** Why the directory cannot serve (set by the constructor instead of throwing). */
  private unavailable: { message: string } | null = null;
  /** The directory database (protected: the test entry reads its meter, server/test-workers/entry.ts). */
  protected db: DoDb | null = null;
  private app: Hono<DirectoryEnv> | null = null;
  private service: DirectoryService | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      try {
        const config = cfConfig(env);
        const db = new DoDb(ctx.storage);
        this.db = db;
        migrate(db, DIRECTORY_MIGRATIONS, { appVersion: APP_VERSION });
        const built = createDirectoryApp({
          db,
          config: config.directory,
          spaces: new DoSpaceAdminClient(env),
          // SMTP over cloudflare:sockets; MAIL_TRANSPORT=cloudflare needs the EMAIL binding its deploy adds (§10.6).
          mail: createMailTransport(config.directory.mail, { smtp: createCloudflareSmtpConnector(), email: env.EMAIL }),
          defer: (task) => {
            ctx.waitUntil(task.catch((err: unknown) => console.error('[lyren] A background task failed:', err)));
          },
          clock: { now: () => Date.now() },
          runtime: CF_RUNTIME,
          shareOrigins: () => publicOrigins(config),
        });
        for (const warning of built.service.startupWarnings) console.warn(`[lyren] Warning: ${warning}`);
        this.app = built.app;
        this.service = built.service;
        if ((await ctx.storage.getAlarm()) === null) await ctx.storage.setAlarm(Date.now() + FIRST_ALARM_MS);
      } catch (err) {
        this.unavailable = { message: unavailableMessage(err) };
        console.error('[lyren] The directory is unavailable:', err);
      }
    });
  }

  /** The directory app, for the request the Worker sent (with the TrustedMeta in x-lyren-meta). */
  override async fetch(request: Request): Promise<Response> {
    if (!this.app) return errorResponse(unavailable(this.reason()));
    const found = workerMeta(request, 'directory');
    if ('refusal' in found) return found.refusal;
    try {
      return await this.app.fetch(request, { meta: found.meta });
    } catch (err) {
      return errorAnswer(err, 'A directory request');
    }
  }

  // ---- RPC (SpaceDO, through DoDirectoryClient) -----------------------------------------------------

  async authorizeSpace(input: Parameters<DirectoryClient['authorizeSpace']>[0]): Promise<SpaceAuthResult> {
    return this.ready().authorizeSpace(input);
  }

  async spaceSync(input: Parameters<DirectoryClient['spaceSync']>[0]): Promise<SpaceSyncPayload | null> {
    return this.ready().spaceSync(input);
  }

  // P7 (§8.4, §8.9): until the import arrives, the service's answers are Node's (no candidates, no budget).
  async importCandidates(input: Parameters<DirectoryClient['importCandidates']>[0]): Promise<ImportCandidateDTO[]> {
    return this.ready().importCandidates(input);
  }

  async reserveImport(input: Parameters<DirectoryClient['reserveImport']>[0]): Promise<ImportReservation> {
    return this.ready().reserveImport(input);
  }

  async refundImport(input: Parameters<DirectoryClient['refundImport']>[0]): Promise<void> {
    return this.ready().refundImport(input);
  }

  async importCommitted(input: Parameters<DirectoryClient['importCommitted']>[0]): Promise<void> {
    return this.ready().importCommitted(input);
  }

  /** The hourly maintenance (§9.8). An unavailable directory sets no next alarm: a start that works sets one. */
  override async alarm(): Promise<void> {
    const service = this.service;
    if (!service) return;
    try {
      await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    } catch (err) {
      console.error('[lyren] Could not schedule the next maintenance:', err);
    }
    try {
      await service.maintenance();
    } catch (err) {
      console.error('[lyren] Maintenance failed:', err);
    }
    // §5.6's domain-move warning: here rather than in the constructor, whose every run would read every passkey.
    try {
      const warning = service.passkeyWarning();
      if (warning !== null) console.warn(`[lyren] Warning: ${warning}`);
    } catch (err) {
      console.error('[lyren] Could not count the accounts left without a passkey that works here:', err);
    }
  }

  private reason(): string {
    return this.unavailable?.message ?? 'The directory is not ready yet. Try again in a minute.';
  }

  /** The service, or the reason it is unavailable (thrown to the RPC caller). */
  private ready(): DirectoryService {
    if (!this.service) throw new Error(this.reason());
    return this.service;
  }
}
