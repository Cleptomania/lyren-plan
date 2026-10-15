// Request parsing helpers. Always validate input with the shared zod schemas.

import type { Context } from 'hono';
import type { z } from 'zod';
import { idParamSchema } from '@shared/schemas';
import { badRequest, validationError } from './errors';

/** Parse and validate the JSON body. Throws 400 on malformed JSON or schema mismatch. */
export async function readJson<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
  let body: unknown;
  try {
    const text = await c.req.text();
    body = text.length === 0 ? {} : JSON.parse(text);
  } catch {
    throw badRequest('Request body must be valid JSON');
  }
  const result = schema.safeParse(body);
  if (!result.success) throw validationError(result.error);
  return result.data;
}

/** Parse and validate query-string parameters (single values only). */
export function readQuery<S extends z.ZodType>(c: Context, schema: S): z.output<S> {
  const result = schema.safeParse(c.req.query());
  if (!result.success) throw validationError(result.error, 'query');
  return result.data;
}

/** Parse a positive integer route parameter (default name 'id'). */
export function readId(c: Context, name = 'id'): number {
  const result = idParamSchema.safeParse(c.req.param(name));
  if (!result.success) throw badRequest(`Invalid ${name}`);
  return result.data;
}
