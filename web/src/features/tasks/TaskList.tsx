// Task list used by project / epic / milestone pages and anywhere a filtered list of tasks is
// shown (SPEC §9.1). Fetches with POST /tasks/query, re-filters and re-sorts the cached
// result locally (so optimistic edits move rows immediately), optionally groups rows under
// collapsible headers, offers inline "Add task" rows, a toolbar, and a selection mode with
// a sticky bulk-action bar. Rows are the domain TaskRow (its "⋯" menu is the non-drag path).
// Closed and archived tasks are hidden until "Show closed" / "Show archived" is ticked; an
// empty list counts what those toggles hide (two limit-1 queries) and says so, with buttons
// that reveal them, instead of claiming there are no tasks.

import { clsx } from 'clsx';
import { Archive, CalendarClock, CalendarDays, ChevronRight, ListTodo, Milestone, SearchX } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { STATUS_CATEGORY_META, type Priority, type StatusCategory } from '@shared/constants';
import { buildFilterContext, compareTasks, matchesTaskFilter } from '@shared/filter';
import type { TaskCreateInput, TaskFilter, TaskSort } from '@shared/schemas';
import type { TaskDTO } from '@shared/types';
import { useLookups, type Lookups } from '../../api/bootstrap';
import { useTaskQuery } from '../../api/tasks';
import { useSpace } from '../../app/space';
import { EpicDot, PriorityIcon, StatusIcon, statusFraction, TaskRow, useSharedToday } from '../../components/domain';
import { Button, ColorDot, EmptyState, ErrorState, SkeletonList } from '../../components/ui';
import { pluralize } from '../../lib/format';
import { useDebouncedValue } from '../../lib/hooks';
import { useOverlay } from '../../lib/overlays';
import { useOpenTaskId } from '../../lib/taskLinks';
import { BulkActionBar } from './BulkActionBar';
import { QuickAddRow } from './QuickAddRow';
import {
  applySelection,
  DEFAULT_TASK_LIST_SORT,
  effectiveTaskFilter,
  groupByChoices,
  groupCreatePatch,
  groupLabel,
  groupTasks,
  hiddenTaskCounts,
  hiddenTaskProbes,
  hiddenTasksMessage,
  initialShowArchived,
  initialShowClosed,
  pruneSelection,
  quickAddDefaults,
  serverTaskFilter,
  type GroupContext,
  type TaskListGroupBy,
} from './taskListModel';
import { TaskListToolbar } from './TaskListToolbar';

export type { TaskListGroupBy } from './taskListModel';

export interface TaskListProps {
  /** Filter sent to POST /api/tasks/query. */
  filter: TaskFilter;
  /** Default { field: 'manual', dir: 'asc' }. */
  sort?: TaskSort;
  /** Group rows under collapsible headers. Default 'none'. */
  groupBy?: TaskListGroupBy;
  /** Hide row badges that are redundant in context (e.g. 'project' on a project page). */
  hide?: Array<'project' | 'epic' | 'milestone' | 'status'>;
  /** Prefill for the "Add task" affordance; omit to hide it. */
  createDefaults?: Partial<TaskCreateInput>;
  /** Checkboxes + bulk-action bar. */
  selectable?: boolean;
  /** Search box / show-closed + show-archived toggles / sort + group selectors above the list. Default true. */
  toolbar?: boolean;
  emptyMessage?: string;
}

/** Tasks fetched per page ("Show more" adds another page). */
const PAGE_SIZE = 200;
const NO_KEYS: ReadonlySet<string> = new Set();

/** Local state seeded from a prop; re-seeded whenever the prop's value changes. */
function useSeededState<T>(seed: T): [T, (value: T) => void] {
  const key = JSON.stringify(seed);
  const [state, setState] = useState({ key, value: seed });
  const current = state.key === key ? state : { key, value: seed };
  if (current !== state) setState(current);
  const set = useCallback((value: T) => setState({ key, value }), [key]);
  return [current.value, set];
}

/** A value that keeps its identity while its JSON is unchanged (callers pass inline objects). */
function useStableValue<T>(value: T): T {
  const ref = useRef({ key: JSON.stringify(value), value });
  const key = JSON.stringify(value);
  if (ref.current.key !== key) ref.current = { key, value };
  return ref.current.value;
}

