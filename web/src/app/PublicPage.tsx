// Wrapper for the pages a link opens, which work signed in or out (design §12.2): /signup/complete, /reset,
// /email/confirm, /recover and /invite. Unlike PublicOnly it sends nobody away: a reset link opened in a
// browser signed in to another account, or an invitation for the signed-in account, must still show. It
// asks the server for nothing but the auth status (no request that answers 401 signed out, Appendix D 48).

import { Suspense } from 'react';
import { Outlet } from 'react-router';
import { useAuthStatus } from '../api/auth';
import { FullPageError, FullPageSpinner } from '../components/layout/FullPage';
import { Toaster } from '../components/ui/Toast';

export function PublicPage() {
  const { data, error, refetch, isPending } = useAuthStatus();
  if (isPending) return <FullPageSpinner />;
  if (error && !data) return <FullPageError error={error} onRetry={() => void refetch()} />;
  return (
    <>
      <Suspense fallback={<FullPageSpinner />}>
        <Outlet />
      </Suspense>
      <Toaster />
    </>
  );
}
