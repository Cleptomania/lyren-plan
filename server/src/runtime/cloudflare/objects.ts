// What DirectoryDO and SpaceDO share (design §10.3): the reason an object that could not start answers
// with, the TrustedMeta of a request, and the answer for an error that reached an object outside its app.

import { ConfigError } from '../../core/config';
import { DailyQuotaError } from '../../core/db';
import { decodeMeta, META_HEADER } from '../../core/meta';
import type { TrustedMeta } from '../../core/ports';
import { dailyQuotaAnswer, errorResponse, HttpError } from '../../http/errors';

const internal = () => new HttpError(500, 'internal', 'Internal server error');

/**
 * Why an object answers 503 (§10.3): a configuration error (Appendix B), a database from a newer build
 * (typically after a rollback past a migration that is not backward compatible, §10.11), or anything else
 * that kept the database from opening.
 */
export function unavailableMessage(err: unknown): string {
  if (err instanceof ConfigError) return `Configuration error: ${err.message}`;
  const message = err instanceof Error ? err.message : String(err);
  if (/is newer than this build supports/.test(message)) {
    return 'This data was upgraded by a newer version of Lyren Plan. Deploy that version again.';
  }
  return `The database could not be opened: ${message}`;
}

/**
 * The TrustedMeta the Worker put in x-lyren-meta (it always does: the objects are reachable only through
 * its bindings). Without a valid one the request is answered 500 and logged, since only a bug gets here.
 */
export function workerMeta(request: Request, object: string): { meta: TrustedMeta } | { refusal: Response } {
  const meta = decodeMeta(request.headers.get(META_HEADER));
  if (meta) return { meta };
  console.error(`[lyren] A request reached the ${object} without a valid ${META_HEADER} header`);
  return { refusal: errorResponse(internal()) };
}

/** The answer for an error thrown outside the app (whose own handler answers the rest). */
export function errorAnswer(err: unknown, what: string): Response {
  if (err instanceof HttpError) return errorResponse(err);
  if (err instanceof DailyQuotaError) return errorResponse(dailyQuotaAnswer(err));
  console.error(`[lyren] ${what} failed:`, err);
  return errorResponse(internal());
}
