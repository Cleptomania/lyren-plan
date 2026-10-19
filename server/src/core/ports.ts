// The asynchronous interfaces between the gateway, the directory and the space hosts (design §2.3).
// They are runtime-neutral: on Node the clients are in-process calls, on Cloudflare stub.fetch and
// RPC between the Worker and the Durable Objects. Arguments and results stay plain JSON-safe data.
// (The Db interface is in core/db.ts; RuntimeInfo, Clock and Defer are in core/runtime.ts.)

import type { SpaceRole } from '@shared/roles';
import type { ImportCandidateDTO } from '@shared/types';

export type { ImportCandidateDTO, SpaceRole };

/** Facts the gateway established. Trusted because only the gateway can build it (core/meta.ts). */
export interface TrustedMeta {
  /** '' when unknown; rate-limit keys use limiterKey(clientIp). */
  clientIp: string;
  /** The browser's request was HTTPS (cookie Secure flag and name, §5.4). */
  secure: boolean;
  /** Random UUID, for logs. */
  requestId: string;
  /** Truncated to 300 characters. */
  userAgent: string | null;
  /** Space requests only: sha256 hex of the session cookie value. */
  sessionTokenHash: string | null;
  /** Space requests only: which cookie name carried it (§5.4.1). */
  sessionCookie: 'host' | 'plain' | null;
}

export interface SpaceIdentity {
  /** Directory users.id = the id in the space's users mirror. */
  userId: number;
  displayName: string;
  email: string | null;
  role: SpaceRole;
  instanceAdmin: boolean;
  sessionId: number;
  /** ISO time of the last credential proof in this session (§5.4.4). */
  reauthAt: string;
  space: { id: string; name: string; status: 'importing' | 'active'; syncVersion: number };
}

export type SpaceAuthResult =
  | { ok: true; identity: SpaceIdentity; cacheUntil: number } // cacheUntil: ms epoch, ≤ session expiry
  | { ok: false; reason: 'unauthenticated' } // no or expired session, disabled user → 401
  | { ok: false; reason: 'not_found' }; // not a member, space deleted or provisioning → 404

export interface MirrorProfile {
  userId: number;
  displayName: string;
  email: string | null;
}

export interface SpaceSyncPayload {
  name: string;
  status: 'importing' | 'active';
  syncVersion: number;
  /** Current members. */
  members: MirrorProfile[];
  /** One entry for every id in mirrorUserIds that is not a current member (§3.5). */
  others: Array<{ userId: number; displayName: string } | { userId: number; deleted: true }>;
}

export type ImportReservation =
  | {
      ok: true;
      /** What refundImport gives back; null when nothing was reserved (a start, or no daily budget: Node's default). */
      reservationId: string | null;
      /** What is left of today's IMPORT_DAILY_ROW_WRITES after this reservation; null when there is none. */
      dailyLeft: number | null;
    }
  | { ok: false; reason: 'rate_limited' | 'daily_budget'; retryAfterSec: number };

/** Gateway → directory, and space host → directory. */
export interface DirectoryClient {
  serve(request: Request, meta: TrustedMeta): Promise<Response>;
  authorizeSpace(input: {
    tokenHash: string;
    spaceId: string;
    cookie: 'host' | 'plain';
    secure: boolean;
  }): Promise<SpaceAuthResult>;
  /** Full mirror state for a space. mirrorUserIds = every account row of the mirror with deleted = 0. */
  spaceSync(input: { spaceId: string; mirrorUserIds: number[] }): Promise<SpaceSyncPayload | null>;
  /** Users an importer may map archive users to (§8.5). */
  importCandidates(input: { spaceId: string; userId: number; emailKeys: string[] }): Promise<ImportCandidateDTO[]>;
  /**
   * The import's limits (§8.4, §8.9, Appendix D 62). `start`, as every analyze and commit begins, before the
   * file is read: counts im:<userId> and reports what is left of today's budget (rowWrites 0). `rows`, a
   * commit's after its estimate: reserves rowWrites of the instance's daily import budget, counting nothing.
   */
  reserveImport(input: {
    spaceId: string;
    userId: number;
    step: 'start' | 'rows';
    rowWrites: number;
  }): Promise<ImportReservation>;
  /**
   * Gives back a reservation whose commit did not write (failed or idempotent retry), less `spentRows`: what
   * a transaction that failed part way was billed for all the same (the space's meter, Cloudflare).
   */
  refundImport(input: { reservationId: string; spentRows?: number }): Promise<void>;
  /**
   * A space host finished an import (both modes): an 'importing' space becomes 'active'; the mapped
   * accounts are recorded in space_people (§3.5); sync_version is bumped. Idempotent.
   */
  importCommitted(input: {
    spaceId: string;
    userId: number;
    mode: 'new' | 'replace';
    mappedUserIds: number[];
  }): Promise<void>;
}

/** The subset a space host needs (both runtimes implement it over DirectoryClient). */
export type SpaceDirectoryPort = Pick<
  DirectoryClient,
  'authorizeSpace' | 'spaceSync' | 'importCandidates' | 'reserveImport' | 'refundImport' | 'importCommitted'
>;

/** Gateway → space host. */
export interface SpaceHostClient {
  serve(spaceId: string, request: Request, meta: TrustedMeta): Promise<Response>;
}

/** Directory → space storage. Trusted internal calls; no identity. */
export interface SpaceInit {
  spaceId: string;
  name: string;
  owner: MirrorProfile;
  syncVersion: number;
  sampleData: { today?: string } | null;
}

export interface SpaceAdminClient {
  /** Create schema, defaults and the owner's mirror row; idempotent. */
  init(init: SpaceInit): Promise<void>;
  /** Drop the auth cache and force a sync on the next request. */
  invalidate(spaceId: string): Promise<void>;
  /** Delete all data; idempotent. */
  destroy(spaceId: string): Promise<void>;
  stats(spaceId: string): Promise<{ bytes: number; tasks: number } | null>;
}
