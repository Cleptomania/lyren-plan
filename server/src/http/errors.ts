// HTTP error type + JSON error handler. Route code throws these; app.onError renders them.

import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ZodError } from 'zod';
import type { ApiErrorBody } from '@shared/types';
import { DailyQuotaError } from '../core/db';

type ErrorCode = ApiErrorBody['error']['code'];

export class HttpError extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: ErrorCode;
  readonly details?: Array<{ path: string; message: string }>;
  /** Response headers the error needs (Retry-After). */
  readonly headers?: Record<string, string>;

  constructor(
    status: ContentfulStatusCode,
    code: ErrorCode,
    message: string,
    details?: Array<{ path: string; message: string }>,
    headers?: Record<string, string>,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.headers = headers;
  }
}

/** Retry-After in whole seconds (at least 1). */
const retryAfter = (seconds: number | undefined) =>
  seconds === undefined ? undefined : { 'Retry-After': String(Math.max(1, Math.ceil(seconds))) };

export const badRequest = (message: string, details?: Array<{ path: string; message: string }>) =>
  new HttpError(400, details ? 'validation_error' : 'bad_request', message, details);
export const unauthorized = (message = 'Not signed in') => new HttpError(401, 'unauthorized', message);
export const forbidden = (message = 'Forbidden') => new HttpError(403, 'forbidden', message);
export const notFound = (what = 'Resource') => new HttpError(404, 'not_found', `${what} not found`);
export const conflict = (message: string) => new HttpError(409, 'conflict', message);
export const rateLimited = (message = 'Too many attempts, try again later', retryAfterSec?: number) =>
  new HttpError(429, 'rate_limited', message, undefined, retryAfter(retryAfterSec));
// Codes of the multi-user design (§7.5).
export const reauthRequired = () => new HttpError(403, 'reauth_required', 'Confirm it’s you to continue');
export const accountDisabled = () => new HttpError(403, 'account_disabled', 'This account has been disabled');
export const invalidToken = () => new HttpError(400, 'invalid_token', 'This link is invalid or has expired.');
export const quotaExceeded = (message: string) => new HttpError(409, 'quota_exceeded', message);
export const lastOwner = (message: string, details?: Array<{ path: string; message: string }>) =>
  new HttpError(409, 'last_owner', message, details);
export const lastAdmin = (message: string) => new HttpError(409, 'last_admin', message);
export const lastCredential = (message: string) => new HttpError(409, 'last_credential', message);
export const passkeyError = (message: string, details?: Array<{ path: string; message: string }>) =>
  new HttpError(400, 'passkey_error', message, details);
export const unavailable = (message: string, retryAfterSec?: number) =>
  new HttpError(503, 'unavailable', message, undefined, retryAfter(retryAfterSec));
export const spaceUnavailable = () => new HttpError(409, 'space_unavailable', 'This space is still being imported.');
export const payloadTooLarge = (message = 'Request body too large') => new HttpError(413, 'payload_too_large', message);

type Detail = { path: string; message: string };

/** Characters of a detail's path or message at most: a key or value of the body can be part of either. */
const DETAIL_MAX_CHARS = 300;

const clipped = (text: string) => (text.length > DETAIL_MAX_CHARS ? `${text.slice(0, DETAIL_MAX_CHARS - 1)}…` : text);

/** A zod issue as a flat {path, message} detail, its path under `prefix` (each clipped to DETAIL_MAX_CHARS). */
export function issueDetail(issue: ZodError['issues'][number], prefix?: string): Detail {
  return { path: clipped([prefix, ...issue.path.map(String)].filter(Boolean).join('.')), message: clipped(issue.message) };
}

/** Details a validation error lists at most; a last one counts the rest (Appendix D 44). */
const MAX_DETAILS = 20;

/** The first `max` of `total` problems, and a last detail that counts the rest. */
export function limitDetails(details: Detail[], max: number, total: number = details.length): Detail[] {
  if (total <= max) return details;
  return [...details.slice(0, max), { path: '', message: `…and ${total - max} more problem(s)` }];
}

/** Convert a ZodError to a 400 validation error with flat {path, message} details (the first MAX_DETAILS). */
export function validationError(err: ZodError, prefix?: string): HttpError {
  const details = err.issues.slice(0, MAX_DETAILS).map((i) => issueDetail(i, prefix));
  const first = details[0];
  const message = first ? (first.path ? `${first.path}: ${first.message}` : first.message) : 'Invalid input';
  return new HttpError(400, 'validation_error', message, limitDetails(details, MAX_DETAILS, err.issues.length));
}

/** A value that fails its schema and is too large to describe (shared/src/bounded.ts#parseBounded). */
export const invalidUndescribed = () =>
  new HttpError(400, 'validation_error', 'Invalid input (too many values to list its problems)');

export function errorBody(code: ErrorCode, message: string, details?: Array<{ path: string; message: string }>): ApiErrorBody {
  return details ? { error: { code, message, details } } : { error: { code, message } };
}

/** An HttpError as a JSON response, for code that answers without a Hono context (the Cloudflare Worker and objects). */
export function errorResponse(err: HttpError): Response {
  return new Response(JSON.stringify(errorBody(err.code, err.message, err.details)), {
    status: err.status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...err.headers },
  });
}

/** The first daily-quota error of this process or isolate is logged; the rest would only repeat it. */
let quotaLogged = false;

/** §11.3: a Durable Object's daily limit (rows read or written) is used up: 503 with the daily-limit message. */
export function dailyQuotaAnswer(err: DailyQuotaError): HttpError {
  if (!quotaLogged) {
    quotaLogged = true;
    console.error('[lyren] A daily limit of the platform is used up:', err.cause);
  }
  return unavailable(err.message);
}

/** Node's errors for a request stream the client aborted or reset mid-body. */
function isClientAbort(err: Error): boolean {
  const code = (err as { code?: unknown }).code;
  return code === 'ECONNRESET' || code === 'ECONNABORTED' || err.message === 'aborted';
}

/** app.onError handler. */
export function handleError(err: Error, c: Context): Response {
  if (err instanceof HttpError) {
    for (const [name, value] of Object.entries(err.headers ?? {})) c.header(name, value);
    return c.json(errorBody(err.code, err.message, err.details), err.status);
  }
  if (err instanceof ZodError) {
    const v = validationError(err);
    return c.json(errorBody(v.code, v.message, v.details), 400);
  }
  if (err instanceof DailyQuotaError) {
    const answer = dailyQuotaAnswer(err);
    return c.json(errorBody(answer.code, answer.message), answer.status);
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
