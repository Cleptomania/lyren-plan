// Quick filters live in the URL (view state, never saved): `?q=&tags=&pri=&closed=`.

import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { parseQuickFilters, QUICK_FILTER_PARAMS, writeQuickFilters, type QuickFilters } from './filters';

export function useQuickFilters(): [QuickFilters, (next: QuickFilters) => void] {
  const [params, setParams] = useSearchParams();
  // Re-parse only when a quick-filter param changes (not when ?task= opens the drawer).
  const key = QUICK_FILTER_PARAMS.map((k) => params.get(k) ?? '').join('\u0000');
  // `key` stands in for `params` (only the quick-filter params matter).
  const quick = useMemo(() => parseQuickFilters(params), [key]);
  const setQuick = useCallback(
    (next: QuickFilters) => setParams((prev) => writeQuickFilters(prev, next), { replace: true, preventScrollReset: true }),
    [setParams],
  );
  return [quick, setQuick];
}
