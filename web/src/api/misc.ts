import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { WeekStart } from '@shared/dates';
import type { DashboardDTO, SearchResultDTO } from '@shared/types';
import { useSpaceId } from '../app/space';
import { qs, spaceApi } from './client';
import { qk } from './keys';

/** `weekStartsOn`: the account's preference (the week's totals). */
export function useDashboard(today: string, weekStartsOn: WeekStart) {
  const sid = useSpaceId();
  return useQuery({
    queryKey: qk.dashboard(sid, today, weekStartsOn),
    queryFn: () => spaceApi(sid).get<DashboardDTO>(`/dashboard${qs({ today, weekStartsOn })}`),
  });
}

/** Search in the page's space; disabled for queries shorter than 1 character after trimming. */
export function useSearch(q: string, limit = 10) {
  const sid = useSpaceId();
  const term = q.trim();
  return useQuery({
    queryKey: qk.search(sid, `${term}|${limit}`),
    queryFn: () => spaceApi(sid).get<SearchResultDTO>(`/search${qs({ q: term, limit })}`),
    enabled: term.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 10_000,
  });
}
