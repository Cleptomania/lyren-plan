// The board's data pipeline (SPEC §8 "Data flow"): effective filter → POST /tasks/query
// (limit LIMITS.queryLimitMax) → filter + sort the cached result locally (so optimistic edits
// move cards immediately) → lanes × columns grid. Everything is memoized by its inputs.

import { useMemo } from 'react';
import type { BoardConfig } from '@shared/board';
import { LIMITS } from '@shared/constants';
import { buildFilterContext, type SortContext } from '@shared/filter';
import type { TaskQueryInput } from '@shared/schemas';
import type { TaskDTO } from '@shared/types';
import { useLookups } from '../../api/bootstrap';
import { useTaskQuery } from '../../api/tasks';
import { useToday } from '../../lib/hooks';
import { EMPTY_QUICK_FILTERS, effectiveFilters, hasQuickFilters, type EffectiveFilters, type QuickFilters } from './filters';
import { buildBoardGrid, deriveBoardTasks, editableGroups, type BoardContext, type BoardGrid, type BoardGroup } from './grouping';

export interface BoardModel {
  ctx: BoardContext;
  filters: EffectiveFilters;
  /** Filtered + sorted tasks shown by the board. */
  tasks: TaskDTO[];
  grid: BoardGrid;
  /**
   * Every group per axis as the saved config sees it (quick filters ignored): what the config
   * panel lists and what reordering writes to prefs.order. Equals grid.columns / grid.lanes
   * without quick filters.
   */
  editGroups: { columns: BoardGroup[]; lanes: BoardGroup[] };
  layout: BoardConfig['layout'];
  /** First load (nothing to show yet). */
  loading: boolean;
  /** A changed filter is loading while the previous result is shown. */
  refreshing: boolean;
  /** Failed with nothing cached. */
  error: unknown;
  refetch: () => void;
  /** Matching tasks on the server when the result was truncated (else null). */
  truncatedTotal: number | null;
}

const NO_TASKS: TaskDTO[] = [];

export function useBoardModel(
  config: BoardConfig,
  opts: { projectId: number | null; quick: QuickFilters; layout: BoardConfig['layout'] },
): BoardModel {
  const { projectId, quick, layout } = opts;
  const lookups = useLookups();
  const today = useToday();
  const weekStartsOn = lookups.settings.weekStartsOn;

  const filters = useMemo(() => effectiveFilters(config.filter, quick, projectId), [config.filter, quick, projectId]);
  const input = useMemo<TaskQueryInput>(
    () => ({ filter: filters.server, sort: config.sort, today, weekStartsOn, limit: LIMITS.queryLimitMax }),
    [filters.server, config.sort, today, weekStartsOn],
  );
  const query = useTaskQuery(input, { enabled: !filters.empty });

  const fctx = useMemo(
    () => buildFilterContext({ statuses: lookups.statuses, projects: lookups.projects, today, weekStartsOn }),
    [lookups.statuses, lookups.projects, today, weekStartsOn],
  );
  const sctx = useMemo<SortContext>(
    () => ({ statusPositionById: new Map(lookups.statuses.map((s) => [s.id, s.position])) }),
    [lookups.statuses],
  );
  const ctx = useMemo<BoardContext>(() => ({ lookups, fctx }), [lookups, fctx]);

  const raw = filters.empty ? NO_TASKS : (query.data?.tasks ?? NO_TASKS);
  const tasks = useMemo(
    () => deriveBoardTasks(raw, filters.server, config.sort, fctx, sctx, filters.local),
    [raw, filters, config.sort, fctx, sctx],
  );
  const grid = useMemo(() => buildBoardGrid(config, ctx, tasks, filters.server, layout), [config, ctx, tasks, filters.server, layout]);
  const quickActive = hasQuickFilters(quick);
  const editGroups = useMemo(() => {
    if (!quickActive) return { columns: grid.columns, lanes: grid.lanes };
    const saved = effectiveFilters(config.filter, EMPTY_QUICK_FILTERS, projectId).server;
    return editableGroups(config, ctx, tasks, saved, grid.hasLanes);
  }, [quickActive, grid, config, ctx, tasks, projectId]);

  const data = query.data;
  return {
    ctx,
    filters,
    tasks,
    grid,
    editGroups,
    layout,
    loading: !filters.empty && query.isPending,
    refreshing: !filters.empty && query.isFetching && query.isPlaceholderData,
    error: !filters.empty && query.isError && !data ? query.error : null,
    refetch: () => void query.refetch(),
    truncatedTotal: !filters.empty && data && data.total > data.tasks.length ? data.total : null,
  };
}
