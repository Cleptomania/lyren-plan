// The directory client on Node (design §2.2 a, §9.1): in-process calls. serve() hands a request to the
// directory app with the TrustedMeta as its binding; the other methods are the DirectoryService's,
// passed through (no auth cache on Node, so a revocation reaches every space at once).

import type { Hono } from 'hono';
import type { DirectoryClient, SpaceDirectoryPort, TrustedMeta } from '../../core/ports';
import type { DirectoryEnv } from '../../directory/app';
import type { DirectoryService } from '../../directory/service';

export class NodeDirectoryClient implements DirectoryClient {
  constructor(
    private readonly app: Hono<DirectoryEnv>,
    private readonly service: DirectoryService,
  ) {}

  async serve(request: Request, meta: TrustedMeta): Promise<Response> {
    return this.app.fetch(request, { meta });
  }

  authorizeSpace(input: Parameters<DirectoryClient['authorizeSpace']>[0]) {
    return this.service.authorizeSpace(input);
  }

  spaceSync(input: Parameters<DirectoryClient['spaceSync']>[0]) {
    return this.service.spaceSync(input);
  }

  importCandidates(input: Parameters<DirectoryClient['importCandidates']>[0]) {
    return this.service.importCandidates(input);
  }

  reserveImport(input: Parameters<DirectoryClient['reserveImport']>[0]) {
    return this.service.reserveImport(input);
  }

  refundImport(input: Parameters<DirectoryClient['refundImport']>[0]) {
    return this.service.refundImport(input);
  }

  importCommitted(input: Parameters<DirectoryClient['importCommitted']>[0]) {
    return this.service.importCommitted(input);
  }
}

/**
 * A SpaceDirectoryPort for the spaces that forwards to the client `get` returns. The space store is
 * built before the directory app (which needs the store to create spaces), so its hosts reach the
 * directory through this.
 */
export function forwardingPort(get: () => SpaceDirectoryPort): SpaceDirectoryPort {
  return {
    authorizeSpace: (input) => get().authorizeSpace(input),
    spaceSync: (input) => get().spaceSync(input),
    importCandidates: (input) => get().importCandidates(input),
    reserveImport: (input) => get().reserveImport(input),
    refundImport: (input) => get().refundImport(input),
    importCommitted: (input) => get().importCommitted(input),
  };
}
