// Case folding for stored *_fold columns and search (design §3.4). It replaces the lyren_lower SQL
// function, which a Durable Object cannot register (no UDFs; its lower() and NOCASE fold ASCII only).

/**
 * The one case-folding function. Identical to shared/src/filter.ts (searchTokens uses toLowerCase).
 * fold(a + '\n' + b) === fold(a) + '\n' + fold(b) for all strings (the only context-sensitive
 * mapping, final sigma, does not look across a newline), so stored folds can be concatenated in SQL.
 */
export const fold = (s: string): string => s.toLowerCase();
