// Bulk delete for the selection bars (TaskList and the board's select mode). Like the single
// delete in TaskActionsHost, it closes the task drawer when the drawer shows one of the deleted
// tasks: forgetDeletedTasks keeps the data of observed queries, so the drawer would otherwise
// keep showing a task that no longer exists (and every edit there fails with "Task not found").

import { useCallback, useLayoutEffect, useRef } from 'react';
import { useBulkDeleteTasks } from '../../api/tasks';
import { useCloseTask, useOpenTaskId } from '../../lib/taskLinks';

type BulkDeleteMutation = ReturnType<typeof useBulkDeleteTasks>;

/** Whether deleting `deletedIds` removes the task open in the drawer. */
export function deletesOpenTask(openTaskId: number | null, deletedIds: readonly number[]): boolean {
  return openTaskId !== null && deletedIds.includes(openTaskId);
}

/** useBulkDeleteTasks, plus: a successful delete closes the drawer if it shows a deleted task. */
export function useBulkDeleteTasksClosingDrawer(): Pick<BulkDeleteMutation, 'mutate' | 'isPending'> {
  const { mutate: rawMutate, isPending } = useBulkDeleteTasks();
  const openTaskId = useOpenTaskId();
  const closeTask = useCloseTask();

  // Router-bound values change with the location; the async success callback reads the latest.
  const nav = useRef({ openTaskId, closeTask });
  useLayoutEffect(() => {
    nav.current = { openTaskId, closeTask };
  });

  const mutate = useCallback<BulkDeleteMutation['mutate']>(
    (ids, options) =>
      rawMutate(ids, {
        ...options,
        onSuccess: (...args) => {
          options?.onSuccess?.(...args);
          if (deletesOpenTask(nav.current.openTaskId, ids)) nav.current.closeTask();
        },
      }),
    [rawMutate],
  );

  return { mutate, isPending };
}
