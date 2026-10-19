// /signup (design §5.8.5, §12.2): open sign-up with email verification. Under any policy but open, and on
// an instance that sends no mail now, the page says how accounts are made here instead. The answer is the same for every address (202): the address
// gets either the sign-up link (24 hours) or, when it has an account already, a note to sign in, so the page
// says both and never which.

import { useQueryClient } from '@tanstack/react-query';
import { MailCheck } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { LIMITS } from '@shared/constants';
import { signupInput } from '@shared/schemas';
import { useAuthStatus, useSignup } from '../../api/auth';
import { ApiError } from '../../api/client';
import { qk } from '../../api/keys';
import { Button, ButtonLink } from '../../components/ui/Button';
import { Field } from '../../components/ui/Field';
import { apiFieldErrors, zodFieldErrors } from '../../components/ui/formErrors';
import { Input } from '../../components/ui/Input';
import { useDocumentTitle } from '../../lib/hooks';
import { authErrorMessage } from './authErrors';
import { AUTH_LINK, AuthLayout, FormAlert } from './AuthLayout';
import { signupClosedText } from './linkPages';

function SignInInstead() {
  return (
    <p className="text-center text-sm text-fg-muted">
      Have an account?{' '}
      <Link to="/login" className={AUTH_LINK}>
        Sign in
      </Link>
    </p>
  );
}

export default function SignupPage() {
  useDocumentTitle('Create an account');
  const qc = useQueryClient();
  const { data: status } = useAuthStatus();
  const signup = useSignup();
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const closed = status ? signupClosedText(status.instance) : null;

  if (closed) {
    return (
      <AuthLayout title={closed.title}>
        <div className="flex flex-col gap-4">
          <p className="text-sm text-fg-muted">{closed.body}</p>
          <ButtonLink to="/login" variant="primary" fullWidth>
            Sign in
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
              We sent a message to <span className="break-words font-medium">{sentTo}</span>. Follow the link in it within 24 hours to finish
              creating your account. If that address has an account already, the message says how to sign in instead.
            </p>
          </div>
          <p className="text-[13px] text-fg-muted">Nothing arrived after a few minutes? Check the spam folder, or try again.</p>
          <Button
            fullWidth
            onClick={() => {
              setSentTo(null);
              signup.reset();
            }}
          >
            Use another address
          </Button>
          <SignInInstead />
        </div>
      </AuthLayout>
    );
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (signup.isPending) return;
    setFormError(null);
    const parsed = signupInput.safeParse({ email });
    if (!parsed.success) {
      setError(zodFieldErrors(parsed.error).email);
      emailRef.current?.focus();
      return;
    }
    setError(undefined);
    signup.mutate(
      { email },
      {
        onSuccess: () => setSentTo(parsed.data.email.address),
        onError: (err) => {
          const field = apiFieldErrors(err).email;
          if (field) {
            setError(field);
            emailRef.current?.focus();
            return;
          }
          // The policy changed meanwhile: the page then explains the new one.
          if (err instanceof ApiError && err.code === 'signup_disabled') void qc.invalidateQueries({ queryKey: qk.authStatus });
          setFormError(authErrorMessage(err));
        },
      },
    );
  };

  return (
    <AuthLayout title="Create an account" subtitle="We’ll email you a link to set it up.">
      <form method="post" noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
        <Field label="Email" error={error} hint="You sign in with it. Members of your spaces can see it.">
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
        <Button type="submit" variant="primary" fullWidth loading={signup.isPending} className="mt-1">
          Send the link
        </Button>
        <SignInInstead />
      </form>
    </AuthLayout>
  );
}
