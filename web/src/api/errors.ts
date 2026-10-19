// API errors (design §7.5, §12.11): ApiError, how a failed response becomes one, and what the UI does
// with each code. Pure, so the mapping is unit-tested (errors.test.ts); api/client.ts applies it to every
// response, and toasts, error states and forms read the text through errorMessage().

import type { ApiErrorBody } from '@shared/types';

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorBody['error']['code'] | 'network_error';
  readonly details: Array<{ path: string; message: string }>;

  constructor(status: number, code: ApiError['code'], message: string, details: ApiError['details'] = []) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** Message for a specific field path (e.g. 'title'), for inline form errors. */
  fieldError(path: string): string | undefined {
    return this.details.find((d) => d.path === path)?.message;
  }
}

/**
 * A reauth_required refusal whose re-auth dialog the person closed (§12.8): the request was not sent again
 * (api/client.ts). Nothing needs saying about it (toast.error shows nothing); its code is the server's.
 */
export class ReauthDeclinedError extends ApiError {}

/** Whether `err` is a re-auth the person declined (ReauthDeclinedError). */
export function isReauthDeclined(err: unknown): boolean {
  return err instanceof ReauthDeclinedError;
}

/** Cloudflare's own answer once the account's daily requests are spent (§11.3): a page naming error 1027. */
export const DAILY_LIMIT_TEXT = 'This instance has reached its daily usage limit. It resets at 00:00 UTC.';
/**
 * Any other 429 without an error body of ours: the zone's rate-limiting rule (Cloudflare's error 1015, a block
 * of seconds; docs/cloudflare.md step 9) or a reverse proxy's limit (Appendix D 66).
 */
export const TOO_MANY_REQUESTS_TEXT = 'Too many requests. Wait a moment and try again.';
/** A 503 without an error body of ours (a proxy, the platform). */
export const UNAVAILABLE_TEXT = 'Lyren Plan is temporarily unavailable.';
export const SPACE_IMPORTING_TEXT = 'This space is still being imported.';

function isErrorBody(data: unknown): data is ApiErrorBody {
  const error = (data as ApiErrorBody | null)?.error;
  return typeof error === 'object' && error !== null && typeof error.code === 'string' && typeof error.message === 'string';
}

/**
 * The ApiError of a failed response from its status and body text. The server's own answers carry
 * `{ error: { code, message, details? } }`; anything else came from in front of it (a reverse proxy,
 * Cloudflare's 1027 or 1015 page, a 503 while the server restarts).
 */
export function errorFromResponse(status: number, text: string): ApiError {
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (isErrorBody(data)) {
    const { code, message, details } = data.error;
    return new ApiError(status, code, message, Array.isArray(details) ? details : []);
  }
  if (data === null && /\b1027\b/.test(text)) return new ApiError(status, 'rate_limited', DAILY_LIMIT_TEXT);
  if (status === 429) return new ApiError(429, 'rate_limited', TOO_MANY_REQUESTS_TEXT);
  if (status === 503) return new ApiError(503, 'unavailable', UNAVAILABLE_TEXT);
  return new ApiError(status, status === 401 ? 'unauthorized' : 'internal', `Request failed (${status})`);
}

/** The page's location, as the wrong_host redirect keeps it. */
export interface PageLocation {
  origin: string;
  pathname: string;
  search: string;
  hash: string;
}

/**
 * Where a 421 wrong_host (§10.2) sends the page: the same path, search and hash at the origin of the
 * PUBLIC_URL in the error's details. Null when that is no http(s) URL, or is this origin already (a
 * redirect there would only loop).
 */
export function wrongHostUrl(err: ApiError, location: PageLocation): string | null {
  const publicUrl = err.details.find((d) => d.path === 'publicUrl')?.message;
  if (!publicUrl) return null;
  let base: URL;
  try {
    base = new URL(publicUrl);
  } catch {
    return null;
  }
  if ((base.protocol !== 'https:' && base.protocol !== 'http:') || base.origin === location.origin) return null;
  // Set part by part: a pathname such as //other.example/x can never become another host this way.
  const url = new URL(base.origin);
  url.pathname = location.pathname;
  url.search = location.search;
  url.hash = location.hash;
  return url.origin === base.origin ? url.href : null;
}

/** What the UI does with an error (§12.11). */
export type ErrorAction =
  /** reauth_required: confirm the password or a passkey (the re-auth dialog), then retry once. */
  | { kind: 'reauth'; message: string }
  /** wrong_host: move to PUBLIC_URL. */
  | { kind: 'redirect'; url: string }
  /** Everything else: say it (a toast, an inline message, an error state). */
  | { kind: 'message'; message: string };

export function errorAction(err: ApiError, location?: PageLocation): ErrorAction {
  switch (err.code) {
    case 'reauth_required':
      return { kind: 'reauth', message: err.message };
    case 'wrong_host': {
      const url = location ? wrongHostUrl(err, location) : null;
      return url ? { kind: 'redirect', url } : { kind: 'message', message: err.message };
    }
    case 'space_unavailable':
      return { kind: 'message', message: SPACE_IMPORTING_TEXT };
    case 'unavailable':
      return { kind: 'message', message: err.message || UNAVAILABLE_TEXT };
    // quota_exceeded, last_owner, last_admin, last_credential, rate_limited and the rest: the server's
    // texts are written for users.
    default:
      return { kind: 'message', message: err.message };
  }
}

/**
 * The spaces a last_owner refusal of an account deletion names (§5.8.17): details `spaces.<id>`
 * whose message is the space's name.
 */
export function lastOwnerSpaces(err: ApiError): Array<{ id: string; name: string }> {
  if (err.code !== 'last_owner') return [];
  return err.details.flatMap((d) => (d.path.startsWith('spaces.') ? [{ id: d.path.slice('spaces.'.length), name: d.message }] : []));
}

/** Human-readable message for any thrown value (for toasts). */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const action = errorAction(err);
    return action.kind === 'message' || action.kind === 'reauth' ? action.message : err.message;
  }
  if (err instanceof Error) return err.message;
  return 'Something went wrong';
}
