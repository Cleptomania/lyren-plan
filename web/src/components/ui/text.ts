// Small pure text helpers used by UI components.

/**
 * Up to two initials from a display name: 'Ada Lovelace' → 'AL', 'grace' → 'GR', 'Unknown (imported)' → 'UI'
 * (brackets and quotes are no part of a word).
 */
export function initials(name: string): string {
  const words = name.trim().split(/[\s._\-()[\]{}"'“”‘’]+/u).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) {
    const chars = Array.from(words[0]!);
    return chars.slice(0, 2).join('').toLocaleUpperCase();
  }
  const first = Array.from(words[0]!)[0] ?? '';
  const last = Array.from(words[words.length - 1]!)[0] ?? '';
  return (first + last).toLocaleUpperCase();
}
