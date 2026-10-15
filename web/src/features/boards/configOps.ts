// Immutable BoardConfig edits used by the board (group headers) and the config panel.
// Pure; unit-tested in configOps.test.ts.

import {
  activePrefs,
  OTHER_GROUP_KEY,
  updateActivePrefs,
  type BoardConfig,
  type ColumnGroupField,
  type CustomColumn,
  type SwimlaneGroupField,
} from '@shared/board';
import { toggleKey } from './grouping';

export type AxisName = 'columns' | 'swimlanes';

/** Fields that can't be swimlanes together with `columns` (same field, or status × category). */
export function clashesWithColumns(columns: ColumnGroupField, lane: SwimlaneGroupField): boolean {
  if (lane === 'none') return false;
  if (lane === columns) return lane !== 'custom';
  return (columns === 'status' && lane === 'statusCategory') || (columns === 'statusCategory' && lane === 'status');
}

export function setColumnsGroupBy(cfg: BoardConfig, groupBy: ColumnGroupField): BoardConfig {
  const lanes = clashesWithColumns(groupBy, cfg.swimlanes.groupBy) ? { ...cfg.swimlanes, groupBy: 'none' as const } : cfg.swimlanes;
  return { ...cfg, columns: { ...cfg.columns, groupBy }, swimlanes: lanes };
}

export function setLanesGroupBy(cfg: BoardConfig, groupBy: SwimlaneGroupField): BoardConfig {
  if (clashesWithColumns(cfg.columns.groupBy, groupBy)) return cfg;
  return { ...cfg, swimlanes: { ...cfg.swimlanes, groupBy } };
}

export function setGroupCollapsed(cfg: BoardConfig, axis: AxisName, key: string, collapsed: boolean): BoardConfig {
  return updateActivePrefs(cfg, axis, { collapsed: toggleKey(activePrefs(cfg[axis]).collapsed, key, collapsed) });
}

export function setGroupHidden(cfg: BoardConfig, axis: AxisName, key: string, hidden: boolean): BoardConfig {
  return updateActivePrefs(cfg, axis, { hidden: toggleKey(activePrefs(cfg[axis]).hidden, key, hidden) });
}

/** Largest WIP limit the field accepts (the config schema allows any safe positive integer). */
export const WIP_LIMIT_MAX = 9999;

/**
 * WIP limit field text → limit: blank = no limit (null), an integer 1…WIP_LIMIT_MAX, else
 * undefined (invalid: the field reverts instead of sending a config the API refuses).
 */
export function parseWipLimit(text: string): number | null | undefined {
  const t = text.trim();
  if (t === '') return null;
  if (!/^\d+$/.test(t)) return undefined;
  const n = Number(t);
  return Number.isSafeInteger(n) && n > 0 && n <= WIP_LIMIT_MAX ? n : undefined;
}

/** Soft WIP limit of a column (null / non-positive removes it). */
export function setWipLimit(cfg: BoardConfig, key: string, limit: number | null): BoardConfig {
  const wipLimits = { ...activePrefs(cfg.columns).wipLimits };
  if (limit === null || !Number.isSafeInteger(limit) || limit <= 0) delete wipLimits[key];
  else wipLimits[key] = limit;
  return updateActivePrefs(cfg, 'columns', { wipLimits });
}

/**
 * `key` moved next to its visible neighbour (delta -1 = before the previous visible group,
 * +1 = after the next one) within the full display order `allKeys`.
 */
export function moveAmongVisible(allKeys: readonly string[], visibleKeys: readonly string[], key: string, delta: -1 | 1): string[] {
  const vi = visibleKeys.indexOf(key);
  const neighbour = visibleKeys[vi + delta];
  if (vi < 0 || neighbour === undefined) return [...allKeys];
  const rest = allKeys.filter((k) => k !== key);
  const at = rest.indexOf(neighbour);
  if (at < 0) return [...allKeys];
  rest.splice(delta < 0 ? at : at + 1, 0, key);
  return rest;
}

