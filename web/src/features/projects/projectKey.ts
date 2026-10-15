// Project key suggestion and validation for the project form. Mirrors the server's
// generateProjectKey (SPEC §5.1) so the suggested key is the one the server would pick.

import { LIMITS } from '@shared/constants';
import { projectKeySchema } from '@shared/schemas';

interface KeyedProject {
  id: number;
  key: string;
  name: string;
}

/**
 * Key derived from a name: initials of up to 4 words when the name has at least two words,
 * else its first 3 characters; ASCII letters/digits only (diacritics stripped), upper case;
 * 'P' prefix unless it starts with a letter; padded with 'X'. '' for a name without letters/digits.
 */
export function baseProjectKey(name: string): string {
  const words = name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  if (words.length === 0) return '';
  let key = words.length >= 2 ? words.slice(0, 4).map((w) => w.charAt(0)).join('') : words[0]!.slice(0, 3);
  key = key.toUpperCase();
  if (!/^[A-Z]/.test(key)) key = `P${key}`;
  return key.padEnd(LIMITS.projectKeyMin, 'X').slice(0, LIMITS.projectKeyMax);
}

/** The project (other than `exceptId`) already using `key`, compared case-insensitively. */
export function projectWithKey<P extends KeyedProject>(projects: readonly P[], key: string, exceptId?: number): P | undefined {
  const wanted = key.trim().toUpperCase();
  return projects.find((p) => p.id !== exceptId && p.key.toUpperCase() === wanted);
}

/** Suggested key for a new project: the base key, made unique with 2, 3, … like the server. */
export function suggestProjectKey(name: string, projects: readonly KeyedProject[]): string {
  const base = baseProjectKey(name);
  if (!base || !projectWithKey(projects, base)) return base;
  for (let n = 2; ; n++) {
    const suffix = String(n);
    const candidate = base.slice(0, LIMITS.projectKeyMax - suffix.length) + suffix;
    if (!projectWithKey(projects, candidate)) return candidate;
  }
}

/** What the user typed in the key field, normalized as they type (upper case, letters/digits only). */
export function normalizeKeyInput(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, LIMITS.projectKeyMax);
}

/** Live validation message for a key, or undefined when it is valid and free. */
export function projectKeyError(key: string, projects: readonly KeyedProject[], exceptId?: number): string | undefined {
  const parsed = projectKeySchema.safeParse(key);
  if (!parsed.success) return parsed.error.issues[0]?.message ?? 'Invalid key';
  const owner = projectWithKey(projects, parsed.data, exceptId);
  return owner ? `Already used by “${owner.name}”` : undefined;
}
