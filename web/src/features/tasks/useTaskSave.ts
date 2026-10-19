// Immediate, optimistic task edits for the detail view (drawer and full page).

import { useMutationState } from '@tanstack/react-query';
import { useCallback } from 'react';
import type { TaskUpdateInput } from '@shared/schemas';
import type { TaskDTO } from '@shared/types';
import { updateTaskMutationKey, useUpdateTask } from '../../api/tasks';
import { useSpaceId } from '../../app/space';
import { toast } from '../../components/ui';

export interface SaveOptions {
  /** Success toast once the server confirmed (e.g. a project move that changed the ref). */
  success?: (saved: TaskDTO) => string;
}

/**
 * `save(patch)` PATCHes the task through the optimistic useUpdateTask (the UI updates at once,
 * a failure rolls back with an error toast). The returned promise rejects on failure so
 * editors can restore their draft.
 */
export function useTaskSave(taskId: number): (patch: TaskUpdateInput, opts?: SaveOptions) => Promise<TaskDTO> {
  const { mutateAsync } = useUpdateTask();
  return useCallback(
    (patch, opts) =>
      mutateAsync({ id: taskId, ...patch }).then(
        (saved) => {
          if (opts?.success) toast.success(opts.success(saved));
          return saved;
        },
        (err: unknown) => {
          toast.error(err);
          throw err;
        },
      ),
    [mutateAsync, taskId],
  );
}

/** True while an update of this task is in flight (for a "Saving…" hint). */
export function useTaskSaving(taskId: number): boolean {
  const sid = useSpaceId();
  const pending = useMutationState({
    filters: { mutationKey: updateTaskMutationKey(sid), status: 'pending' },
    select: (m) => (m.state.variables as { id?: number } | undefined)?.id,
  });
  return pending.includes(taskId);
}

/** Fire-and-forget variant for pickers: errors are already toasted by save(). */
export function ignoreRejection(promise: Promise<unknown>): void {
  promise.catch(() => undefined);
}
