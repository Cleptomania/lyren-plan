// Hex color input parsing for ColorPicker.

/** '#abc', 'abc', '#AABBCC', ' aabbcc ' → '#aabbcc'; anything else → null. */
export function normalizeHex(input: string): string | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(input.trim());
  if (!m) return null;
  let hex = m[1]!.toLowerCase();
  if (hex.length === 3) hex = hex.replace(/./g, (c) => c + c);
  return `#${hex}`;
}
