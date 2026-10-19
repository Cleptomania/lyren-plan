// Board UI context: stable callbacks for cells, cards and group headers (they read the latest
// config / grid through a ref, so memoized cards keep identical props across renders) plus
// the display settings and the selection state, in separate contexts so each consumer only
// re-renders for what it uses. A role that may not change tasks (design §12.9) gets no "+", no
// card moves in menus and no drags (BoardDisplay.editable).

import {
  ArrowDown,
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpToLine,
  ChevronsDownUp,
  ChevronsUpDown,
  Columns3,
  EyeOff,
  Gauge,
  Rows3,
  SlidersHorizontal,
} from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import { OTHER_GROUP_KEY, type BoardConfig } from '@shared/board';
import type { TaskUpdateInput } from '@shared/schemas';
import type { BootstrapDTO, TaskDTO } from '@shared/types';
import { qk } from '../../api/keys';
import { applyTaskPatch, inverseTaskPatch } from '../../api/tasks';
import { useSpace } from '../../app/space';
import { taskActions, type ExtraMenuItems } from '../../components/domain';
import type { MenuItemInput } from '../../components/ui';
import { openCreateTask } from '../../lib/events';
import { moveGroup, setGroupCollapsed, setGroupHidden, type AxisName } from './configOps';
import {
  cellCreateDefaults,
  cellKey,
  cellTasks,
  computeDropPatch,
  customLandingMessage,
  dropPosition,
  NO_LANE,
  withNewRef,
  type BoardGroup,
  type CellRef,
} from './grouping';
import { GroupIcon } from './parts';
import type { ConfigUpdate } from './useBoardConfig';
import type { BoardModel } from './useBoardModel';

export type ConfigSection = 'layout' | 'filter' | 'columns' | 'lanes' | 'cards';

export interface BoardUiApi {
  /** Card click: opens the task, or toggles it in select mode. */
  openTask: (task: TaskDTO) => void;
  /** "⋯" extras for the cards of one cell (stable per cell). */
  menuFor: (lane: string, col: string) => ExtraMenuItems;
  /** "+" of a column / cell. */
  quickAdd: (lane: string, col: string) => void;
  toggleCollapsed: (axis: AxisName, group: BoardGroup) => void;
  /** Header "⋯" entries of a column or lane. */
  groupMenu: (axis: AxisName, group: BoardGroup) => MenuItemInput[];
  toggleSelected: (task: TaskDTO, on: boolean) => void;
  configure: (section?: ConfigSection) => void;
}

export interface BoardDisplay {
  /** The viewer may create and move tasks (false for viewers). */
  editable: boolean;
  fields: BoardConfig['card']['fields'];
  density: BoardConfig['card']['density'];
  colorBy: BoardConfig['card']['colorBy'];
  manualSort: boolean;
  selectMode: boolean;
}

export interface BoardSelection {
  active: boolean;
  ids: ReadonlySet<number>;
}

const ApiContext = createContext<BoardUiApi | null>(null);
const DisplayContext = createContext<BoardDisplay | null>(null);
const SelectionContext = createContext<BoardSelection>({ active: false, ids: new Set() });

export function useBoardUi(): BoardUiApi {
  const api = useContext(ApiContext);
  if (!api) throw new Error('useBoardUi() outside <BoardUiProvider>');
  return api;
}

export function useBoardDisplay(): BoardDisplay {
  const d = useContext(DisplayContext);
  if (!d) throw new Error('useBoardDisplay() outside <BoardUiProvider>');
  return d;
}

export function useBoardSelection(): BoardSelection {
  return useContext(SelectionContext);
}

export interface BoardUiProviderProps {
  config: BoardConfig;
  setConfig: (update: ConfigUpdate) => void;
  model: BoardModel;
  /** Project board scope (quick-add default project). */
  projectId: number | null;
  selection: BoardSelection;
  onToggleSelected: (task: TaskDTO, on: boolean) => void;
  onConfigure: (section?: ConfigSection) => void;
  children: ReactNode;
}

