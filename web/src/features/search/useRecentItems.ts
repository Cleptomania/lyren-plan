// The command palette's Recent list (read once per opening, so it never reorders while shown),
// with its tasks brought up to date from the server: Recent lives in this device's storage,
// and another device (or the API) may have archived, renamed, moved or deleted a task since.
// One POST /tasks/query {filter: {ids}} per opening; a task it no longer returns was deleted.
// Until the answer arrives the freshest cached copy is shown, else what was stored.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import type { TaskQueryInput } from '@shared/schemas';
import type { TaskQueryResult } from '@shared/types';
import { useLookups } from '../../api/bootstrap';
import { spaceApi } from '../../api/client';
import { qk } from '../../api/keys';
import { findCachedTask } from '../../api/tasks';
import { useSpaceId } from '../../app/space';
import { resolveRecents } from './paletteModel';
import { loadRecent, refreshRecentTasks, type RecentItem, type RecentTaskUpdate } from './recent';

/** The query that refreshes the Recent tasks (archived ones and archived projects included). */
export function recentTasksQuery(ids: readonly number[]): TaskQueryInput {
  return { filter: { ids: [...ids], archived: 'include', includeArchivedProjects: true }, limit: Math.max(1, ids.length) };
}

export function useRecentItems(): RecentItem[] {
  const sid = useSpaceId();
  const qc = useQueryClient();
  const lookups = useLookups();
  const [stored] = useState(() => loadRecent(sid));
  const taskIds = useMemo(() => stored.flatMap((r) => (r.kind === 'task' ? [r.id] : [])), [stored]);
  const input = useMemo(() => recentTasksQuery(taskIds), [taskIds]);
  const answer = useQuery({
    queryKey: qk.taskQuery(sid, input),
    queryFn: () => spaceApi(sid).post<TaskQueryResult>('/tasks/query', input),
    enabled: taskIds.length > 0,
    // Ask again on every opening.
    staleTime: 0,
    retry: false,
  });

  const updates = useMemo(() => {
    const map = new Map<number, RecentTaskUpdate>();
    if (!answer.data) return map;
    const byId = new Map(answer.data.tasks.map((t) => [t.id, t]));
    for (const id of taskIds) {
      const t = byId.get(id);
      map.set(id, t ? { ref: t.ref, title: t.title, archived: t.archivedAt !== null } : null);
    }
    return map;
  }, [answer.data, taskIds]);

  useEffect(() => refreshRecentTasks(sid, updates), [sid, updates]);

  return useMemo(() => {
    const live = stored.filter((r) => !(r.kind === 'task' && updates.get(r.id) === null));
    return resolveRecents(live, lookups.boardById, (id) => findCachedTask(qc, sid, id));
    // `answer.dataUpdatedAt`: the answer also lands in the cache findCachedTask reads.
  }, [stored, updates, lookups.boardById, qc, sid, answer.dataUpdatedAt]);
}
