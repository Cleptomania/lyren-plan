import { useCallback, useState } from 'react';

/**
 * useState persisted in localStorage (per-device UI preferences only). Values are JSON;
 * anything unreadable or failing `validate` falls back to `initial`.
 */
export function usePersistentState<T>(
  key: string,
  initial: T,
  validate: (v: unknown) => v is T,
): [T, (next: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return initial;
      const parsed: unknown = JSON.parse(raw);
      return validate(parsed) ? parsed : initial;
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const v = typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
        try {
          localStorage.setItem(key, JSON.stringify(v));
        } catch {
          /* storage unavailable: keep in memory only */
        }
        return v;
      });
    },
    [key],
  );
  return [value, set];
}

export const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean';
