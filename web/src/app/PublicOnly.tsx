// Wrapper for /login, /setup, /signup and /forgot: redirects to the app when already signed in, and
// between login/setup depending on whether first-run setup is needed. The pages a link opens, which
// work signed in too, are PublicPage's.

import { Suspense } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { useAuthStatus } from '../api/auth';
import { FullPageError, FullPageSpinner } from '../components/layout/FullPage';
import { safeRedirectPath } from './redirect';

export function PublicOnly() {
  const { data, error, refetch, isPending } = useAuthStatus();
  const location = useLocation();
  if (isPending) return <FullPageSpinner />;
  if (error && !data) return <FullPageError error={error} onRetry={() => void refetch()} />;
  if (data.user) {
    const from = (location.state as { from?: unknown } | null)?.from;
    return <Navigate to={safeRedirectPath(from)} replace />;
  }
  if (data.setupRequired && location.pathname !== '/setup') return <Navigate to="/setup" replace />;
  if (!data.setupRequired && location.pathname === '/setup') return <Navigate to="/login" replace />;
  return (
    <Suspense fallback={<FullPageSpinner />}>
      <Outlet />
    </Suspense>
  );
}
