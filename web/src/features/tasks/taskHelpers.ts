// Small browser helpers shared by the task screens: task links, the per-device "last used project"
// preference, and unsent create-task drafts. Copying is lib/clipboard.ts.

import { spaceKey } from '../../lib/spaceStorage';
import { taskPageUrl } from '../../lib/taskLinks';

/** Absolute link to a task's full page in its space (uses the ref, which is stable until a project move). */
export function taskLink(spaceId: string, task: { id: number; ref: string }): string {
  return `${window.location.origin}${taskPageUrl(spaceId, task)}`;
}

const lastProjectKey = (spaceId: string) => spaceKey(spaceId, 'lastProjectId');

/** Project of the last task created in the space on this device (a per-device preference). */
export function readLastProjectId(spaceId: string): number | null {
  try {
    const v = Number(localStorage.getItem(lastProjectKey(spaceId)));
    return Number.isInteger(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

export function writeLastProjectId(spaceId: string, id: number): void {
  try {
    localStorage.setItem(lastProjectKey(spaceId), String(id));
  } catch {
    /* storage unavailable */
  }
}

/** sessionStorage helpers for JSON drafts; failures (private mode, quota) are ignored. */
export function readSessionJson(key: string): unknown {
  try {
    const raw = sessionStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

export function writeSessionJson(key: string, value: unknown): void {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}
