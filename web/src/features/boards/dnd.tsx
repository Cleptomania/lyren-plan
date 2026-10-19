// Drag & drop for boards (SPEC §8.2, §8.3).
//
// - Sensors: MouseSensor {distance: 4}, TouchSensor {delay: 250, tolerance: 8} (long press;
//   cards keep `touch-action: manipulation` so phones still scroll), KeyboardSensor with
//   sortableKeyboardCoordinates. Never PointerSensor + touch-action: none.
// - Cards are sortable items (ids `${lane}|${col}|${taskId}`), cells are droppables. Items
//   never shift while dragging: a DragOverlay follows the pointer and an insertion line shows
//   where the card goes (manual sort), so dragging re-renders only the affected cells — the
//   memoized TaskCards keep their props.
// - Drag state lives in a tiny external store; cells subscribe to their own slice.
// - On drop: computeDropPatch(...) + a rank position (manual sort only) → taskActions.update
//   (optimistic, error toast). Targets that can't take the card are dimmed while dragging.
//   A move to another cell confirms with a toast that names the target and offers Undo.
// - Released off the board (the sidebar, the header, a toolbar) a drag is cancelled; the
//   overlay says "Release to cancel" meanwhile.
// - Boards with lanes show the target ("Lane · Column") on the drag overlay. On phones each
//   column stacks its lanes separately, so a touch drag into another column keeps the card's
//   own lane (scrolled under the finger) until the finger moves up or down on purpose.

import { clsx } from 'clsx';
import {
  closestCorners,
  DndContext,
  DragOverlay,
  KeyboardCode,
  KeyboardSensor,
  MouseSensor,
  pointerWithin,
  TouchSensor,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
  type KeyboardCoordinateGetter,
} from '@dnd-kit/core';
import { SortableContext, useSortable } from '@dnd-kit/sortable';
import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import type { BoardConfig } from '@shared/board';
import type { BootstrapDTO, TaskDTO } from '@shared/types';
import { qk } from '../../api/keys';
import { applyTaskPatch, inverseTaskPatch } from '../../api/tasks';
import { useSpace, useSpaceId } from '../../app/space';
import { TaskCard, TaskRow, taskActions, type ExtraMenuItems } from '../../components/domain';
import { useIsMobile } from '../../lib/hooks';
import {
  cardDndId,
  cellKey,
  cellTasks,
  computeDropPatch,
  dropPosition,
  customLandingMessage,
  insertionNeighbours,
  NO_LANE,
  parseCardDndId,
  type BoardGroup,
  type CellRef,
  withNewRef,
} from './grouping';
import type { BoardModel } from './useBoardModel';
import { keepLaneTarget, type LaneLock } from './laneKeep';
import { isOverBoard, nearestToPoint } from './pointerTarget';

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface DragTarget extends CellRef {
  /** Insertion index in the rendered cell list; null = no position (header, collapsed group). */
  index: number | null;
}

interface DragState {
  active: (CellRef & { taskId: number }) | null;
  /** Cell keys that accept the active card. */
  droppable: ReadonlySet<string>;
  target: DragTarget | null;
}

const IDLE: DragState = { active: null, droppable: new Set(), target: null };

class DragStore {
  private state: DragState = IDLE;
  private readonly listeners = new Set<() => void>();
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  get = () => this.state;
  set(next: DragState) {
    this.state = next;
    this.listeners.forEach((l) => l());
  }
  setTarget(target: DragTarget | null) {
    const cur = this.state.target;
    if (cur === target) return;
    if (cur && target && cur.lane === target.lane && cur.col === target.col && cur.index === target.index) return;
    this.set({ ...this.state, target });
  }
}

const StoreContext = createContext<DragStore | null>(null);

function useStore(): DragStore {
  const store = useContext(StoreContext);
  if (!store) throw new Error('Board drag hooks must be used inside <BoardDnd>');
  return store;
}

/** True while a card is being dragged (e.g. to disable scroll snapping). */
export function useIsDragging(): boolean {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, () => store.get().active !== null);
}

export interface CellDragState {
  dragging: boolean;
  /** The active card may be dropped here. */
  canDrop: boolean;
  /** The pointer / keyboard target is this cell. */
  isOver: boolean;
  /** Where the insertion line goes (manual sort), else null. */
  indicator: number | null;
}

