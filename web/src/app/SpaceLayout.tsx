// /s/:spaceId — the frame of a space's pages (design §12.2, §12.3): provides SpaceContext from the
// auth status's list of the account's spaces, loads the space's bootstrap, then renders the app shell
// with the space's global hosts (task drawer, create dialog, command palette). Keyed by the space, so
// switching spaces starts every page and host afresh. A space the account cannot open (not in its
// list after one more look, or a bootstrap answering 404) shows "Space not found"; one still being
// imported goes to its import (/spaces/import?space=<id>, design §12.10).

import { useQueryClient } from '@tanstack/react-query';
import { Compass, LayoutGrid } from 'lucide-react';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, Outlet, useParams } from 'react-router';
import { isSpaceId } from '@shared/ids';
import { useAuthStatus } from '../api/auth';
import { useBootstrap } from '../api/bootstrap';
import { ApiError } from '../api/client';
import { qk } from '../api/keys';
import { AppShell } from '../components/layout/AppShell';
import { FullPageError, FullPageSpinner, PageSpinner } from '../components/layout/FullPage';
import { ButtonLink } from '../components/ui/Button';
import { EmptyState } from '../components/ui/EmptyState';
import { CommandPalette } from '../features/search/CommandPalette';
import { TaskCreateDialogHost } from '../features/tasks/TaskCreateDialogHost';
import { TaskDrawerHost } from '../features/tasks/TaskDrawerHost';
import { useDocumentTitle } from '../lib/hooks';
import { moveLegacyKeys } from '../lib/spaceStorage';
import { rememberLastSpace, SpaceContext, spaceContextValue, useSpace } from './space';

export function SpaceLayout() {
  const { spaceId = '' } = useParams();
  const qc = useQueryClient();
  const auth = useAuthStatus();
  // AuthedApp renders its routes only once the auth status names an account.
  const spaces = auth.data?.spaces ?? [];
  const summary = spaces.find((s) => s.id === spaceId);
  const importing = summary?.status === 'importing';
  const boot = useBootstrap(spaceId, summary !== undefined && !importing);
  const lost = boot.error instanceof ApiError && boot.error.status === 404 && boot.error.code === 'not_found';

  // Not in the list: the status may be older than the space (just created, just joined). Ask once more.
  const [askedFor, setAskedFor] = useState<string | null>(null);
  const known = summary !== undefined;
  useEffect(() => {
    if (known || askedFor === spaceId || !isSpaceId(spaceId)) return;
    setAskedFor(spaceId);
    void qc.invalidateQueries({ queryKey: qk.authStatus });
  }, [known, askedFor, spaceId, qc]);

  // Removed from the space, or it was deleted: the refreshed list no longer has it, and AuthedApp
  // forgets its data.
  useEffect(() => {
    if (lost) void qc.invalidateQueries({ queryKey: qk.authStatus });
  }, [lost, qc]);

  // The context follows the list; the bootstrap answers with the role and name of this moment, so a
  // difference means the list is out of date.
  const bootSpace = boot.data?.space;
  useEffect(() => {
    if (bootSpace && summary && (bootSpace.role !== summary.role || bootSpace.name !== summary.name)) {
      void qc.invalidateQueries({ queryKey: qk.authStatus });
    }
  }, [bootSpace, summary, qc]);

  const role = summary?.role;
  const name = summary?.name;
  const space = useMemo(() => (role && name !== undefined ? spaceContextValue({ id: spaceId, role, name }) : null), [spaceId, role, name]);

  // Before any page reads its storage: the one-time move of the keys from before spaces (§12.6).
  const prepared = useRef<string | null>(null);
  if (space && prepared.current !== spaceId) {
    prepared.current = spaceId;
    moveLegacyKeys(spaceId, auth.data?.legacySpaceId ?? null);
  }
  const ready = space !== null && boot.data !== undefined;
  useEffect(() => {
    if (ready) rememberLastSpace(spaceId);
  }, [ready, spaceId]);

  if (importing) return <Navigate to={`/spaces/import?space=${spaceId}`} replace />;
  if (!space) {
    const looking = isSpaceId(spaceId) && (askedFor !== spaceId || auth.isFetching);
    return looking ? <FullPageSpinner /> : <SpaceNotFound />;
  }
  if (lost) return <SpaceNotFound />;
  // Pages read bootstrap through useLookups(), which throws without data: never render them
  // without it (e.g. the cache was just cleared by a sign-out that is still redirecting).
  if (!boot.data) {
    if (boot.error) return <FullPageError error={boot.error} onRetry={() => void boot.refetch()} />;
    return <FullPageSpinner />;
  }

  return (
    <SpaceContext.Provider value={space}>
      <SpaceShell key={spaceId} />
    </SpaceContext.Provider>
  );
}

function SpaceShell() {
  // Viewers create nothing (design §12.9): no "New task" dialog, so its 'c' hotkey does nothing either.
  const { write } = useSpace().permissions;
  return (
    <>
      <AppShell>
        <Suspense fallback={<PageSpinner />}>
          <Outlet />
        </Suspense>
      </AppShell>
      <TaskDrawerHost />
      {write && <TaskCreateDialogHost />}
      <CommandPalette />
    </>
  );
}

function SpaceNotFound() {
  useDocumentTitle('Space not found');
  return (
    <div role="alert" className="flex h-full min-h-dvh items-center justify-center bg-bg p-6">
      <EmptyState
        icon={<Compass />}
        title="Space not found"
        body="It may have been deleted, or you are no longer a member of it."
        action={
          <ButtonLink to="/spaces" variant="primary" icon={<LayoutGrid />}>
            All spaces
          </ButtonLink>
        }
      />
    </div>
  );
}
