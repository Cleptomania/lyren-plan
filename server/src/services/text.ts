// Text helpers for server-side snapshots and generated names.

/**
 * `text` cut to at most `max` UTF-16 code units (the unit zod's `.max()` limits count) without
 * splitting a surrogate pair. A plain `slice` can leave half an emoji behind, which SQLite stores
 * as U+FFFD in TEXT columns and JSON keeps as a lone `\ud83d` escape.
 */
export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = Math.max(0, max);
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1; // a high surrogate whose low half would be cut off
  return text.slice(0, end);
}
