// Helpers for user-chosen entity colors (#rrggbb). Apply via inline styles.

function parseHex(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = Number.parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** rgba() string for a hex color at the given alpha (0..1). */
export function withAlpha(hex: string, alpha: number): string {
  const rgb = parseHex(hex);
  if (!rgb) return hex;
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
}

/** Relative luminance (WCAG). */
export function luminance(hex: string): number {
  const rgb = parseHex(hex);
  if (!rgb) return 0.5;
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Black or white, whichever reads better on the given background. */
export function readableTextColor(bgHex: string): '#000000' | '#ffffff' {
  return luminance(bgHex) > 0.4 ? '#000000' : '#ffffff';
}

/** Style for a subtle "soft" chip: tinted background + colored text that works in both themes. */
export function softChipStyle(hex: string): { backgroundColor: string; color: string; borderColor: string } {
  return {
    backgroundColor: withAlpha(hex, 0.14),
    color: `color-mix(in srgb, ${hex} 75%, var(--fg))`,
    borderColor: withAlpha(hex, 0.35),
  };
}
