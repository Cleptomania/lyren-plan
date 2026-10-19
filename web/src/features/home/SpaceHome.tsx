// A space's own page (/s/:spaceId/) sends the user to their chosen home page (Account settings → Preferences):
// the space's default board, or its dashboard.

import { Navigate } from 'react-router';
import { useLookups } from '../../api/bootstrap';
import { spaceLink, useSpaceId } from '../../app/space';
import { boardUrl } from '../../lib/taskLinks';

export default function SpaceHome() {
  const sid = useSpaceId();
  const { settings, boardById } = useLookups();
  if (settings.homePage === 'default_board' && settings.defaultBoardId && boardById.has(settings.defaultBoardId)) {
    return <Navigate to={boardUrl(sid, settings.defaultBoardId)} replace />;
  }
  return <Navigate to={spaceLink(sid, '/dashboard')} replace />;
}
