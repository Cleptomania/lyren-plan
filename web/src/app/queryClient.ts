import { QueryClient } from '@tanstack/react-query';
import { ApiError } from '../api/client';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: true,
      // Try the network even when the browser claims to be offline; show cached data/errors
      // instead of spinning forever.
      networkMode: 'offlineFirst',
      retry: (failureCount, error) => {
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
        return failureCount < 2;
      },
    },
    // Fail fast when offline: optimistic changes roll back and the caller shows a toast,
    // instead of a mutation silently pausing forever.
    mutations: { retry: false, networkMode: 'always' },
  },
});
