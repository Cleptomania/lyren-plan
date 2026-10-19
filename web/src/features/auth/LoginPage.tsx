// Sign-in screen. On success the auth-status query refetches and PublicOnly redirects to the page the
// user came from (or the home page). The ways back in follow the instance (linkPages.ts signInHelp):
// "Forgot password?" when it mails reset links, else "ask an administrator"; the reset-password command
// on a server one runs oneself; "Create an account" when sign-up is open (design §12.7). After a password
// reset the address arrives filled in (`state.identifier`), and after a reset with a passkey the focus is on
// "Sign in with a passkey" (`state.passkey`).

import { Link, useLocation } from 'react-router';
import { useAuthStatus } from '../../api/auth';
import { useDocumentTitle } from '../../lib/hooks';
import { AUTH_LINK, AuthLayout, FormNotice } from './AuthLayout';
import { ASK_ADMIN_TEXT, signInHelp } from './linkPages';
import { PasswordResetHint } from './PasswordResetHint';
import { SignInForm } from './SignInForm';

/** What another page hands the sign-in page (the password reset). */
export interface LoginState {
  identifier?: string;
  notice?: string;
  /** The reset set up a passkey: the focus starts on "Sign in with a passkey", not the password. */
  passkey?: boolean;
}

export default function LoginPage() {
  useDocumentTitle('Sign in');
  const { data: status } = useAuthStatus();
  const state = (useLocation().state ?? {}) as LoginState;
  const help = status ? signInHelp(status) : null;

  return (
    <AuthLayout
      title="Sign in to Lyren Plan"
      footer={
        <>
          {help?.askAdmin && <p className="mb-1">{ASK_ADMIN_TEXT}</p>}
          {help?.command && <PasswordResetHint desktop={status?.desktop} operator={help.forgot || help.askAdmin} />}
          {status?.version && <p className="mt-1">Lyren Plan {status.version}</p>}
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {typeof state.notice === 'string' && <FormNotice>{state.notice}</FormNotice>}
        <SignInForm identifier={typeof state.identifier === 'string' ? state.identifier : ''} forgot={help?.forgot} focusPasskey={state.passkey === true}>
          {help?.signup && (
            <p className="text-center text-sm text-fg-muted">
              New here?{' '}
              <Link to="/signup" className={AUTH_LINK}>
                Create an account
              </Link>
            </p>
          )}
        </SignInForm>
      </div>
    </AuthLayout>
  );
}
