// SpaceDO (design §2.1, §10.3, §10.5): one Durable Object per space, named by the space id. It holds the
// space's database (DoDb over the object's SQLite storage) and its space host (space/host.ts: the auth
// cache, the users mirror, the space app behind the gate), and serves the requests the Worker sends it
// (the TrustedMeta in x-lyren-meta, no Cookie header). The directory creates, invalidates, destroys and
// measures it over RPC (DoSpaceAdminClient); the host asks the directory over RPC (DoDirectoryClient).
//
// An object that holds no space (a made-up id, a space whose init has not run or did not finish, one that
// was destroyed) never creates tables itself; only init does, and it writes nothing else. It answers a
// request as a space would answer someone who may not open it, so that no answer tells whether a space
// exists (§13.2, Appendix D 28 and 39): it asks the directory (authorizeSpace for its own id, through the
// same auth cache, which keeps an unknown session for 60 s) and answers 401 for an unknown session and 404
// "Space not found" otherwise, as Node does for a space without a file.
//
// The constructor opens and migrates an existing database inside blockConcurrencyWhile; its errors are
// stored, logged and answered with 503 and the reason (as in DirectoryDO), never rethrown. readSnapshot is
// blockConcurrencyWhile (nothing else runs meanwhile, so the export's view is consistent across its awaits,
// §8.3), the import gate runs one import of this space at a time (space/importGate.ts), storageBytes is the
// database's size (SPACE_MAX_BYTES), and the write generation lives in _meta, committed with each request's own
// writes (§6.4.2: no `reopened` bump). SpaceDO sets no alarms; deleteAll() in destroy removes everything.

import { DurableObject } from 'cloudflare:workers';
import type { SpaceAppConfig } from '../../core/config';
import { isSpaceId } from '../../core/ids';
import { migrate, readSchemaState } from '../../core/migrate';
import type { SpaceAuthResult, SpaceInit, TrustedMeta } from '../../core/ports';
import { APP_VERSION } from '../../core/version';
import { errorResponse, notFound, unauthorized, unavailable } from '../../http/errors';
import { AUTHORIZE_FAILED, AuthCache, createSpaceHost, type SpaceHost } from '../../space/host';
import { createImportGate } from '../../space/importGate';
import { initSpaceDb, storedSpaceId } from '../../space/init';
import { NO_SAFETY } from '../../space/safety';
import { SPACE_MIGRATIONS } from '../../space/schema';
import { createWriteState } from '../../space/writeState';
import { DoDirectoryClient } from './clients';
import { CF_RUNTIME, cfConfig } from './config';
import { DoDb } from './doDb';
import type { Env } from './env';
import { errorAnswer, unavailableMessage, workerMeta } from './objects';

