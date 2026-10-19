// Catch-all route, inside a space's shell and outside any space.

import { ArrowLeft, Compass, LayoutDashboard } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router';
import { spaceLink, useOptionalSpace } from '../../app/space';
import { Page } from '../../components/layout/Page';
import { PageHeader } from '../../components/layout/PageHeader';
import { Button, ButtonLink } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { useDocumentTitle } from '../../lib/hooks';

export default function NotFoundPage() {
  useDocumentTitle('Page not found');
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const space = useOptionalSpace();
  // react-router stores the history index in history.state; idx > 0 means there is an in-app page to go back to.
  const idx = (window.history.state as { idx?: unknown } | null)?.idx;
  const canGoBack = typeof idx === 'number' && idx > 0;

  return (
    <Page width="narrow" header={<PageHeader title="Page not found" />}>
      <EmptyState
        icon={<Compass />}
        title="This page doesn’t exist"
        body={
          <>
            Nothing lives at <code className="break-all rounded bg-surface-2 px-1 font-mono text-[13px] text-fg">{pathname}</code>. It may
            have been moved or deleted.
          </>
        }
        action={
          <>
            {canGoBack && (
              <Button icon={<ArrowLeft />} onClick={() => navigate(-1)}>
                Go back
              </Button>
            )}
            <ButtonLink to={space ? spaceLink(space.id, '/dashboard') : '/'} variant="primary" icon={<LayoutDashboard />}>
              {space ? 'Go to dashboard' : 'Go to home'}
            </ButtonLink>
          </>
        }
      />
    </Page>
  );
}