/** Drag state of one cell (re-renders only when it changes). */
export function useCellDragState(lane: string, col: string, showIndicator: boolean): CellDragState {
  const store = useStore();
  const key = cellKey(lane, col);
  const flags = useSyncExternalStore(store.subscribe, () => {
    const s = store.get();
    if (!s.active) return 0;
    const over = s.target !== null && cellKey(s.target.lane, s.target.col) === key;
    return 1 | (s.droppable.has(key) ? 2 : 0) | (over ? 4 : 0);
  });
  const indicator = useSyncExternalStore(store.subscribe, () => {
    const s = store.get();
    if (!showIndicator || !s.active || !s.target || s.target.index === null) return -1;
    if (cellKey(s.target.lane, s.target.col) !== key || !s.droppable.has(key)) return -1;
    return s.target.index;
  });
  return {
    dragging: (flags & 1) !== 0,
    canDrop: (flags & 2) !== 0,
    isOver: (flags & 4) !== 0,
    indicator: indicator < 0 ? null : indicator,
  };
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

interface CellData {
  type: 'cell';
  lane: string;
  col: string;
  index: number | null;
}
interface CardData {
  type: 'card';
  lane: string;
  col: string;
  taskId: number;
  index: number;
}
type DndData = CellData | CardData;

/** Marks the element around a board's layout (BoardView); the pointer must be over it to drop. */
const BOARD_AREA_ATTR = 'data-board-area';

/**
 * The window's usable bottom: the top of the phone tab bar / offline banner (`data-bottom-chrome`),
 * which the board ends at. A finger pushed onto the tab bar to auto-scroll a column is still
 * "past the board's edge", not off the board.
 */
function usableBottom(height: number): number {
  let bottom = height;
  for (const el of document.querySelectorAll('[data-bottom-chrome]')) {
    const r = el.getBoundingClientRect();
    if (r.height > 0 && r.top > 0 && r.top < bottom) bottom = r.top;
  }
  return bottom;
}

/** The board area around the droppables (null before they mount). */
function boardArea(containers: Parameters<CollisionDetection>[0]['droppableContainers']): HTMLElement | null {
  for (const container of containers) {
    const node = container.node.current;
    if (node?.isConnected) return node.closest<HTMLElement>(`[${BOARD_AREA_ATTR}]`);
  }
  return null;
}

/**
 * Off the board (isOverBoard: the sidebar, the header, a toolbar) nothing — releasing there
 * cancels; cells scrolled out of view under that UI are not targets either. On the board, the
 * droppables under the pointer; over none (a gap, or past the board's edge while it
 * auto-scrolls), the nearest column's nearest cell to the pointer (pointerTarget.ts). Keyboard
 * drags have no pointer: closest corners of the dragged card.
 */
const collision: CollisionDetection = (args) => {
  const p = args.pointerCoordinates;
  if (!p) return closestCorners(args);
  const area = boardArea(args.droppableContainers);
  const root = document.documentElement;
  if (area && !isOverBoard(p, area.getBoundingClientRect(), { width: root.clientWidth, height: usableBottom(root.clientHeight) })) return [];
  const hits = pointerWithin(args);
  if (hits.length > 0) return hits;
  const entries = args.droppableContainers.flatMap((container) => {
    const rect = args.droppableRects.get(container.id);
    return rect ? [{ key: container, rect }] : [];
  });
  const nearest = nearestToPoint(p, entries);
  return nearest ? [{ id: nearest.key.id, data: { droppableContainer: nearest.key, value: nearest.dx + nearest.dy } }] : [];
};

/** Activation constraints from SPEC §8.3. */
function useBoardSensors(coordinateGetter: KeyboardCoordinateGetter) {
  return useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter }),
  );
}

const isKeyboardDrag = (event: { activatorEvent: Event | null }) =>
  typeof KeyboardEvent !== 'undefined' && event.activatorEvent instanceof KeyboardEvent;
const isTouchDrag = (event: { activatorEvent: Event | null }) =>
  typeof TouchEvent !== 'undefined' && event.activatorEvent instanceof TouchEvent;

