// /reset#t=… (design §5.8.9, §12.2, §12.7): the reset link of a forgotten password, an administrator's
// (§5.8.11) or the operator's recovery (§5.8.19). It names the account, takes the new password, or sets up a
// passkey instead (`canUsePasskey`, where passkeys are available: a passkey-only account's way back in), which
// replaces the password unless the account would then have no way back in (the page says which beforehand,
// linkPages.ts passkeyResetText), and then signs nobody in (OWASP): every session of the account ends, this
// browser's too when it was signed in to it, and the sign-in page opens with the address filled in (and, after
// a passkey, the focus on "Sign in with a passkey"). Works signed in to another account too.

import { KeyRound } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { LIMITS } from '@shared/constants';
import type { PasskeyResetDTO } from '@shared/types';
import { useAuthStatus, useResetPassword, useResetPreview } from '../../api/auth';
import { ApiError } from '../../api/client';
import { usePasskeysAvailable, usePreloadedWebAuthn, useResetWithPasskey } from '../../api/passkeys';
import { Button, ButtonLink } from '../../components/ui/Button';
import { apiFieldErrors, hasFieldErrors } from '../../components/ui/formErrors';
import { useDocumentTitle } from '../../lib/hooks';
import { failureText, webauthnFailure } from '../../lib/passkeys';
import { proposedPasskeyName } from '../settings/passkeys';
import { newPasswordErrors } from '../settings/passwordStrength';
import { authErrorMessage } from './authErrors';
import { AuthLayout, FormAlert, FormNotice } from './AuthLayout';
import { LinkChecking, LinkProblem } from './LinkProblem';
import { linkFailure, passkeyResetNotice, passkeyResetText, type LinkFailure } from './linkPages';
import type { LoginState } from './LoginPage';
import { NewPasswordFields, type NewPasswordValues } from './NewPasswordFields';
import { PasskeyExplainer, SwitchCredentialButton, type CredentialWay } from './PasskeyChoice';
import { useLinkToken } from './useLinkToken';

export const PASSWORD_CHANGED_TEXT = 'Password changed. Sign in with your new password.';

