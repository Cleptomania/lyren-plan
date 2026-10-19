// The frame of the pages outside any space (/spaces, /settings, /admin): a slim bar with the app's name
// (→ '/') and the way back to the space last used, above the page. The pages render their own
// PageHeader, as the pages of a space do.

import { ArrowLeft } from 'lucide-react';
import { Suspense } from 'react';
import { Link, Outlet, useLocation } from 'react-router';
import { useAuthStatus } from '../api/auth';
import { AppMark } from '../components/layout/AppMark';
import { PageSpinner } from '../components/layout/FullPage';
import { ConfirmHost } from '../components/ui/ConfirmDialog';
import { homeSpace } from './legacyRedirect';
import { readLastSpace, spaceLink } from './space';

export function DirectoryLayout() {
  const location = useLocation();
  const status = useAuthStatus().data;
  const lastId = status ? homeSpace(status, readLastSpace()) : null;
  const last = status?.spaces.find((s) => s.id === lastId);

  return (
    <div className="flex min-h-dvh flex-col bg-bg">
      <div className="border-b border-border pt-safe">
        <div className="mx-auto flex h-12 w-full max-w-5xl items-center gap-3 px-4 md:px-6">
          {/* The name keeps its width; a long space name is what gets cut. */}
          <Link to="/" className="flex shrink-0 items-center gap-2 rounded-md">
            <AppMark size={20} />
            <span className="whitespace-nowrap text-[15px] font-semibold tracking-tight text-fg">Lyren Plan</span>
          </Link>
          {last && (
            <Link
              to={spaceLink(last.id, '/')}
              className="ml-auto flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-sm text-fg-muted hover:bg-surface-2 hover:text-fg [&_svg]:size-4 [&_svg]:shrink-0"
            >
              <ArrowLeft aria-hidden />
              <span className="truncate" title={last.name}>
                {last.name}
              </span>
            </Link>
          )}
        </div>
      </div>
      <main id="main" tabIndex={-1} className="min-w-0 flex-1 pb-safe outline-none">
        <Suspense fallback={<PageSpinner />}>
          <Outlet />
        </Suspense>
      </main>
      <ConfirmHost resetKey={location.pathname + location.search} />
    </div>
  );
}
