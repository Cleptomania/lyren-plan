// Request parsing helpers. Always validate input with the shared zod schemas.

import type { Context } from 'hono';
import type { z } from 'zod';
import { parseBounded } from '@shared/bounded';
import { idParamSchema } from '@shared/schemas';
import { badRequest, invalidUndescribed, validationError } from './errors';

/**
 * Parse and validate the JSON body. Throws 400 on malformed JSON or schema mismatch; a large body that fails is
 * refused without its problems (parseBounded, design Appendix D 44).
 */
export async function readJson<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
  return parseInput(schema, await readBody(c));
}

/** The JSON body, not validated yet (an empty body is `{}`); 400 when it is not JSON. */
export async function readBody(c: Context): Promise<unknown> {
  try {
    const text = await c.req.text();
    return text.length === 0 ? {} : JSON.parse(text);
  } catch {
    throw badRequest('Request body must be valid JSON');
  }
}

/** Validate a body read with readBody (for a route that refuses some requests before it looks at the body). */
export function parseInput<S extends z.ZodType>(schema: S, body: unknown): z.output<S> {
  const result = parseBounded(schema, body);
  if (result === null) throw invalidUndescribed();
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
