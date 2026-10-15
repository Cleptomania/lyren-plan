// Work-log duration helpers ("1h 30m" <-> minutes).

/** Format minutes as a compact duration: 0 -> "0m", 45 -> "45m", 90 -> "1h 30m", 480 -> "8h". */
export function formatMinutes(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return '';
  const total = Math.max(0, Math.round(minutes));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/**
 * Parse a human duration into minutes. Accepts "90", "90m", "1.5h", "1h30", "1h 30m",
 * "2h15m", "1:30" (h:mm). A bare number is minutes. Returns null when unparseable.
 */
export function parseDuration(input: string): number | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;
  const colon = /^(\d+):([0-5]\d)$/.exec(s);
  if (colon) return Number(colon[1]) * 60 + Number(colon[2]);
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s));
  const re = /^(?:(\d+(?:\.\d+)?)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*m?(?:in(?:utes?|s)?)?)?$/;
  const m = re.exec(s);
  if (!m || (m[1] === undefined && m[2] === undefined)) return null;
  const hours = m[1] !== undefined ? Number(m[1]) : 0;
  const mins = m[2] !== undefined ? Number(m[2]) : 0;
  const total = Math.round(hours * 60 + mins);
  return Number.isFinite(total) ? total : null;
}
