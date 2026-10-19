// The space host (design §2.2, §2.5, §10.5): one per open space, in front of its space app. For each
// request it rewrites /api/s/<id>/… to /api/…, authorizes the session against the directory (through the
// auth cache on Cloudflare; Node has none), pulls the users mirror when the identity's syncVersion is
// ahead or after an invalidate (§3.5), self-heals the actor's mirror row, and hands the identity to the
// space app as in-memory bindings, with reauthorize (a fresh lookup, for `fresh` rules) and recheck (the
// same lookup again, which the gate makes once a request's body has arrived, Appendix D 27). The space
// app never sees a Cookie header (the gateway removes it, and the host removes it again) and never reads
// identity from headers.

import type { SpaceAuthResult, SpaceIdentity, TrustedMeta } from '../core/ports';
import { META_HEADER } from '../core/meta';
import { systemClock } from '../core/runtime';
import type { AppEnv, Deps } from '../env';
import { errorBody, HttpError, notFound, unauthorized, unavailable } from '../http/errors';
import { nowIso } from '../services/sql';
import { createSpaceApp } from './app';
import { appliedSyncVersion, applySync, healActor, mirrorUserIds } from './mirror';

export interface SpaceHost {
  serve(request: Request, meta: TrustedMeta): Promise<Response>;
  /** Drops the auth cache and forces a mirror sync on the next request (SpaceAdminClient.invalidate). */
  invalidate(): void;
  /** Requests being served (a runtime closes an evicted host when this drops to 0). */
  readonly activeRequests: number;
}

export interface SpaceHostOptions {
  deps: Deps;
  /** AUTH_CACHE_SECONDS · 1000 on Cloudflare (default 30 s); 0 = no cache (always on Node). */
  authCacheTtlMs: number;
  /**
   * The auth cache to use (default: a new one with authCacheTtlMs, when that is above 0). A SpaceDO
   * passes the cache it already used before the space was initialized (runtime/cloudflare/spaceDo.ts).
   */
  authCache?: AuthCache | null;
  /** The space app to serve (default createSpaceApp(deps)); tests pass a spy. */
  app?: { fetch(request: Request, env: AppEnv['Bindings']): Response | Promise<Response> };
}

/** How long a token the directory did not know is remembered (§10.5). */
const UNAUTHENTICATED_TTL_MS = 60_000;

interface CacheEntry {
  result: SpaceAuthResult;
  /** ms epoch until which the entry may be used. */
  until: number;
}

/**
 * Authorization results by session token hash (§10.5): an `ok` result until min(now + ttl, cacheUntil),
 * `unauthenticated` for 60 s, `not_found` never; an LRU of `max` entries. Concurrent lookups of one token
 * share one load (single flight), and clear() makes every lookup that started before it unable to store
 * its result, so an answer the directory gave before a demotion or revocation is never cached after the
 * push that announced it.
 */