export function TaskList({
  filter: filterProp,
  sort,
  groupBy,
  hide,
  createDefaults: createDefaultsProp,
  selectable: selectableProp = false,
  toolbar = true,
  emptyMessage,
}: TaskListProps) {
  const lookups = useLookups();
  // Viewers (design §12.9): no quick add, no bulk selection.
  const { write } = useSpace().permissions;
  const selectable = selectableProp && write;
  const today = useSharedToday();
  const weekStartsOn = lookups.settings.weekStartsOn;
  const openTaskId = useOpenTaskId();
  const filter = useStableValue(filterProp);
  const createDefaults = useStableValue(write ? createDefaultsProp : undefined);

  // ---- Toolbar state ---------------------------------------------------------------
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 250);
  const [showClosed, setShowClosed] = useSeededState(initialShowClosed(filter));
  // Without a toolbar it can only be turned on from the empty state ("Hide archived" undoes it).
  const [showArchived, setShowArchived] = useSeededState(initialShowArchived(filter));
  const [sortState, setSort] = useSeededState<TaskSort>(sort ?? DEFAULT_TASK_LIST_SORT);
  const [groupState, setGroupBy] = useSeededState<TaskListGroupBy>(groupBy ?? 'none');
  const groupChoices = useMemo(() => groupByChoices(filter), [filter]);

  const view = useMemo(
    () => ({ enabled: toolbar, search: debouncedSearch, showClosed, showArchived }),
    [toolbar, debouncedSearch, showClosed, showArchived],
  );
  const effectiveFilter = useMemo(() => effectiveTaskFilter(filter, view), [filter, view]);

  // "Show more" grows the page; any filter / sort change starts over.
  const queryKey = JSON.stringify([effectiveFilter, sortState]);
  const [paging, setPaging] = useState({ key: queryKey, limit: PAGE_SIZE });
  const limit = paging.key === queryKey ? paging.limit : PAGE_SIZE;

  const serverFilter = useMemo(() => serverTaskFilter(effectiveFilter), [effectiveFilter]);
  const query = useTaskQuery({ filter: serverFilter, sort: sortState, limit, today, weekStartsOn });
  const { data } = query;

  // Re-apply filter + sort to the cached result: optimistic edits (and the previous result
  // while a new filter loads) then show the right rows in the right order immediately.
  const tasks = useMemo(() => {
    if (!data) return [];
    const fctx = buildFilterContext({ statuses: lookups.statuses, projects: lookups.projects, today, weekStartsOn });
    const sctx = { statusPositionById: new Map(lookups.statuses.map((s) => [s.id, s.position])) };
    return data.tasks.filter((t) => matchesTaskFilter(t, effectiveFilter, fctx)).sort((a, b) => compareTasks(a, b, sortState, sctx));
  }, [data, effectiveFilter, sortState, lookups, today, weekStartsOn]);

  // ---- What an empty list hides --------------------------------------------------------
  const listEmpty = data !== undefined && tasks.length === 0;
  const probes = useMemo(() => hiddenTaskProbes(filter, view), [filter, view]);
  const probeAll = useTaskQuery(
    { filter: serverTaskFilter(probes?.all ?? {}), limit: 1, today, weekStartsOn },
    { enabled: listEmpty && probes !== null },
  );
  const probeArchived = useTaskQuery(
    { filter: serverTaskFilter(probes?.archived ?? {}), limit: 1, today, weekStartsOn },
    { enabled: listEmpty && !!probes?.archived },
  );

  // The toggles the list's result and the probe's result were fetched for. While a changed
  // toggle loads, an empty list shows a skeleton rather than an empty state (or counts) that
  // the new result is about to replace. A new search keeps the previous counts meanwhile.
  const toggles = `${showClosed}:${showArchived}`;
  const [settledToggles, setSettledToggles] = useState(toggles);
  if (data && !query.isPlaceholderData && settledToggles !== toggles) setSettledToggles(toggles);
  const [probedToggles, setProbedToggles] = useState(toggles);
  if (probeAll.data && !probeAll.isPlaceholderData && probedToggles !== toggles) setProbedToggles(toggles);
  const allTotal = probeAll.data && !probeAll.isError && !(probeAll.isPlaceholderData && probedToggles !== toggles) ? probeAll.data.total : null;
  // The archived probe only runs with both toggles off, so a previous result is never from other toggles.
  const archivedTotal = probeArchived.data && !probeArchived.isError ? probeArchived.data.total : null;
  const needArchived = !!probes?.archived;
  // Still loading (a failed or paused probe falls back to an empty state without counts).
  const probing =
    listEmpty &&
    probes !== null &&
    ((allTotal === null && probeAll.fetchStatus === 'fetching') ||
      (needArchived && archivedTotal === null && probeArchived.fetchStatus === 'fetching'));
  const hidden =
    listEmpty && probes !== null && !probing && allTotal !== null && (!needArchived || archivedTotal !== null)
      ? hiddenTaskCounts(filter, view, { all: allTotal, archived: archivedTotal })
      : null;
  const revealArchived = () => {
    setShowArchived(true);
    // Archived tasks are mostly finished ones: those also need "Show closed".
    if (toolbar && !showClosed) setShowClosed(true);
  };

  const groupCtx = useMemo<GroupContext>(() => ({ lookups, today, weekStartsOn }), [lookups, today, weekStartsOn]);
  const groups = useMemo(() => groupTasks(tasks, groupState, groupCtx), [tasks, groupState, groupCtx]);

  // ---- Collapsed groups (per grouping) ---------------------------------------------------
  const [collapsedState, setCollapsedState] = useState<{ groupBy: TaskListGroupBy; keys: ReadonlySet<string> }>({
    groupBy: groupState,
    keys: new Set(),
  });
  const collapsed = collapsedState.groupBy === groupState ? collapsedState.keys : NO_KEYS;
  const toggleGroup = (key: string) => {
    const next = new Set(collapsed);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setCollapsedState({ groupBy: groupState, keys: next });
  };

  // ---- Selection -----------------------------------------------------------------------
  const [selecting, setSelecting] = useState(false);
  const [selectedState, setSelected] = useState<ReadonlySet<number>>(() => new Set());
  const anchorRef = useRef<number | null>(null);
  const visibleSet = useMemo(() => new Set(tasks.map((t) => t.id)), [tasks]);
  const selected = useMemo(() => pruneSelection(selectedState, visibleSet), [selectedState, visibleSet]);
  useEffect(() => {
    if (selected !== selectedState) setSelected(selected);
  }, [selected, selectedState]);

  /** Visible order (rows of expanded groups) for shift-click ranges. */
  const order = useMemo(
    () => groups.filter((g) => !collapsed.has(g.key)).flatMap((g) => g.tasks.map((t) => t.id)),
    [groups, collapsed],
  );
  const latest = useRef({ order, selected });
  latest.current = { order, selected };

  const togglers = useRef(new Map<number, (value: boolean, e: { shiftKey: boolean }) => void>());
  const toggler = useCallback((id: number) => {
    let fn = togglers.current.get(id);
    if (!fn) {
      fn = (value, { shiftKey }) => {
        setSelected((prev) => applySelection(prev, latest.current.order, anchorRef.current, id, value, shiftKey));
        anchorRef.current = id;
      };
      togglers.current.set(id, fn);
    }
    return fn;
  }, []);
  const toggleFromRow = useCallback(
    (task: TaskDTO) => toggler(task.id)(!latest.current.selected.has(task.id), { shiftKey: false }),
    [toggler],
  );

  const exitSelection = useCallback(() => {
    setSelecting(false);
    setSelected(new Set());
    anchorRef.current = null;
  }, []);
  // Selection mode is modal-ish: Esc leaves it (and the phone "+" button steps aside).
  useOverlay(selecting, exitSelection);

  const selectedTasks = useMemo(() => tasks.filter((t) => selected.has(t.id)), [tasks, selected]);

  // ---- Render ----------------------------------------------------------------------------
  const fetchingNewResult = query.isFetching && query.isPlaceholderData;

  const renderRows = (list: readonly TaskDTO[]) =>
    list.map((task) => (
      <TaskRow
        key={task.id}
        role="listitem"
        task={task}
        hide={hide}
        selectable={selecting}
        selected={selecting && selected.has(task.id)}
        onSelectedChange={selecting ? toggler(task.id) : undefined}
        onOpen={selecting ? toggleFromRow : undefined}
        editable={!selecting}
        showMenu={!selecting}
        active={!selecting && openTaskId === task.id}
      />
    ));

  const revealing = fetchingNewResult && settledToggles !== toggles;
  /** A toolbar-less list showing archived tasks after "Show archived tasks" in its empty state. */
  const revealedArchived = !toolbar && showArchived && !initialShowArchived(filter);

  let body: ReactNode;
  if (query.isPending || (tasks.length === 0 && (revealing || probing))) {
    body = (
      <ListCard>
        <SkeletonList rows={6} className="px-3 py-1" />
      </ListCard>
    );
  } else if (query.isError && !data) {
    body = (
      <ListCard>
        <ErrorState size="sm" error={query.error} onRetry={() => void query.refetch()} />
      </ListCard>
    );
  } else if (tasks.length === 0) {
    const searchText = toolbar ? debouncedSearch.trim() : '';
    const message = hidden && hiddenTasksMessage(hidden, searchText);
    // Counts unavailable (the probe failed): offer every toggle that is off.
    const unknown = probes !== null && !hidden;
    const offerClosed = hidden ? hidden.closed > 0 : unknown && toolbar && !showClosed;
    const offerArchived = hidden ? hidden.archived > 0 : unknown && !showArchived;
    body = (
      <ListCard>
        <EmptyState
          size="sm"
          icon={searchText ? <SearchX /> : message && hidden?.closed === 0 ? <Archive /> : <ListTodo />}
          title={message?.title ?? (searchText ? `No tasks match “${searchText}”` : (emptyMessage ?? 'No tasks'))}
          body={message?.body ?? (unknown && toolbar && !showClosed ? 'Closed tasks are hidden.' : undefined)}
          action={
            (searchText || offerClosed || offerArchived) && (
              <>
                {searchText && (
                  <Button size="sm" onClick={() => setSearch('')}>
                    Clear filter
                  </Button>
                )}
                {offerClosed && (
                  <Button size="sm" variant="ghost" onClick={() => setShowClosed(true)}>
                    Show closed tasks
                  </Button>
                )}
                {offerArchived && (
                  <Button size="sm" variant="ghost" onClick={revealArchived}>
                    Show archived tasks
                  </Button>
                )}
              </>
            )
          }
        />
        {createDefaults && (
          <QuickAddRow
            defaults={quickAddDefaults(createDefaults, {}, filter, lookups)}
            className="border-t border-border"
          />
        )}
      </ListCard>
    );
  } else if (groupState === 'none') {
    body = (
      <ListCard busy={fetchingNewResult}>
        <div role="list" aria-label="Tasks" className="divide-y divide-border">
          {renderRows(tasks)}
        </div>
        {createDefaults && (
          <QuickAddRow defaults={quickAddDefaults(createDefaults, {}, filter, lookups)} className="border-t border-border" />
        )}
      </ListCard>
    );
  } else {
    const patches = groups.map((g) => (createDefaults ? groupCreatePatch(groupState, g.key, groupCtx) : null));
    const noGroupTakesNewTasks = patches.every((p) => p === null);
    body = (
      <ListCard busy={fetchingNewResult}>
        {groups.map((group, i) => {
          const label = groupLabel(groupState, group.key, lookups);
          const isCollapsed = collapsed.has(group.key);
          const patch = patches[i];
          const contentId = `task-group-${groupState}-${group.key}`;
          return (
            <section key={group.key} aria-label={label} className={clsx(i > 0 && 'border-t border-border')}>
              <h3>
                <button
                  type="button"
                  aria-expanded={!isCollapsed}
                  aria-controls={contentId}
                  onClick={() => toggleGroup(group.key)}
                  className="flex h-10 w-full items-center gap-2 bg-surface-2/60 px-3 text-left text-[13px] font-medium text-fg hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2"
                >
                  <ChevronRight
                    aria-hidden
                    className={clsx('size-4 shrink-0 text-fg-subtle transition-transform motion-reduce:transition-none', !isCollapsed && 'rotate-90')}
                  />
                  <GroupIcon groupBy={groupState} groupKey={group.key} lookups={lookups} />
                  <span className="min-w-0 truncate">{label}</span>
                  <span className="shrink-0 text-xs font-normal tabular-nums text-fg-subtle">
                    {group.tasks.length}
                    <span className="sr-only"> {group.tasks.length === 1 ? 'task' : 'tasks'}</span>
                  </span>
                </button>
              </h3>
              <div id={contentId} hidden={isCollapsed}>
                {!isCollapsed && (
                  <>
                    <div role="list" aria-label={label} className="divide-y divide-border border-t border-border">
                      {renderRows(group.tasks)}
                    </div>
                    {createDefaults && patch && (
                      <QuickAddRow
                        defaults={quickAddDefaults(createDefaults, patch, filter, lookups)}
                        context={label}
                        className="border-t border-border"
                      />
                    )}
                  </>
                )}
              </div>
            </section>
          );
        })}
        {createDefaults && noGroupTakesNewTasks && (
          <QuickAddRow defaults={quickAddDefaults(createDefaults, {}, filter, lookups)} className="border-t border-border" />
        )}
      </ListCard>
    );
  }

  const total = data?.total ?? 0;
  const loaded = data?.tasks.length ?? 0;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {toolbar && (
        <TaskListToolbar
          search={search}
          onSearchChange={setSearch}
          showClosed={showClosed}
          onShowClosedChange={setShowClosed}
          showArchived={showArchived}
          onShowArchivedChange={setShowArchived}
          sort={sortState}
          onSortChange={setSort}
          groupBy={groupState}
          groupChoices={groupChoices}
          onGroupByChange={setGroupBy}
          selectable={selectable}
          selecting={selecting}
          onSelectingChange={(next) => (next ? setSelecting(true) : exitSelection())}
          fetching={fetchingNewResult}
        />
      )}
      {!toolbar && ((selectable && !selecting && tasks.length > 0) || revealedArchived) && (
        <div className="flex justify-end gap-1">
          {revealedArchived && (
            <Button size="sm" variant="ghost" icon={<Archive />} onClick={() => setShowArchived(false)}>
              Hide archived
            </Button>
          )}
          {selectable && !selecting && tasks.length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => setSelecting(true)}>
              Select
            </Button>
          )}
        </div>
      )}

      {body}

      {data && total > loaded && (
        <div className="flex flex-wrap items-center justify-center gap-3 text-sm text-fg-muted">
          <span>
            Showing {loaded} of {pluralize(total, 'task')}
          </span>
          <Button
            size="sm"
            loading={query.isFetching && limit > loaded}
            onClick={() => setPaging({ key: queryKey, limit: limit + PAGE_SIZE })}
          >
            Show more
          </Button>
        </div>
      )}

      {selecting && (
        <BulkActionBar
          tasks={selectedTasks}
          listedCount={tasks.length}
          onSelectAll={() => setSelected(new Set(tasks.map((t) => t.id)))}
          onClearSelection={() => setSelected(new Set())}
          onExit={exitSelection}
        />
      )}
    </div>
  );
}

