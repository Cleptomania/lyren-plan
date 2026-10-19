// First-run setup: create the owner account (with the one-time setup code from the server
// log when required) and optionally sample data. On success the auth-status query
// refetches and PublicOnly redirects into the app.
// The desktop app opens /setup#code=<code>: the code is filled in and removed from the
// address bar straight away (setupLink.ts).

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { LIMITS } from '@shared/constants';
import { localToday } from '@shared/dates';
import { setupInput, type SetupInput } from '@shared/schemas';
import { useAuthStatus, useSetup } from '../../api/auth';
import { ApiError } from '../../api/client';
import { qk } from '../../api/keys';
import { Button } from '../../components/ui/Button';
import { Checkbox } from '../../components/ui/Checkbox';
import { Field } from '../../components/ui/Field';
import { apiFieldErrors, zodFieldErrors, type FieldErrors } from '../../components/ui/formErrors';
import { Input, PasswordInput } from '../../components/ui/Input';
import { useDocumentTitle } from '../../lib/hooks';
import { authErrorMessage } from './authErrors';
import { AuthLayout, FormAlert } from './AuthLayout';
import { hashWithoutSetupCode, setupCodeFromHash, setupCodeHelp } from './setupLink';

interface SetupValues {
  displayName: string;
  email: string;
  password: string;
  setupCode: string;
  createSampleData: boolean;
}

type TextKey = 'displayName' | 'email' | 'password' | 'setupCode';
const FIELD_ORDER: TextKey[] = ['setupCode', 'displayName', 'email', 'password'];

export default function SetupPage() {
  useDocumentTitle('Set up');
  const qc = useQueryClient();
  const { data: status } = useAuthStatus();
  const codeRequired = status?.setupCodeRequired ?? false;
  const codeHelp = setupCodeHelp(status?.desktop);
  const setup = useSetup();
  const location = useLocation();
  const navigate = useNavigate();
  // Read once: the code is removed from the URL below.
  const [linkCode] = useState(() => setupCodeFromHash(location.hash));
  const [values, setValues] = useState<SetupValues>({
    displayName: '',
    email: '',
    password: '',
    setupCode: linkCode ?? '',
    createSampleData: true,
  });
  useEffect(() => {
    if (setupCodeFromHash(location.hash) === null) return;
    void navigate(
      { pathname: location.pathname, search: location.search, hash: hashWithoutSetupCode(location.hash) },
      { replace: true, state: location.state },
    );
  }, [location, navigate]);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const refs: Record<TextKey, RefObject<HTMLInputElement | null>> = {
    setupCode: useRef<HTMLInputElement>(null),
    displayName: useRef<HTMLInputElement>(null),
    email: useRef<HTMLInputElement>(null),
    password: useRef<HTMLInputElement>(null),
  };

  const set = (key: TextKey) => (e: { target: { value: string } }) => {
    setValues((v) => ({ ...v, [key]: e.target.value }));
    if (errors[key]) setErrors((x) => ({ ...x, [key]: undefined }));
  };
  const focusFirstError = (fe: FieldErrors) => {
    const first = FIELD_ORDER.find((k) => fe[k]);
    if (first) refs[first].current?.focus();
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (setup.isPending) return;
    setFormError(null);
    const input: SetupInput = {
      displayName: values.displayName,
      email: values.email,
      password: values.password,
      createSampleData: values.createSampleData,
      setupCode: codeRequired ? values.setupCode.trim() : undefined,
      today: localToday(),
    };
    const parsed = setupInput.safeParse(input);
    const fe = parsed.success ? {} : zodFieldErrors(parsed.error);
    const minLength = status?.instance.passwordMinLength ?? LIMITS.passwordMin;
    if (!fe.password && values.password.length < minLength) fe.password = `At least ${minLength} characters`;
    if (codeRequired && !values.setupCode.trim()) fe.setupCode = 'Required';
    if (!parsed.success || Object.keys(fe).length > 0) {
      setErrors(fe);
      focusFirstError(fe);
      return;
    }
    setErrors({});
    setup.mutate(input, {
      onError: (err) => {
        if (err instanceof ApiError && err.status === 409) {
          // Someone else finished setup meanwhile: the auth gate will switch to sign-in.
          void qc.invalidateQueries({ queryKey: qk.authStatus });
          return;
        }
        if (err instanceof ApiError && err.status === 403) {
          const fe2: FieldErrors = { setupCode: codeHelp.invalid };
          setErrors(fe2);
          focusFirstError(fe2);
          return;
        }
        const fe2 = apiFieldErrors(err);
        setErrors(fe2);
        focusFirstError(fe2);
        setFormError(authErrorMessage(err));
      },
    });
  };

  return (
    <AuthLayout
      wide
      title="Welcome to Lyren Plan"
      subtitle="Create the owner account for this server."
      footer={status?.version ? <p>Lyren Plan {status.version}</p> : undefined}
    >
      <form method="post" noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
        {codeRequired && (
          <Field
            label="Setup code"
            required
            error={errors.setupCode}
            hint={
              linkCode && values.setupCode === linkCode
                ? 'Filled in from the link Lyren Plan opened.'
                : codeHelp.hint
            }
          >
            <Input
              ref={refs.setupCode}
              name="setupCode"
              value={values.setupCode}
              onChange={set('setupCode')}
              autoComplete="one-time-code"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              autoFocus={!linkCode}
              maxLength={200}
              className="font-mono"
            />
          </Field>
        )}
        <Field label="Your name" required error={errors.displayName}>
          <Input
            ref={refs.displayName}
            name="name"
            value={values.displayName}
            onChange={set('displayName')}
            autoComplete="name"
            autoFocus={!codeRequired || Boolean(linkCode)}
            maxLength={LIMITS.displayNameMax}
          />
        </Field>
        <Field label="Email" required error={errors.email} hint="Used to sign in.">
          <Input
            ref={refs.email}
            type="email"
            name="email"
            value={values.email}
            onChange={set('email')}
            autoComplete="email"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            maxLength={LIMITS.identifierMax}
          />
        </Field>
        <Field
          label="Password"
          required
          error={errors.password}
          hint={`At least ${status?.instance.passwordMinLength ?? LIMITS.passwordMin} characters.`}
        >
          <PasswordInput
            ref={refs.password}
            name="new-password"
            value={values.password}
            onChange={set('password')}
            autoComplete="new-password"
            maxLength={LIMITS.passwordMax}
          />
        </Field>
        <Checkbox
          checked={values.createSampleData}
          onCheckedChange={(checked) => setValues((v) => ({ ...v, createSampleData: checked }))}
          label="Create sample data"
          description="A demo project with milestones, epics, tasks and boards to explore. Delete it any time."
          className="mt-1"
        />
        {formError && <FormAlert>{formError}</FormAlert>}
        <Button type="submit" variant="primary" fullWidth loading={setup.isPending} className="mt-1">
          Create account
        </Button>
      </form>
    </AuthLayout>
  );
}
