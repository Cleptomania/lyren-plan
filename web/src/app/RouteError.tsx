// Router error element: replaces React Router's developer error page. A page that throws
// (or whose lazy chunk fails to load) shows a friendly message — inside the app shell for
// pages, full-screen for the gates — with a way out. A chunk that fails to load while online
// usually means the server was upgraded and the old file names are gone: reload once, by itself.

import { CloudOff, LayoutDashboard, RotateCw, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useRouteError } from 'react-router';
import { errorMessage } from '../api/client';
import { Button } from '../components/ui/Button';
import { EmptyState } from '../components/ui/EmptyState';
import { useDocumentTitle } from '../lib/hooks';
import { claimAutoReload, isChunkLoadError } from './chunkErrors';

function sessionStore(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function reload() {
  window.location.reload();
}

export function RouteError({ variant = 'page' }: { variant?: 'page' | 'full' }) {
  const error = useRouteError();
  const location = useLocation();
  const navigate = useNavigate();
  const chunk = isChunkLoadError(error);
  const [online] = useState(() => navigator.onLine);
  const [reloading, setReloading] = useState(false);

  // Re-render the route without reloading (keeps the app's state): a new location resets the
  // router's error boundary, and lazy pages import again after a failure (retryableLazy).
  const retry = () => {
    const { pathname, search, hash, state } = location;
    navigate({ pathname, search, hash }, { replace: true, state, preventScrollReset: true });
  };

  useEffect(() => {
    if (!chunk) console.error(error);
  }, [chunk, error]);

  // Stale chunk after an upgrade (or a network blip): one automatic reload fetches the new app.
  useEffect(() => {
    if (chunk && online && claimAutoReload(sessionStore())) {
      setReloading(true);
      reload();
    }
  }, [chunk, online]);

  const offline = chunk && !online;

  // Offline: try again by itself as soon as the connection is back.
  useEffect(() => {
    if (!offline) return;
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  });

  const title = offline
    ? 'This page isn’t available offline'
    : chunk
      ? 'Couldn’t load this page'
      : 'Something went wrong';
  const body = offline
    ? 'It hasn’t been opened on this device yet. Reconnect, then try again.'
    : chunk
      ? 'A newer version of Lyren Plan may be available, or the connection dropped. Reload to continue.'
      : errorMessage(error);
  useDocumentTitle(title);

  const content = (
    <div role="alert">
      <EmptyState
        icon={offline ? <CloudOff /> : <TriangleAlert />}
        title={title}
        body={<span className="break-words">{body}</span>}
        action={
          <>
            <Button
              variant="primary"
              icon={<RotateCw />}
              loading={reloading}
              // Still offline: a reload would only show the browser's offline page.
              onClick={() => (chunk && !navigator.onLine ? retry() : reload())}
            >
              {offline ? 'Try again' : 'Reload'}
            </Button>
            <Button
              icon={<LayoutDashboard />}
              // Full screen: the shell itself failed, so leave by a full navigation.
              onClick={() => (variant === 'full' ? window.location.assign('/') : navigate('/'))}
            >
              Go to home
            </Button>
          </>
        }
      />
    </div>
  );

  if (variant === 'full') {
    return <div className="flex h-full min-h-dvh items-center justify-center bg-bg p-6">{content}</div>;
  }
  return <div className="mx-auto w-full max-w-3xl px-4 py-10 md:px-6">{content}</div>;
}
