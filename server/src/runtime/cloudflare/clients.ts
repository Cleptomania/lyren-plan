// The clients of the Durable Objects (design §2.3, §10.2, §10.3): how the Worker reaches the objects and
// how the objects reach each other. The Worker's calls are stub.fetch with the TrustedMeta in x-lyren-meta,
// so a Request and a streamed Response pass through unchanged (uploads and downloads included); the header
// is trustworthy because the objects are reachable only through this Worker's bindings, and it is always
// replaced. Directory↔space calls are RPC methods with plain JSON-safe arguments and results.
//
// A failed RPC (the object threw, was reset or overloaded, or the platform refused the call) becomes a
// thrown Error that names the call, which the caller treats like any other failure: a failed init is
// compensated (§5.8.4), a failed push leaves the space on its cache TTL (§10.5), a failed authorizeSpace
// answers 503 (space/host.ts).

import { isSpaceId } from '../../core/ids';
import { encodeMeta, META_HEADER } from '../../core/meta';
import type {
  DirectoryClient,
  ImportCandidateDTO,
  ImportReservation,
  SpaceAdminClient,
  SpaceAuthResult,
  SpaceHostClient,
  SpaceInit,
  SpaceSyncPayload,
  TrustedMeta,
} from '../../core/ports';
import { spaceRequest, withoutMeta } from '../../gateway/guards';
import type { DirectoryDO } from './directoryDo';
import type { Env } from './env';
import type { SpaceDO } from './spaceDo';

/** The name of the one DirectoryDO. */
export const DIRECTORY_NAME = 'directory';

/** `request` with `meta` in x-lyren-meta (whatever a client sent there is replaced). */
export function withMeta(request: Request, meta: TrustedMeta): Request {
  const headers = withoutMeta(request.headers);
  headers.set(META_HEADER, encodeMeta(meta));
  return new Request(request, { headers });
}

// A stub as the object's own method types (workers-types' RPC types lose the unions of the results).
type DirectoryStub = Pick<
  DirectoryDO,
  'fetch' | 'authorizeSpace' | 'spaceSync' | 'importCandidates' | 'reserveImport' | 'refundImport' | 'importCommitted'
>;
type SpaceStub = Pick<SpaceDO, 'fetch' | 'init' | 'invalidate' | 'destroy' | 'stats'>;

/** Runs an RPC; its failure becomes an Error that names the call (the original is its cause). */
async function rpc<T>(what: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    throw new Error(`${what} failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}

/** The SpaceDO of a space; only valid ids ever name an object. */
function spaceStub(env: Env, spaceId: string): SpaceStub {
  if (!isSpaceId(spaceId)) throw new Error(`Not a space id: ${JSON.stringify(spaceId)}`);
  return env.SPACES.getByName(spaceId) as unknown as SpaceStub;
}

/** The Worker's and the space objects' way to the DirectoryDO (DirectoryClient; a SpaceDirectoryPort too). */
export class DoDirectoryClient implements DirectoryClient {
  constructor(private readonly env: Env) {}

  private stub(): DirectoryStub {
    return this.env.DIRECTORY.getByName(DIRECTORY_NAME) as unknown as DirectoryStub;
  }

  /** The directory app, with the meta in x-lyren-meta and the cookie as it came (the directory owns it). */
  serve(request: Request, meta: TrustedMeta): Promise<Response> {
    return this.stub().fetch(withMeta(request, meta));
  }

  authorizeSpace(input: Parameters<DirectoryClient['authorizeSpace']>[0]): Promise<SpaceAuthResult> {
    return rpc('The directory call authorizeSpace', () => this.stub().authorizeSpace(input));
  }

  spaceSync(input: Parameters<DirectoryClient['spaceSync']>[0]): Promise<SpaceSyncPayload | null> {
    return rpc('The directory call spaceSync', () => this.stub().spaceSync(input));
  }

  importCandidates(input: Parameters<DirectoryClient['importCandidates']>[0]): Promise<ImportCandidateDTO[]> {
    return rpc('The directory call importCandidates', () => this.stub().importCandidates(input));
  }

  reserveImport(input: Parameters<DirectoryClient['reserveImport']>[0]): Promise<ImportReservation> {
    return rpc('The directory call reserveImport', () => this.stub().reserveImport(input));
  }

  refundImport(input: Parameters<DirectoryClient['refundImport']>[0]): Promise<void> {
    return rpc('The directory call refundImport', () => this.stub().refundImport(input));
  }

  importCommitted(input: Parameters<DirectoryClient['importCommitted']>[0]): Promise<void> {
    return rpc('The directory call importCommitted', () => this.stub().importCommitted(input));
  }
}

/** The Worker's way to a space: the SpaceDO named by the id, without the Cookie header (§10.2 step 8). */
export class DoSpaceHostClient implements SpaceHostClient {
  constructor(private readonly env: Env) {}

  serve(spaceId: string, request: Request, meta: TrustedMeta): Promise<Response> {
    return spaceStub(this.env, spaceId).fetch(withMeta(spaceRequest(request), meta));
  }
}

/** The directory's way to the space objects (SpaceAdminClient). */
export class DoSpaceAdminClient implements SpaceAdminClient {
  constructor(private readonly env: Env) {}

  private stub(spaceId: string): SpaceStub {
    return spaceStub(this.env, spaceId);
  }

  init(init: SpaceInit): Promise<void> {
    return rpc(`The init of space ${init.spaceId}`, () => this.stub(init.spaceId).init(init));
  }

  invalidate(spaceId: string): Promise<void> {
    return rpc(`The invalidate of space ${spaceId}`, () => this.stub(spaceId).invalidate());
  }

  async destroy(spaceId: string): Promise<void> {
    if (!isSpaceId(spaceId)) return;
    await rpc(`The destroy of space ${spaceId}`, () => this.stub(spaceId).destroy());
  }

  async stats(spaceId: string): Promise<{ bytes: number; tasks: number } | null> {
    if (!isSpaceId(spaceId)) return null;
    return rpc(`The stats of space ${spaceId}`, () => this.stub(spaceId).stats());
  }
}
