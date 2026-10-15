// Fetch wrapper for the JSON API. Adds the CSRF header, parses errors into ApiError,
// and notifies listeners when the session has expired (HTTP 401).

import { CSRF_HEADER } from '@shared/constants';
import type { ApiErrorBody } from '@shared/types';
import { servedFromThisComputer, unreachableText } from './networkError';

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

type UnauthorizedListener = () => void;
const unauthorizedListeners = new Set<UnauthorizedListener>();

/** Subscribe to "session expired" events (any 401 outside /auth). Returns an unsubscribe. */
export function onUnauthorized(fn: UnauthorizedListener): () => void {
  unauthorizedListeners.add(fn);
  return () => unauthorizedListeners.delete(fn);
}

export async function request<T>(method: string, path: string, body?: unknown, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', [CSRF_HEADER]: '1' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      ...init,
      method,
      headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err;
    const message = servedFromThisComputer() ? unreachableText().message : 'Could not reach the server. Check your connection.';
    throw new ApiError(0, 'network_error', message);
  }

  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    const err = (data as ApiErrorBody | null)?.error;
    if (res.status === 401 && !path.startsWith('/auth/')) {
      unauthorizedListeners.forEach((fn) => fn());
    }
    throw new ApiError(
      res.status,
      err?.code ?? (res.status === 401 ? 'unauthorized' : 'internal'),
      err?.message ?? `Request failed (${res.status})`,
      err?.details ?? [],
    );
  }
  return data as T;
}

export const http = {
  get: <T>(path: string, init?: RequestInit) => request<T>('GET', path, undefined, init),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};

/** Build a query string from defined values: qs({a: 1, b: undefined}) -> '?a=1'. */
export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

/** Human-readable message for any thrown value (for toasts). */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Something went wrong';
}
