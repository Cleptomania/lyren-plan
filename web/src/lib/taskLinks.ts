// Tasks open in a drawer over the current page via the `?task=<id>` search param,
// so any page can show a task and the URL stays shareable. /tasks/:key is the
// standalone full-page view (key = numeric id or ref like 'LYR-12'). Every link is inside a space
// (/s/<spaceId>/…, app/space.ts).
//
// History: opening a task from a page pushes ONE entry (so phone Back closes the
// drawer); switching to another task while one is open replaces it; closing pops
// our entry when we pushed it, otherwise removes the param in place.
//
// The helpers belong to the space whose page made them: a toast's "Open" (or a delete settling)
// can outlive that page, since toasts stay up across a space switch. Once the page shows another
// space, opening goes to the task's full page in its own space and closing does nothing, rather
// than acting on the same id in the space now shown.

import { useCallback } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { spaceLink, spaceOfPath, useSpaceId } from '../app/space';

export const TASK_PARAM = 'task';

interface DrawerState {
  taskDrawer?: boolean;
}

/** Whether the page at `pathname` (the router's location at the moment of the call) is in `spaceId`. */
export function pageInSpace(spaceId: string, pathname: string): boolean {
  return spaceOfPath(pathname)?.spaceId === spaceId;
}

/** The location now: a helper may run after its page unmounted (its render's location is stale then). */
const currentPathname = () => window.location.pathname;

export function useOpenTask(): (taskId: number) => void {
  const sid = useSpaceId();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  return useCallback(
    (taskId: number) => {
      if (!pageInSpace(sid, currentPathname())) {
        navigate(taskPageUrl(sid, { id: taskId }));
        return;
      }
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
    [sid, params, setParams, location.state, navigate],
  );
}

export function useCloseTask(): () => void {
  const sid = useSpaceId();
  const [, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  return useCallback(() => {
    if (!pageInSpace(sid, currentPathname())) return;
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
  }, [sid, location.state, navigate, setParams]);
}

/** The task id currently open in the drawer, if any. */
export function useOpenTaskId(): number | null {
  const [params] = useSearchParams();
  const v = Number(params.get(TASK_PARAM));
  return Number.isInteger(v) && v > 0 ? v : null;
}

/** A task's full page in its space (ref, else id). */
export function taskPageUrl(spaceId: string, task: { id: number; ref?: string }): string {
  return spaceLink(spaceId, `/tasks/${task.ref ?? task.id}`);
}

export const projectUrl = (spaceId: string, projectId: number) => spaceLink(spaceId, `/projects/${projectId}`);
export const milestoneUrl = (spaceId: string, projectId: number, milestoneId: number) =>
  spaceLink(spaceId, `/projects/${projectId}/milestones/${milestoneId}`);
export const epicUrl = (spaceId: string, projectId: number, epicId: number) => spaceLink(spaceId, `/projects/${projectId}/epics/${epicId}`);
export const boardUrl = (spaceId: string, boardId: number) => spaceLink(spaceId, `/boards/${boardId}`);
