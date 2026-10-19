// The space a page belongs to (design §12.3). Every page of a space lives under /s/<spaceId>/…;
// SpaceLayout (app/SpaceLayout.tsx) provides the context from AuthStatusDTO.spaces. Pages build their
// links with useSpacePath() ('/projects/3' → '/s/<id>/projects/3') or spaceLink(id, path) outside
// React; they never write an unprefixed space route (routeLiterals.test.ts keeps it that way).

import { createContext, useCallback, useContext } from 'react';
import { isSpaceId } from '@shared/ids';
import { spacePermissions, type SpacePermissions, type SpaceRole } from '@shared/roles';

export interface SpaceContextValue {
  id: string;
  /** The viewer's role in the space. */
  role: SpaceRole;
  name: string;
  /** What the role may do (shared/src/roles.ts): the server checks the same. */
  permissions: SpacePermissions;
}

export const SpaceContext = createContext<SpaceContextValue | null>(null);

/** The context value of a space (memoize it per id, role and name). */
export function spaceContextValue(space: { id: string; role: SpaceRole; name: string }): SpaceContextValue {
  return { id: space.id, role: space.role, name: space.name, permissions: spacePermissions(space.role) };
}

/** The space of the page. Only inside SpaceLayout (every space page), so it never throws there. */
export function useSpace(): SpaceContextValue {
  const space = useContext(SpaceContext);
  if (!space) throw new Error('useSpace() used outside a space (/s/:spaceId)');
  return space;
}

export function useSpaceId(): string {
  return useSpace().id;
}

/** The space of the page, or null on the pages outside a space (/spaces, /settings, /admin). */
export function useOptionalSpace(): SpaceContextValue | null {
  return useContext(SpaceContext);
}

/** `path` (an in-app path inside the space: '/projects/3?task=1') under the space's prefix. */
export function spaceLink(spaceId: string, path: string): string {
  return `/s/${spaceId}${path}`;
}

/** spaceLink bound to the page's space. */
export function useSpacePath(): (path: string) => string {
  const id = useSpaceId();
  return useCallback((path: string) => spaceLink(id, path), [id]);
}

/**
 * The space a pathname belongs to and the path inside it ('/s/<id>/tasks/1' → { spaceId, path:
 * '/tasks/1' }; '/s/<id>' and '/s/<id>/' → path '/'), or null outside a space.
 */
export function spaceOfPath(pathname: string): { spaceId: string; path: string } | null {
  const m = /^\/s\/([^/]+)(\/.*)?$/.exec(pathname);
  if (!m || !isSpaceId(m[1])) return null;
  return { spaceId: m[1]!, path: m[2] ?? '/' };
}

// ---- The last space used on this device (localStorage, design §12.6) --------------------------

export const LAST_SPACE_KEY = 'lyren.lastSpace';

function local(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The space last entered on this device, when the stored value is a space id. */
export function readLastSpace(storage: Storage | null = local()): string | null {
  try {
    const value = storage?.getItem(LAST_SPACE_KEY) ?? null;
    return isSpaceId(value) ? value : null;
  } catch {
    return null;
  }
}

export function rememberLastSpace(spaceId: string, storage: Storage | null = local()): void {
  try {
    if (storage?.getItem(LAST_SPACE_KEY) !== spaceId) storage?.setItem(LAST_SPACE_KEY, spaceId);
  } catch {
    /* storage unavailable */
  }
}
