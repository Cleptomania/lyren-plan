// What the space app's route factories receive (design §2.5) and its Hono environment. Runtime-neutral:
// the Node runtime (runtime/node/spaceStore.ts) and the Cloudflare SpaceDO build Deps for each space.

import type { SpaceAppConfig } from './core/config';
import type { Db } from './core/db';
import type { SpaceDirectoryPort, SpaceIdentity, TrustedMeta } from './core/ports';
import type { Clock, RuntimeInfo } from './core/runtime';
import type { GateRule } from './space/gate';
import type { SpaceSafety } from './space/safety';
import type { WriteState } from './space/writeState';

export interface Deps {
  /** This space's database. */
  db: Db;
  config: SpaceAppConfig;
  space: {
    id: string;
    /** Import candidates, reservations and commits (§8.4, P7). */
    directory: SpaceDirectoryPort;
    /** What a replace import can fall back to (§8.8). */
    safety: SpaceSafety;
    runtime: RuntimeInfo;
    /**
     * Runs fn on a consistent view of the space across awaits (export, §8.3). Node: a second read
     * connection inside BEGIN…COMMIT (WAL snapshot); in-memory databases use the main connection. CF:
     * ctx.blockConcurrencyWhile.
     */
    readSnapshot<T>(fn: (db: Db) => Promise<T>): Promise<T>;
    /** Write generation and daily write budget of this space (§6.4.2). */
    writeState: WriteState;
    /** One import at a time, a second one gets 503 (§8.4, space/importGate.ts): Node per process, CF per space. */
    importGate: { run<T>(fn: () => Promise<T>): Promise<T> };
    /**
     * The database's size in bytes, for SPACE_MAX_BYTES (§11.4; CF: ctx.storage.sql.databaseSize). Omitted,
     * the gate never refuses a write as "full".
     */
    storageBytes?: () => number;
    /** The gate's clock: the re-auth window and the UTC day of the write budget (default: system time). */
    clock?: Clock;
  };
}

/** The acting user as route bodies see it (currentUser, space/context.ts); built from the identity. */
export interface SpaceActor {
  id: number;
  display_name: string;
}

export interface AppEnv {
  /** In-memory bindings the space host passes to app.fetch (§10.5); never read from headers or cookies. */
  Bindings: {
    identity: SpaceIdentity;
    /** The identity came from the Cloudflare auth cache. */
    fromCache: boolean;
    /** A fresh authorizeSpace, bypassing the cache (null → 401). */
    reauthorize: () => Promise<SpaceIdentity | null>;
    /**
     * The request's authorization again, as of now, the way the host looked it up (through the
     * Cloudflare auth cache; Node has none): the gate judges a request whose body it awaited on this
     * (Appendix D 27). Throws the host's 401, 404 or 503.
     */
    recheck: () => Promise<{ identity: SpaceIdentity; fromCache: boolean }>;
    meta: TrustedMeta;
  };
  Variables: {
    user: SpaceActor;
    /** The identity the gate judged: c.env.identity, or the fresh one of a `fresh` rule (§6.4 step 4). */
    identity: SpaceIdentity;
    rule: GateRule;
    importMode?: 'new' | 'replace';
  };
}