/** Insertion index for a card rect among a rendered cell's cards (null for a cell without positions). */
function indexInCell(cell: HTMLElement | null, rect: { top: number; height: number } | null): number | null {
  if (!cell || cell.dataset.collapsed !== undefined) return null;
  const items = cellItems(cell);
  if (!rect) return items.length;
  const mid = rect.top + rect.height / 2;
  return items.filter((el) => {
    const r = el.getBoundingClientRect();
    return r.top + r.height / 2 < mid;
  }).length;
}

/** Scroll a phone column so the given cell sits under the finger (y), as far as it can scroll. */
function scrollCellUnder(cell: HTMLElement | null, y: number) {
  const body = cell?.closest<HTMLElement>('[data-col-body]');
  if (!cell || !body) return;
  const r = cell.getBoundingClientRect();
  const want = y - Math.min(28, r.height / 2);
  body.scrollTop += r.top - want;
}

/** The rendered cell element (`data-board-cell`) and its card / row elements in order. */
function cellElement(lane: string, col: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-board-cell="${CSS.escape(cellKey(lane, col))}"]`);
}
function cellItems(cell: HTMLElement | null): HTMLElement[] {
  return cell ? [...cell.querySelectorAll<HTMLElement>('[data-board-item]')] : [];
}

export interface BoardDndProps {
  config: BoardConfig;
  model: BoardModel;
  /** List layout renders rows; the overlay follows suit. */
  children: ReactNode;
}

function groupLabel(groups: readonly BoardGroup[], key: string): string {
  return groups.find((g) => g.key === key)?.label ?? key;
}

export function BoardDnd({ config, model, children }: BoardDndProps) {
  const store = useMemo(() => new DragStore(), []);
  const sid = useSpaceId();
  const qc = useQueryClient();
  const isMobile = useIsMobile();
  const [activeTask, setActiveTask] = useState<TaskDTO | null>(null);
  const { layout } = model;
  // Phone columns are ~85vw wide: dnd-kit's default edge speed (up to 10px per 5ms tick)
  // carries a card past several columns before the finger can react, so go gentler there.
  const autoScroll = useMemo(() => ({ threshold: { x: 0.12, y: 0.12 }, acceleration: isMobile ? 3 : 10 }), [isMobile]);
  const latest = useRef({ config, model, isMobile });
  useLayoutEffect(() => {
    latest.current = { config, model, isMobile };
  });

  // Touch drags: the finger's position (dnd-kit reports scroll-adjusted deltas only) and the
  // lane kept while the card visits another column (keepLaneTarget).
  const finger = useRef<{ x: number; y: number } | null>(null);
  const laneLock = useRef<LaneLock | null>(null);
  const trackFinger = useMemo(
    () => (e: TouchEvent) => {
      const t = e.touches[0];
      if (t) finger.current = { x: t.clientX, y: t.clientY };
    },
    [],
  );

  /**
   * Keyboard moves go slot by slot through the grid (↑/↓ within a cell, then into the
   * neighbouring lane; ←/→ to the neighbouring column) instead of by geometry, and keep the
   * drop target in the store. The overlay is moved next to the chosen slot.
   */
  const keyboardCoordinates = useCallback<KeyboardCoordinateGetter>(
    (event) => {
      const code = event.code;
      const dx = code === KeyboardCode.Right ? 1 : code === KeyboardCode.Left ? -1 : 0;
      const dy = code === KeyboardCode.Down ? 1 : code === KeyboardCode.Up ? -1 : 0;
      if (!dx && !dy) return undefined;
      event.preventDefault();
      const { active, target } = store.get();
      if (!active || !target) return undefined;
      const { grid } = latest.current.model;
      const lanes = grid.hasLanes && latest.current.model.layout === 'kanban' ? grid.visibleLanes.filter((l) => !l.collapsed).map((l) => l.key) : [NO_LANE];
      const cols = grid.visibleColumns.map((c) => c.key);
      const count = (lane: string, col: string) => cellItems(cellElement(lane, col)).length;
      let { lane, col } = target;
      let index = target.index ?? 0;
      if (dx) {
        const ci = cols.indexOf(col) + dx;
        if (ci < 0 || ci >= cols.length) return undefined;
        col = cols[ci]!;
        index = Math.min(index, count(lane, col));
      } else {
        const n = count(lane, col);
        // In the card's own cell, the slots before and after it are the same place.
        const own = lane === active.lane && col === active.col ? cellItems(cellElement(lane, col)).findIndex((el) => el.dataset.taskId === String(active.taskId)) : -1;
        let next = index + dy;
        if (own >= 0 && next === own + 1) next += dy;
        if (next < 0 || next > n) {
          const li = lanes.indexOf(lane) + dy;
          if (li < 0 || li >= lanes.length) return undefined;
          lane = lanes[li]!;
          index = dy > 0 ? 0 : count(lane, col);
        } else index = next;
      }
      const cell = cellElement(lane, col);
      if (!cell) return undefined;
      const items = cellItems(cell);
      const collapsed = cell.dataset.collapsed !== undefined;
      store.setTarget({ lane, col, index: collapsed ? null : index });
      const anchor = items[index] ?? items[items.length - 1] ?? cell;
      anchor.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const rect = anchor.getBoundingClientRect();
      const cellRect = cell.getBoundingClientRect();
      const y = items[index] ? rect.top - 10 : items.length > 0 ? rect.bottom - 10 : cellRect.top + 4;
      return { x: cellRect.left + 4, y };
    },
    [store],
  );
  const sensors = useBoardSensors(keyboardCoordinates);

  const cellName = useCallback((cell: CellRef) => {
    const g = latest.current.model.grid;
    const col = groupLabel(g.columns, cell.col);
    return g.hasLanes && cell.lane !== NO_LANE ? `${groupLabel(g.lanes, cell.lane)} · ${col}` : col;
  }, []);

  const findTask = useCallback((id: number) => latest.current.model.tasks.find((t) => t.id === id) ?? null, []);

  // dnd-kit announces a drop only after onDragEnd has reset the store, so onDragEnd records
  // the outcome here for the announcement (otherwise every drop read "not moved").
  const dropMessage = useRef<string | null>(null);
  const describeDrop = useCallback(
    (target: DragTarget | null, droppable: ReadonlySet<string>) => {
      if (!target) return 'Dropped. The task was not moved.';
      return droppable.has(cellKey(target.lane, target.col)) ? `Dropped in ${cellName(target)}.` : 'The task can’t be moved there; it was not moved.';
    },
    [cellName],
  );

  const resolveTarget = useCallback((event: DragMoveEvent): DragTarget | null => {
    const over = event.over;
    const data = over?.data.current as DndData | undefined;
    if (!over || !data) return null;
    const rect = event.active.rect.current.translated;
    if (data.type === 'cell') {
      // Over the cell but not over a card (its padding or the gaps between cards): place the
      // card by its centre among the cell's cards instead of always appending it at the end.
      const items = data.index !== null && rect ? cellItems(cellElement(data.lane, data.col)) : [];
      if (!rect || data.index === null || items.length === 0) return { lane: data.lane, col: data.col, index: data.index };
      const mid = rect.top + rect.height / 2;
      const index = items.filter((el) => {
        const r = el.getBoundingClientRect();
        return r.top + r.height / 2 < mid;
      }).length;
      return { lane: data.lane, col: data.col, index: Math.min(index, data.index) };
    }
    const after = rect ? rect.top + rect.height / 2 > over.rect.top + over.rect.height / 2 : false;
    return { lane: data.lane, col: data.col, index: data.index + (after ? 1 : 0) };
  }, []);

  /** The cell to target for a pointer / touch move; `align` lets a kept lane scroll under the finger. */
  const pickTarget = useCallback(
    (event: DragMoveEvent, align: boolean): DragTarget | null => {
      const raw = resolveTarget(event);
      const { active, droppable } = store.get();
      const { model: m, isMobile: mobile } = latest.current;
      if (!active || !finger.current || !isTouchDrag(event) || !mobile || !m.grid.hasLanes || m.layout !== 'kanban') return raw;
      const y = finger.current.y;
      const kept = keepLaneTarget(raw, active, laneLock.current, y, (c) => droppable.has(cellKey(c.lane, c.col)));
      laneLock.current = kept.lock;
      if (!kept.target || !raw || kept.target.lane === raw.lane) return raw;
      const cell = cellElement(kept.target.lane, kept.target.col);
      if (align && kept.entered) scrollCellUnder(cell, y);
      return { ...kept.target, index: indexInCell(cell, event.active.rect.current.translated) };
    },
    [resolveTarget, store],
  );

  const onDragStart = useCallback(
    (event: DragStartEvent) => {
      const parsed = parseCardDndId(String(event.active.id));
      const task = parsed ? findTask(parsed.taskId) : null;
      if (!parsed || !task) return;
      laneLock.current = null;
      if (isTouchDrag(event)) {
        const t = (event.activatorEvent as TouchEvent).touches[0];
        finger.current = t ? { x: t.clientX, y: t.clientY } : null;
        window.addEventListener('touchmove', trackFinger, { capture: true, passive: true });
      }
      const { config: cfg, model: m } = latest.current;
      const lanes = m.grid.hasLanes ? m.grid.visibleLanes.map((l) => l.key) : [NO_LANE];
      const droppable = new Set<string>();
      for (const lane of lanes) {
        for (const col of m.grid.visibleColumns) {
          if (computeDropPatch(cfg, m.ctx, task, parsed, { lane, col: col.key }) !== null) droppable.add(cellKey(lane, col.key));
        }
      }
      const data = event.active.data.current as CardData | undefined;
      store.set({ active: parsed, droppable, target: { lane: parsed.lane, col: parsed.col, index: data?.index ?? null } });
      setActiveTask(task);
      navigator.vibrate?.(10);
    },
    [findTask, store, trackFinger],
  );

  const onDragMove = useCallback(
    (event: DragMoveEvent) => {
      // Keyboard drags set the target slot themselves (see keyboardCoordinates).
      if (!isKeyboardDrag(event)) store.setTarget(pickTarget(event, true));
    },
    [pickTarget, store],
  );

  const reset = useCallback(() => {
    window.removeEventListener('touchmove', trackFinger, { capture: true });
    finger.current = null;
    laneLock.current = null;
    store.set(IDLE);
    setActiveTask(null);
  }, [store, trackFinger]);

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, droppable } = store.get();
      const target = isKeyboardDrag(event) ? store.get().target : pickTarget(event, false);
      dropMessage.current = describeDrop(active ? target : null, droppable);
      reset();
      if (!active || !target) return;
      const task = findTask(active.taskId);
      if (!task || !droppable.has(cellKey(target.lane, target.col))) return;
      const { config: cfg, model: m } = latest.current;
      const patch = computeDropPatch(cfg, m.ctx, task, active, target);
      if (!patch) return;
      const sameCell = active.lane === target.lane && active.col === target.col;
      let position;
      if (cfg.sort.field === 'manual' && target.index !== null) {
        const list = cellTasks(m.grid, target.lane, target.col);
        const n = insertionNeighbours(list, target.index, task.id);
        if (n.changed) position = dropPosition(cfg.sort, n.above, n.below);
      }
      if (Object.keys(patch).length === 0 && !position) return;
      if (sameCell) {
        taskActions.update(task, { position });
        return;
      }
      // A move to another cell says where the card went (custom groups: where it actually
      // landed, when its new fields match another group; another project: the new ref) and
      // offers Undo, which also restores the card's old rank, so it is back in its old place
      // among all tasks (other boards and lists included), even when it was alone in its cell.
      const full = position ? { ...patch, position } : patch;
      const patched = applyTaskPatch(task, patch, qc.getQueryData<BootstrapDTO>(qk.bootstrap(sid)));
      const landing = customLandingMessage(cfg, m.ctx, m.grid, patched, active, target);
      const message = landing ?? `Moved ${task.ref} to ${cellName(target)}`;
      taskActions.update(task, full, { success: withNewRef(task, message), undo: inverseTaskPatch(task, full) });
    },
    [cellName, describeDrop, findTask, pickTarget, qc, reset, sid, store],
  );

  const announced = useRef('');
  const describeTarget = useCallback(() => {
    const t = store.get().target;
    if (!t) return 'Not over the board. Release to cancel.';
    const ok = store.get().droppable.has(cellKey(t.lane, t.col));
    const pos = t.index === null ? '' : `, position ${t.index + 1}`;
    return `${cellName(t)}${pos}${ok ? '' : ' — the task can’t be moved here'}.`;
  }, [cellName, store]);

  const announcements = useMemo<Announcements>(
    () => ({
      onDragStart: ({ active }) => {
        const p = parseCardDndId(String(active.id));
        const t = p ? findTask(p.taskId) : null;
        return t ? `Picked up ${t.ref}, ${t.title}, in ${cellName(p!)}.` : 'Picked up a task.';
      },
      onDragOver: () => describeTarget(),
      onDragMove: () => {
        const t = store.get().target;
        const key = t ? `${cellKey(t.lane, t.col)}#${t.index}` : '';
        if (key === announced.current) return undefined;
        announced.current = key;
        return describeTarget();
      },
      onDragEnd: () => {
        const s = store.get();
        if (s.active) return describeDrop(s.target, s.droppable);
        const message = dropMessage.current ?? describeDrop(null, s.droppable);
        dropMessage.current = null;
        return message;
      },
      onDragCancel: () => 'Moving cancelled. The task was not moved.',
    }),
    [cellName, describeDrop, describeTarget, findTask, store],
  );

  // Lanes: the badge names the target (the card and finger cover its lane header). Every
  // layout: "Release to cancel" off the board, "Can't move here" over a dimmed cell.
  const badge = <DropTargetBadge cellName={cellName} names={layout === 'kanban' && model.grid.hasLanes} />;
  const overlay = activeTask ? (
    layout === 'list' ? (
      <div className="relative w-[min(36rem,90vw)]">
        {badge}
        <div className="rounded-lg border border-border bg-surface shadow-drag">
          <TaskRow task={activeTask} fields={config.card.fields} showMenu={false} editable={false} />
        </div>
      </div>
    ) : (
      <div className="relative">
        {badge}
        <TaskCard task={activeTask} overlay fields={config.card.fields} density={config.card.density} colorBy={config.card.colorBy} />
      </div>
    )
  ) : null;

  return (
    <StoreContext.Provider value={store}>
      <DndContext
        sensors={sensors}
        collisionDetection={collision}
        onDragStart={onDragStart}
        onDragMove={onDragMove}
        onDragOver={onDragMove}
        onDragEnd={onDragEnd}
        onDragCancel={reset}
        autoScroll={autoScroll}
        accessibility={{
          announcements,
          screenReaderInstructions: {
            draggable:
              'To move a task, press space or enter, use the arrow keys to choose a column and position, then press space or enter to drop it, or escape to cancel. The task’s actions menu offers the same moves.',
          },
        }}
      >
        {children}
        <DragOverlay dropAnimation={null}>{overlay}</DragOverlay>
      </DndContext>
    </StoreContext.Provider>
  );
}

