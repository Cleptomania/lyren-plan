// Pure helpers for the project hierarchy (milestones → epics) and manual ordering.

import type { EpicStatus, MilestoneStatus } from '@shared/constants';
import { addDays, type ISODate } from '@shared/dates';
import type { EpicDTO, MilestoneDTO } from '@shared/types';

export interface MilestoneSection {
  milestone: MilestoneDTO;
  /** The milestone's epics in position order. */
  epics: EpicDTO[];
}

export interface Hierarchy {
  /** Milestones in position order with their epics. */
  sections: MilestoneSection[];
  /** Epics without a milestone (or whose milestone is unknown), in position order. */
  loose: EpicDTO[];
}

const byPosition = <T extends { position: number; id: number }>(a: T, b: T) => a.position - b.position || a.id - b.id;

/** Group one project's epics under its milestones (inputs in any order). */
export function buildHierarchy(milestones: readonly MilestoneDTO[], epics: readonly EpicDTO[]): Hierarchy {
  const sortedMilestones = [...milestones].sort(byPosition);
  const sortedEpics = [...epics].sort(byPosition);
  const known = new Set(sortedMilestones.map((m) => m.id));
  return {
    sections: sortedMilestones.map((milestone) => ({
      milestone,
      epics: sortedEpics.filter((e) => e.milestoneId === milestone.id),
    })),
    loose: sortedEpics.filter((e) => e.milestoneId === null || !known.has(e.milestoneId)),
  };
}

export const isMilestoneClosed = (status: MilestoneStatus) => status === 'completed' || status === 'cancelled';
export const isEpicClosed = (status: EpicStatus) => status === 'done' || status === 'cancelled';

/** True when a not-yet-closed milestone/epic is past its due date. */
export function isOverdue(dueDate: ISODate | null, closed: boolean, today: ISODate): boolean {
  return !closed && dueDate !== null && dueDate < today;
}

/** True when an open milestone/epic is due within the next `days` days (today included). */
export function isDueSoon(dueDate: ISODate | null, closed: boolean, today: ISODate, days = 7): boolean {
  return !closed && dueDate !== null && dueDate >= today && dueDate <= addDays(today, days - 1);
}

/** The milestone to show as "next": the first open one by position. */
export function nextMilestone(milestones: readonly MilestoneDTO[]): MilestoneDTO | undefined {
  return [...milestones].sort(byPosition).find((m) => !isMilestoneClosed(m.status));
}

/**
 * Reorder inside a visible subset of a scope and return the new order of the FULL scope
 * (reorder endpoints need every id). The visible items keep the slots they occupy in the
 * full list and are re-filled in their new order, so hidden items never move.
 * Returns null when nothing changes (unknown ids, or dropped onto itself).
 */
export function reorderSubset(
  full: readonly number[],
  visible: readonly number[],
  activeId: number,
  overId: number,
): number[] | null {
  const from = visible.indexOf(activeId);
  const to = visible.indexOf(overId);
  if (from < 0 || to < 0 || from === to) return null;
  const moved = [...visible];
  moved.splice(from, 1);
  moved.splice(to, 0, activeId);
  const inSubset = new Set(visible);
  let next = 0;
  return full.map((id) => (inSubset.has(id) ? moved[next++]! : id));
}

/** Move one item up (-1) or down (+1) within the visible subset; null at either end. */
export function moveWithinSubset(
  full: readonly number[],
  visible: readonly number[],
  id: number,
  delta: -1 | 1,
): number[] | null {
  const index = visible.indexOf(id);
  const target = visible[index + delta];
  if (index < 0 || target === undefined) return null;
  return reorderSubset(full, visible, id, target);
}
