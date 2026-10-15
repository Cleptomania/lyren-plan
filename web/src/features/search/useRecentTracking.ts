// Records recently opened tasks (drawer `?task=<id>` or /tasks/:key) and boards (/boards/:id, or
// a project's Board tab with ?board=<id>) for the command palette, from the URL — so items opened
// anywhere count, not only those picked in the palette. Task labels come from the React Query
// cache (the drawer or page fetches the task); we wait for it to arrive rather than fetching, and
// keep the entry current while the task stays open (renamed, moved, archived or unarchived).

import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { matchPath, useLocation } from 'react-router';
import { useLookups } from '../../api/bootstrap';
import { findCachedTaskByKey } from '../../api/tasks';
import { taskKeyForLocation } from '../../components/layout/navigation';
import { rememberRecent, type RecentInput } from './recent';

function positiveInt(value: string | null | undefined): number | null {
  const n = Number(value);
  return value && Number.isInteger(n) && n > 0 ? n : null;
}

/** Board shown by the URL: a global board page, or a project's Board tab with `?board=<id>`. */
function boardIdFor(pathname: string, search: string): number | null {
  const global = matchPath('/boards/:boardId', pathname);
  if (global) return positiveInt(global.params.boardId);
  if (matchPath('/projects/:projectId/board', pathname)) return positiveInt(new URLSearchParams(search).get('board'));
  return null;
}

export function useRecentTracking(): void {
  const { pathname, search } = useLocation();
  const qc = useQueryClient();
  const { boardById } = useLookups();

  const taskKey = taskKeyForLocation({ pathname, search });
  const taskKeyId = taskKey === null ? '' : 'id' in taskKey ? `id:${taskKey.id}` : `ref:${taskKey.ref}`;
  useEffect(() => {
    if (taskKey === null) return;
    let last = '';
    const record = () => {
      const task = findCachedTaskByKey(qc, taskKey);
      if (!task) return;
      const entry: RecentInput = { kind: 'task', id: task.id, ref: task.ref, title: task.title, archived: task.archivedAt !== null };
      const signature = JSON.stringify(entry);
      if (signature === last) return;
      last = signature;
      rememberRecent(entry);
    };
    record();
    // Cache writes (fetches and optimistic edits) may load or change the task while it is open.
    return qc.getQueryCache().subscribe((event) => {
      if (event.type === 'updated' && event.action.type === 'success') record();
    });
    // taskKeyId stands in for taskKey (a new object every render).
  }, [qc, taskKeyId]);

  const boardId = boardIdFor(pathname, search);
  const board = boardId === null ? undefined : boardById.get(boardId);
  const boardName = board?.name;
  useEffect(() => {
    if (boardId !== null && boardName !== undefined) rememberRecent({ kind: 'board', id: boardId, name: boardName });
  }, [boardId, boardName]);
}
