// Gate + shell for every signed-in route: checks the session, loads bootstrap,
// then renders the app shell with global hosts (task drawer, create dialog,
// command palette, toasts).

import { useQueryClient } from '@tanstack/react-query';
import { Suspense, useEffect } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { useAuthStatus } from '../api/auth';
import { useBootstrap } from '../api/bootstrap';
import { onUnauthorized } from '../api/client';
import { qk } from '../api/keys';
import { AppShell } from '../components/layout/AppShell';
import { FullPageError, FullPageSpinner, PageSpinner } from '../components/layout/FullPage';
import { Toaster } from '../components/ui/Toast';
import { CommandPalette } from '../features/search/CommandPalette';
import { TaskCreateDialogHost } from '../features/tasks/TaskCreateDialogHost';
import { TaskDrawerHost } from '../features/tasks/TaskDrawerHost';
import { safeRedirectPath } from './redirect';

export function AuthedApp() {
  const qc = useQueryClient();
  const location = useLocation();
  const auth = useAuthStatus();
  const signedIn = !!auth.data?.user;
  // Start bootstrap in parallel with the auth check (a 401 while signed out is harmless).
  const boot = useBootstrap(auth.isPending || signedIn);

  // Any 401 from the API means the session ended: re-check auth status (redirects to /login).
  useEffect(() => onUnauthorized(() => void qc.invalidateQueries({ queryKey: qk.authStatus })), [qc]);

  if (auth.isPending) return <FullPageSpinner />;
  if (auth.error && !auth.data) return <FullPageError error={auth.error} onRetry={() => void auth.refetch()} />;
  if (!auth.data.user) {
    return (
      <Navigate
        to={auth.data.setupRequired ? '/setup' : '/login'}
        replace
        state={{ from: safeRedirectPath(location.pathname + location.search + location.hash) }}
      />
    );
  }
  // Pages read bootstrap through useLookups(), which throws without data: never render them
  // without it (e.g. the cache was just cleared by a sign-out that is still redirecting).
  if (!boot.data) {
    if (boot.error) return <FullPageError error={boot.error} onRetry={() => void boot.refetch()} />;
    return <FullPageSpinner />;
  }

  return (
    <>
      <AppShell>
        <Suspense fallback={<PageSpinner />}>
          <Outlet />
        </Suspense>
      </AppShell>
      <TaskDrawerHost />
      <TaskCreateDialogHost />
      <CommandPalette />
      <Toaster />
    </>
  );
}
