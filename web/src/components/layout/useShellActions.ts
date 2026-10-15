// Actions shared by the desktop sidebar and the mobile navigation.

import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useLocation } from 'react-router';
import type { TaskCreateInput } from '@shared/schemas';
import { useLogout } from '../../api/auth';
import { useLookups } from '../../api/bootstrap';
import { findCachedTaskByKey } from '../../api/tasks';
import { toast } from '../ui/Toast';
import { createTaskDefaults } from './navigation';

/**
 * "New task" prefill for what is on screen (navigation.ts createTaskDefaults): the task in the
 * drawer or on its page (project + epic), else the page's project / epic / board project.
 *
 * Returns a getter to call when the dialog opens (hotkey, button): the task is read from the
 * React Query cache at that moment, so a task that loaded — or was moved to another epic —
 * after the caller's last render still counts.
 */
export function useCreateTaskDefaults(): () => Partial<TaskCreateInput> {
  const { pathname, search } = useLocation();
  const qc = useQueryClient();
  const { projectById, epicById, boardById } = useLookups();
  return useCallback(
    () =>
      createTaskDefaults(
        { pathname, search },
        { projectById, epicById, boardById, findTask: (key) => findCachedTaskByKey(qc, key) },
      ),
    [pathname, search, qc, projectById, epicById, boardById],
  );
}

/** Sign out; the auth gate then redirects to /login. */
export function useSignOut(): () => void {
  const logout = useLogout();
  const { mutate } = logout;
  return useCallback(() => mutate(undefined, { onError: (err) => toast.error(err) }), [mutate]);
}