export class SpaceDO extends DurableObject<Env> {
  /** The space's database (protected: the test entry reads its meter, server/test-workers/entry.ts). */
  protected readonly db: DoDb;
  private readonly directory: DoDirectoryClient;
  /** The space id this object is named by; null when its name is none (no request ever names it). */
  private readonly spaceId: string | null;
  /** Why the space cannot serve (set by the constructor instead of throwing). */
  private unavailable: { message: string } | null = null;
  private config: SpaceAppConfig | null = null;
  /** AUTH_CACHE_SECONDS (none when 0); the host uses the same one once the space exists. */
  private cache: AuthCache | null = null;
  private host: SpaceHost | null = null;
  /** One import of this space at a time (Appendix D 62): a commit awaits the directory between its read and its write. */
  private readonly importGate = createImportGate('Another import into this space is running. Try again in a minute.');
  /** destroy() ran: this instance holds no space until it is evicted. */
  private destroyed = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = new DoDb(ctx.storage);
    this.directory = new DoDirectoryClient(env);
    const name = ctx.id.name;
    this.spaceId = name !== undefined && isSpaceId(name) ? name : null;
    void ctx.blockConcurrencyWhile(async () => {
      try {
        const config = cfConfig(env).space;
        this.config = config;
        this.cache = config.authCacheSeconds > 0 ? new AuthCache(config.authCacheSeconds * 1000) : null;
        // Uninitialized: never create tables here.
        if (readSchemaState(this.db).empty) return;
        migrate(this.db, SPACE_MIGRATIONS, { appVersion: APP_VERSION });
        this.open();
      } catch (err) {
        this.unavailable = { message: unavailableMessage(err) };
        console.error(`[lyren] Space ${name ?? '(unnamed)'} is unavailable:`, err);
      }
    });
  }

  override async fetch(request: Request): Promise<Response> {
    if (this.unavailable) return errorResponse(unavailable(this.unavailable.message));
    const found = workerMeta(request, 'space');
    if ('refusal' in found) return found.refusal;
    try {
      return this.host ? await this.host.serve(request, found.meta) : await this.refuse(found.meta);
    } catch (err) {
      return errorAnswer(err, `A request for space ${this.spaceId}`);
    }
  }

  // ---- RPC (DirectoryDO, through DoSpaceAdminClient) ------------------------------------------------

  /** Creates the schema, defaults, the owner's mirror row and the _meta records (space/init.ts); idempotent. */
  async init(init: SpaceInit): Promise<void> {
    if (this.unavailable) throw new Error(this.unavailable.message);
    if (this.destroyed) throw new Error(`Space ${this.spaceId} was destroyed`);
    if (init.spaceId !== this.spaceId) throw new Error(`This object holds space ${this.spaceId}, not ${init.spaceId}`);
    initSpaceDb(this.db, init);
    if (!this.host) this.open();
  }

  /** Drops the auth cache and makes the next request sync the users mirror. */
  async invalidate(): Promise<void> {
    if (this.host) this.host.invalidate();
    else this.cache?.clear();
  }

  /** Deletes everything the object stores (also when it is unavailable); idempotent. */
  async destroy(): Promise<void> {
    this.host = null;
    this.destroyed = true;
    this.cache?.clear();
    await this.ctx.storage.deleteAll();
  }

  /** The database's size and its task count; null when the object holds no space. */
  async stats(): Promise<{ bytes: number; tasks: number } | null> {
    if (this.unavailable) throw new Error(this.unavailable.message);
    if (!this.host) return null;
    const tasks = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks')!.n;
    return { bytes: this.ctx.storage.sql.databaseSize, tasks };
  }

  // ---- Internals ------------------------------------------------------------------------------------

  /** Builds the host once the database holds this space (initSpaceDb wrote its id). */
  private open(): void {
    const stored = storedSpaceId(this.db);
    // An init that did not finish: not a space yet (init runs again).
    if (stored === null || this.spaceId === null || this.config === null) return;
    if (stored !== this.spaceId) throw new Error(`This database belongs to space ${stored}, not ${this.spaceId}`);
    const { db, config } = this;
    this.host = createSpaceHost({
      deps: {
        db,
        config,
        space: {
          id: this.spaceId,
          directory: this.directory,
          safety: NO_SAFETY,
          runtime: CF_RUNTIME,
          readSnapshot: (fn) => this.ctx.blockConcurrencyWhile(() => fn(db)),
          writeState: createWriteState(db, { dailyRowWrites: config.spaceDailyRowWrites }),
          importGate: this.importGate,
          storageBytes: () => this.ctx.storage.sql.databaseSize,
        },
      },
      authCacheTtlMs: config.authCacheSeconds * 1000,
      authCache: this.cache,
    });
  }

  /**
   * No space here: the answer someone who may not open a space gets (see the header). 401 without a
   * session or for one the directory does not know, else 404; the directory is asked through the cache.
   */
  private async refuse(meta: TrustedMeta): Promise<Response> {
    const { sessionTokenHash: tokenHash, sessionCookie: cookie } = meta;
    if (tokenHash === null || cookie === null) return errorResponse(unauthorized());
    if (this.spaceId === null) return errorResponse(notFound('Space'));
    const input = { tokenHash, spaceId: this.spaceId, cookie, secure: meta.secure };
    const load = () => this.directory.authorizeSpace(input);
    let result: SpaceAuthResult;
    try {
      result = this.cache ? (await this.cache.lookup(tokenHash, Date.now(), load)).result : await load();
    } catch (err) {
      console.error(`[lyren] Authorizing a request for space ${this.spaceId} failed:`, err);
      return errorResponse(unavailable(AUTHORIZE_FAILED));
    }
    return errorResponse(!result.ok && result.reason === 'unauthenticated' ? unauthorized() : notFound('Space'));
  }
}
