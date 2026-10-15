// HTTP error type + JSON error handler. Route code throws these; app.onError renders them.

import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ZodError } from 'zod';
import type { ApiErrorBody } from '@shared/types';

type ErrorCode = ApiErrorBody['error']['code'];

export class HttpError extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: ErrorCode;
  readonly details?: Array<{ path: string; message: string }>;

  constructor(status: ContentfulStatusCode, code: ErrorCode, message: string, details?: Array<{ path: string; message: string }>) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: Array<{ path: string; message: string }>) =>
  new HttpError(400, details ? 'validation_error' : 'bad_request', message, details);
export const unauthorized = (message = 'Not signed in') => new HttpError(401, 'unauthorized', message);
export const forbidden = (message = 'Forbidden') => new HttpError(403, 'forbidden', message);
export const notFound = (what = 'Resource') => new HttpError(404, 'not_found', `${what} not found`);
export const conflict = (message: string) => new HttpError(409, 'conflict', message);
export const rateLimited = (message = 'Too many attempts, try again later') => new HttpError(429, 'rate_limited', message);

/** Convert a ZodError to a 400 validation error with flat {path, message} details. */
export function validationError(err: ZodError, prefix?: string): HttpError {
  const details = err.issues.map((i) => ({
    path: [prefix, ...i.path.map(String)].filter(Boolean).join('.'),
    message: i.message,
  }));
  const first = details[0];
  const message = first ? (first.path ? `${first.path}: ${first.message}` : first.message) : 'Invalid input';
  return new HttpError(400, 'validation_error', message, details);
}

export function errorBody(code: ErrorCode, message: string, details?: Array<{ path: string; message: string }>): ApiErrorBody {
  return details ? { error: { code, message, details } } : { error: { code, message } };
}

/** Node's errors for a request stream the client aborted or reset mid-body. */
function isClientAbort(err: Error): boolean {
  const code = (err as { code?: unknown }).code;
  return code === 'ECONNRESET' || code === 'ECONNABORTED' || err.message === 'aborted';
}

/** app.onError handler. */
export function handleError(err: Error, c: Context): Response {
  if (err instanceof HttpError) {
    return c.json(errorBody(err.code, err.message, err.details), err.status);
  }
  if (err instanceof ZodError) {
    const v = validationError(err);
    return c.json(errorBody(v.code, v.message, v.details), 400);
  }
  // SQLite constraint violations that slipped past validation.
  const msg = String((err as { message?: unknown }).message ?? '');
  if (/UNIQUE constraint failed/i.test(msg)) {
    return c.json(errorBody('conflict', 'A record with that value already exists'), 409);
  }
  if (/FOREIGN KEY constraint failed/i.test(msg)) {
    return c.json(errorBody('conflict', 'Referenced record does not exist or is still in use'), 409);
  }
  // Hono's HTTPException (e.g. from bodyLimit) exposes getResponse().
  const maybe = err as { getResponse?: () => Response; status?: number };
  if (typeof maybe.getResponse === 'function' && typeof maybe.status === 'number') {
    if (maybe.status === 413) return c.json(errorBody('payload_too_large', 'Request body too large'), 413);
    return maybe.getResponse();
  }
  // The client went away while its body was being read: nobody receives a response and there is
  // nothing to fix server-side, so don't fill the log with a stack trace per dropped upload.
  if (isClientAbort(err)) return c.json(errorBody('bad_request', 'Request aborted'), 400);
  console.error('[lyren] Unhandled error:', err);
  return c.json(errorBody('internal', 'Internal server error'), 500);
}