function axisLabel(axis: AxisName): { noun: string; prev: string; next: string } {
  return axis === 'columns' ? { noun: 'column', prev: 'Move left', next: 'Move right' } : { noun: 'lane', prev: 'Move up', next: 'Move down' };
}

export function BoardUiProvider({
  config,
  setConfig,
  model,
  projectId,
  selection,
  onToggleSelected,
  onConfigure,
  children,
}: BoardUiProviderProps) {
  const { id: sid, permissions } = useSpace();
  const editable = permissions.write;
  const qc = useQueryClient();
  const latest = useRef({ config, setConfig, model, projectId, selection, onToggleSelected, onConfigure, qc, sid, editable });
  useLayoutEffect(() => {
    latest.current = { config, setConfig, model, projectId, selection, onToggleSelected, onConfigure, qc, sid, editable };
  });

  const api = useMemo<BoardUiApi>(() => {
    const menus = new Map<string, ExtraMenuItems>();

    const move = (task: TaskDTO, from: CellRef, to: CellRef, label: string) => {
      const { config: cfg, model: m, qc: client, sid: spaceId } = latest.current;
      const patch = computeDropPatch(cfg, m.ctx, task, from, to);
      if (!patch || Object.keys(patch).length === 0) return;
      // Same landing rule as a drag (SPEC §8.2): overlapping custom groups may keep the card elsewhere.
      const patched = applyTaskPatch(task, patch, client.getQueryData<BootstrapDTO>(qk.bootstrap(spaceId)));
      const landing = customLandingMessage(cfg, m.ctx, m.grid, patched, from, to);
      taskActions.update(task, patch, { success: withNewRef(task, landing ?? `Moved ${task.ref} to ${label}`), undo: inverseTaskPatch(task, patch) });
    };

    const reorder = (task: TaskDTO, list: readonly TaskDTO[], where: 'top' | 'bottom') => {
      const { config: cfg } = latest.current;
      const others = list.filter((t) => t.id !== task.id);
      const position =
        where === 'top' ? dropPosition(cfg.sort, null, others[0] ?? null) : dropPosition(cfg.sort, others.at(-1) ?? null, null);
      if (position) taskActions.update(task, { position } satisfies TaskUpdateInput);
    };

    const menuFor = (lane: string, col: string): ExtraMenuItems => {
      const key = cellKey(lane, col);
      const cached = menus.get(key);
      if (cached) return cached;
      const build = (task: TaskDTO): MenuItemInput[] => {
        const { config: cfg, model: m, editable: canMove } = latest.current;
        if (!canMove) return [];
        const { grid, ctx } = m;
        const from = { lane, col };
        const items: MenuItemInput[] = [{ separator: true }];
        const colItems = grid.visibleColumns
          .filter((g) => g.key !== col)
          .map((g) => {
            const to = { lane, col: g.key };
            const ok = computeDropPatch(cfg, ctx, task, from, to);
            return {
              label: g.hint ? `${g.label} (${g.hint})` : g.label,
              icon: <GroupIcon field={cfg.columns.groupBy} group={g} />,
              disabled: ok === null || Object.keys(ok).length === 0,
              onSelect: () => move(task, from, to, g.label),
            };
          });
        if (colItems.length > 0) items.push({ label: 'Move to column', icon: <Columns3 />, items: colItems });
        if (grid.hasLanes && lane !== NO_LANE) {
          const laneItems = grid.visibleLanes
            .filter((g) => g.key !== lane)
            .map((g) => {
              const to = { lane: g.key, col };
              const ok = computeDropPatch(cfg, ctx, task, from, to);
              return {
                label: g.hint ? `${g.label} (${g.hint})` : g.label,
                icon: <GroupIcon field={cfg.swimlanes.groupBy} group={g} />,
                disabled: ok === null || Object.keys(ok).length === 0,
                onSelect: () => move(task, from, to, g.label),
              };
            });
          if (laneItems.length > 0) items.push({ label: 'Move to lane', icon: <Rows3 />, items: laneItems });
        }
        if (cfg.sort.field === 'manual') {
          const list = cellTasks(grid, lane, col);
          const index = list.findIndex((t) => t.id === task.id);
          items.push(
            { label: 'Move to top of column', icon: <ArrowUpToLine />, disabled: index <= 0, onSelect: () => reorder(task, list, 'top') },
            {
              label: 'Move to bottom of column',
              icon: <ArrowDownToLine />,
              disabled: index < 0 || index === list.length - 1,
              onSelect: () => reorder(task, list, 'bottom'),
            },
          );
        }
        return items;
      };
      menus.set(key, build);
      return build;
    };

    return {
      openTask: (task) => {
        const { selection: sel, onToggleSelected: toggle } = latest.current;
        if (sel.active) toggle(task, !sel.ids.has(task.id));
        else taskActions.open(task);
      },
      menuFor,
      quickAdd: (lane, col) => {
        const { config: cfg, model: m, projectId: pid, editable: canAdd } = latest.current;
        if (!canAdd) return;
        openCreateTask(cellCreateDefaults(cfg, m.ctx, { lane, col }, pid, m.filters.server));
      },
      toggleCollapsed: (axis, group) => latest.current.setConfig((c) => setGroupCollapsed(c, axis, group.key, !group.collapsed)),
      groupMenu: (axis, group) => {
        const { config: cfg, model: m } = latest.current;
        const groups = axis === 'columns' ? m.grid.columns : m.grid.lanes;
        const visible = groups.filter((g) => g.visible).map((g) => g.key);
        // The full order comes from the saved config: quick filters must not drop groups from it.
        const all = (axis === 'columns' ? m.editGroups.columns : m.editGroups.lanes).map((g) => g.key);
        const idx = visible.indexOf(group.key);
        const words = axisLabel(axis);
        const fixed = cfg[axis].groupBy === 'custom' && group.key === OTHER_GROUP_KEY;
        const set = latest.current.setConfig;
        return [
          {
            label: group.collapsed ? `Expand ${words.noun}` : `Collapse ${words.noun}`,
            icon: group.collapsed ? <ChevronsUpDown /> : <ChevronsDownUp />,
            onSelect: () => set((c) => setGroupCollapsed(c, axis, group.key, !group.collapsed)),
          },
          {
            label: words.prev,
            icon: axis === 'columns' ? <ArrowLeft /> : <ArrowUp />,
            disabled: fixed || idx <= 0,
            onSelect: () => set((c) => moveGroup(c, axis, all, visible, group.key, -1)),
          },
          {
            label: words.next,
            icon: axis === 'columns' ? <ArrowRight /> : <ArrowDown />,
            disabled: fixed || idx < 0 || idx >= visible.length - 1 || (cfg[axis].groupBy === 'custom' && visible[idx + 1] === OTHER_GROUP_KEY),
            onSelect: () => set((c) => moveGroup(c, axis, all, visible, group.key, 1)),
          },
          { label: `Hide ${words.noun}`, icon: <EyeOff />, onSelect: () => set((c) => setGroupHidden(c, axis, group.key, true)) },
          { separator: true },
          axis === 'columns' && { label: 'WIP limit…', icon: <Gauge />, onSelect: () => latest.current.onConfigure('columns') },
          {
            label: axis === 'columns' ? 'Configure columns…' : 'Configure lanes…',
            icon: <SlidersHorizontal />,
            onSelect: () => latest.current.onConfigure(axis === 'columns' ? 'columns' : 'lanes'),
          },
        ];
      },
      toggleSelected: (task, on) => latest.current.onToggleSelected(task, on),
      configure: (section) => latest.current.onConfigure(section),
    };
  }, []);

  const display = useMemo<BoardDisplay>(
    () => ({
      editable,
      fields: config.card.fields,
      density: config.card.density,
      colorBy: config.card.colorBy,
      manualSort: config.sort.field === 'manual',
      selectMode: selection.active,
    }),
    [editable, config.card.fields, config.card.density, config.card.colorBy, config.sort.field, selection.active],
  );

  return (
    <ApiContext.Provider value={api}>
      <DisplayContext.Provider value={display}>
        <SelectionContext.Provider value={selection}>{children}</SelectionContext.Provider>
      </DisplayContext.Provider>
    </ApiContext.Provider>
  );
}
