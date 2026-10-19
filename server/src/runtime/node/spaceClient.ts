// The space client on Node (design §2.2 b, §9.1): in-process calls into the space store. The gateway
// serves space requests through it (SpaceHostClient), and the directory app creates, invalidates,
// destroys and measures spaces through it (SpaceAdminClient).
//
// A space request is authorized before its space is touched (§13.2, Appendix D 28): an unknown session
// answers 401 and a space the account cannot open 404, whether or not the space has a file, so neither
// reveals that a space exists, and neither opens a closed space file or pushes a space out of the LRU.
// Only then is the host acquired, which authorizes the request again itself (an in-process lookup: Node
// has no auth cache). A space with a directory row but without a database answers 404 too.

import type { SpaceAdminClient, SpaceDirectoryPort, SpaceHostClient, SpaceInit, TrustedMeta } from '../../core/ports';
import { errorBody, HttpError, notFound, unauthorized, unavailable } from '../../http/errors';
import { AUTHORIZE_FAILED } from '../../space/host';
import type { NodeSpaceStore } from './spaceStore';

/** A JSON error answered before any space host runs. */
function refusal(err: HttpError): Response {
  return new Response(JSON.stringify(errorBody(err.code, err.message)), {
    status: err.status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export class NodeSpaceClient implements SpaceHostClient, SpaceAdminClient {
  constructor(
    private readonly store: NodeSpaceStore,
    private readonly directory: SpaceDirectoryPort,
  ) {}

  async serve(spaceId: string, request: Request, meta: TrustedMeta): Promise<Response> {
    if (meta.sessionTokenHash === null || meta.sessionCookie === null) return refusal(unauthorized());
    let result: Awaited<ReturnType<SpaceDirectoryPort['authorizeSpace']>>;
    try {
      result = await this.directory.authorizeSpace({
        tokenHash: meta.sessionTokenHash,
        spaceId,
        cookie: meta.sessionCookie,
        secure: meta.secure,
      });
    } catch (err) {
      console.error(`[lyren] Authorizing a request for space ${spaceId} failed:`, err);
      return refusal(unavailable(AUTHORIZE_FAILED));
    }
    if (!result.ok) return refusal(result.reason === 'unauthenticated' ? unauthorized() : notFound('Space'));

    const space = this.store.acquire(spaceId);
    if (!space) return refusal(notFound('Space'));
    try {
      return await space.host.serve(request, meta);
    } finally {
      space.release();
    }
  }

  init(init: SpaceInit): Promise<void> {
    return this.store.init(init);
  }

  /** Drop the space's cached state and sync its users mirror at the next request (a closed space has none). */
  invalidate(spaceId: string): Promise<void> {
    return this.store.invalidate(spaceId);
  }

  destroy(spaceId: string): Promise<void> {
    return this.store.destroy(spaceId);
  }

  stats(spaceId: string): Promise<{ bytes: number; tasks: number } | null> {
    return this.store.stats(spaceId);
  }
}