function ListCard({ children, busy = false }: { children: ReactNode; busy?: boolean }) {
  return (
    <div
      aria-busy={busy || undefined}
      className={clsx(
        'min-w-0 overflow-hidden rounded-lg border border-border bg-surface shadow-card transition-opacity',
        busy && 'opacity-70',
      )}
    >
      {children}
    </div>
  );
}

function GroupIcon({ groupBy, groupKey, lookups }: { groupBy: TaskListGroupBy; groupKey: string; lookups: Lookups }) {
  const id = Number(groupKey);
  const box = (node: ReactNode) => (
    <span aria-hidden className="flex size-4 shrink-0 items-center justify-center [&_svg]:size-4">
      {node}
    </span>
  );
  switch (groupBy) {
    case 'status': {
      const status = lookups.statusById.get(id);
      return status ? box(<StatusIcon status={status} fraction={statusFraction(status, lookups.statuses)} label={null} />) : null;
    }
    case 'statusCategory': {
      const category = groupKey as StatusCategory;
      if (!(category in STATUS_CATEGORY_META)) return null;
      const status = lookups.statuses.find((s) => s.category === category);
      return box(
        <StatusIcon
          status={{ name: STATUS_CATEGORY_META[category].label, category, color: status?.color ?? '#94a3b8' }}
          label={null}
        />,
      );
    }
    case 'priority':
      return box(<PriorityIcon priority={id as Priority} label={null} />);
    case 'project': {
      const project = lookups.projectById.get(id);
      return project ? <ColorDot color={project.color} square /> : null;
    }
    case 'milestone':
      return box(<Milestone className="text-fg-subtle" />);
    case 'epic': {
      const epic = lookups.epicById.get(id);
      return epic ? <EpicDot color={epic.color} /> : null;
    }
    case 'due':
      return box(groupKey === 'overdue' ? <CalendarClock className="text-danger" /> : <CalendarDays className="text-fg-subtle" />);
    case 'none':
      return null;
  }
}