/**
 * Merge a new display order of `keys` into the saved prefs.order: `keys` take the given order
 * and saved keys missing from it (groups currently out of view, e.g. under a quick filter) keep
 * their place after the key they followed before, so a partial list never discards them.
 */
export function mergeGroupOrder(saved: readonly string[], keys: readonly string[]): string[] {
  const out = [...new Set(keys)];
  const listed = new Set(out);
  let prev: string | null = null;
  for (const k of saved) {
    if (!listed.has(k)) {
      out.splice(prev === null ? 0 : out.indexOf(prev) + 1, 0, k);
      listed.add(k);
    }
    prev = k;
  }
  return out;
}

/**
 * Reorder a group: custom groups reorder the custom array ("Other" stays last); other fields
 * store the full display order in prefs.order.
 */
export function moveGroup(
  cfg: BoardConfig,
  axis: AxisName,
  allKeys: readonly string[],
  visibleKeys: readonly string[],
  key: string,
  delta: -1 | 1,
): BoardConfig {
  const a = cfg[axis];
  if (a.groupBy === 'custom') {
    if (key === OTHER_GROUP_KEY) return cfg;
    const ids = a.custom.map((c) => c.id);
    const visibleIds = visibleKeys.filter((k) => k !== OTHER_GROUP_KEY);
    const order = moveAmongVisible(ids, visibleIds, key, delta);
    return reorderCustom(cfg, axis, order);
  }
  const order = mergeGroupOrder(activePrefs(a).order, moveAmongVisible(allKeys, visibleKeys, key, delta));
  return updateActivePrefs(cfg, axis, { order });
}

/** Display order of a non-custom axis (prefs.order = all keys; saved keys not listed are kept). */
export function setGroupOrder(cfg: BoardConfig, axis: AxisName, keys: readonly string[]): BoardConfig {
  if (cfg[axis].groupBy === 'custom') return reorderCustom(cfg, axis, keys.filter((k) => k !== OTHER_GROUP_KEY));
  return updateActivePrefs(cfg, axis, { order: mergeGroupOrder(activePrefs(cfg[axis]).order, keys) });
}

function reorderCustom(cfg: BoardConfig, axis: AxisName, ids: readonly string[]): BoardConfig {
  const a = cfg[axis];
  const byId = new Map(a.custom.map((c) => [c.id, c]));
  const ordered = ids.map((id) => byId.get(id)).filter((c): c is CustomColumn => !!c);
  const rest = a.custom.filter((c) => !ids.includes(c.id));
  return { ...cfg, [axis]: { ...a, custom: [...ordered, ...rest] } } as BoardConfig;
}

export function updateCustomGroup(cfg: BoardConfig, axis: AxisName, id: string, patch: Partial<CustomColumn>): BoardConfig {
  const a = cfg[axis];
  return { ...cfg, [axis]: { ...a, custom: a.custom.map((c) => (c.id === id ? { ...c, ...patch, id: c.id } : c)) } } as BoardConfig;
}

export function addCustomGroup(cfg: BoardConfig, axis: AxisName, col: CustomColumn): BoardConfig {
  const a = cfg[axis];
  return { ...cfg, [axis]: { ...a, custom: [...a.custom, col] } } as BoardConfig;
}

/** Remove a custom group and its prefs (hidden / collapsed / WIP). */
export function removeCustomGroup(cfg: BoardConfig, axis: AxisName, id: string): BoardConfig {
  const a = cfg[axis];
  const prefs = a.prefs.custom;
  const wipLimits = { ...(prefs?.wipLimits ?? {}) };
  delete wipLimits[id];
  const nextPrefs = prefs
    ? {
        ...a.prefs,
        custom: {
          order: prefs.order.filter((k) => k !== id),
          hidden: prefs.hidden.filter((k) => k !== id),
          collapsed: prefs.collapsed.filter((k) => k !== id),
          wipLimits,
        },
      }
    : a.prefs;
  return { ...cfg, [axis]: { ...a, custom: a.custom.filter((c) => c.id !== id), prefs: nextPrefs } } as BoardConfig;
}
