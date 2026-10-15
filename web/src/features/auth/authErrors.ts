import { ApiError, errorMessage } from '../../api/client';
import { unreachableText } from '../../api/networkError';

/** Human message for a failed sign-in / setup request. */
export function authErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'network_error') return unreachableText().message;
    if (err.status === 429) return 'Too many attempts. Wait a few minutes before trying again.';
    if (err.status === 401) return 'Incorrect username or password.';
  }
  return errorMessage(err);
}
