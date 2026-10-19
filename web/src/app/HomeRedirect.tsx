// '/' and the old unprefixed links (design §12.2), resolved by legacyRedirect.ts: '/' opens the last
// space used (else the first, else /spaces); /dashboard, /projects/…, /tasks/WEB-12, /settings/tags and
// the other paths of the client before spaces open the same page in the upgraded install's space (else
// the last used), with their search and hash.

import { Navigate, useLocation } from 'react-router';
import { useAuthStatus } from '../api/auth';
import { homePath, legacyRedirectPath, legacySpace } from './legacyRedirect';
import { readLastSpace } from './space';

/** Inside AuthedApp, whose auth status names the account. */
export function HomeRedirect() {
  const status = useAuthStatus().data;
  return <Navigate to={status ? homePath(status, readLastSpace()) : '/spaces'} replace />;
}

export function LegacySpaceRedirect() {
  const location = useLocation();
  const status = useAuthStatus().data;
  const target = status ? legacySpace(status, readLastSpace()) : null;
  return <Navigate to={legacyRedirectPath(location, target)} replace state={location.state} />;
}
