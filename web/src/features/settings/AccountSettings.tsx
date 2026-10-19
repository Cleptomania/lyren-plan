// Account settings → Profile: the display name (and the username of an account from before spaces), the
// email address with its verification and changes (EmailCard), signing out, and the version.

import { LogOut } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { LIMITS } from '@shared/constants';
import { updateAccountInput } from '@shared/schemas';
import { useUpdateAccount } from '../../api/account';
import { useAccount, useAuthStatus, useLogout } from '../../api/auth';
import { Button, Field, Input, apiFieldErrors, toast, zodFieldErrors } from '../../components/ui';
import { EmailCard } from './EmailCard';
import { SettingsCard, SettingsPage } from './SettingsBlocks';

const READ_ONLY = 'read-only:bg-surface-2 read-only:text-fg-muted read-only:shadow-none';

function ProfileCard() {
  const user = useAccount();
  const updateMe = useUpdateAccount();
  const [name, setName] = useState(user.displayName);
  const [error, setError] = useState<string | undefined>();
  useEffect(() => setName(user.displayName), [user.displayName]);

  const changed = name.trim() !== user.displayName;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = updateAccountInput.safeParse({ displayName: name });
    if (!parsed.success) return setError(zodFieldErrors(parsed.error).displayName);
    setError(undefined);
    updateMe.mutate(parsed.data, {
      onSuccess: () => toast.success('Display name updated'),
      onError: (err) => {
        setError(apiFieldErrors(err).displayName);
        toast.error(err);
      },
    });
  };

  return (
    <SettingsCard title="Profile" description="How you appear to the members of your spaces: in comments, work logs and history.">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Display name" error={error}>
          <Input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (error) setError(undefined);
            }}
            maxLength={LIMITS.displayNameMax}
            autoComplete="name"
          />
        </Field>
        {user.username !== null && (
          <Field label="Username" hint="The sign-in name of an account from before spaces. It still works for signing in.">
            <Input value={user.username} readOnly autoComplete="username" className={READ_ONLY} />
          </Field>
        )}
        <div className="flex justify-end">
          <Button type="submit" variant="primary" disabled={!changed} loading={updateMe.isPending}>
            Save name
          </Button>
        </div>
      </form>
    </SettingsCard>
  );
}

/** The Sign out card's text. The desktop app (AuthStatusDTO.desktop) keeps the data in its data folder, not on a server. */
export function signOutDescription(desktop: boolean): string {
  return `Sign out of Lyren Plan on this device. Your data stays ${
    desktop ? 'in the data folder on the computer that runs Lyren Plan' : 'on the server'
  }.`;
}

export default function AccountSettings() {
  const account = useAccount();
  const status = useAuthStatus().data;
  const version = status?.version;
  // Set only by the single-file desktop app.
  const desktop = status?.desktop !== undefined;
  const logout = useLogout();
  return (
    <SettingsPage title="Profile" description={`Signed in as ${account.email ?? account.username}.`}>
      <ProfileCard />
      <EmailCard />
      <SettingsCard
        title="Sign out"
        description={signOutDescription(desktop)}
        actions={
          <Button
            icon={<LogOut aria-hidden />}
            loading={logout.isPending}
            onClick={() => logout.mutate(undefined, { onError: (err) => toast.error(err) })}
          >
            Sign out
          </Button>
        }
      />
      <p className="text-center text-xs text-fg-subtle">
        Lyren Plan <span className="font-mono">{version}</span> · self-hosted
      </p>
    </SettingsPage>
  );
}
