// Settings → Account: profile (display name), password, signed-in devices, sign out, version.

import { clsx } from 'clsx';
import { LogOut, Monitor, Smartphone, Tablet } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { LIMITS } from '@shared/constants';
import { changePasswordInput, updateMeInput } from '@shared/schemas';
import type { SessionDTO } from '@shared/types';
import {
  useChangePassword,
  useLogout,
  useRevokeOtherSessions,
  useRevokeSession,
  useSessions,
  useUpdateMe,
} from '../../api/auth';
import { useBootstrap, useLookups } from '../../api/bootstrap';
import {
  Badge,
  Button,
  ErrorState,
  Field,
  Input,
  PasswordInput,
  SkeletonList,
  apiFieldErrors,
  toast,
  useConfirm,
  zodFieldErrors,
  type FieldErrors,
} from '../../components/ui';
import { formatDateTime, formatRelativeTime, pluralize } from '../../lib/format';
import { passwordStrength } from './passwordStrength';
import { SettingsCard, SettingsPage } from './SettingsBlocks';
import { describeUserAgent, type DeviceKind } from './userAgent';

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

function ProfileCard() {
  const { user } = useLookups();
  const updateMe = useUpdateMe();
  const [name, setName] = useState(user.displayName);
  const [error, setError] = useState<string | undefined>();
  useEffect(() => setName(user.displayName), [user.displayName]);

  const changed = name.trim() !== user.displayName;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = updateMeInput.safeParse({ displayName: name });
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
    <SettingsCard title="Profile" description="How you appear in comments, work logs and history.">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Username" hint="Used to sign in. Can’t be changed.">
          <Input value={user.username} readOnly autoComplete="username" className="read-only:bg-surface-2 read-only:text-fg-muted read-only:shadow-none" />
        </Field>
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
        <div className="flex justify-end">
          <Button type="submit" variant="primary" disabled={!changed} loading={updateMe.isPending}>
            Save name
          </Button>
        </div>
      </form>
    </SettingsCard>
  );
}

// ---------------------------------------------------------------------------
// Password
// ---------------------------------------------------------------------------

const STRENGTH_COLORS = ['bg-danger', 'bg-danger', 'bg-warning', 'bg-success', 'bg-success'] as const;

function StrengthMeter({ password }: { password: string }) {
  const s = passwordStrength(password);
  return (
    <div className="flex flex-col gap-1.5" aria-live="polite">
      <div className="flex gap-1" aria-hidden>
        {[1, 2, 3, 4].map((i) => (
          <span
            key={i}
            className={clsx('h-1 flex-1 rounded-full transition-colors', password && s.score >= i ? STRENGTH_COLORS[s.score] : 'bg-surface-3')}
          />
        ))}
      </div>
      <p className="text-xs text-fg-muted">
        {s.label && <span className="font-medium text-fg">{s.label}. </span>}
        {s.hint}
      </p>
    </div>
  );
}

const EMPTY_PASSWORDS = { currentPassword: '', newPassword: '', confirm: '' };

