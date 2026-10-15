// Small browser helpers shared by the task screens: copying links, the per-device
// "last used project" preference, and unsent create-task drafts.

import { taskPageUrl } from '../../lib/taskLinks';

/** Absolute link to a task's full page (uses the ref, which is stable until a project move). */
export function taskLink(task: { id: number; ref: string }): string {
  return `${window.location.origin}${taskPageUrl(task)}`;
}

/**
 * Copy text to the clipboard. The async Clipboard API only exists in secure contexts, and
 * self-hosted instances are often plain HTTP on a LAN, so fall back to execCommand.
 */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  document.body.appendChild(area);
  area.select();
  try {
    if (!document.execCommand('copy')) throw new Error('Copy is not supported in this browser');
  } finally {
    area.remove();
    active?.focus({ preventScroll: true });
  }
}

const LAST_PROJECT_KEY = 'lyren.lastProjectId';

/** Project of the last task created on this device (a per-device preference). */
export function readLastProjectId(): number | null {
  try {
    const v = Number(localStorage.getItem(LAST_PROJECT_KEY));
    return Number.isInteger(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

export function writeLastProjectId(id: number): void {
  try {
    localStorage.setItem(LAST_PROJECT_KEY, String(id));
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
