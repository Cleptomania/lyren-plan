// Bounded validation of untrusted values that may be large (design Appendix D 44). zod describes every list
// item and record entry that fails and every missing field of every object, so describing a large invalid value
// costs far more memory and time than the value itself: a 2 MiB filter of 700,000 empty strings as project ids
// made 700,000 issues and half a gigabyte of heap on Node, and a stack overflow in workerd. zod's validate() is no
// bound either: it stops a list only at an issue that cannot continue, a type error, while a failed check
// (positive, max, regex, refine) can continue, so a million zero ids still made a million issues and 1.3 GB of
// heap; and it never stops a record.

import { z } from 'zod';

/** List items and object members of a value that zod may describe problem by problem. */
export const DESCRIBED_VALUES = 5_000;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Whether `value` (parsed JSON) holds more than `limit` list items and object members, nested ones included. */
function exceedsValues(value: unknown, limit: number): boolean {
  let left = limit;
  const pending: object[] = [];
  const visit = (v: unknown) => {
    if (typeof v === 'object' && v !== null) pending.push(v);
  };
  visit(value);
  for (let v = pending.pop(); v !== undefined; v = pending.pop()) {
    if (Array.isArray(v)) {
      left -= v.length;
      if (left < 0) return true;
      for (const item of v) visit(item);
    } else {
      for (const key in v) {
        if (--left < 0) return true;
        visit((v as Record<string, unknown>)[key]);
      }
    }
  }
  return false;
}

/** Whether `length` is outside what the length checks of a list schema allow. */
function lengthFails(def: z.core.$ZodArrayDef, length: number): boolean {
  return (def.checks ?? []).some((check) => {
    const d = (check as z.core.$ZodChecks)._zod.def;
    if (d.check === 'max_length') return length > d.maximum;
    if (d.check === 'min_length') return length < d.minimum;
    return d.check === 'length_equals' && length !== d.length;
  });
}

/** Numeric strings, which zod's records also try as numbers (as its regexes.number). */
const NUMERIC_KEY = /^-?\d+(?:\.\d+)?$/;

/**
 * Whether a walk of `value` along `schema` finds a part that fails it. The walk opens objects, lists, records,
 * unions and the wrappers around them itself, checks a list's length before its items, and stops at the first
 * part that fails. It hands every other part to zod's validate() on its own: in the shared schemas a scalar, an
 * unknown value, or a value of the wrong type, which zod judges at once (shared/src/bounded.test.ts checks that
 * every list and record of the shared schemas lies on the walk). So it makes a few issues at most and visits each
 * value once for each union it is in. Finding nothing is not a pass: the checks of a whole object or list
 * (refine, transform) are left to the parse.
 */
export function findsProblem(schema: z.core.$ZodType, value: unknown): boolean {
  const def = (schema as z.core.$ZodTypes)._zod.def;
  switch (def.type) {
    case 'optional':
    case 'default':
    case 'prefault':
      return value !== undefined && findsProblem(def.innerType, value);
    case 'nullable':
      return value !== null && findsProblem(def.innerType, value);
    case 'pipe':
      // The output side sees the input side's output, which the parse makes.
      return findsProblem(def.in, value);
    case 'union':
      return def.options.every((option) => findsProblem(option, value));
    case 'array':
      if (Array.isArray(value)) return lengthFails(def, value.length) || value.some((item) => findsProblem(def.element, item));
      break;
    case 'object':
      if (isObject(value)) {
        const { shape, catchall } = def;
        for (const key in shape) if (findsProblem(shape[key]!, value[key])) return true;
        if (catchall === undefined) return false;
        for (const key in value) {
          if (!Object.hasOwn(shape, key) && key !== '__proto__' && findsProblem(catchall, value[key])) return true;
        }
        return false;
      }
      break;
    case 'record':
      if (isObject(value)) {
        for (const key in value) {
          if (key === '__proto__') continue;
          const keyFails =
            findsProblem(def.keyType, key) && !(NUMERIC_KEY.test(key) && !findsProblem(def.keyType, Number(key)));
          if (keyFails ? def.mode !== 'loose' : findsProblem(def.valueType, value[key])) return true;
        }
        return false;
      }
      break;
  }
  return !z.core.validate(schema, value);
}

/**
 * schema.safeParse(value), or null when the value fails and holds too many values to describe. A value of more
 * than DESCRIBED_VALUES list items and object members, nested ones included, is walked first (findsProblem) and
 * parsed only when the walk finds nothing: then every list is within its length and every scalar valid, so the
 * parse can fail only on the checks of whole objects and lists, an issue or two for each object that has them.
 * Smaller values, which every form and request of the web client is, are parsed and described as they are. Use
 * it for every untrusted value that may be large; never safeParse one.
 */
export function parseBounded<S extends z.ZodType>(schema: S, value: unknown): z.ZodSafeParseResult<z.output<S>> | null {
  if (exceedsValues(value, DESCRIBED_VALUES) && findsProblem(schema, value)) return null;
  return schema.safeParse(value);
}
