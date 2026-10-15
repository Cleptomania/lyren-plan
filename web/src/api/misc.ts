import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { DashboardDTO, SearchResultDTO } from '@shared/types';
import { http, qs } from './client';
import { qk } from './keys';

export function useDashboard(today: string) {
  return useQuery({
    queryKey: qk.dashboard(today),
    queryFn: () => http.get<DashboardDTO>(`/dashboard${qs({ today })}`),
  });
}

/** Global search; disabled for queries shorter than 1 character after trimming. */
export function useSearch(q: string, limit = 10) {
  const term = q.trim();
  return useQuery({
    queryKey: qk.search(`${term}|${limit}`),
    queryFn: () => http.get<SearchResultDTO>(`/search${qs({ q: term, limit })}`),
    enabled: term.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 10_000,
  });
}
