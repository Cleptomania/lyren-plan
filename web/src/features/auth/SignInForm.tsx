// The sign-in form: the sign-in page's, and the one the invitation and email confirmation pages show in
// place when a link needs a signed-in account (design §12.7). The password, and where passkeys are available
// (lib/passkeys.ts) a passkey: picked in the identifier field's autofill (autocomplete="username webauthn",
// asked for on mount) or with "Sign in with a passkey" (usePasskeySignIn.ts). On success the auth status is
// refreshed (api/auth.ts signedIn) and `onSignedIn` runs: the page carries on with its link.

import { KeyRound } from 'lucide-react';
import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import { LIMITS } from '@shared/constants';
import { loginInput } from '@shared/schemas';
import type { UserDTO } from '@shared/types';
import { useLogin } from '../../api/auth';
import { ApiError } from '../../api/client';
import { usePasskeysAvailable } from '../../api/passkeys';
import { Button } from '../../components/ui/Button';
import { Field } from '../../components/ui/Field';
import { apiFieldErrors, zodFieldErrors, type FieldErrors } from '../../components/ui/formErrors';
import { Input, PasswordInput } from '../../components/ui/Input';
import { authErrorMessage } from './authErrors';
import { AUTH_LINK, FormAlert, OrDivider } from './AuthLayout';
import { usePasskeySignIn } from './usePasskeySignIn';

export interface SignInFormProps {
  /** Filled in (the invited address, the one a reset was for). */
  identifier?: string;
  /** "Forgot password?" next to the password (the instance mails reset links). */
  forgot?: boolean;
  submitLabel?: string;
  /** After the sign-in, even when the form is no longer shown; the button stays busy until it settles. */
  onSignedIn?: (user: UserDTO) => Promise<unknown> | void;
  /** Under the button (a way to sign up instead). */
  children?: ReactNode;
  autoFocus?: boolean;
  /** The focus starts on "Sign in with a passkey" where passkeys are available (a reset just set one up). */
  focusPasskey?: boolean;
}

export function SignInForm({ identifier = '', forgot, submitLabel = 'Sign in', onSignedIn, children, autoFocus = true, focusPasskey = false }: SignInFormProps) {
  const login = useLogin();
  const passkeys = usePasskeysAvailable();
  const passkey = usePasskeySignIn({ enabled: passkeys, onSignedIn });
  const [values, setValues] = useState({ identifier, password: '' });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [continuing, setContinuing] = useState(false);
  const identifierRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const busy = login.isPending || continuing || passkey.busy;
  const passkeyFirst = autoFocus && focusPasskey && passkeys;

  const set = (key: keyof typeof values) => (e: { target: { value: string } }) => {
    setValues((v) => ({ ...v, [key]: e.target.value }));
    if (errors[key]) setErrors((x) => ({ ...x, [key]: undefined }));
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setFormError(null);
    passkey.clearError();
    const parsed = loginInput.safeParse(values);
    if (!parsed.success) {
      const fe = zodFieldErrors(parsed.error);
      setErrors(fe);
      (fe.identifier ? identifierRef : passwordRef).current?.focus();
      return;
    }
    setErrors({});
    let user: UserDTO;
    try {
      // Awaited rather than mutate()'s callbacks: the page may show something else once signed in, and
      // what it does next must still run.
      user = (await login.mutateAsync(parsed.data)).user;
    } catch (err) {
      setErrors(apiFieldErrors(err));
      setFormError(authErrorMessage(err));
      if (err instanceof ApiError && err.status === 401) {
        passwordRef.current?.focus();
        passwordRef.current?.select();
      }
      return;
    }
    if (!onSignedIn) return;
    setContinuing(true);
    try {
      await onSignedIn(user);
    } finally {
      setContinuing(false);
    }
  };

  return (
    <form method="post" noValidate onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-4">
      <Field label="Email or username" error={errors.identifier}>
        <Input
          ref={identifierRef}
          name="identifier"
          value={values.identifier}
          onChange={set('identifier')}
          // The browser's passkeys for this site join its suggestions (conditional UI, §5.8.3).
          autoComplete={passkeys ? 'username webauthn' : 'username'}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoFocus={autoFocus && !identifier && !passkeyFirst}
          maxLength={LIMITS.identifierMax}
        />
      </Field>
      <Field
        label="Password"
        error={errors.password}
        labelAction={
          forgot ? (
            <Link to="/forgot" className={`text-[13px] ${AUTH_LINK}`}>
              Forgot password?
            </Link>
          ) : undefined
        }
      >
        <PasswordInput
          ref={passwordRef}
          name="password"
          value={values.password}
          onChange={set('password')}
          autoComplete="current-password"
          autoFocus={autoFocus && Boolean(identifier) && !passkeyFirst}
        />
      </Field>
      {(formError ?? passkey.error) && <FormAlert>{formError ?? passkey.error}</FormAlert>}
      <Button type="submit" variant="primary" fullWidth loading={login.isPending || continuing} disabled={passkey.busy} className="mt-1">
        {submitLabel}
      </Button>
      {passkeys && (
        <>
          <OrDivider />
          <Button
            fullWidth
            icon={<KeyRound aria-hidden />}
            loading={passkey.busy}
            disabled={login.isPending || continuing}
            autoFocus={passkeyFirst}
            onClick={() => {
              setFormError(null);
              void passkey.signIn();
            }}
          >
            Sign in with a passkey
          </Button>
        </>
      )}
      {children}
    </form>
  );
}
