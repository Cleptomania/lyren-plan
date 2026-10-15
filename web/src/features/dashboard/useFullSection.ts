// The whole of a dashboard section whose list GET /api/dashboard truncated (counts.* > list
// length). One POST /api/tasks/query loads every task of the section (up to
// LIMITS.queryLimitMax), sorted here in the dashboard's order; "Show more" only renders
// SECTION_PAGE more rows. Fetching it all at once keeps the list an exact continuation of the
// dashboard's own (a server page sorted by another key, e.g. updatedAt for "Recently
// completed", could leave out its first rows), and a later "Show more" can't fail.

import { useMemo, useState } from 'react';
import { LIMITS } from '@shared/constants';
import type { TaskDTO } from '@shared/types';
import { useTaskQuery } from '../../api/tasks';
import { compareDashboardTasks, dashboardSectionQuery, type DashboardSection } from './dashboardModel';

/** Rows rendered per "Show more" of a truncated section (the dashboard itself shows up to 50). */
export const SECTION_PAGE = 200;

export interface FullSection {
  /** The rows to render, in dashboard order; null until the section has loaded. */
  tasks: TaskDTO[] | null;
  /** Loaded tasks not rendered yet ("Show N more"). */
  remaining: number;
  /** The section is loading and nothing is in yet. */
  loading: boolean;
  /** Loading failed and nothing is in (a failed refresh keeps the rows already shown). */
  failed: boolean;
  /** Render another SECTION_PAGE rows. */
  more: () => void;
  /** Back to one page (the section was collapsed). */
  reset: () => void;
  retry: () => void;
}

export function useFullSection(section: DashboardSection, today: string, enabled: boolean): FullSection {
  const [shown, setShown] = useState(SECTION_PAGE);
  const query = useTaskQuery(dashboardSectionQuery(section, today, LIMITS.queryLimitMax), { enabled });
  // Disabled (collapsed, or no longer truncated), a cached answer from an earlier expansion is
  // not shown: it may be stale.
  const data = enabled ? query.data : undefined;
  const sorted = useMemo(() => (data ? [...data.tasks].sort(compareDashboardTasks(section)) : null), [data, section]);
  return {
    tasks: sorted ? sorted.slice(0, shown) : null,
    remaining: sorted ? Math.max(0, sorted.length - shown) : 0,
    loading: enabled && query.isFetching && !data,
    failed: enabled && query.isError && !data,
    more: () => setShown((n) => n + SECTION_PAGE),
    reset: () => setShown(SECTION_PAGE),
    retry: () => void query.refetch(),
  };
}
