// /email/confirm#t=… (design §5.8.6, §5.8.10, §12.7): the link of an email verification or of an email
// change, sent as soon as the page opens. Either works only in a session of its account (on any device):
// signed out, the page asks that account to sign in (the server names it) and sends the link again;
// signed in as another account, it offers to sign out first. The token stays in memory meanwhile; a
// refusal consumes nothing.

import { CircleCheck, LogOut } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuthStatus, useConfirmEmail, useLogout } from '../../api/auth';
import { Button, ButtonLink } from '../../components/ui/Button';
import { useDocumentTitle } from '../../lib/hooks';
import { AuthLayout, FormAlert } from './AuthLayout';
import { LinkChecking, LinkProblem } from './LinkProblem';
import { emailConfirmFailure, signInHelp, type EmailConfirmFailure } from './linkPages';
import type { LoginState } from './LoginPage';
import { SignInForm } from './SignInForm';
import { useLinkToken } from './useLinkToken';

function EmailConfirm({ token }: { token: string | null }) {
  useDocumentTitle('Confirm your email address');
  const status = useAuthStatus().data;
  const confirm = useConfirmEmail();
  const logout = useLogout();
  const [failure, setFailure] = useState<EmailConfirmFailure | null>(null);
  const started = useRef(false);

  const send = useCallback(() => {
    if (token === null) return;
    setFailure(null);
    confirm.mutate(token, { onError: (err) => setFailure(emailConfirmFailure(err)) });
  }, [confirm, token]);

  // Once, as the page opens (not again when React mounts it twice in development).
  useEffect(() => {
    if (token === null || started.current) return;
    started.current = true;
    send();
  }, [send, token]);

  const signedIn = Boolean(status?.user);
  const onward = signedIn ? (
    <ButtonLink to="/settings" fullWidth>
      Account settings
    </ButtonLink>
  ) : (
    <ButtonLink to="/login" fullWidth>
      Sign in
    </ButtonLink>
  );

  if (token === null) return <LinkProblem kind="email" failure={null} actions={onward} />;

  if (confirm.data) {
    const { email, purpose } = confirm.data;
    return (
      <AuthLayout title={purpose === 'change_email' ? 'Email address changed' : 'Email address verified'}>
        <div className="flex flex-col gap-4">
          <div className="flex items-start gap-3">
            <CircleCheck aria-hidden className="mt-0.5 size-5 shrink-0 text-success" />
            <p className="text-sm text-fg">
              {purpose === 'change_email' ? (
                <>
                  Your account’s email address is now <span className="break-words font-medium">{email}</span>. Sign in with it from now on.
                </>
              ) : (
                <>
                  <span className="break-words font-medium">{email}</span> is verified.
                </>
              )}
            </p>
          </div>
          {signedIn ? (
            <ButtonLink to="/" variant="primary" fullWidth>
              Continue
            </ButtonLink>
          ) : (
            <ButtonLink to="/login" state={{ identifier: email } satisfies LoginState} variant="primary" fullWidth>
              Sign in
            </ButtonLink>
          )}
        </div>
      </AuthLayout>
    );
  }

  if (failure === null) return <LinkChecking title="Confirm your email address" text="Confirming…" />;

  if (failure.kind === 'sign_in') {
    return (
      <AuthLayout title="Sign in to confirm" subtitle={failure.message}>
        <div className="flex flex-col gap-4">
          <p className="text-[13px] text-fg-muted">
            {failure.displayName ? `Only ${failure.displayName}’s account` : 'Only the account this link is for'} can confirm this email address. Sign in
            with its current address or username. If you have no such account here, you can ignore this link.
          </p>
          <SignInForm submitLabel="Sign in and confirm" forgot={status ? signInHelp(status).forgot : false} onSignedIn={() => send()} />
        </div>
      </AuthLayout>
    );
  }

  if (failure.kind === 'other_account') {
    return (
      <AuthLayout title="Sign in as the right account">
        <div className="flex flex-col gap-4">
          <FormAlert>{failure.message}</FormAlert>
          <p className="text-sm text-fg-muted">
            You are signed in as {status?.user?.email ?? status?.user?.username ?? 'another account'}. Sign out, then sign in as the account this link
            is for.
          </p>
          <Button
            variant="primary"
            fullWidth
            icon={<LogOut aria-hidden />}
            loading={logout.isPending}
            onClick={() => void logout.mutateAsync().then(send, (err: unknown) => setFailure(emailConfirmFailure(err)))}
          >
            Sign out
          </Button>
          <ButtonLink to="/" fullWidth>
            Keep using this account
          </ButtonLink>
        </div>
      </AuthLayout>
    );
  }

  return <LinkProblem kind="email" failure={failure} onRetry={send} actions={onward} />;
}

/** A new link opened in place (the same page, another fragment) starts afresh. */
export default function EmailConfirmPage() {
  const token = useLinkToken();
  return <EmailConfirm key={token ?? ''} token={token} />;
}