/** Room (px) the badge needs above the dragged card. */
const BADGE_ROOM_PX = 32;

/**
 * Above the dragged card: "→ Lane · Column" on boards with lanes (`names`: the card and the
 * finger cover the target's lane header, and lane moves change fields — epic, priority… — too),
 * "Can't move here" over a cell that can't take the card, and "Release to cancel" off the board.
 * Positioned outside the overlay's box so dnd-kit's measurements of the card stay the same;
 * below the card while the card is too close to the window's top (e.g. dragged onto the header).
 */
function DropTargetBadge({ cellName, names }: { cellName: (cell: CellRef) => string; names: boolean }) {
  const store = useStore();
  const ref = useRef<HTMLDivElement>(null);
  const [below, setBelow] = useState(false);
  const text = useSyncExternalStore(store.subscribe, () => {
    const { active, target, droppable } = store.get();
    if (!active) return '';
    if (!target) return 'Release to cancel';
    if (target.lane === active.lane && target.col === active.col) return '';
    if (!droppable.has(cellKey(target.lane, target.col))) return 'Can’t move here';
    return names ? `→ ${cellName(target)}` : '';
  });
  // The overlay moves by transform without re-rendering: check its place once per frame.
  useEffect(() => {
    if (!text) return;
    let frame = 0;
    const tick = () => {
      const host = ref.current?.parentElement;
      if (host) setBelow(host.getBoundingClientRect().top < BADGE_ROOM_PX);
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [text]);
  if (!text) return null;
  return (
    <div
      ref={ref}
      aria-hidden
      className={clsx(
        'absolute left-0 max-w-full truncate rounded-full bg-fg px-2.5 py-1 text-xs font-medium text-bg shadow-md',
        below ? 'top-full mt-1.5' : 'bottom-full mb-1.5',
      )}
    >
      {text}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Droppable cells and sortable items
// ---------------------------------------------------------------------------

/** Make an element a drop target for a cell (index null = append without a position). */
export function useCellDroppable(lane: string, col: string, index: number | null, id = `cell:${lane}|${col}`) {
  const data: CellData = { type: 'cell', lane, col, index };
  return useDroppable({ id, data });
}

/** SortableContext for the cards of one cell. */
export function CellSortable({ ids, children }: { ids: string[]; children: ReactNode }) {
  return <SortableContext items={ids}>{children}</SortableContext>;
}

interface SortableItemProps {
  task: TaskDTO;
  lane: string;
  col: string;
  index: number;
  onOpen: (task: TaskDTO) => void;
  extraMenuItems: ExtraMenuItems;
  selected: boolean;
}

export interface SortableCardProps extends SortableItemProps {
  fields: BoardConfig['card']['fields'];
  density: BoardConfig['card']['density'];
  colorBy: BoardConfig['card']['colorBy'];
}

/**
 * dnd-kit's default role="button" would make the card a button wrapping the title and "⋯"
 * buttons (nested interactive: screen readers flatten it into one long button and can't reach
 * the inner controls). A focusable group keeps the keyboard drag (Space / Enter on the card)
 * and lets the title button (open) and the "⋯" menu (non-drag moves) stay reachable.
 */
const SORTABLE_ATTRIBUTES = { role: 'group', roleDescription: 'Draggable task' } as const;
/** A role that may not change tasks (design §12.9): no drags, and the card is no draggable thing. */
const FIXED_ATTRIBUTES = { role: 'group', roleDescription: 'Task' } as const;

/**
 * useSortable wired for a card / row root. The root is also the ACTIVATOR node: without one,
 * dnd-kit's KeyboardSensor starts a drag on Enter / Space from any descendant, so Enter on the
 * title button picked the card up instead of opening the task.
 */
function useSortableItem(id: string, data: CardData) {
  const { write } = useSpace().permissions;
  const { setNodeRef, setActivatorNodeRef, listeners, attributes, isDragging } = useSortable({
    id,
    data,
    disabled: !write,
    attributes: write ? SORTABLE_ATTRIBUTES : FIXED_ATTRIBUTES,
  });
  const ref = useCallback(
    (el: HTMLDivElement | null) => {
      setNodeRef(el);
      setActivatorNodeRef(el);
    },
    [setNodeRef, setActivatorNodeRef],
  );
  return { ref, listeners, attributes, isDragging };
}

/** A board card wired to dnd-kit. The inner TaskCard is memoized and keeps stable props. */
export const SortableCard = memo(function SortableCard({ task, lane, col, index, ...card }: SortableCardProps) {
  const data: CardData = { type: 'card', lane, col, taskId: task.id, index };
  const { ref, listeners, attributes, isDragging } = useSortableItem(cardDndId(lane, col, task.id), data);
  return (
    <TaskCard
      ref={ref}
      {...listeners}
      {...attributes}
      aria-label={`${task.ref}: ${task.title}`}
      data-board-item=""
      task={task}
      dragging={isDragging}
      fields={card.fields}
      density={card.density}
      colorBy={card.colorBy}
      onOpen={card.onOpen}
      selected={card.selected}
      extraMenuItems={card.extraMenuItems}
    />
  );
});

export interface SortableRowProps extends SortableItemProps {
  fields: BoardConfig['card']['fields'];
  selectable: boolean;
  onSelectedChange?: (task: TaskDTO, selected: boolean) => void;
}

/** A list-layout row wired to dnd-kit (lane is always NO_LANE). */
export const SortableRow = memo(function SortableRow({ task, lane, col, index, onSelectedChange, ...row }: SortableRowProps) {
  const data: CardData = { type: 'card', lane, col, taskId: task.id, index };
  const { ref, listeners, attributes, isDragging } = useSortableItem(cardDndId(lane, col, task.id), data);
  const onSel = useMemo(
    () => (onSelectedChange ? (on: boolean) => onSelectedChange(task, on) : undefined),
    [onSelectedChange, task],
  );
  return (
    <TaskRow
      ref={ref}
      {...listeners}
      {...attributes}
      aria-label={`${task.ref}: ${task.title}`}
      data-board-item=""
      task={task}
      dragging={isDragging}
      fields={row.fields}
      onOpen={row.onOpen}
      selectable={row.selectable}
      selected={row.selected}
      onSelectedChange={onSel}
      extraMenuItems={row.extraMenuItems}
      className="border-b border-border/60 last:border-b-0"
    />
  );
});
