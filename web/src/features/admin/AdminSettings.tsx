// Administration → Settings (design §5.3, §5.5): who can create an account (the signup policy, each choice
// explained; `open` needs mail) and the minimum length of new passwords. Both affect what happens from now
// on only. Saving asks for the password first when the re-auth window is closed (§5.4.4).

import { clsx } from 'clsx';
import { useState, type FormEvent } from 'react';
import type { SignupPolicy } from '@shared/constants';
import { useUpdateInstanceSettings } from '../../api/admin';
import { useAuthStatus } from '../../api/auth';
import { Button, Field, Input, toast } from '../../components/ui';
import { ensureReauth } from '../account/ReauthDialog';
import { SettingsCard, SettingsPage } from '../settings/SettingsBlocks';
import { parsePasswordMinimum, POLICY_CHOICES, policyUnavailable, settingsChange } from './settings';

function PolicyCard({ current, mail, minLength }: { current: SignupPolicy; mail: boolean; minLength: number }) {
  const update = useUpdateInstanceSettings();
  const [policy, setPolicy] = useState<SignupPolicy>(current);
  const [saved, setSaved] = useState(current);
  // Follow a change made elsewhere (another admin, the command line) while nothing is being edited.
  if (current !== saved) {
    setSaved(current);
    setPolicy(current);
  }
  const change = settingsChange({ signupPolicy: current, passwordMinLength: minLength }, { signupPolicy: policy, passwordMinLength: minLength });

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!change || !(await ensureReauth())) return;
    update.mutate(change, {
      onSuccess: () => toast.success('Sign-up policy saved'),
      onError: (err) => toast.error(err),
    });
  };

  return (
    <SettingsCard
      title="Who can create an account"
      description="A change affects only accounts created from now on: existing accounts stay, and pending invitations are checked against the policy when they are accepted."
      footer={
        <Button type="submit" form="signup-policy" variant="primary" loading={update.isPending} disabled={!change}>
          Save
        </Button>
      }
    >
      <form id="signup-policy" onSubmit={(e) => void save(e)}>
        <fieldset className="flex flex-col gap-2">
          <legend className="sr-only">Sign-up policy</legend>
          {POLICY_CHOICES.map((choice) => {
            const unavailable = choice.value !== current ? policyUnavailable(choice.value, mail) : null;
            const checked = policy === choice.value;
            return (
              <label
                key={choice.value}
                className={clsx(
                  'flex items-start gap-3 rounded-lg border p-3 transition-colors',
                  'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2',
                  checked ? 'border-accent bg-accent-soft' : 'border-border',
                  unavailable ? 'cursor-not-allowed opacity-70' : 'cursor-pointer hover:border-border-strong',
                )}
              >
                <input
                  type="radio"
                  name="signupPolicy"
                  value={choice.value}
                  checked={checked}
                  disabled={unavailable !== null}
                  onChange={() => setPolicy(choice.value)}
                  className="mt-0.5 size-4 shrink-0 accent-accent focus-visible:outline-none"
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-fg">
                    {choice.label}
                    {choice.value === current && <span className="ml-2 text-[12px] font-normal text-fg-muted">(current)</span>}
                  </span>
                  <span className="mt-0.5 block text-[13px] text-fg-muted">{choice.description}</span>
                  {unavailable && <span className="mt-1 block text-[13px] font-medium text-warning">{unavailable}</span>}
                </span>
              </label>
            );
          })}
        </fieldset>
      </form>
    </SettingsCard>
  );
}

function PasswordCard({ current, policy }: { current: number; policy: SignupPolicy }) {
  const update = useUpdateInstanceSettings();
  const [text, setText] = useState(String(current));
  const [saved, setSaved] = useState(current);
  const [error, setError] = useState<string | undefined>();
  if (current !== saved) {
    setSaved(current);
    setText(String(current));
  }
  const parsed = parsePasswordMinimum(text);
  const dirty = 'value' in parsed ? parsed.value !== current : text.trim() !== String(current);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if ('error' in parsed) return setError(parsed.error);
    const change = settingsChange({ signupPolicy: policy, passwordMinLength: current }, { signupPolicy: policy, passwordMinLength: parsed.value });
    if (!change || !(await ensureReauth())) return;
    update.mutate(change, {
      onSuccess: () => toast.success('Password minimum saved'),
      onError: (err) => toast.error(err),
    });
  };

  return (
    <SettingsCard
      title="Minimum password length"
      description="For passwords chosen from now on (new accounts, changes and resets). Existing passwords keep working."
      footer={
        <Button type="submit" form="password-minimum" variant="primary" loading={update.isPending} disabled={!dirty}>
          Save
        </Button>
      }
    >
      <form id="password-minimum" onSubmit={(e) => void save(e)} noValidate>
        <Field label="Characters, at least" error={error} hint="From 8 to 64. Long passphrases are easier to remember than short complicated passwords.">
          <Input
            type="number"
            inputMode="numeric"
            min={8}
            max={64}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              if (error) setError(undefined);
            }}
            className="max-w-32"
          />
        </Field>
      </form>
    </SettingsCard>
  );
}

export default function AdminSettings() {
  const instance = useAuthStatus().data?.instance;
  if (!instance) return null;
  return (
    <SettingsPage title="Settings" description="Who can join this instance, and how strong passwords must be.">
      <PolicyCard current={instance.signupPolicy} mail={instance.mailLinks} minLength={instance.passwordMinLength} />
      <PasswordCard current={instance.passwordMinLength} policy={instance.signupPolicy} />
    </SettingsPage>
  );
}
