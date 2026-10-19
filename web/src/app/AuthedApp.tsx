// Gate for every signed-in route: checks the session, then renders the routes (a space's pages in
// SpaceLayout, the account, spaces and admin pages in DirectoryLayout), the toasts, the re-auth dialog
// (§12.8) and the security notices (§12.7). Nothing of a space is asked for before the auth status names
// an account (Appendix D 48), so a fresh instance goes to /setup without a refused request.

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { useAuthStatus } from '../api/auth';
import { onUnauthorized } from '../api/client';
import { qk } from '../api/keys';
import { forgetLostSpaces } from '../api/spaces';
import { FullPageError, FullPageSpinner } from '../components/layout/FullPage';
import { Toaster } from '../components/ui/Toast';
import { NoticesBanner } from '../features/account/NoticesBanner';
import { ReauthHost } from '../features/account/ReauthDialog';
import { claimDrafts } from '../lib/spaceStorage';
import { safeRedirectPath } from './redirect';

export function AuthedApp() {
  const qc = useQueryClient();
  const location = useLocation();
  const auth = useAuthStatus();

  // Any 401 from the API means the session ended: re-check auth status (redirects to /login).
  useEffect(() => onUnauthorized(() => void qc.invalidateQueries({ queryKey: qk.authStatus })), [qc]);

  // A space the account no longer has (it left, was removed, the space was deleted): forget its data.
  const spaceIds = auth.data?.user ? auth.data.spaces.map((s) => s.id).join(' ') : null;
  useEffect(() => {
    if (spaceIds !== null) forgetLostSpaces(qc, spaceIds ? spaceIds.split(' ') : []);
  }, [qc, spaceIds]);

  // Before any page reads a draft: those another account left in this tab are dropped (it signed in
  // in another tab of the same browser meanwhile, sharing the cookie).
  const userId = auth.data?.user?.id;
  const claimedFor = useRef<number | null>(null);
  if (userId !== undefined && claimedFor.current !== userId) {
    claimedFor.current = userId;
    claimDrafts(userId);
  }

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

  return (
    <>
      <Outlet />
      <Toaster />
      <ReauthHost />
      <NoticesBanner />
    </>
  );
}
