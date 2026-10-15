// Pure model of the "New task" dialog: the draft, its defaults (prefill → last used project →
// first active project), validation of a stored (sessionStorage) draft, and the API input.

import { PRIORITY_VALUES, type Priority } from '@shared/constants';
import { isValidISODate } from '@shared/dates';
import type { TaskCreateInput } from '@shared/schemas';
import type { EpicDTO, ProjectDTO } from '@shared/types';

export interface CreateDraft {
  title: string;
  description: string;
  projectId: number | null;
  epicId: number | null;
  statusId: number | null;
  priority: Priority;
  tagIds: number[];
  startDate: string | null;
  dueDate: string | null;
  estimate: number | null;
}

export interface DraftLookups {
  /** By position (archived included). */
  projects: readonly Pick<ProjectDTO, 'id' | 'status'>[];
  epicById: ReadonlyMap<number, Pick<EpicDTO, 'id' | 'projectId'>>;
  /** Default status for new tasks (first 'unstarted'). */
  defaultStatusId: number | null;
}

/** First usable project: the prefill, else the last used one, else the first active project. */
export function defaultProjectId(
  preferred: number | undefined,
  lastUsed: number | null,
  projects: DraftLookups['projects'],
): number | null {
  const usable = (id: number | null | undefined) =>
    id !== null && id !== undefined && projects.some((p) => p.id === id && p.status !== 'archived');
  if (usable(preferred)) return preferred!;
  // An explicit prefill of an archived project is still honoured (e.g. "New task" on its page).
  if (preferred !== undefined && projects.some((p) => p.id === preferred)) return preferred;
  if (usable(lastUsed)) return lastUsed;
  return projects.find((p) => p.status !== 'archived')?.id ?? null;
}

/** A fresh draft for the given prefill. */
export function initialDraft(defaults: Partial<TaskCreateInput>, lookups: DraftLookups, lastUsedProjectId: number | null): CreateDraft {
  const epic = defaults.epicId !== undefined && defaults.epicId !== null ? lookups.epicById.get(defaults.epicId) : undefined;
  const projectId = defaultProjectId(defaults.projectId ?? epic?.projectId, lastUsedProjectId, lookups.projects);
  return {
    title: defaults.title ?? '',
    description: defaults.description ?? '',
    projectId,
    epicId: epic && epic.projectId === projectId ? epic.id : null,
    statusId: defaults.statusId ?? lookups.defaultStatusId,
    priority: defaults.priority ?? 0,
    tagIds: [...new Set(defaults.tagIds ?? [])],
    startDate: defaults.startDate ?? null,
    dueDate: defaults.dueDate ?? null,
    estimate: defaults.estimate ?? null,
  };
}

/** Switch project; the epic is kept only when it belongs to the new project. */
export function withProject(draft: CreateDraft, projectId: number, epicById: DraftLookups['epicById']): CreateDraft {
  const epic = draft.epicId !== null ? epicById.get(draft.epicId) : undefined;
  return { ...draft, projectId, epicId: epic && epic.projectId === projectId ? draft.epicId : null };
}

/** The user typed something worth asking about before it is thrown away. */
export function draftHasContent(draft: Pick<CreateDraft, 'title' | 'description'>): boolean {
  return draft.title.trim() !== '' || draft.description.trim() !== '';
}

/** Draft → POST /tasks body (validate with taskCreateInput). `position` comes from the prefill. */
export function draftToInput(draft: CreateDraft, defaults: Partial<TaskCreateInput>): Partial<TaskCreateInput> {
  const input: Partial<TaskCreateInput> = {
    title: draft.title.replace(/\s*\n\s*/g, ' ').trim(),
    priority: draft.priority,
  };
  if (draft.projectId !== null) input.projectId = draft.projectId;
  if (draft.epicId !== null) input.epicId = draft.epicId;
  if (draft.statusId !== null) input.statusId = draft.statusId;
  const description = draft.description.replace(/\s+$/, '');
  if (description) input.description = description;
  if (draft.tagIds.length > 0) input.tagIds = draft.tagIds;
  if (draft.startDate) input.startDate = draft.startDate;
  if (draft.dueDate) input.dueDate = draft.dueDate;
  if (draft.estimate !== null) input.estimate = draft.estimate;
  if (defaults.position !== undefined) input.position = defaults.position;
  return input;
}

const isId = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;
const isDate = (v: unknown): v is string | null => v === null || isValidISODate(v);

/** A draft read back from sessionStorage, or null when it is missing or malformed. */
export function parseStoredDraft(value: unknown): CreateDraft | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.title !== 'string' || typeof v.description !== 'string') return null;
  if (!(v.projectId === null || isId(v.projectId))) return null;
  if (!(v.epicId === null || isId(v.epicId))) return null;
  if (!(v.statusId === null || isId(v.statusId))) return null;
  if (!PRIORITY_VALUES.includes(v.priority as Priority)) return null;
  if (!Array.isArray(v.tagIds) || !v.tagIds.every(isId)) return null;
  if (!isDate(v.startDate) || !isDate(v.dueDate)) return null;
  if (!(v.estimate === null || (typeof v.estimate === 'number' && Number.isFinite(v.estimate) && v.estimate >= 0))) return null;
  return {
    title: v.title,
    description: v.description,
    projectId: v.projectId,
    epicId: v.epicId,
    statusId: v.statusId,
    priority: v.priority as Priority,
    tagIds: v.tagIds,
    startDate: v.startDate,
    dueDate: v.dueDate,
    estimate: v.estimate,
  };
}

/**
 * Drop references to entities that no longer exist (a restored draft can be hours old):
 * unknown project → the default, unknown epic / status / tags → removed.
 */
export function sanitizeDraft(
  draft: CreateDraft,
  lookups: DraftLookups & { statusIds: ReadonlySet<number>; tagIds: ReadonlySet<number> },
  lastUsedProjectId: number | null,
): CreateDraft {
  const projectExists = draft.projectId !== null && lookups.projects.some((p) => p.id === draft.projectId);
  const projectId = projectExists ? draft.projectId : defaultProjectId(undefined, lastUsedProjectId, lookups.projects);
  const epic = draft.epicId !== null ? lookups.epicById.get(draft.epicId) : undefined;
  return {
    ...draft,
    projectId,
    epicId: epic && epic.projectId === projectId ? epic.id : null,
    statusId: draft.statusId !== null && lookups.statusIds.has(draft.statusId) ? draft.statusId : lookups.defaultStatusId,
    tagIds: draft.tagIds.filter((id) => lookups.tagIds.has(id)),
  };
}