export class AuthCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly pending = new Map<string, Promise<SpaceAuthResult>>();
  private gen = 0;

  constructor(
    private readonly ttlMs: number,
    private readonly max = 1000,
  ) {}

  /** The cached result, a lookup already in flight for the token, or a new load. */
  async lookup(
    tokenHash: string,
    nowMs: number,
    load: () => Promise<SpaceAuthResult>,
  ): Promise<{ result: SpaceAuthResult; fromCache: boolean }> {
    const hit = this.entries.get(tokenHash);
    if (hit && hit.until > nowMs) {
      // Most recently used last.
      this.entries.delete(tokenHash);
      this.entries.set(tokenHash, hit);
      return { result: hit.result, fromCache: true };
    }
    if (hit) this.entries.delete(tokenHash);
    const inFlight = this.pending.get(tokenHash);
    if (inFlight) return { result: await inFlight, fromCache: false };
    return { result: await this.load(tokenHash, nowMs, load, true), fromCache: false };
  }

  /** A new load that bypasses the cached entry and replaces it (fresh rules, §6.4 step 4). */
  refresh(tokenHash: string, nowMs: number, load: () => Promise<SpaceAuthResult>): Promise<SpaceAuthResult> {
    this.entries.delete(tokenHash);
    return this.load(tokenHash, nowMs, load, false);
  }

  /** Clears every entry and every lookup in flight, and increments the generation. */
  clear(): void {
    this.entries.clear();
    this.pending.clear();
    this.gen += 1;
  }

  get size(): number {
    return this.entries.size;
  }

  private async load(
    tokenHash: string,
    nowMs: number,
    load: () => Promise<SpaceAuthResult>,
    share: boolean,
  ): Promise<SpaceAuthResult> {
    const gen = this.gen;
    const promise = load();
    if (share) this.pending.set(tokenHash, promise);
    try {
      const result = await promise;
      if (this.gen === gen) this.store(tokenHash, result, nowMs);
      return result;
    } finally {
      if (this.pending.get(tokenHash) === promise) this.pending.delete(tokenHash);
    }
  }

  private store(tokenHash: string, result: SpaceAuthResult, nowMs: number): void {
    let until: number;
    if (result.ok) until = Math.min(nowMs + this.ttlMs, result.cacheUntil);
    else if (result.reason === 'unauthenticated') until = nowMs + UNAUTHENTICATED_TTL_MS;
    else return;
    if (until <= nowMs) return;
    this.entries.delete(tokenHash);
    this.entries.set(tokenHash, { result, until });
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

/** A JSON error the host answers itself (before the space app runs). */
function apiError(err: HttpError): Response {
  return new Response(JSON.stringify(errorBody(err.code, err.message)), {
    status: err.status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

/** How many actors' profiles self-heal remembers (below), so that most requests read no mirror row. */
const HEALED_MAX = 1000;

/** The 503's message when the directory cannot be asked. */
export const AUTHORIZE_FAILED = 'Your access to this space could not be checked. Try again.';

export function createSpaceHost(o: SpaceHostOptions): SpaceHost {
  const { deps, authCacheTtlMs } = o;
  const { db, space } = deps;
  const clock = space.clock ?? systemClock;
  const app = o.app ?? createSpaceApp(deps);
  const cache = o.authCache !== undefined ? o.authCache : authCacheTtlMs > 0 ? new AuthCache(authCacheTtlMs) : null;
  const prefix = `/api/s/${space.id}`;
  let applied = appliedSyncVersion(db);
  /**
   * Whether `applied` was compared with the directory's version yet. A file put back by hand (a restore
   * without the command, a copy) can hold a version its directory has not reached, and its mirror would
   * otherwise stay as it is until the directory passed that version. Compared once, with the first
   * identity that is not from the auth cache, which a new host always gets.
   */
  let compared = false;
  let syncNeeded = false;
  /** The sync in flight; it resolves to false when it failed. */
  let syncing: Promise<boolean> | null = null;
  let active = 0;
  /** userId → the profile last written or seen in their mirror row. */
  const healed = new Map<number, string>();

  async function sync(): Promise<void> {
    syncNeeded = false;
    const payload = await space.directory.spaceSync({ spaceId: space.id, mirrorUserIds: mirrorUserIds(db) });
    // null: the space is being deleted; the next authorizeSpace answers not_found.
    if (payload === null) return;
    // Display data, not the space's content: the write budget leaves it out (§6.4.2).
    space.writeState.uncounted(() => {
      if (applySync(db, payload, nowIso()) > 0) space.writeState.bump();
    });
    // The directory's version, as applySync wrote it (one sync at a time, so it never goes back but
    // after a file that was ahead).
    applied = payload.syncVersion;
    healed.clear();
  }

  /** A new sync, or the one in flight; false when it failed (logged; the next request tries again). */
  function syncOnce(): Promise<boolean> {
    syncing ??= sync()
      .then(() => true)
      .catch((err: unknown) => {
        // The actor's own row is still self-healed below.
        syncNeeded = true;
        console.error(`[lyren] Users mirror sync of space ${space.id} failed:`, err);
        return false;
      })
      .finally(() => {
        syncing = null;
      });
    return syncing;
  }

  /**
   * Sync when the identity is ahead of the mirror, an invalidate asked for it, or the file was ahead of
   * the directory (`compared`); one sync at a time.
   */
  async function syncIfBehind(identity: SpaceIdentity, fromCache: boolean): Promise<void> {
    if (!compared && !fromCache) {
      compared = true;
      if (identity.space.syncVersion < applied) syncNeeded = true;
    }
    const behind = () => syncNeeded || identity.space.syncVersion > applied;
    if (!behind()) return;
    // A sync that was already running may have read the directory before this request's change (an
    // invalidate, a newer syncVersion): when it is done and did not catch up, sync once more.
    const joined = syncing !== null;
    if ((await syncOnce()) && joined && behind()) await syncOnce();
  }

  function heal(identity: SpaceIdentity): void {
    const profile = JSON.stringify([identity.displayName, identity.email]);
    if (healed.get(identity.userId) === profile) return;
    try {
      space.writeState.uncounted(() => {
        if (healActor(db, identity, nowIso())) space.writeState.bump();
      });
    } catch (err) {
      // As a failed sync: logged, and this request goes on (reads still work when writes fail, §11.3).
      console.error(`[lyren] Self-heal of user ${identity.userId} in space ${space.id} failed:`, err);
      return;
    }
    if (healed.size >= HEALED_MAX) healed.clear();
    healed.set(identity.userId, profile);
  }

  /** /api/s/<id>/rest → /api/rest, without the Cookie header (and any client-sent meta header). */
  function rewrite(request: Request): Request | null {
    const url = new URL(request.url);
    if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return null;
    url.pathname = `/api${url.pathname.slice(prefix.length)}`;
    const headers = new Headers(request.headers);
    headers.delete('cookie');
    headers.delete(META_HEADER);
    const init: RequestInit & { duplex?: 'half' } = { method: request.method, headers, signal: request.signal };
    if (request.body !== null) {
      init.body = request.body;
      init.duplex = 'half';
    }
    return new Request(url, init);
  }

  /**
   * The request's authorization: through the auth cache when there is one, else from the directory.
   * Throws what the host answers when it cannot serve the request: 401, 404, or 503 when the directory
   * cannot be asked.
   */
  async function authorize(
    tokenHash: string,
    load: () => Promise<SpaceAuthResult>,
  ): Promise<{ identity: SpaceIdentity; fromCache: boolean }> {
    let auth: { result: SpaceAuthResult; fromCache: boolean };
    try {
      auth = cache ? await cache.lookup(tokenHash, clock.now(), load) : { result: await load(), fromCache: false };
    } catch (err) {
      console.error(`[lyren] Authorizing a request for space ${space.id} failed:`, err);
      throw unavailable(AUTHORIZE_FAILED);
    }
    const { result, fromCache } = auth;
    if (!result.ok) throw result.reason === 'unauthenticated' ? unauthorized() : notFound('Space');
    if (result.identity.space.id !== space.id) throw notFound('Space');
    return { identity: result.identity, fromCache };
  }

  async function serve(request: Request, meta: TrustedMeta): Promise<Response> {
    active += 1;
    try {
      const rewritten = rewrite(request);
      if (!rewritten) return apiError(new HttpError(404, 'not_found', 'Not found'));
      if (meta.sessionTokenHash === null || meta.sessionCookie === null) return apiError(unauthorized());
      const input = { tokenHash: meta.sessionTokenHash, spaceId: space.id, cookie: meta.sessionCookie, secure: meta.secure };
      const load = () => space.directory.authorizeSpace(input);

      let auth: { identity: SpaceIdentity; fromCache: boolean };
      try {
        auth = await authorize(input.tokenHash, load);
      } catch (err) {
        if (err instanceof HttpError) return apiError(err);
        throw err;
      }
      const { identity, fromCache } = auth;

      await syncIfBehind(identity, fromCache);
      heal(identity);

      const reauthorize = async (): Promise<SpaceIdentity | null> => {
        let fresh: SpaceAuthResult;
        try {
          fresh = cache ? await cache.refresh(input.tokenHash, clock.now(), load) : await load();
        } catch (err) {
          console.error(`[lyren] Authorizing a request for space ${space.id} failed:`, err);
          throw unavailable(AUTHORIZE_FAILED);
        }
        return fresh.ok && fresh.identity.space.id === space.id ? fresh.identity : null;
      };
      const recheck = () => authorize(input.tokenHash, load);
      return await app.fetch(rewritten, { identity, fromCache, reauthorize, recheck, meta });
    } finally {
      active -= 1;
    }
  }

  return {
    serve,
    invalidate() {
      cache?.clear();
      syncNeeded = true;
      healed.clear();
    },
    get activeRequests() {
      return active;
    },
  };
}