function PasswordCard() {
  const { user } = useLookups();
  const changePassword = useChangePassword();
  const [values, setValues] = useState(EMPTY_PASSWORDS);
  const [errors, setErrors] = useState<FieldErrors>({});

  const set = (key: keyof typeof EMPTY_PASSWORDS) => (e: { target: { value: string } }) => {
    setValues((v) => ({ ...v, [key]: e.target.value }));
    if (errors[key]) setErrors((x) => ({ ...x, [key]: undefined }));
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = changePasswordInput.safeParse(values);
    const next: FieldErrors = parsed.success ? {} : zodFieldErrors(parsed.error);
    if (!values.confirm) next.confirm = 'Required';
    else if (values.confirm !== values.newPassword) next.confirm = 'Passwords don’t match';
    if (parsed.success && values.newPassword === values.currentPassword) {
      next.newPassword = 'Choose a password different from the current one';
    }
    setErrors(next);
    if (!parsed.success || Object.values(next).some(Boolean)) return;
    changePassword.mutate(parsed.data, {
      onSuccess: () => {
        setValues(EMPTY_PASSWORDS);
        toast.success('Password changed. Your other devices were signed out.');
      },
      onError: (err) => {
        setErrors(apiFieldErrors(err));
        toast.error(err);
      },
    });
  };

  return (
    <SettingsCard title="Password" description="Changing your password signs you out on every other device.">
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        {/* Lets password managers associate the new password with the account. */}
        <input type="text" name="username" autoComplete="username" value={user.username} readOnly hidden />
        <Field label="Current password" error={errors.currentPassword}>
          <PasswordInput value={values.currentPassword} onChange={set('currentPassword')} autoComplete="current-password" />
        </Field>
        <Field label="New password" error={errors.newPassword}>
          <PasswordInput
            value={values.newPassword}
            onChange={set('newPassword')}
            autoComplete="new-password"
            maxLength={LIMITS.passwordMax}
          />
        </Field>
        <StrengthMeter password={values.newPassword} />
        <Field label="Confirm new password" error={errors.confirm}>
          <PasswordInput value={values.confirm} onChange={set('confirm')} autoComplete="new-password" maxLength={LIMITS.passwordMax} />
        </Field>
        <div className="flex justify-end">
          <Button
            type="submit"
            variant="primary"
            loading={changePassword.isPending}
            disabled={!values.currentPassword || !values.newPassword || !values.confirm}
          >
            Change password
          </Button>
        </div>
      </form>
    </SettingsCard>
  );
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

const DEVICE_ICONS: Record<DeviceKind, typeof Monitor> = { desktop: Monitor, mobile: Smartphone, tablet: Tablet };

function SessionRow({ session, onRevoke, revoking }: { session: SessionDTO; onRevoke: () => void; revoking: boolean }) {
  const device = describeUserAgent(session.userAgent);
  const Icon = DEVICE_ICONS[device.kind];
  const details = [
    session.ip,
    session.current ? 'Active now' : `Last active ${formatRelativeTime(session.lastSeenAt)}`,
    `Signed in ${formatDateTime(session.createdAt)}`,
  ].filter(Boolean);
  return (
    <li className="flex min-w-0 items-center gap-3 px-4 py-3">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-fg-muted">
        <Icon aria-hidden className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate text-sm font-medium text-fg" title={session.userAgent ?? undefined}>
            {device.label}
          </span>
          {session.current && <Badge variant="success">This device</Badge>}
        </div>
        <p className="mt-0.5 text-[13px] text-fg-muted">{details.join(' · ')}</p>
      </div>
      {!session.current && (
        <Button size="sm" onClick={onRevoke} loading={revoking} aria-label={`Sign out ${device.label}${session.ip ? ` (${session.ip})` : ''}`}>
          Sign out
        </Button>
      )}
    </li>
  );
}

function SessionsCard() {
  const sessions = useSessions();
  const revoke = useRevokeSession();
  const revokeOthers = useRevokeOtherSessions();
  const confirm = useConfirm();
  const others = sessions.data?.filter((s) => !s.current).length ?? 0;

  const revokeAllOthers = async () => {
    const ok = await confirm({
      title: 'Sign out all other devices?',
      body: `${pluralize(others, 'other session')} will be signed out. This device stays signed in.`,
      confirmLabel: 'Sign out others',
      danger: true,
    });
    if (!ok) return;
    revokeOthers.mutate(undefined, {
      onSuccess: (res) => toast.success(`Signed out ${pluralize(res.revoked, 'other session')}`),
      onError: (err) => toast.error(err),
    });
  };

  return (
    <SettingsCard
      title="Signed-in devices"
      description="Browsers and apps where you’re signed in. Sign out any you don’t recognise."
      flush
      footer={
        others > 0 ? (
          <Button variant="danger" size="sm" onClick={revokeAllOthers} loading={revokeOthers.isPending}>
            Sign out all other devices
          </Button>
        ) : undefined
      }
    >
      {sessions.isPending ? (
        <SkeletonList rows={2} className="px-4 pb-3" />
      ) : sessions.error ? (
        <ErrorState size="sm" error={sessions.error} onRetry={() => void sessions.refetch()} />
      ) : (
        <ul className="divide-y divide-border border-t border-border" aria-label="Sessions">
          {sessions.data.map((s) => (
            <SessionRow
              key={s.id}
              session={s}
              revoking={revoke.isPending && revoke.variables === s.id}
              onRevoke={() =>
                revoke.mutate(s.id, {
                  onSuccess: () => toast.success(`Signed out ${describeUserAgent(s.userAgent).label}`),
                  onError: (err) => toast.error(err),
                })
              }
            />
          ))}
        </ul>
      )}
    </SettingsCard>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/** The Sign out card's text. The desktop app (BootstrapDTO.desktop) keeps the data in its data folder, not on a server. */
export function signOutDescription(desktop: boolean): string {
  return `Sign out of Lyren Plan on this device. Your data stays ${
    desktop ? 'in the data folder on the computer that runs Lyren Plan' : 'on the server'
  }.`;
}

export default function AccountSettings() {
  const { user, version } = useLookups();
  // Set only by the single-file desktop app.
  const desktop = useBootstrap().data?.desktop !== undefined;
  const logout = useLogout();
  return (
    <SettingsPage title="Account" description={`Signed in as ${user.username}.`}>
      <ProfileCard />
      <PasswordCard />
      <SessionsCard />
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
