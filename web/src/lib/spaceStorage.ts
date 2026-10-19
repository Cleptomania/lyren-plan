// Browser storage that names a space's ids (design §12.6): each space has its own keys,
// lyren.s.<spaceId>.<name>, since every space numbers its projects, boards and tasks from 1. Device
// preferences stay global (lyren.theme, lyren.sidebar.*, lyren.board.listOnPhone,
// lyren.project.showDescription, lyren.trayHint.dismissed, lyren.chunkReloadAt), and so does
// lyren.lastSpace (app/space.ts).
//
// The client before spaces kept the id-bearing keys unprefixed. The first time the space the upgrade
// made of the old data is opened (AuthStatusDTO.legacySpaceId, named only to its members; the ids are
// still valid there, §3.8) and lyren.legacyKeysMoved is unset, they are renamed into that space's
// namespace and the flag is set, whatever other spaces the account has. No other space ever gets them.
//
// Unsent drafts (sessionStorage) belong to the account signed in in the tab (lyren.draftsAccount):
// signing out drops them, and another account signing in in the tab never sees them.

export const LEGACY_KEYS_MOVED = 'lyren.legacyKeysMoved';
/** sessionStorage: the account whose unsent drafts the tab holds (the drafts' keys name no account). */
export const DRAFTS_ACCOUNT = 'lyren.draftsAccount';

/** A space's key for `name` ('palette.recent', 'draft.comment.12', …). */
export function spaceKey(spaceId: string, name: string): string {
  return `lyren.s.${spaceId}.${name}`;
}

/** The id-bearing keys of the client before spaces: localStorage… */
const LEGACY_LOCAL = /^lyren\.(palette\.recent|lastProjectId|projectBoard\.\d+|overview\.\d+)$/;
/** …and the unsent drafts in sessionStorage. */
const LEGACY_SESSION = /^lyren\.(createTaskDraft|draft\.(?:comment|worklog)\.\d+)$/;
/** Every unsent draft: a space's, or one of the client before spaces. */
const DRAFT_KEY = /^lyren\.(?:s\.[0-9a-z]{16}\.)?(?:createTaskDraft|draft\.(?:comment|worklog)\.\d+)$/;

function keysOf(storage: Storage): string[] {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key !== null) keys.push(key);
  }
  return keys;
}

function moveInto(storage: Storage, pattern: RegExp, spaceId: string): number {
  let moved = 0;
  for (const key of keysOf(storage)) {
    const m = pattern.exec(key);
    if (!m) continue;
    const value = storage.getItem(key);
    const target = spaceKey(spaceId, m[1]!);
    // What the space already has wins.
    if (value !== null && storage.getItem(target) === null) {
      storage.setItem(target, value);
      moved++;
    }
    storage.removeItem(key);
  }
  return moved;
}

function browserStorage(kind: 'localStorage' | 'sessionStorage'): Storage | null {
  try {
    return window[kind];
  } catch {
    return null;
  }
}

/**
 * The one-time move, run as a space is entered (before its pages read their keys). `legacySpaceId`:
 * the auth status's, null when there was no upgrade or the account is no member of that space.
 * Returns how many keys were moved; storage that fails is left as it is.
 */
export function moveLegacyKeys(
  spaceId: string,
  legacySpaceId: string | null,
  storage: { local: Storage | null; session: Storage | null } = { local: browserStorage('localStorage'), session: browserStorage('sessionStorage') },
): number {
  if (spaceId !== legacySpaceId) return 0;
  const { local, session } = storage;
  try {
    if (!local || local.getItem(LEGACY_KEYS_MOVED) !== null) return 0;
    let moved = moveInto(local, LEGACY_LOCAL, spaceId);
    if (session) moved += moveInto(session, LEGACY_SESSION, spaceId);
    local.setItem(LEGACY_KEYS_MOVED, '1');
    return moved;
  } catch {
    return 0;
  }
}

// ---- Unsent drafts and the account (sessionStorage) ----------------------------------------------

/** Drop every unsent draft of the tab: the account signed out, and the next one must not get them. */
export function forgetDrafts(session: Storage | null = browserStorage('sessionStorage')): void {
  try {
    if (!session) return;
    for (const key of keysOf(session)) if (DRAFT_KEY.test(key)) session.removeItem(key);
    session.removeItem(DRAFTS_ACCOUNT);
  } catch {
    // Storage unavailable: there are no drafts either.
  }
}

/**
 * The tab's drafts are `accountId`'s from now on; another account's are dropped first. `signedIn`: the
 * account has just signed in (or set up), so drafts no account claimed yet are dropped too: the client
 * before spaces and the first version with spaces wrote them without one, and the session that wrote
 * them has ended. An account still signed in from before keeps them (a tab open across the upgrade).
 */
export function claimDrafts(accountId: number, o: { signedIn?: boolean } = {}, session: Storage | null = browserStorage('sessionStorage')): void {
  try {
    if (!session) return;
    const owner = session.getItem(DRAFTS_ACCOUNT);
    if (owner === String(accountId)) return;
    if (owner !== null || o.signedIn) forgetDrafts(session);
    session.setItem(DRAFTS_ACCOUNT, String(accountId));
  } catch {
    // Storage unavailable: drafts are a convenience only.
  }
}
