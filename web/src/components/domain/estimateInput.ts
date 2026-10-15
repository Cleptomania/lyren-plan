// Estimate parsing and presets. Estimates are plain numbers; settings.estimateUnit says
// whether they are story points or hours.

import type { EstimateUnit } from '@shared/constants';
import { parseDuration } from '@shared/duration';

/** Upper bound accepted by the API (taskCreateInput.estimate). */
export const ESTIMATE_MAX = 100_000;

/** Quick choices offered by EstimatePicker. */
export const ESTIMATE_PRESETS: Readonly<Record<EstimateUnit, readonly number[]>> = {
  points: [1, 2, 3, 5, 8, 13],
  hours: [0.5, 1, 2, 4, 8, 16],
};

export type EstimateParseResult = { ok: true; value: number | null } | { ok: false; error: string };

/**
 * Parse user input into an estimate. Empty → null (no estimate). Accepts decimals with a
 * comma or dot. In hours mode durations also work: "1h 30m" / "90m" → 1.5.
 * Values are rounded to two decimals.
 */
export function parseEstimateInput(raw: string, unit: EstimateUnit): EstimateParseResult {
  const s = raw.trim().replace(',', '.');
  if (!s) return { ok: true, value: null };
  let value: number | null = null;
  if (/^(\d+\.?\d*|\.\d+)$/.test(s)) {
    value = Number(s);
  } else if (unit === 'hours' && /[hm]/i.test(s)) {
    const minutes = parseDuration(s);
    value = minutes === null ? null : minutes / 60;
  }
  if (value === null || !Number.isFinite(value)) {
    return { ok: false, error: unit === 'hours' ? 'Enter hours, e.g. 2 or 1h 30m' : 'Enter a number, e.g. 3' };
  }
  if (value < 0 || value > ESTIMATE_MAX) return { ok: false, error: `Enter a value from 0 to ${ESTIMATE_MAX}` };
  return { ok: true, value: Math.round(value * 100) / 100 };
}

/** Text for an estimate input field (no unit). */
export function estimateInputText(value: number | null | undefined): string {
  return value === null || value === undefined ? '' : String(value);
}
