// The command palette UI — lazy chunk of CommandPalette.tsx.
//
// One combobox over: matching commands, server search results (tasks, projects, milestones,
// epics), boards (matched locally) and, with an empty query, recently opened items + all
// commands. Desktop: a panel near the top of the screen with keyboard hints. Phones: a
// full-screen sheet whose Back gesture closes it.
//
// Focus stays in the input (aria-activedescendant); ↑/↓ (or Ctrl+N/P) move the highlight, the
// mouse highlights on hover, Enter runs the highlighted item, mod+Enter opens a task as a page.
//
// History on phones: the sheet pushes an entry so Back closes it. Picking a destination
// REPLACES that entry (navigate(..., { replace: true }) after dismissForNavigation), so Back
// from the destination returns to the page the palette was opened on, with no dead entry.
// Picking the page (or drawer task) already showing just closes the palette.
// Commands that open another overlay (New task, Keyboard shortcuts) run after the palette has
// fully closed, so focus restoration and history entries don't interleave.
//
// The search covers the current space only. "Switch space…" turns the list into the account's spaces
// (Backspace in the empty input returns); viewers get no "New task" (design §12.9).

import { FloatingFocusManager, FloatingOverlay, FloatingPortal } from '@floating-ui/react';
import { useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import {
  Activity,
  ArrowLeftRight,
  Check,
  CornerDownLeft,
  FolderKanban,
  History,
  Keyboard,
  LayoutDashboard,
  Milestone as MilestoneIcon,
  Moon,
  Plus,
  Search,
  Settings,
  SquareKanban,
  Sun,
  Timer,
  UserRound,
  X,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { useLocation, useNavigate } from 'react-router';
import { MILESTONE_STATUS_LABELS, PROJECT_STATUS_LABELS } from '@shared/constants';
import type { BoardDTO, TaskDTO } from '@shared/types';
import { useAuthStatus } from '../../api/auth';
import { useLookups, type Lookups } from '../../api/bootstrap';
import { useSearch } from '../../api/misc';
import { findCachedTask } from '../../api/tasks';
import { ROLE_LABELS } from '../../app/permissions';
import { rememberLastSpace, useSpace, useSpacePath } from '../../app/space';
import { EpicDot, ProjectBadge, StatusIcon, statusFraction } from '../../components/domain';
import { spaceChoices, switchSpacePath } from '../../components/layout/navigation';
import { useCreateTaskDefaults } from '../../components/layout/useShellActions';
import { Button, ColorDot, IconButton, Kbd, Shortcut, Spinner } from '../../components/ui';
import { TRANSITION } from '../../components/ui/internal/floating';
import { OverlayControlsContext, type OverlayControls } from '../../components/ui/internal/overlayControls';
import { useModal, useScrimClose } from '../../components/ui/internal/useModal';
import { openCreateTask } from '../../lib/events';
import { formatDueDate } from '../../lib/format';
import { useDebouncedValue, useIsMobile, useToday } from '../../lib/hooks';
import { boardUrl, epicUrl, milestoneUrl, projectUrl, TASK_PARAM, taskPageUrl, useOpenTask } from '../../lib/taskLinks';
import { setStoredTheme } from '../../lib/theme';
import {
  buildSections,
  buildSpaceSections,
  flattenSections,
  highlightSegments,
  paletteTokens,
  wrapIndex,
  type PaletteActionLike,
  type PaletteItem,
} from './paletteModel';
import { rememberRecent } from './recent';
import { useRecentItems } from './useRecentItems';

/** Results per server group. */
const SEARCH_LIMIT = 8;
const DEBOUNCE_MS = 120;

export interface CommandPaletteDialogProps {
  open: boolean;
  /** Text the input starts with (reset on every open). */
  initialQuery: string;
  /** Changes on every open; remounts the content so query and highlight start fresh. */
  session: number;
  onClose: () => void;
  onShowShortcuts: () => void;
}

export default function CommandPaletteDialog({ open, initialQuery, session, onClose, onShowShortcuts }: CommandPaletteDialogProps) {
  const isMobile = useIsMobile();
  // Full-screen on phones, where Back must close it: that is the only layout pushing history.
  const usesHistory = isMobile;
  const { refs, context, isMounted, status, controls, close } = useModal(open, onClose, {
    history: usesHistory,
    duration: isMobile ? TRANSITION.sheet : TRANSITION.dialog,
  });
  const scrim = useScrimClose(true, close);
  const inputRef = useRef<HTMLInputElement>(null);

  // Commands that open another overlay run once the palette is fully gone.
  const pendingRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (open) pendingRef.current = null;
  }, [open]);
  useEffect(() => {
    if (isMounted || !pendingRef.current) return;
    const run = pendingRef.current;
    pendingRef.current = null;
    run();
  }, [isMounted]);
  const afterClose = useCallback(
    (run: () => void) => {
      pendingRef.current = run;
      close();
    },
    [close],
  );

  if (!isMounted) return null;

  return (
    <FloatingPortal>
      <FloatingOverlay
        lockScroll
        className={clsx('z-50 flex', isMobile ? 'items-stretch' : 'items-start justify-center px-4 pb-4 pt-[12vh]')}
      >
        <div aria-hidden data-status={status} className="ui-fade fixed inset-0 bg-overlay" {...scrim} />
        <FloatingFocusManager context={context} initialFocus={inputRef}>
          <div
            ref={refs.setFloating}
            role="dialog"
            aria-modal="true"
            aria-label="Search and commands"
            tabIndex={-1}
            data-status={status}
            className={clsx(
              'relative flex flex-col overflow-hidden bg-popover text-fg shadow-pop outline-none',
              isMobile
                ? 'ui-sheet h-full w-full'
                : 'ui-dialog max-h-[min(36rem,calc(100dvh-14vh-1rem))] w-full max-w-xl rounded-xl border border-border',
            )}
          >
            <OverlayControlsContext.Provider value={controls}>
              <PaletteBody
                key={session}
                initialQuery={initialQuery}
                inputRef={inputRef}
                isMobile={isMobile}
                usesHistory={usesHistory}
                controls={controls}
                afterClose={afterClose}
                onShowShortcuts={onShowShortcuts}
              />
            </OverlayControlsContext.Provider>
          </div>
        </FloatingFocusManager>
      </FloatingOverlay>
    </FloatingPortal>
  );
}

