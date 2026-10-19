// /signup/complete#t=… (design §5.8.5, §12.2, §12.7): the sign-up link. It shows the address the link was
// sent to, then takes a name and a password, or a passkey instead where passkeys are available, and creates
// the account (its address verified, a space of its own) and signs it in. A link that cannot be used, a
// policy closed meanwhile or an address that has an account by now each get their own state. Works signed
// in too (the new account then takes this browser's place).

import { KeyRound } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { LIMITS } from '@shared/constants';
import { useAuthStatus, useCompleteSignup, useSignupPreview } from '../../api/auth';
import { ApiError } from '../../api/client';
import { usePasskeysAvailable, usePreloadedWebAuthn, useSignupWithPasskey } from '../../api/passkeys';
import { Button, ButtonLink } from '../../components/ui/Button';
import { Field } from '../../components/ui/Field';
import { apiFieldErrors, hasFieldErrors, type FieldErrors } from '../../components/ui/formErrors';
import { Input } from '../../components/ui/Input';
import { useDocumentTitle } from '../../lib/hooks';
import { failureText, webauthnFailure } from '../../lib/passkeys';
import { proposedPasskeyName } from '../settings/passkeys';
import { newPasswordErrors } from '../settings/passwordStrength';
import { authErrorMessage } from './authErrors';
import { AuthLayout, FormAlert } from './AuthLayout';
import { LinkChecking, LinkProblem } from './LinkProblem';
import { linkFailure, type LinkFailure } from './linkPages';
import { NewPasswordFields, type NewPasswordValues } from './NewPasswordFields';
import { PasskeyExplainer, SwitchCredentialButton, type CredentialWay } from './PasskeyChoice';
import { useLinkToken } from './useLinkToken';

function SignupComplete({ token }: { token: string | null }) {
  useDocumentTitle('Create your account');
  const navigate = useNavigate();
  const status = useAuthStatus().data;
  const passkeys = usePasskeysAvailable();
  usePreloadedWebAuthn(passkeys);
  const complete = useCompleteSignup();
  const completeWithPasskey = useSignupWithPasskey();
  // Once the link is used, its preview is not asked for again (api/auth.ts LINK_PREVIEW_OPTIONS).
  const unused = (complete.isIdle || complete.isError) && (completeWithPasskey.isIdle || completeWithPasskey.isError);
  const preview = useSignupPreview(unused ? token : null);
  const min = status?.instance.passwordMinLength ?? LIMITS.passwordMin;
  const [name, setName] = useState('');
  const [way, setWay] = useState<CredentialWay>('password');
  const [passwords, setPasswords] = useState<NewPasswordValues>({ password: '', confirm: '' });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<LinkFailure | null>(null);

  if (token === null) return <LinkProblem kind="signup" failure={null} actions={<ButtonLink to="/signup" fullWidth>Sign up</ButtonLink>} />;
  if (preview.isPending) return <LinkChecking title="Create your account" />;
  const failure = refusal ?? (preview.error ? linkFailure(preview.error) : null);
  if (failure !== null || !preview.data) {
    const taken = failure?.kind === 'refused' && failure.code === 'conflict';
    return (
      <LinkProblem
        kind="signup"
        failure={failure}
        onRetry={() => void preview.refetch()}
        actions={
          taken ? (
            <ButtonLink to="/login" state={{ identifier: preview.data?.email }} variant="primary" fullWidth>
              Sign in
            </ButtonLink>
          ) : failure?.kind === 'invalid' ? (
            <ButtonLink to="/signup" fullWidth>
              Sign up again
            </ButtonLink>
          ) : undefined
        }
      />
    );
  }
  const email = preview.data.email;
  const withPasskey = passkeys && way === 'passkey';
  const busy = complete.isPending || complete.isSuccess || completeWithPasskey.isPending || completeWithPasskey.isSuccess;

  /** The link, the policy or the address: the page says so instead of the form. */
  const refusedLink = (err: unknown): boolean => {
    const failed = linkFailure(err);
    if (!(err instanceof ApiError) || !(failed.kind === 'invalid' || err.code === 'signup_disabled' || err.code === 'conflict')) return false;
    setRefusal(failed);
    return true;
  };
  // Into the account's own space (HomeRedirect).
  const done = () => void navigate('/', { replace: true });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setFormError(null);
    const fe: FieldErrors = withPasskey ? {} : { ...newPasswordErrors(passwords.password, passwords.confirm, min) };
    if (!name.trim()) fe.displayName = 'Required';
    setErrors(fe);
    if (hasFieldErrors(fe)) return;
    if (withPasskey) {
      completeWithPasskey.mutate(
        { token, displayName: name, passkeyName: proposedPasskeyName(navigator.userAgent) },
        {
          onSuccess: done,
          onError: (err) => {
            const fields = apiFieldErrors(err);
            if (fields.displayName) return setErrors(fields);
            if (refusedLink(err)) return;
            setFormError(failureText(webauthnFailure(err, 'create'), 'create'));
          },
        },
      );
      return;
    }
    complete.mutate(
      { token, displayName: name, password: passwords.password },
      {
        onSuccess: done,
        onError: (err) => {
          const fields = apiFieldErrors(err);
          if (fields.password || fields.displayName) return setErrors(fields);
          if (!refusedLink(err)) setFormError(authErrorMessage(err));
        },
      },
    );
  };

  return (
    <AuthLayout
      wide
      title="Create your account"
      subtitle={
        <>
          For <span className="break-words font-medium text-fg">{email}</span>
        </>
      }
    >
      <form method="post" noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
        {status?.user && (
          <p className="rounded-md bg-surface-2 px-3 py-2 text-[13px] text-fg-muted">
            You are signed in as {status.user.email ?? status.user.username}. Creating this account signs this browser in to it instead.
          </p>
        )}
        <Field label="Your name" required error={errors.displayName} hint="Shown to the members of your spaces.">
          <Input
            name="name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (errors.displayName) setErrors((x) => ({ ...x, displayName: undefined }));
            }}
            autoComplete="name"
            autoFocus
            maxLength={LIMITS.displayNameMax}
          />
        </Field>
        {withPasskey ? (
          <PasskeyExplainer account={email} />
        ) : (
          <NewPasswordFields
            values={passwords}
            errors={errors}
            min={min}
            username={email}
            onChange={(key, value) => {
              setPasswords((p) => ({ ...p, [key]: value }));
              if (errors[key]) setErrors((x) => ({ ...x, [key]: undefined }));
            }}
          />
        )}
        {formError && <FormAlert>{formError}</FormAlert>}
        <Button type="submit" variant="primary" fullWidth loading={busy} icon={withPasskey ? <KeyRound aria-hidden /> : undefined} className="mt-1">
          {withPasskey ? 'Create account with a passkey' : 'Create account'}
        </Button>
        {passkeys && (
          <SwitchCredentialButton
            way={way}
            onSwitch={(next) => {
              setWay(next);
              setErrors((x) => ({ displayName: x.displayName }));
              setFormError(null);
            }}
          />
        )}
      </form>
    </AuthLayout>
  );
}

/** A new link opened in place (the same page, another fragment) starts afresh. */
export default function SignupCompletePage() {
  const token = useLinkToken();
  return <SignupComplete key={token ?? ''} token={token} />;
}
