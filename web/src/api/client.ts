// Fetch wrapper for the JSON API. Adds the CSRF header, turns failed answers into ApiError
// (api/errors.ts), notifies listeners when the session has expired (HTTP 401), and moves the page to
// PUBLIC_URL on a 421 wrong_host. request() and `http` serve the directory's paths (/auth/…,
// /account/…, /spaces…, /admin/…); spaceApi(spaceId) the paths of one space, under /api/s/<spaceId>,
// whose reads are conditional (design §6.4.2): the last ETag and body of each are kept in memory
// (api/etagStore.ts), sent back as If-None-Match, and a 304 resolves with the stored body.

import { CSRF_HEADER } from '@shared/constants';
import { createEtagStore, etagKey, sameEtag } from './etagStore';
import { ApiError, errorFromResponse, ReauthDeclinedError, wrongHostUrl } from './errors';
import { servedFromThisComputer, unreachableText } from './networkError';

export { ApiError, errorMessage, isReauthDeclined } from './errors';

type UnauthorizedListener = () => void;
const unauthorizedListeners = new Set<UnauthorizedListener>();

/** Subscribe to "session expired" events (any 401 outside /auth). Returns an unsubscribe. */
export function onUnauthorized(fn: UnauthorizedListener): () => void {
  unauthorizedListeners.add(fn);
  return () => unauthorizedListeners.delete(fn);
}

/**
 * Asked when a request is answered 403 reauth_required (§12.8): it confirms the password or a passkey and
 * resolves true when the re-auth window is open again, and the request is then sent once more; false (the
 * dialog was closed) rejects the request with a ReauthDeclinedError.
 */
export type ReauthHandler = (err: ApiError) => Promise<boolean>;
let reauthHandler: ReauthHandler | null = null;

/** Install the re-auth dialog's handler (one at a time). Returns an uninstall. */
export function setReauthHandler(handler: ReauthHandler): () => void {
  reauthHandler = handler;
  return () => {
    if (reauthHandler === handler) reauthHandler = null;
  };
}

const etags = createEtagStore();

/** Forget the conditional-read memory: all of it, or one space's (left or lost). */
export function forgetEtags(spaceId?: string): void {
  if (spaceId === undefined) etags.clear();
  else etags.forgetSpace(spaceId);
}

/** Forget the conditional-read memory of every space but `spaceIds` (the account's spaces now). */
export function retainEtags(spaceIds: readonly string[]): void {
  etags.retainSpaces(spaceIds);
}

// Once per page load: should the instance at PUBLIC_URL answer 421 again, the page stays where it is.
let movedToPublicUrl = false;

function moveToPublicUrl(err: ApiError): void {
  if (movedToPublicUrl || typeof window === 'undefined') return;
  const url = wrongHostUrl(err, window.location);
  if (url === null) return;
  movedToPublicUrl = true;
  window.location.replace(url);
}

/** Space reads sent as POST (the gate's conditional rules): answered 304 like a GET. */
const CONDITIONAL_POSTS: ReadonlySet<string> = new Set(['/tasks/query']);

interface SendOptions {
  /** A space read: If-None-Match from the store, 304 from it. */
  conditional?: boolean;
  /** This is the request again after a re-auth or a 304 the store could not answer. */
  retry?: 'reauth' | 'unconditional';
}

async function send<T>(method: string, path: string, body: unknown, init: RequestInit, o: SendOptions): Promise<T> {
  const url = `/api${path}`;
  // A form (an import's file) goes as multipart, its boundary in the Content-Type the browser writes.
  const form = body instanceof FormData ? body : undefined;
  const text = body === undefined || form ? undefined : JSON.stringify(body);
  const key = o.conditional ? etagKey(method, url, text) : null;
  const cached = key !== null && o.retry !== 'unconditional' ? etags.get(key) : undefined;
  // A sign-out, or leaving the space, while the request is out: its answer is not kept.
  const mark = key !== null ? etags.mark(key) : undefined;
  const headers: Record<string, string> = { Accept: 'application/json', [CSRF_HEADER]: '1' };
  if (text !== undefined) headers['Content-Type'] = 'application/json';
  if (cached) headers['If-None-Match'] = cached.etag;
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      method,
      headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
      body: form ?? text,
      credentials: 'same-origin',
      // The browser's cache stays out of it, so the 304 reaches this code as it is.
      ...(key !== null && { cache: 'no-store' }),
    });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err;
    const message = servedFromThisComputer() ? unreachableText().message : 'Could not reach the server. Check your connection.';
    throw new ApiError(0, 'network_error', message);
  }

  if (res.status === 304 && key !== null) {
    // Read the (empty) body to its end, so the request completes rather than being cut off unread.
    await res.text().catch(() => '');
    const etag = res.headers.get('ETag');
    if (cached && (etag === null || sameEtag(etag, cached.etag))) {
      etags.set(key, cached, mark);
      return JSON.parse(cached.text) as T;
    }
    // Not the answer this client holds (evicted meanwhile, or another tag): ask without the condition.
    etags.delete(key);
    if (o.retry === 'unconditional') throw new ApiError(304, 'internal', 'Unexpected answer (304)');
    return send<T>(method, path, body, init, { ...o, retry: 'unconditional' });
  }

  const resText = await res.text();
  if (!res.ok) {
    const err = errorFromResponse(res.status, resText);
    if (res.status === 401 && !path.startsWith('/auth/')) {
      unauthorizedListeners.forEach((fn) => fn());
    }
    if (err.code === 'wrong_host') moveToPublicUrl(err);
    if (err.code === 'reauth_required' && reauthHandler && o.retry !== 'reauth') {
      if (await reauthHandler(err)) return send<T>(method, path, body, init, { ...o, retry: 'reauth' });
      // The person closed the dialog: the caller has nothing to tell them (errors.ts isReauthDeclined).
      throw new ReauthDeclinedError(err.status, err.code, err.message, err.details);
    }
    throw err;
  }
  if (key !== null) {
    const etag = res.headers.get('ETag');
    if (etag) etags.set(key, { etag, text: resText }, mark);
    else etags.delete(key);
  }
  if (!resText) return null as T;
  try {
    return JSON.parse(resText) as T;
  } catch {
    return null as T;
  }
}

/** A directory request (paths after /api). */
export function request<T>(method: string, path: string, body?: unknown, init: RequestInit = {}): Promise<T> {
  return send<T>(method, path, body, init, {});
}

export const http = {
  get: <T>(path: string, init?: RequestInit) => request<T>('GET', path, undefined, init),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};

/** Requests to one space: `path` is the space app's (/tasks/12), sent as /api/s/<spaceId>/tasks/12. */
export function spaceApi(spaceId: string) {
  const prefix = `/s/${spaceId}`;
  return {
    get: <T>(path: string, init: RequestInit = {}) => send<T>('GET', prefix + path, undefined, init, { conditional: true }),
    post: <T>(path: string, body?: unknown, init: RequestInit = {}) =>
      send<T>('POST', prefix + path, body ?? {}, init, { conditional: CONDITIONAL_POSTS.has(path) }),
    patch: <T>(path: string, body: unknown, init: RequestInit = {}) => send<T>('PATCH', prefix + path, body, init, {}),
    put: <T>(path: string, body: unknown, init: RequestInit = {}) => send<T>('PUT', prefix + path, body, init, {}),
    del: <T>(path: string, init: RequestInit = {}) => send<T>('DELETE', prefix + path, undefined, init, {}),
  };
}

export type SpaceApi = ReturnType<typeof spaceApi>;

/** Build a query string from defined values: qs({a: 1, b: undefined}) -> '?a=1'. */
export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}
