// Where '/' and the old unprefixed space links lead (design §12.2). Pure, so the targets and the
// open-redirect cases are unit-tested (legacyRedirect.test.ts). Old bookmarks and links pasted into
// descriptions and comments (/tasks/WEB-12, /projects/3/board?task=17, /settings/tags) keep their path,
// search and hash under /s/<space>/, where <space> is the upgraded install's space when the account is a
// member there (AuthStatusDTO.legacySpaceId), else the last space used, else the first one.

import { isSpaceId } from '@shared/ids';
import type { AuthStatusDTO } from '@shared/types';
import { spaceLink } from './space';

type Spaces = Pick<AuthStatusDTO, 'spaces'>;

/** The space-route paths of the client before spaces (1.x): what LegacySpaceRedirect is mounted at. */
export const LEGACY_SPACE_ROUTES = [
  'dashboard',
  'projects/*',
  'boards/*',
  'tasks/*',
  'activity',
  'worklog',
  'settings/statuses',
  'settings/tags',
  'settings/data',
] as const;

const LEGACY_PATH = /^\/(?:(?:dashboard|activity|worklog)\/?|(?:projects|boards|tasks)(?:\/.*)?|settings\/(?:statuses|tags|data)\/?)$/;

/** A space that opens: one still being imported does not until its import is done (§8.4). */
const opens = (s: Spaces['spaces'][number]) => s.status !== 'importing';

function has(status: Spaces, id: string | null | undefined): id is string {
  return isSpaceId(id) && status.spaces.some((s) => s.id === id && opens(s));
}

/** '/' → the last space used while the account still has it, else its first space; null: none. */
export function homeSpace(status: Spaces, lastSpace: string | null): string | null {
  if (has(status, lastSpace)) return lastSpace;
  return status.spaces.find(opens)?.id ?? null;
}

/** What '/' shows: the home space's home, or /spaces when the account has no space. */
export function homePath(status: Spaces, lastSpace: string | null): string {
  const id = homeSpace(status, lastSpace);
  return id === null ? '/spaces' : spaceLink(id, '/');
}

/** The space old links go to: the upgraded install's space for its members, else homeSpace(). */
export function legacySpace(status: Pick<AuthStatusDTO, 'spaces' | 'legacySpaceId'>, lastSpace: string | null): string | null {
  if (has(status, status.legacySpaceId)) return status.legacySpaceId;
  return homeSpace(status, lastSpace);
}

/**
 * The new place of an old link: the same path, search and hash under /s/<target>/ (/settings/statuses →
 * /s/<target>/settings/statuses), /s/<target>/ for a path that was no space route, /spaces without a
 * target. Always a same-origin path under the space: a crafted path (//host, /\host, encoded or dotted
 * segments that would climb out of /s/<target>/) can never lead anywhere else.
 */
export function legacyRedirectPath(
  location: { pathname: string; search: string; hash: string },
  target: string | null,
  origin: string = window.location.origin,
): string {
  if (!isSpaceId(target)) return '/spaces';
  const home = spaceLink(target, '/');
  if (!LEGACY_PATH.test(location.pathname)) return home;
  let url: URL;
  try {
    url = new URL(spaceLink(target, location.pathname) + location.search + location.hash, origin);
  } catch {
    return home;
  }
  if (url.origin !== origin || !url.pathname.startsWith(home)) return home;
  return url.pathname + url.search + url.hash;
}
