// The token of the link that opened this page (lib/linkToken.ts). At start it left the address bar before
// the router read it; a link followed inside the app (the router saw its fragment) is taken here the same
// way, before the page asks the server anything with it. The page keeps the token while it is shown, also
// once the link was used (forgetLink), so its last state stays on screen until it moves on.

import { useLayoutEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { heldLinkToken, linkTokenFromHash, takeLinkToken } from '../../lib/linkToken';

export function useLinkToken(): string | null {
  const location = useLocation();
  const navigate = useNavigate();
  const current = linkTokenFromHash(location.hash) ?? heldLinkToken(location.pathname);
  const [kept, setKept] = useState(current);
  // Another link opened in place (the same page, a new fragment).
  if (current !== null && current !== kept) setKept(current);
  useLayoutEffect(() => {
    takeLinkToken(location, (url) => void navigate(url, { replace: true, state: location.state }));
  }, [location, navigate]);
  return current ?? kept;
}
