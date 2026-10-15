// Pure search helpers for Picker.

export interface SearchableOption {
  label: string;
  keywords?: string;
  hint?: string;
}

function tokens(query: string): string[] {
  return query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
}

/** Options whose label/keywords/hint contain every whitespace-separated token (case-insensitive). */
export function filterPickerOptions<O extends SearchableOption>(options: readonly O[], query: string): O[] {
  const t = tokens(query);
  if (t.length === 0) return [...options];
  return options.filter((o) => {
    const hay = `${o.label} ${o.keywords ?? ''} ${o.hint ?? ''}`.toLocaleLowerCase();
    return t.every((tok) => hay.includes(tok));
  });
}

/** Whether a "Create “query”" row makes sense: non-empty query with no option of exactly that label. */
export function canCreateOption(options: readonly SearchableOption[], query: string): boolean {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return false;
  return !options.some((o) => o.label.trim().toLocaleLowerCase() === q);
}

/** Toggle `value` in a multi-select value list (keeps order, appends new values). */
export function toggleValue<V>(values: readonly V[], value: V): V[] {
  return values.includes(value) ? values.filter((v) => v !== value) : [...values, value];
}
