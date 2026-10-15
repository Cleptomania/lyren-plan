// Tasks open in a drawer over the current page via the `?task=<id>` search param,
// so any page can show a task and the URL stays shareable. /tasks/:key is the
// standalone full-page view (key = numeric id or ref like 'LYR-12').
//
// History: opening a task from a page pushes ONE entry (so phone Back closes the
// drawer); switching to another task while one is open replaces it; closing pops
// our entry when we pushed it, otherwise removes the param in place.

import { useCallback } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';

export const TASK_PARAM = 'task';

interface DrawerState {
  taskDrawer?: boolean;
}

export function useOpenTask(): (taskId: number) => void {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  return useCallback(
    (taskId: number) => {
      const already = params.has(TASK_PARAM);
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set(TASK_PARAM, String(taskId));
          return next;
        },
        {
          replace: already,
          preventScrollReset: true,
          state: already ? location.state : { ...(location.state as object | null), taskDrawer: true },
        },
      );
    },
    [params, setParams, location.state],
  );
}

export function useCloseTask(): () => void {
  const [, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  return useCallback(() => {
    if ((location.state as DrawerState | null)?.taskDrawer) {
      navigate(-1);
      return;
    }
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete(TASK_PARAM);
        return next;
      },
      { replace: true, preventScrollReset: true },
    );
  }, [location.state, navigate, setParams]);
}

/** The task id currently open in the drawer, if any. */
export function useOpenTaskId(): number | null {
  const [params] = useSearchParams();
  const v = Number(params.get(TASK_PARAM));
  return Number.isInteger(v) && v > 0 ? v : null;
}

export function taskPageUrl(task: { id: number; ref?: string }): string {
  return `/tasks/${task.ref ?? task.id}`;
}

export const projectUrl = (projectId: number) => `/projects/${projectId}`;
export const milestoneUrl = (projectId: number, milestoneId: number) => `/projects/${projectId}/milestones/${milestoneId}`;
export const epicUrl = (projectId: number, epicId: number) => `/projects/${projectId}/epics/${epicId}`;
export const boardUrl = (boardId: number) => `/boards/${boardId}`;