// ---------------------------------------------------------------------------------------------

interface PaletteAction extends PaletteActionLike {
  icon: ReactNode;
  /** Shortcut hint shown next to the command (useHotkey syntax). */
  shortcut?: string;
  run: () => void;
}

type Item = PaletteItem<PaletteAction>;

interface PaletteBodyProps {
  initialQuery: string;
  inputRef: RefObject<HTMLInputElement | null>;
  isMobile: boolean;
  usesHistory: boolean;
  controls: OverlayControls;
  afterClose: (run: () => void) => void;
  onShowShortcuts: () => void;
}

function PaletteBody({ initialQuery, inputRef, isMobile, usesHistory, controls, afterClose, onShowShortcuts }: PaletteBodyProps) {
  const { id: sid, permissions } = useSpace();
  const sp = useSpacePath();
  const spaces = useAuthStatus().data?.spaces;
  const lookups = useLookups();
  const qc = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();
  const openTaskDrawer = useOpenTask();
  const baseId = useId();
  const listId = `${baseId}-list`;

  const [query, setQuery] = useState(initialQuery);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  /** 'spaces' after "Switch space…": the list holds the account's spaces. */
  const [mode, setMode] = useState<'all' | 'spaces'>('all');
  const keyboardNav = useRef(false);
  const today = useToday();

  const term = query.trim();
  const tokens = useMemo(() => paletteTokens(term), [term]);
  const debounced = useDebouncedValue(term, DEBOUNCE_MS);
  const search = useSearch(mode === 'spaces' ? '' : debounced, SEARCH_LIMIT);
  // The visible results belong to the current text (not debouncing, no request in flight).
  const settled = debounced === term && !search.isFetching;

  // ---- navigation helpers ----------------------------------------------------------------
  const go = useCallback(
    (to: string) => {
      // Already there: just close (on phones that pops the sheet's own history entry; a
      // navigation would leave a second copy of the page in history).
      if (to === location.pathname + location.search) return controls.close();
      const replace = controls.closeForNavigation();
      navigate(to, { replace: usesHistory && replace });
    },
    [controls, location.pathname, location.search, navigate, usesHistory],
  );

  /**
   * `recent`: a Recent item, stored earlier — its ref may be stale (the task moved to another
   * project, or the project key changed), so its page is opened by id.
   */
  const openTask = useCallback(
    (task: TaskEntry, asPage: boolean, recent = false) => {
      const cached = recent ? findCachedTask(qc, sid, task.id) : undefined;
      const latest = cached ? taskEntry(cached) : task;
      rememberRecent(sid, { kind: 'task', ...latest });
      if (asPage) return go(taskPageUrl(sid, recent ? { id: task.id } : latest));
      const params = new URLSearchParams(location.search);
      if (params.get(TASK_PARAM) === String(task.id)) return controls.close(); // already open
      const replace = controls.closeForNavigation();
      if (!usesHistory) return openTaskDrawer(task.id);
      // Same as useOpenTask, but replacing the sheet's own history entry.
      params.set(TASK_PARAM, String(task.id));
      navigate(
        { pathname: location.pathname, search: `?${params.toString()}` },
        { replace, preventScrollReset: true, state: { ...(location.state as object | null), taskDrawer: true } },
      );
    },
    [controls, go, location.pathname, location.search, location.state, navigate, openTaskDrawer, qc, sid, usesHistory],
  );

  const openBoard = useCallback(
    (board: BoardDTO) => {
      rememberRecent(sid, { kind: 'board', id: board.id, name: board.name });
      go(boardHref(sid, board));
    },
    [go, sid],
  );

  // ---- commands --------------------------------------------------------------------------
  const [dark] = useState(() => document.documentElement.classList.contains('dark'));
  // The page (and drawer task) under the palette; read when "New task" runs.
  const getCreateDefaults = useCreateTaskDefaults();
  const actions = useMemo<PaletteAction[]>(() => {
    const writer: PaletteAction[] = permissions.write
      ? [
          {
            id: 'new-task',
            label: 'New task',
            keywords: 'create add issue todo',
            icon: <Plus />,
            shortcut: 'c',
            run: () => afterClose(() => openCreateTask(getCreateDefaults())),
          },
        ]
      : [];
    return [
      ...writer,
      {
        id: 'switch-space',
        label: 'Switch space…',
        keywords: 'spaces workspace change other open',
        icon: <ArrowLeftRight />,
        run: () => {
          setMode('spaces');
          setQuery('');
          setActiveKey(null);
          inputRef.current?.focus();
        },
      },
      { id: 'go-dashboard', label: 'Go to Dashboard', keywords: 'home overview today', icon: <LayoutDashboard />, run: () => go(sp('/dashboard')) },
      { id: 'go-projects', label: 'Go to Projects', icon: <FolderKanban />, run: () => go(sp('/projects')) },
      { id: 'go-boards', label: 'Go to Boards', keywords: 'kanban', icon: <SquareKanban />, run: () => go(sp('/boards')) },
      { id: 'go-activity', label: 'Go to Activity', keywords: 'history feed changes', icon: <Activity />, run: () => go(sp('/activity')) },
      { id: 'go-worklog', label: 'Go to Work log', keywords: 'time tracking hours report', icon: <Timer />, run: () => go(sp('/worklog')) },
      {
        id: 'go-space-settings',
        label: 'Go to Space settings',
        keywords: 'estimate unit default board statuses tags data export backup',
        icon: <Settings />,
        run: () => go(sp('/settings')),
      },
      {
        id: 'go-settings',
        label: 'Go to Account settings',
        keywords: 'profile preferences password sessions theme week',
        icon: <UserRound />,
        run: () => go('/settings'),
      },
      {
        id: 'toggle-theme',
        label: dark ? 'Switch to light theme' : 'Switch to dark theme',
        keywords: 'toggle theme appearance mode dark light',
        icon: dark ? <Sun /> : <Moon />,
        run: () => {
          controls.close();
          setStoredTheme(dark ? 'light' : 'dark');
        },
      },
      {
        id: 'shortcuts',
        label: 'Keyboard shortcuts',
        keywords: 'help keys hotkeys',
        icon: <Keyboard />,
        shortcut: '?',
        run: () => afterClose(onShowShortcuts),
      },
    ];
  }, [afterClose, controls, dark, getCreateDefaults, go, inputRef, onShowShortcuts, permissions.write, sp]);

  // ---- results ---------------------------------------------------------------------------
  // Read once per open; tasks refreshed from the server, deleted tasks and boards dropped.
  const recents = useRecentItems();
  const spaceList = useMemo(() => spaceChoices(spaces ?? [], sid), [spaces, sid]);
  const sections = useMemo(
    () =>
      mode === 'spaces'
        ? buildSpaceSections<PaletteAction>(term, spaceList)
        : buildSections({
            query: term,
            actions,
            recents,
            boards: lookups.boards,
            results: debounced ? search.data : undefined,
          }),
    [actions, debounced, lookups.boards, mode, recents, search.data, spaceList, term],
  );
  const flat = useMemo(() => flattenSections(sections), [sections]);
  const indexByKey = useMemo(() => new Map(flat.map((item, i) => [item.key, i])), [flat]);
  const activeIndex = flat.length === 0 ? -1 : Math.max(0, activeKey === null ? 0 : (indexByKey.get(activeKey) ?? 0));
  const optionId = (index: number) => `${baseId}-opt-${index}`;

  useLayoutEffect(() => {
    if (!keyboardNav.current || activeIndex < 0) return;
    document.getElementById(optionId(activeIndex))?.scrollIntoView({ block: 'nearest' });
  });

  const activate = (item: Item, asPage = false) => {
    switch (item.kind) {
      case 'action':
        return item.action.run();
      case 'task':
        return openTask(taskEntry(item.task), asPage);
      case 'recent': {
        const r = item.recent;
        if (r.kind === 'task') return openTask({ id: r.id, ref: r.ref, title: r.title, archived: !!r.archived }, asPage, true);
        const board = lookups.boardById.get(r.id);
        return board ? openBoard(board) : undefined;
      }
      case 'project':
        return go(projectUrl(sid, item.project.id));
      case 'milestone':
        return go(milestoneUrl(sid, item.milestone.projectId, item.milestone.id));
      case 'epic':
        return go(epicUrl(sid, item.epic.projectId, item.epic.id));
      case 'board':
        return openBoard(item.board);
      case 'space':
        if (item.space.current) return controls.close();
        rememberLastSpace(item.space.id);
        return go(switchSpacePath(item.space.id));
    }
  };

  const move = (dir: 1 | -1) => {
    keyboardNav.current = true;
    const next = wrapIndex(activeIndex, dir, flat.length);
    setActiveKey(flat[next]?.key ?? null);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    const ctrlOnly = e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
    if (e.key === 'ArrowDown' || (ctrlOnly && e.key.toLowerCase() === 'n')) {
      e.preventDefault();
      move(1);
    } else if (e.key === 'ArrowUp' || (ctrlOnly && e.key.toLowerCase() === 'p')) {
      e.preventDefault();
      move(-1);
    } else if (e.key === 'Enter') {
      const item = flat[activeIndex];
      if (!item) return;
      e.preventDefault();
      activate(item, e.metaKey || e.ctrlKey);
    } else if (e.key === 'Backspace' && mode === 'spaces' && query === '') {
      e.preventDefault();
      setMode('all');
      setActiveKey(null);
    }
  };

  // ---- status ----------------------------------------------------------------------------
  const searching = mode === 'all' && tokens.length > 0 && !settled;
  const failed = mode === 'all' && tokens.length > 0 && settled && search.isError;
  const empty = tokens.length > 0 && (mode === 'spaces' || (settled && !search.isError)) && flat.length === 0;
  const announcement =
    tokens.length === 0 ? '' : failed ? 'Search failed' : !settled ? '' : flat.length === 0 ? 'No results' : `${flat.length} results`;

  return (
    <>
      <div
        className={clsx(
          'flex shrink-0 items-center gap-2 border-b border-border',
          isMobile ? 'px-3 pb-2 pt-safe-3' : 'h-14 px-4',
        )}
      >
        <div
          className={clsx(
            'flex min-w-0 flex-1 items-center',
            isMobile ? 'h-11 rounded-lg border border-border bg-surface' : 'h-full',
          )}
        >
          <Search aria-hidden className={clsx('pointer-events-none size-[18px] shrink-0 text-fg-subtle', isMobile && 'ml-3')} />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
            aria-autocomplete="list"
            aria-label={mode === 'spaces' ? 'Switch to a space' : 'Search tasks, projects and commands'}
            placeholder={
              mode === 'spaces' ? 'Switch to space…' : isMobile ? 'Search or run a command' : 'Search tasks, projects, boards… or type a command'
            }
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveKey(null);
            }}
            onKeyDown={onKeyDown}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="go"
            maxLength={200}
            className="h-full min-w-0 flex-1 bg-transparent px-3 text-base text-fg outline-none placeholder:text-fg-subtle md:text-[15px]"
          />
          {searching && <Spinner size="xs" label={null} className="mr-2 shrink-0 text-fg-subtle" />}
          {query && (
            <IconButton
              aria-label="Clear search"
              tooltip={false}
              size="sm"
              icon={<X />}
              onClick={() => {
                setQuery('');
                setActiveKey(null);
                inputRef.current?.focus();
              }}
              className={clsx('shrink-0', isMobile && 'mr-0.5')}
            />
          )}
        </div>
        {isMobile ? (
          <Button variant="ghost" onClick={controls.close} className="-mr-1 shrink-0">
            Cancel
          </Button>
        ) : (
          <Kbd className="shrink-0 pointer-coarse:hidden">Esc</Kbd>
        )}
      </div>

      <div
        className={clsx('min-h-0 flex-1 overflow-y-auto overscroll-contain scrollbar-thin', isMobile ? 'px-2 pb-safe-3 pt-1' : 'p-2')}
      >
        <div id={listId} role="listbox" aria-label="Results">
          {sections.map((section) => {
            const headingId = `${baseId}-${section.id}`;
            return (
              <div key={section.id} role="group" aria-labelledby={headingId} className="pb-1">
                <div
                  id={headingId}
                  role="presentation"
                  className="px-2.5 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle"
                >
                  {section.label}
                </div>
                {section.items.map((item) => {
                  const index = indexByKey.get(item.key) ?? -1;
                  const active = index === activeIndex;
                  return (
                    <div
                      key={item.key}
                      id={optionId(index)}
                      role="option"
                      aria-selected={active}
                      data-active={active || undefined}
                      onPointerMove={() => {
                        keyboardNav.current = false;
                        if (!active) setActiveKey(item.key);
                      }}
                      // Keep focus (and the phone keyboard) in the input.
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={(e) => activate(item, e.metaKey || e.ctrlKey)}
                      className={clsx(
                        'group/option flex cursor-pointer select-none items-center gap-3 rounded-md px-2.5 text-sm text-fg',
                        'min-h-12 md:min-h-9 data-[active]:bg-surface-3/70 dark:data-[active]:bg-surface-3',
                      )}
                    >
                      <OptionContent item={item} tokens={tokens} lookups={lookups} today={today} keyHints={!isMobile} />
                      {!isMobile && (
                        <CornerDownLeft
                          aria-hidden
                          className="hidden size-3.5 shrink-0 text-fg-subtle pointer-fine:group-data-[active]/option:block"
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>

        {searching && flat.length === 0 && (
          <p className="flex items-center justify-center gap-2 px-3 py-8 text-sm text-fg-muted">
            <Spinner size="sm" label={null} /> Searching…
          </p>
        )}
        {failed && (
          <div className="flex flex-col items-center gap-2 px-3 py-6 text-center text-sm text-fg-muted">
            <p>Search failed. {search.error instanceof Error ? search.error.message : ''}</p>
            <Button size="sm" onClick={() => void search.refetch()}>
              Try again
            </Button>
          </div>
        )}
        {empty && (
          <div className="px-3 py-10 text-center">
            <p className="text-sm font-medium text-fg">{mode === 'spaces' ? `No space matches “${term}”` : `No results for “${term}”`}</p>
            {mode === 'all' && <p className="mt-1 text-[13px] text-fg-muted">Try fewer words, or a task reference like WEB-12.</p>}
          </div>
        )}
      </div>

      {!isMobile && (
        <div className="flex h-9 shrink-0 items-center gap-4 border-t border-border px-4 text-xs text-fg-subtle pointer-coarse:hidden">
          <span className="flex items-center gap-1.5">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> to move
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>↵</Kbd> to open
          </span>
          <span className="flex items-center gap-1.5">
            <Shortcut combo="mod+enter" /> task as page
          </span>
          <span className="ml-auto flex items-center gap-1.5">
            <Kbd>?</Kbd> shortcuts
          </span>
        </div>
      )}

      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------------------------

/** What the palette remembers about a task it opens (recent.ts RecentInput). */
interface TaskEntry {
  id: number;
  ref: string;
  title: string;
  archived: boolean;
}

const taskEntry = (task: TaskDTO): TaskEntry => ({ id: task.id, ref: task.ref, title: task.title, archived: task.archivedAt !== null });

/** Global boards have their own page; project boards open in their project's Board tab. */
function boardHref(spaceId: string, board: BoardDTO): string {
  return board.projectId === null ? boardUrl(spaceId, board.id) : `${projectUrl(spaceId, board.projectId)}/board?board=${board.id}`;
}

function Highlighted({ text, tokens }: { text: string; tokens: readonly string[] }) {
  return (
    <>
      {highlightSegments(text, tokens).map((s, i) =>
        s.match ? (
          <mark key={i} className="bg-transparent font-semibold text-fg">
            {s.text}
          </mark>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  );
}

const ICON = 'flex size-5 shrink-0 items-center justify-center text-fg-muted [&_svg]:size-4';
const LABEL = 'min-w-0 flex-1 truncate';
const META = 'shrink-0 text-xs text-fg-subtle';
const REF = 'shrink-0 font-mono text-[11.5px] text-fg-subtle';

/**
 * Marks an archived task (search lists them last; Recent can hold one): the same plain label
 * archived projects get here, so it stays readable on a phone without crowding the title out.
 */
function ArchivedMark() {
  return <span className={META}>Archived</span>;
}

interface OptionContentProps {
  item: Item;
  tokens: readonly string[];
  lookups: Lookups;
  today: string;
  /** Show keyboard shortcut hints (not in the phone layout). */
  keyHints: boolean;
}

function OptionContent({ item, tokens, lookups, today, keyHints }: OptionContentProps) {
  switch (item.kind) {
    case 'action': {
      const { action } = item;
      return (
        <>
          <span aria-hidden className={ICON}>
            {action.icon}
          </span>
          <span className={LABEL}>
            <Highlighted text={action.label} tokens={tokens} />
          </span>
          {keyHints && action.shortcut && <Shortcut combo={action.shortcut} className="shrink-0" />}
        </>
      );
    }
    case 'recent': {
      const r = item.recent;
      return r.kind === 'task' ? (
        <>
          <span aria-hidden className={ICON}>
            <History />
          </span>
          <span className={REF}>{r.ref}</span>
          <span className={clsx(LABEL, r.archived && 'text-fg-muted')}>{r.title}</span>
          <span className="sr-only">, recently opened task</span>
          {r.archived && <ArchivedMark />}
        </>
      ) : (
        <>
          <span aria-hidden className={ICON}>
            <History />
          </span>
          <span className={LABEL}>{r.name}</span>
          <span className={META}>Board</span>
        </>
      );
    }
    case 'task': {
      const { task } = item;
      const status = lookups.statusById.get(task.statusId);
      const closed = status?.category === 'completed' || status?.category === 'cancelled';
      const archived = task.archivedAt !== null;
      return (
        <>
          <span aria-hidden className={ICON}>
            {status && <StatusIcon status={status} fraction={statusFraction(status, lookups.statuses)} label={null} />}
          </span>
          <span className={clsx(REF, 'min-w-[3.5rem] md:min-w-[4.25rem]')}>
            <Highlighted text={task.ref} tokens={tokens} />
          </span>
          <span
            title={task.title}
            className={clsx(
              LABEL,
              (closed || archived) && 'text-fg-muted',
              status?.category === 'cancelled' && 'line-through decoration-fg-subtle',
            )}
          >
            <Highlighted text={task.title} tokens={tokens} />
          </span>
          {status && <span className="sr-only">, {status.name}</span>}
          {archived && <ArchivedMark />}
          <ProjectBadge project={lookups.projectById.get(task.projectId)} plain className="shrink-0" />
        </>
      );
    }
    case 'project': {
      const { project } = item;
      return (
        <>
          <span aria-hidden className={ICON}>
            <ColorDot color={project.color} size="md" square />
          </span>
          <span className={LABEL}>
            <Highlighted text={project.name} tokens={tokens} />
          </span>
          {project.status !== 'active' && <span className={META}>{PROJECT_STATUS_LABELS[project.status]}</span>}
          <span className={REF}>
            <Highlighted text={project.key} tokens={tokens} />
          </span>
        </>
      );
    }
    case 'milestone': {
      const { milestone } = item;
      const open = milestone.status === 'planned' || milestone.status === 'active';
      return (
        <>
          <span aria-hidden className={ICON}>
            <MilestoneIcon />
          </span>
          <span className={clsx(LABEL, !open && 'text-fg-muted')}>
            <Highlighted text={milestone.name} tokens={tokens} />
          </span>
          <span className={META}>
            {open ? (milestone.dueDate ? `Due ${formatDueDate(milestone.dueDate, today)}` : '') : MILESTONE_STATUS_LABELS[milestone.status]}
          </span>
          <ProjectBadge project={lookups.projectById.get(milestone.projectId)} plain className="shrink-0" />
        </>
      );
    }
    case 'epic': {
      const { epic } = item;
      const closed = epic.status === 'done' || epic.status === 'cancelled';
      return (
        <>
          <span aria-hidden className={ICON}>
            <EpicDot color={epic.color} />
          </span>
          <span className={clsx(LABEL, closed && 'text-fg-muted')}>
            <Highlighted text={epic.name} tokens={tokens} />
          </span>
          <ProjectBadge project={lookups.projectById.get(epic.projectId)} plain className="shrink-0" />
        </>
      );
    }
    case 'space': {
      const { space } = item;
      return (
        <>
          <span aria-hidden className={ICON}>
            {space.current ? <Check /> : <ArrowLeftRight />}
          </span>
          <span className={LABEL}>
            <Highlighted text={space.name} tokens={tokens} />
          </span>
          {space.current && <span className="sr-only">, current space</span>}
          <span className={META}>{ROLE_LABELS[space.role]}</span>
        </>
      );
    }
    case 'board': {
      const { board } = item;
      return (
        <>
          <span aria-hidden className={ICON}>
            <SquareKanban />
          </span>
          <span className={LABEL}>
            <Highlighted text={board.name} tokens={tokens} />
          </span>
          {board.projectId === null ? (
            <span className={META}>Board</span>
          ) : (
            <ProjectBadge project={lookups.projectById.get(board.projectId)} plain className="shrink-0" />
          )}
        </>
      );
    }
  }
}
