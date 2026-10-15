// Optimistic edits of the bootstrap cache (statuses, tags, settings) for the settings pages.
// The admin mutation hooks invalidate bootstrap on success, which replaces the optimistic
// copy with server data; on failure the caller rolls back and the cache is refetched.

import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import type { BootstrapDTO } from '@shared/types';
import { qk } from '../../api/keys';

export type Rollback = () => void;

/** Returns `apply(update)`: patches the cached bootstrap now and resolves to a rollback. */
export function useOptimisticBootstrap(): (update: (b: BootstrapDTO) => BootstrapDTO) => Promise<Rollback> {
  const qc = useQueryClient();
  return useCallback(
    async (update) => {
      // A refetch in flight would overwrite the optimistic value with stale data.
      await qc.cancelQueries({ queryKey: qk.bootstrap });
      const previous = qc.getQueryData<BootstrapDTO>(qk.bootstrap);
      if (previous) qc.setQueryData<BootstrapDTO>(qk.bootstrap, update(previous));
      return () => {
        if (previous) qc.setQueryData<BootstrapDTO>(qk.bootstrap, previous);
        void qc.invalidateQueries({ queryKey: qk.bootstrap });
      };
    },
    [qc],
  );
}
