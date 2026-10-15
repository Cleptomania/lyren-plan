// Map validation errors to per-field messages for <Field error>.
//
//   const parsed = loginInput.safeParse(values);
//   if (!parsed.success) return setErrors(zodFieldErrors(parsed.error));
//   mutation.mutate(parsed.data, { onError: (err) => setErrors(apiFieldErrors(err)) });

import type { ZodError } from 'zod';
import { ApiError } from '../../api/client';

/** Field path ('title', 'dueDate', 'config.filter') → first message. */
export type FieldErrors = Partial<Record<string, string>>;

/** First message per field path of a zod error (form-level issues use the key ''). */
export function zodFieldErrors(error: ZodError): FieldErrors {
  const out: FieldErrors = {};
  for (const issue of error.issues) {
    const key = issue.path.map(String).join('.');
    if (out[key] === undefined) out[key] = issue.message;
  }
  return out;
}

/** Field messages from an ApiError's `details` (400 validation errors); {} for anything else. */
export function apiFieldErrors(error: unknown): FieldErrors {
  const out: FieldErrors = {};
  if (!(error instanceof ApiError)) return out;
  for (const d of error.details) {
    if (out[d.path] === undefined) out[d.path] = d.message;
  }
  return out;
}

/** True when the error carries at least one field message (so a form-level banner is redundant). */
export function hasFieldErrors(errors: FieldErrors): boolean {
  return Object.entries(errors).some(([k, v]) => k !== '' && !!v);
}