function ResetPassword({ token }: { token: string | null }) {
  useDocumentTitle('Choose a new password');
  const navigate = useNavigate();
  const status = useAuthStatus().data;
  const passkeys = usePasskeysAvailable();
  usePreloadedWebAuthn(passkeys);
  const reset = useResetPassword();
  const resetWithPasskey = useResetWithPasskey();
  const unused = (reset.isIdle || reset.isError) && (resetWithPasskey.isIdle || resetWithPasskey.isError);
  const preview = useResetPreview(unused ? token : null);
  const min = status?.instance.passwordMinLength ?? LIMITS.passwordMin;
  const [way, setWay] = useState<CredentialWay>('password');
  const [passwords, setPasswords] = useState<NewPasswordValues>({ password: '', confirm: '' });
  const [errors, setErrors] = useState<{ password?: string; confirm?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<LinkFailure | null>(null);
  // Done while another account stays signed in here: the sign-in page would send the browser back to it.
  const [doneFor, setDoneFor] = useState<{ account: string; passkey: PasskeyResetDTO | null } | null>(null);

  const newLink = (
    <ButtonLink to={status?.instance.mailLinks ? '/forgot' : '/login'} fullWidth>
      {status?.instance.mailLinks ? 'Ask for a new link' : 'Back to sign in'}
    </ButtonLink>
  );
  if (token === null && doneFor === null) return <LinkProblem kind="reset" failure={null} actions={newLink} />;
  if (doneFor !== null) {
    return (
      <AuthLayout title={doneFor.passkey ? 'Passkey set up' : 'Password changed'}>
        <div className="flex flex-col gap-4">
          <FormNotice>
            {doneFor.passkey ? 'A passkey was added to ' : 'The password of '}
            <span className="break-words font-medium">{doneFor.account}</span>
            {doneFor.passkey ? ', and that account is signed out everywhere.' : ' is changed, and that account is signed out everywhere.'}
            {doneFor.passkey?.passwordRemoved && ' Its password was removed.'}
            {doneFor.passkey && doneFor.passkey.passwordKept !== null && ' Its password still works too.'}
          </FormNotice>
          <ButtonLink to="/" variant="primary" fullWidth>
            Continue as {status?.user?.displayName ?? 'yourself'}
          </ButtonLink>
        </div>
      </AuthLayout>
    );
  }
  if (preview.isPending) return <LinkChecking title="Choose a new password" />;
  const failure = refusal ?? (preview.error ? linkFailure(preview.error) : null);
  if (failure !== null || !preview.data) return <LinkProblem kind="reset" failure={failure} onRetry={() => void preview.refetch()} actions={newLink} />;
  const account = preview.data.email ?? preview.data.username ?? '';
  const offersPasskey = passkeys && preview.data.canUsePasskey;
  const withPasskey = offersPasskey && way === 'passkey';
  const busy = reset.isPending || reset.isSuccess || resetWithPasskey.isPending || resetWithPasskey.isSuccess;

  /** `passkey`: the answer of a reset with a passkey, null for a new password. */
  const done = (signedInAs: { email: string | null; username: string | null } | null, passkey: PasskeyResetDTO | null) => {
    // Signed in to another account (it stays so): say it here. Otherwise sign in afresh.
    const other = signedInAs !== null && (signedInAs.email ?? signedInAs.username) !== account;
    if (other) setDoneFor({ account, passkey });
    else {
      const notice = passkey ? passkeyResetNotice(passkey) : PASSWORD_CHANGED_TEXT;
      // After a passkey the sign-in form puts the focus on its passkey button, not the password.
      void navigate('/login', { replace: true, state: { identifier: account, notice, passkey: passkey !== null } satisfies LoginState });
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (busy || token === null) return;
    setFormError(null);
    const signedInAs = status?.user ?? null;
    if (withPasskey) {
      resetWithPasskey.mutate(
        { token, name: proposedPasskeyName(navigator.userAgent) },
        {
          onSuccess: (res) => done(signedInAs, res),
          onError: (err) => {
            const failed = linkFailure(err);
            if (err instanceof ApiError && failed.kind === 'invalid') return setRefusal(failed);
            setFormError(failureText(webauthnFailure(err, 'create'), 'create'));
          },
        },
      );
      return;
    }
    const fe = newPasswordErrors(passwords.password, passwords.confirm, min);
    setErrors(fe);
    if (hasFieldErrors(fe)) return;
    reset.mutate(
      { token, password: passwords.password },
      {
        onSuccess: () => done(signedInAs, null),
        onError: (err) => {
          const fields = apiFieldErrors(err);
          if (fields.password) return setErrors({ password: fields.password });
          const failed = linkFailure(err);
          if (failed.kind === 'invalid') setRefusal(failed);
          else setFormError(authErrorMessage(err));
        },
      },
    );
  };

  return (
    <AuthLayout
      wide
      title={withPasskey ? 'Set up a passkey' : preview.data.hasPassword ? 'Choose a new password' : 'Set a password'}
      subtitle={
        <>
          For <span className="break-words font-medium text-fg">{account}</span>
        </>
      }
    >
      <form method="post" noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
        {withPasskey ? (
          <PasskeyExplainer account={account} />
        ) : (
          <NewPasswordFields
            label="New password"
            values={passwords}
            errors={errors}
            min={min}
            username={account}
            onChange={(key, value) => {
              setPasswords((p) => ({ ...p, [key]: value }));
              if (errors[key]) setErrors((x) => ({ ...x, [key]: undefined }));
            }}
          />
        )}
        <p className="text-[13px] text-fg-muted">
          {withPasskey ? passkeyResetText(preview.data) : 'This signs the account out on every device. You then sign in with the new password.'}
        </p>
        {formError && <FormAlert>{formError}</FormAlert>}
        <Button type="submit" variant="primary" fullWidth loading={busy} icon={withPasskey ? <KeyRound aria-hidden /> : undefined} className="mt-1">
          {withPasskey ? 'Set up a passkey' : preview.data.hasPassword ? 'Change password' : 'Set password'}
        </Button>
        {offersPasskey && (
          <SwitchCredentialButton
            way={way}
            passkeyLabel="Set up a passkey instead"
            onSwitch={(next) => {
              setWay(next);
              setErrors({});
              setFormError(null);
            }}
          />
        )}
      </form>
    </AuthLayout>
  );
}

/** A new link opened in place (the same page, another fragment) starts afresh. */
export default function ResetPasswordPage() {
  const token = useLinkToken();
  return <ResetPassword key={token ?? ''} token={token} />;
}
