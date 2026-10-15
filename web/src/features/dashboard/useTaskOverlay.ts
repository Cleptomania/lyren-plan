// Optimistic display for tasks shown from the dashboard's own cache.
//
// Row edits (status / priority pickers, the "⋯" menu) go through useUpdateTask, whose
// optimistic writes only touch the ['tasks', …] caches; the dashboard list refreshes when
// the mutation settles. Until then this overlays the in-flight patches (and, right after
// success, the server's copy) on the dashboard's TaskDTOs, so a row reflects the edit
// immediately — and falls back by itself when the mutation fails.

import { useMutationState } from '@tanstack/react-query';
import { useCallback } from 'react';
import type { TaskUpdateInput } from '@shared/schemas';
import type { TaskDTO } from '@shared/types';
import { useBootstrap } from '../../api/bootstrap';
import { applyTaskPatch, UPDATE_TASK_MUTATION_KEY } from '../../api/tasks';

interface UpdateSnapshot {
  status: 'idle' | 'pending' | 'success' | 'error';
  vars: (TaskUpdateInput & { id: number }) | undefined;
  data: TaskDTO | undefined;
  submittedAt: number;
}

export function useTaskOverlay(): (task: TaskDTO) => TaskDTO {
  const boot = useBootstrap().data;
  const updates = useMutationState<UpdateSnapshot>({
    filters: { mutationKey: UPDATE_TASK_MUTATION_KEY },
    select: (m) => ({
      status: m.state.status,
      vars: m.state.variables as UpdateSnapshot['vars'],
      data: m.state.data as TaskDTO | undefined,
      submittedAt: m.state.submittedAt,
    }),
  });

  return useCallback(
    (task: TaskDTO) => {
      let out = task;
      // A saved copy newer than the list's (the list refetches right after).
      for (const u of updates) {
        if (u.status === 'success' && u.data?.id === task.id && u.data.updatedAt > out.updatedAt) out = u.data;
      }
      // In-flight edits, oldest first.
      const pending = updates.filter((u) => u.status === 'pending' && u.vars?.id === task.id);
      pending.sort((a, b) => a.submittedAt - b.submittedAt);
      for (const u of pending) {
        const { id: _id, ...patch } = u.vars!;
        out = applyTaskPatch(out, patch, boot);
      }
      return out;
    },
    [updates, boot],
  );
}
