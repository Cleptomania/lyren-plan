// The page a link opened, when the link cannot be used (design §5.7, §12.7): opened without its token, a
// token the server refuses (one answer for unknown, used, expired and revoked links: its message, then how
// long such links work and where a new one comes from), or a request that may work in a while (Try again).

import { Link2Off, RotateCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '../../components/ui/Button';
import { Spinner } from '../../components/ui/Spinner';
import { AuthLayout } from './AuthLayout';
import { LINK_HELP, MISSING_LINK_TEXT, type LinkFailure, type LinkKind } from './linkPages';

const INVALID_TITLES: Readonly<Record<LinkKind, string>> = {
  signup: 'This sign-up link can’t be used',
  reset: 'This reset link can’t be used',
  email: 'This confirmation link can’t be used',
  invitation: 'This invitation can’t be used',
};

export function LinkProblem({
  kind,
  failure,
  onRetry,
  actions,
}: {
  kind: LinkKind;
  /** null: the page has no token (opened without its link). */
  failure: LinkFailure | null;
  onRetry?: () => void;
  /** Where to go instead (a new link, sign in). */
  actions?: ReactNode;
}) {
  const title =
    failure === null
      ? 'Open the link again'
      : failure.kind === 'invalid'
        ? INVALID_TITLES[kind]
        : failure.kind === 'retry'
          ? 'Something went wrong'
          : 'This link can’t be used';
  return (
    <AuthLayout title={title}>
      <div className="flex flex-col gap-4">
        <div className="flex items-start gap-3">
          <Link2Off aria-hidden className="mt-0.5 size-5 shrink-0 text-fg-subtle" />
          <div className="flex min-w-0 flex-col gap-2 text-sm">
            <p role={failure?.kind === 'retry' ? 'alert' : undefined} className="text-fg">
              {failure === null ? MISSING_LINK_TEXT : failure.message}
            </p>
            {failure?.kind === 'invalid' && <p className="text-fg-muted">{LINK_HELP[kind]}</p>}
          </div>
        </div>
        {failure?.kind === 'retry' && onRetry && (
          <Button fullWidth icon={<RotateCw aria-hidden />} onClick={onRetry}>
            Try again
          </Button>
        )}
        {actions}
      </div>
    </AuthLayout>
  );
}

/** While the server looks at the link (an inspect, or a confirmation on its way). */
export function LinkChecking({ title, text = 'Checking the link…' }: { title: string; text?: string }) {
  return (
    <AuthLayout title={title}>
      <div className="flex items-center justify-center gap-3 py-2 text-sm text-fg-muted" role="status">
        <Spinner size="sm" label={null} />
        {text}
      </div>
    </AuthLayout>
  );
}
