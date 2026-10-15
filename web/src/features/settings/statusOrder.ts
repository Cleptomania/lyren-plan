// Status ordering for Settings → Statuses. The page shows statuses grouped by category
// (STATUS_CATEGORIES order), each group by position. Reordering only happens within a group,
// and every reorder sends the full display order, so the stored order (which drives board
// columns) always matches what the page shows.

import { STATUS_CATEGORIES, type StatusCategory } from '@shared/constants';
import type { StatusDTO } from '@shared/types';

export interface StatusGroup {
  category: StatusCategory;
  statuses: StatusDTO[];
}

const byPosition = (a: StatusDTO, b: StatusDTO) => a.position - b.position || a.id - b.id;

/** All five categories (empty ones included), each with its statuses by position. */
export function groupStatuses(statuses: readonly StatusDTO[]): StatusGroup[] {
  return STATUS_CATEGORIES.map((category) => ({
    category,
    statuses: statuses.filter((s) => s.category === category).sort(byPosition),
  }));
}

/** Ids in display order (groups in category order). */
export function displayOrder(statuses: readonly StatusDTO[]): number[] {
  return groupStatuses(statuses).flatMap((g) => g.statuses.map((s) => s.id));
}

/** Ids in stored order (position, id). */
export function storedOrder(statuses: readonly StatusDTO[]): number[] {
  return [...statuses].sort(byPosition).map((s) => s.id);
}

function sameOrder(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/** True when the stored order differs from the grouped display order (a reorder would fix it). */
export function needsNormalizing(statuses: readonly StatusDTO[]): boolean {
  return !sameOrder(displayOrder(statuses), storedOrder(statuses));
}

/**
 * Full display order after moving `activeId` to the index of `overId` inside their (shared)
 * category group. Null when the move is a no-op or crosses groups.
 */
export function orderAfterMove(statuses: readonly StatusDTO[], activeId: number, overId: number): number[] | null {
  if (activeId === overId) return null;
  const groups = groupStatuses(statuses);
  const group = groups.find((g) => g.statuses.some((s) => s.id === activeId));
  if (!group || !group.statuses.some((s) => s.id === overId)) return null;
  const ids = group.statuses.map((s) => s.id);
  const from = ids.indexOf(activeId);
  const to = ids.indexOf(overId);
  ids.splice(to, 0, ...ids.splice(from, 1));
  return groups.flatMap((g) => (g === group ? ids : g.statuses.map((s) => s.id)));
}

/** Full display order after moving a status one step up (-1) or down (+1) within its group. */
export function orderAfterStep(statuses: readonly StatusDTO[], id: number, delta: -1 | 1): number[] | null {
  const group = groupStatuses(statuses).find((g) => g.statuses.some((s) => s.id === id));
  if (!group) return null;
  const index = group.statuses.findIndex((s) => s.id === id);
  const neighbour = group.statuses[index + delta];
  return neighbour ? orderAfterMove(statuses, id, neighbour.id) : null;
}

/** Copy of `statuses` with positions set from `ids` (for optimistic updates). */
export function withPositions(statuses: readonly StatusDTO[], ids: readonly number[]): StatusDTO[] {
  const index = new Map(ids.map((id, i) => [id, i]));
  return statuses.map((s) => ({ ...s, position: index.get(s.id) ?? s.position }));
}

/** The most sensible place to move tasks of a deleted status: a sibling, else an open status. */
export function suggestedReassignTarget(statuses: readonly StatusDTO[], deletingId: number): StatusDTO | undefined {
  const deleting = statuses.find((s) => s.id === deletingId);
  const others = [...statuses].filter((s) => s.id !== deletingId).sort(byPosition);
  return (
    others.find((s) => s.category === deleting?.category) ??
    others.find((s) => s.category === 'unstarted') ??
    others[0]
  );
}
