// /recover (design §5.8.19, §12.2): the operator's way back in when no administrator can sign in. With the
// RECOVERY_TOKEN the server was given and an account's address or username, it hands out a reset link
// for that account (24 hours), which also makes the account an administrator when none is left. While
// the token is unset the page says recovery is off, without asking the server (and so does a 404).

import { useQueryClient } from '@tanstack/react-query';
import { KeyRound, LifeBuoy } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { LIMITS } from '@shared/constants';
import { recoverInput } from '@shared/schemas';
import type { RecoveryLinkDTO } from '@shared/types';
import { useAuthStatus, useRecover } from '../../api/auth';
import { ApiError } from '../../api/client';
import { qk } from '../../api/keys';
import { Button, ButtonLink } from '../../components/ui/Button';
import { CopyField } from '../../components/ui/CopyField';
import { Field } from '../../components/ui/Field';
import { apiFieldErrors, hasFieldErrors, zodFieldErrors, type FieldErrors } from '../../components/ui/formErrors';
import { Input, PasswordInput } from '../../components/ui/Input';
import { formatDateTime } from '../../lib/format';
import { useDocumentTitle } from '../../lib/hooks';
import { holdLinkToken, linkTokenFromHash } from '../../lib/linkToken';
import { absoluteLink } from '../../lib/shareLinks';
import { authErrorMessage } from './authErrors';
import { AuthLayout, FormAlert, FormNotice } from './AuthLayout';

/** How the operator removes the token again, per runtime. */
function removeTokenText(runtime: 'node' | 'cloudflare'): string {
  return runtime === 'cloudflare'
    ? 'Once you are back in, delete the secret again: npm run cf -- secret delete RECOVERY_TOKEN, or in the dashboard (Workers & Pages → your Worker → Settings → Variables and Secrets).'
    : 'Once you are back in, remove RECOVERY_TOKEN from the server’s environment and restart it.';
}

function RecoveryLink({ result, identifier, runtime }: { result: RecoveryLinkDTO; identifier: string; runtime: 'node' | 'cloudflare' }) {
  const navigate = useNavigate();
  const link = absoluteLink(result.link, window.location.origin);
  const open = () => {
    const url = new URL(link);
    const token = linkTokenFromHash(url.hash);
    // A link to this address opens in place, its token handed over in memory; another address (PUBLIC_URL) is loaded.
    if (url.origin === window.location.origin && token !== null) {
      holdLinkToken(url.pathname, token);
      void navigate(url.pathname);
    } else {
      window.location.assign(link);
    }
  };
  return (
    <div className="flex flex-col gap-4">
      <FormNotice>
        A reset link for <span className="break-words font-medium">{identifier}</span>. It works once, until {formatDateTime(result.expiresAt)}.
        {result.madeAdmin && ' No administrator was left, so the account is an administrator now.'}
      </FormNotice>
      <Button variant="primary" fullWidth icon={<KeyRound aria-hidden />} onClick={open}>
        Choose a new password
      </Button>
      <CopyField value={link} label="reset link" />
      <p className="text-[13px] text-fg-muted">{removeTokenText(runtime)}</p>
    </div>
  );
}

export default function RecoverPage() {
  useDocumentTitle('Recover access');
  const qc = useQueryClient();
  const status = useAuthStatus().data;
  const recover = useRecover();
  const [values, setValues] = useState({ token: '', identifier: '' });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  // The server answered 404 (the token was removed after this page loaded).
  const [off, setOff] = useState(false);
  const tokenRef = useRef<HTMLInputElement>(null);
  const runtime = status?.instance.runtime ?? 'node';

  if (!status?.instance.features.recovery || off) {
    return (
      <AuthLayout title="Recovery is not enabled on this instance">
        <div className="flex flex-col gap-4 text-sm">
          <p className="text-fg">
            When no administrator can sign in, whoever runs this instance sets the RECOVERY_TOKEN secret for a moment, then gets a password reset link
            here. The README’s “Locked out” section describes the steps{runtime === 'cloudflare' ? ', and so does docs/cloudflare.md' : ''}.
          </p>
          <ButtonLink to="/login" fullWidth>
            Back to sign in
          </ButtonLink>
        </div>
      </AuthLayout>
    );
  }

  const set = (key: keyof typeof values) => (e: { target: { value: string } }) => {
    setValues((v) => ({ ...v, [key]: e.target.value }));
    if (errors[key]) setErrors((x) => ({ ...x, [key]: undefined }));
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (recover.isPending) return;
    setFormError(null);
    const parsed = recoverInput.safeParse(values);
    if (!parsed.success) return setErrors(zodFieldErrors(parsed.error));
    setErrors({});
    recover.mutate(parsed.data, {
      onError: (err) => {
        const fields = apiFieldErrors(err);
        if (hasFieldErrors(fields)) return setErrors(fields);
        if (err instanceof ApiError && err.status === 403) {
          setErrors({ token: 'This is not the instance’s recovery token' });
          tokenRef.current?.focus();
          return;
        }
        if (err instanceof ApiError && err.status === 404) {
          if (err.message === 'Account not found') return setErrors({ identifier: 'No account has this email address or username' });
          setOff(true);
          void qc.invalidateQueries({ queryKey: qk.authStatus });
          return;
        }
        setFormError(authErrorMessage(err));
      },
    });
  };

  return (
    <AuthLayout wide title="Recover access" subtitle="For whoever runs this instance, when no administrator can sign in.">
      {recover.data ? (
        <RecoveryLink result={recover.data} identifier={values.identifier.trim()} runtime={runtime} />
      ) : (
        <form method="post" noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="flex items-start gap-3 text-[13px] text-fg-muted">
            <LifeBuoy aria-hidden className="mt-0.5 size-4 shrink-0" />
            <p>Enter the RECOVERY_TOKEN this instance was started with, and the account to get back into. You get a link to choose its new password.</p>
          </div>
          <Field label="Recovery token" required error={errors.token}>
            <PasswordInput ref={tokenRef} name="recovery-token" value={values.token} onChange={set('token')} autoComplete="off" autoFocus maxLength={200} />
          </Field>
          <Field label="Email or username" required error={errors.identifier}>
            <Input
              name="identifier"
              value={values.identifier}
              onChange={set('identifier')}
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              maxLength={LIMITS.identifierMax}
            />
          </Field>
          {formError && <FormAlert>{formError}</FormAlert>}
          <Button type="submit" variant="primary" fullWidth loading={recover.isPending} className="mt-1">
            Get a reset link
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
