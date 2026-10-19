// Counting an import's JSON values before it is parsed (design §8.4 step 4). JSON.parse's memory grows with the
// number of values, not with bytes: in the security review's probe 16 KB of gzip holding `[{},{},…]` (16 MiB
// unpacked) grew the V8 heap by 357 MiB, enough to end a Workers isolate or a shared Node server. One pass over
// the text, outside strings, counts every `{`, `[` and `,` (objects, arrays and list items or members) and
// stops past IMPORT_MAX_JSON_VALUES. The same pass bounds the nesting: a value nested a million levels deep
// parses (V8's JSON.parse does not recurse) but cannot be written back out (JSON.stringify of an activity's
// data overflows the stack), and no archive nests more than about ten levels.

/** The deepest nesting an import may have; an archive's deepest (a board config's column matches) is 9. */
export const MAX_JSON_DEPTH = 64;

/**
 * 'values' when `text` holds more than `maxValues` objects, arrays and list items (or members), 'depth' when
 * it nests deeper than MAX_JSON_DEPTH, else null. Not a validation: malformed JSON is JSON.parse's to refuse.
 */
export function jsonShapeProblem(text: string, maxValues: number): 'values' | 'depth' | null {
  let values = 0;
  let depth = 0;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x22) {
      // A string: skip to its closing quote, past escaped characters (\" and \\ among them).
      for (i++; i < n; i++) {
        const s = text.charCodeAt(i);
        if (s === 0x5c) i++;
        else if (s === 0x22) break;
      }
    } else if (c === 0x7b || c === 0x5b) {
      if (++values > maxValues) return 'values';
      if (++depth > MAX_JSON_DEPTH) return 'depth';
    } else if (c === 0x2c) {
      if (++values > maxValues) return 'values';
    } else if (c === 0x7d || c === 0x5d) {
      depth--;
    }
  }
  return null;
}
