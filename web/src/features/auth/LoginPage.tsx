// Sign-in screen. On success the auth-status query refetches and PublicOnly redirects to
// the page the user came from (or the home page).

import { useRef, useState, type FormEvent } from 'react';
import { loginInput, type LoginInput } from '@shared/schemas';
import { useAuthStatus, useLogin } from '../../api/auth';
import { ApiError } from '../../api/client';
import { Button } from '../../components/ui/Button';
import { Field } from '../../components/ui/Field';
import { apiFieldErrors, zodFieldErrors, type FieldErrors } from '../../components/ui/formErrors';
import { Input, PasswordInput } from '../../components/ui/Input';
import { useDocumentTitle } from '../../lib/hooks';
import { authErrorMessage } from './authErrors';
import { AuthLayout, FormAlert } from './AuthLayout';
import { PasswordResetHint } from './PasswordResetHint';

export default function LoginPage() {
  useDocumentTitle('Sign in');
  const { data: status } = useAuthStatus();
  const login = useLogin();
  const [values, setValues] = useState<LoginInput>({ username: '', password: '' });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const usernameRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  const set = (key: keyof LoginInput) => (e: { target: { value: string } }) => {
    setValues((v) => ({ ...v, [key]: e.target.value }));
    if (errors[key]) setErrors((x) => ({ ...x, [key]: undefined }));
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (login.isPending) return;
    setFormError(null);
    const parsed = loginInput.safeParse(values);
    if (!parsed.success) {
      const fe = zodFieldErrors(parsed.error);
      setErrors(fe);
      (fe.username ? usernameRef : passwordRef).current?.focus();
      return;
    }
    setErrors({});
    login.mutate(parsed.data, {
      onError: (err) => {
        setErrors(apiFieldErrors(err));
        setFormError(authErrorMessage(err));
        if (err instanceof ApiError && err.status === 401) {
          passwordRef.current?.focus();
          passwordRef.current?.select();
        }
      },
    });
  };

  return (
    <AuthLayout
      title="Sign in to Lyren Plan"
      footer={
        <>
          <PasswordResetHint desktop={status?.desktop} />
          {status?.version && <p className="mt-1">Lyren Plan {status.version}</p>}
        </>
      }
    >
      <form method="post" noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
        <Field label="Username" error={errors.username}>
          <Input
            ref={usernameRef}
            name="username"
            value={values.username}
            onChange={set('username')}
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            autoFocus
            maxLength={64}
          />
        </Field>
        <Field label="Password" error={errors.password}>
          <PasswordInput
            ref={passwordRef}
            name="password"
            value={values.password}
            onChange={set('password')}
            autoComplete="current-password"
          />
        </Field>
        {formError && <FormAlert>{formError}</FormAlert>}
        <Button type="submit" variant="primary" fullWidth loading={login.isPending} className="mt-1">
          Sign in
        </Button>
      </form>
    </AuthLayout>
  );
}
