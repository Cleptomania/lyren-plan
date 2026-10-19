// /forgot (design §5.8.9, §12.2): a reset link by mail. The answer is the same for every address (202), so
// the page never says whether the address has an account. On an instance that sends no mail there is no
// form: an administrator makes reset links there (§5.8.11), and whoever runs the server has the
// reset-password command.

import { MailCheck } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { LIMITS } from '@shared/constants';
import { forgotPasswordInput } from '@shared/schemas';
import { useAuthStatus, useForgotPassword } from '../../api/auth';
import { Button, ButtonLink } from '../../components/ui/Button';
import { Field } from '../../components/ui/Field';
import { apiFieldErrors, zodFieldErrors } from '../../components/ui/formErrors';
import { Input } from '../../components/ui/Input';
import { useDocumentTitle } from '../../lib/hooks';
import { authErrorMessage } from './authErrors';
import { AUTH_LINK, AuthLayout, FormAlert } from './AuthLayout';
import { signInHelp } from './linkPages';
import { PasswordResetHint } from './PasswordResetHint';

function BackToSignIn() {
  return (
    <p className="text-center text-sm text-fg-muted">
      Remembered it?{' '}
      <Link to="/login" className={AUTH_LINK}>
        Sign in
      </Link>
    </p>
  );
}

export default function ForgotPasswordPage() {
  useDocumentTitle('Forgot password');
  const { data: status } = useAuthStatus();
  const forgot = useForgotPassword();
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const help = status ? signInHelp(status) : null;

  if (help && !help.forgot) {
    return (
      <AuthLayout title="Forgot your password?">
        <div className="flex flex-col gap-4 text-sm">
          <p className="text-fg">
            {help.askAdmin
              ? 'This instance sends no email, so reset links come from its administrators: ask one of them for a reset link.'
              : 'This Lyren Plan sends no email.'}
          </p>
          {help.command && (
            <div className="text-[13px] text-fg-muted">
              <PasswordResetHint desktop={status?.desktop} operator={help.askAdmin} />
            </div>
          )}
          <ButtonLink to="/login" fullWidth>
            Back to sign in
          </ButtonLink>
        </div>
      </AuthLayout>
    );
  }

  if (sentTo !== null) {
    return (
      <AuthLayout title="Check your inbox">
        <div className="flex flex-col gap-4">
          <div className="flex items-start gap-3">
            <MailCheck aria-hidden className="mt-0.5 size-5 shrink-0 text-success" />
            <p className="text-sm text-fg">
              If an account uses <span className="break-words font-medium">{sentTo}</span>, we sent it a link to choose a new password. The link works
              for 30 minutes.
            </p>
          </div>
          <p className="text-[13px] text-fg-muted">
            Nothing arrived after a few minutes? Check the spam folder, or try again. An administrator of this instance can also make you a reset
            link.
          </p>
          <Button
            fullWidth
            onClick={() => {
              setSentTo(null);
              forgot.reset();
            }}
          >
            Try another address
          </Button>
          <BackToSignIn />
        </div>
      </AuthLayout>
    );
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (forgot.isPending) return;
    setFormError(null);
    const parsed = forgotPasswordInput.safeParse({ email });
    if (!parsed.success) {
      setError(zodFieldErrors(parsed.error).email);
      emailRef.current?.focus();
      return;
    }
    setError(undefined);
    forgot.mutate(
      { email },
      {
        onSuccess: () => setSentTo(parsed.data.email.address),
        onError: (err) => {
          const field = apiFieldErrors(err).email;
          if (field) setError(field);
          else setFormError(authErrorMessage(err));
        },
      },
    );
  };

  return (
    <AuthLayout title="Forgot your password?" subtitle="We’ll email you a link to choose a new one.">
      <form method="post" noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
        <Field
          label="Email"
          error={error}
          hint="The address you sign in with. An account that signs in with a username gets reset links from an administrator."
        >
          <Input
            ref={emailRef}
            type="email"
            name="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              if (error) setError(undefined);
            }}
            autoComplete="email"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            autoFocus
            maxLength={LIMITS.identifierMax}
          />
        </Field>
        {formError && <FormAlert>{formError}</FormAlert>}
        <Button type="submit" variant="primary" fullWidth loading={forgot.isPending} className="mt-1">
          Send the link
        </Button>
        <BackToSignIn />
      </form>
    </AuthLayout>
  );
}
