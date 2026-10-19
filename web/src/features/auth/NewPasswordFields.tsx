// A new password and its confirmation, as the pages that set one ask for it (sign-up, reset, accepting an
// invitation as a new account): the instance's minimum in the hint (design §5.5), the strength meter, and
// the account's address in a hidden field so that password managers save the pair.

import { LIMITS } from '@shared/constants';
import { Field } from '../../components/ui/Field';
import { PasswordInput } from '../../components/ui/Input';
import { StrengthMeter } from '../settings/StrengthMeter';

export interface NewPasswordValues {
  password: string;
  confirm: string;
}

export function NewPasswordFields({
  values,
  errors,
  onChange,
  min,
  username,
  label = 'Password',
}: {
  values: NewPasswordValues;
  errors: { password?: string; confirm?: string };
  onChange: (key: keyof NewPasswordValues, value: string) => void;
  /** AuthStatusDTO.instance.passwordMinLength. */
  min: number;
  /** The address (or username) the password is for. */
  username: string;
  label?: string;
}) {
  return (
    <>
      <input type="text" name="username" autoComplete="username" value={username} readOnly hidden />
      <Field label={label} required error={errors.password} hint={`At least ${min} characters.`}>
        <PasswordInput
          name="new-password"
          value={values.password}
          onChange={(e) => onChange('password', e.target.value)}
          autoComplete="new-password"
          maxLength={LIMITS.passwordMax}
        />
      </Field>
      {values.password && <StrengthMeter password={values.password} min={min} />}
      <Field label="Confirm password" required error={errors.confirm}>
        <PasswordInput
          name="confirm-password"
          value={values.confirm}
          onChange={(e) => onChange('confirm', e.target.value)}
          autoComplete="new-password"
          maxLength={LIMITS.passwordMax}
        />
      </Field>
    </>
  );
}
