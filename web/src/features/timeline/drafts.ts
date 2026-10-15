// Unsent drafts (comment composer, work-log form) kept per task in sessionStorage
// (SPEC §9: survives closing the drawer or a reload, never leaves the tab).

const PREFIX = 'lyren.draft.';

export type DraftKind = 'comment' | 'worklog';

function key(kind: DraftKind, taskId: number): string {
  return `${PREFIX}${kind}.${taskId}`;
}

export function readDraft(kind: DraftKind, taskId: number): string | null {
  try {
    return window.sessionStorage.getItem(key(kind, taskId));
  } catch {
    return null;
  }
}

/** Store a draft; empty/blank values remove it. */
export function writeDraft(kind: DraftKind, taskId: number, value: string): void {
  try {
    if (value.trim() === '') window.sessionStorage.removeItem(key(kind, taskId));
    else window.sessionStorage.setItem(key(kind, taskId), value);
  } catch {
    // Storage full or disabled (private mode): drafts are a convenience only.
  }
}

export function clearDraft(kind: DraftKind, taskId: number): void {
  try {
    window.sessionStorage.removeItem(key(kind, taskId));
  } catch {
    // ignore
  }
}

/** JSON drafts (work-log form fields). Malformed values read as null. */
export function readJsonDraft<T extends object>(kind: DraftKind, taskId: number, isValid: (v: unknown) => v is T): T | null {
  const raw = readDraft(kind, taskId);
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return isValid(value) ? value : null;
  } catch {
    return null;
  }
}
