// Pure navigation helpers for the app shell (unit-tested). They read full pathnames, whose space
// pages are under /s/<spaceId>/ (app/space.ts).

import { matchPath } from 'react-router';
import type { SpaceRole } from '@shared/roles';
import type { TaskCreateInput } from '@shared/schemas';
import type { SpaceSummaryDTO, TaskDTO } from '@shared/types';
import type { TaskKey } from '../../api/tasks';
import { spaceLink, spaceOfPath } from '../../app/space';

/** The drawer's search param (lib/taskLinks TASK_PARAM; repeated so this module stays pure). */
const TASK_PARAM = 'task';

/** The prefix of route patterns inside a space. */
export const IN_SPACE = '/s/:spaceId';

export interface CreateDefaultsLookups {
  projectById: ReadonlyMap<number, { id: number }>;
  epicById: ReadonlyMap<number, { projectId: number }>;
  boardById: ReadonlyMap<number, { projectId: number | null; config: { filter: { projectIds?: number[] } } }>;
  /**
   * A loaded copy of the task the URL shows (the React Query cache: api/tasks
   * findCachedTaskByKey). Undefined, or no function, when it has not loaded.
   */
  findTask?: (key: TaskKey) => Pick<TaskDTO, 'projectId' | 'epicId'> | undefined;
}

/** The part of a location the prefill depends on. */
export interface ShellLocation {
  pathname: string;
  /** Query string with or without the leading '?' (default ''). */
  search?: string;
}

/** A positive integer id written in digits only ('12'; not '1e3' or ' 12'), else null. */
function id(param: string | null | undefined): number | null {
  if (!param || !/^\d+$/.test(param)) return null;
  const n = Number(param);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * The task on screen: the one open in the drawer (`?task=<id>`, on top of any page), else the
 * one of a /tasks/:key page (a numeric id, or a ref such as 'WEB-12', upper-cased).
 */
export function taskKeyForLocation({ pathname, search = '' }: ShellLocation): TaskKey | null {
  const drawer = id(new URLSearchParams(search).get(TASK_PARAM));
  if (drawer !== null) return { id: drawer };
  const page = matchPath(`${IN_SPACE}/tasks/:taskKey`, pathname)?.params.taskKey;
  if (!page) return null;
  const pageId = id(page);
  return pageId !== null ? { id: pageId } : { ref: page.toUpperCase() };
}

/** The project of a task and its epic (when the epic belongs to that project). */
function taskDefaults(task: Pick<TaskDTO, 'projectId' | 'epicId'>, lookups: CreateDefaultsLookups): Partial<TaskCreateInput> | null {
  if (!lookups.projectById.has(task.projectId)) return null;
  const epicId = task.epicId;
  return epicId !== null && lookups.epicById.get(epicId)?.projectId === task.projectId
    ? { projectId: task.projectId, epicId }
    : { projectId: task.projectId };
}

/**
 * Prefill for "New task" from what is on screen: the task open in the drawer or on its page
 * (its project and epic, once loaded), else the project (and epic) being viewed, or a board's
 * project (a project board, or a global board filtered to exactly one project). A drawer task
 * that has not loaded yet falls back to the page underneath it.
 */
export function createTaskDefaults(location: ShellLocation, lookups: CreateDefaultsLookups): Partial<TaskCreateInput> {
  const taskKey = taskKeyForLocation(location);
  const task = taskKey && lookups.findTask?.(taskKey);
  const fromTask = task ? taskDefaults(task, lookups) : null;
  if (fromTask) return fromTask;

  const { pathname } = location;
  const epic = matchPath(`${IN_SPACE}/projects/:projectId/epics/:epicId`, pathname);
  if (epic) {
    const projectId = id(epic.params.projectId);
    const epicId = id(epic.params.epicId);
    if (projectId && lookups.projectById.has(projectId)) {
      return epicId && lookups.epicById.get(epicId)?.projectId === projectId ? { projectId, epicId } : { projectId };
    }
    return {};
  }
  const project = matchPath({ path: `${IN_SPACE}/projects/:projectId`, end: false }, pathname);
  if (project) {
    const projectId = id(project.params.projectId);
    return projectId && lookups.projectById.has(projectId) ? { projectId } : {};
  }
  const board = matchPath(`${IN_SPACE}/boards/:boardId`, pathname);
  if (board) {
    const b = lookups.boardById.get(id(board.params.boardId) ?? -1);
    if (!b) return {};
    const projectId = b.projectId ?? (b.config.filter.projectIds?.length === 1 ? b.config.filter.projectIds[0]! : null);
    return projectId && lookups.projectById.has(projectId) ? { projectId } : {};
  }
  return {};
}

export type MobileTab = 'home' | 'projects' | 'boards' | 'more';

/** Which bottom-bar tab is "current" for a path (null: none, e.g. a task page or outside a space). */
export function mobileTabForPath(pathname: string): MobileTab | null {
  const inSpace = spaceOfPath(pathname);
  if (!inSpace) return null;
  const first = inSpace.path.split('/')[1] ?? '';
  switch (first) {
    case '':
    case 'dashboard':
      return 'home';
    case 'projects':
      return 'projects';
    case 'boards':
      return 'boards';
    case 'activity':
    case 'worklog':
    case 'settings':
      return 'more';
    default:
      return null;
  }
}

// ---- The space switcher (design §12.9) ---------------------------------------------------------

/** Where switching to a space leads: its home, which opens the account's home page there. */
export function switchSpacePath(spaceId: string): string {
  return spaceLink(spaceId, '/');
}

export interface SpaceChoice {
  id: string;
  name: string;
  role: SpaceRole;
  /** The space being viewed (a check mark). */
  current: boolean;
}

/**
 * The switcher's list (desktop menu, the phone sheet, the palette's "Switch space…"): the account's
 * spaces in the auth status's order, the current one marked. A space still being imported cannot be
 * opened yet and is left out (/spaces shows it).
 */
export function spaceChoices(spaces: readonly Pick<SpaceSummaryDTO, 'id' | 'name' | 'role' | 'status'>[], currentId: string | null): SpaceChoice[] {
  return spaces.filter((s) => s.status === 'active').map((s) => ({ id: s.id, name: s.name, role: s.role, current: s.id === currentId }));
}
