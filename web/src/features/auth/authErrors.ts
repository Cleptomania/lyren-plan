import { ApiError, errorMessage } from '../../api/client';
import { unreachableText } from '../../api/networkError';
import { tooManyText } from './linkPages';

/** Human message for a failed sign-in / setup request. */
export function authErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'network_error') return unreachableText().message;
    if (err.status === 429) return tooManyText(err);
    if (err.status === 401) return 'Incorrect email or password.';
  }
  return errorMessage(err);
}
