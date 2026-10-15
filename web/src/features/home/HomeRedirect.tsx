// "/" sends the user to their chosen home page (Settings → Preferences).

import { Navigate } from 'react-router';
import { useLookups } from '../../api/bootstrap';

export default function HomeRedirect() {
  const { settings, boardById } = useLookups();
  if (settings.homePage === 'default_board' && settings.defaultBoardId && boardById.has(settings.defaultBoardId)) {
    return <Navigate to={`/boards/${settings.defaultBoardId}`} replace />;
  }
  return <Navigate to="/dashboard" replace />;
}
