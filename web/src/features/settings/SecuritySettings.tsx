// Account settings → Security: the password (change it; set one, for an account that signs in with passkeys
// only; remove it, §5.8.12), the passkeys where they are available (lib/passkeys.ts: list, add, rename,
// remove, the nudges of §5.6), the signed-in devices (this one marked, sign out one or all others) and the
// recent security events (design §12.2, §5.11).

import { clsx } from 'clsx';
import { KeyRound, Monitor, MoreHorizontal, Pencil, Smartphone, Tablet, Trash2 } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { LIMITS } from '@shared/constants';
import { changePasswordInput } from '@shared/schemas';
import type { PasskeyDTO, SecurityEventDTO, SessionDTO } from '@shared/types';
import { useChangePassword, useRevokeOtherSessions, useRevokeSession, useSecurityEvents, useSessions } from '../../api/account';
import { useAccount, useAuthStatus } from '../../api/auth';
import { ApiError } from '../../api/client';
import {
  useAddPasskey,
  usePasskeys,
  usePasskeysAvailable,
  usePreloadedWebAuthn,
  useRemovePasskey,
  useRemovePassword,
  useRenamePasskey,
} from '../../api/passkeys';
import {
  Badge,
  Button,
  ErrorState,
  Field,
  IconButton,
  InlineEdit,
  Menu,
  PasswordInput,
  SkeletonList,
  apiFieldErrors,
  hasFieldErrors,
  toast,
  useConfirm,
  zodFieldErrors,
  type FieldErrors,
} from '../../components/ui';
import { formatDate, formatDateTime, formatRelativeTime, isoToLocalDate, pluralize } from '../../lib/format';
import { failureText, webauthnFailure } from '../../lib/passkeys';
import { canConfirm, reauthMethods, reauthOpen, reauthUnavailableText } from '../account/reauth';
import { ensureReauth } from '../account/ReauthDialog';
import { FormAlert } from '../auth/AuthLayout';
import {
  canAddPasskey,
  cannotConfirmHere,
  offersPasswordRemoval,
  orphanedPasskeyText,
  PASSKEY_LIMIT_TEXT,
  passkeyNudge,
  passkeyRemovalRefusal,
  passkeyStorage,
  proposedPasskeyName,
} from './passkeys';
import { newPasswordErrors } from './passwordStrength';
import { isWarningEvent, securityEventText } from './securityEvents';
import { SettingsCard, SettingsPage } from './SettingsBlocks';
import { StrengthMeter } from './StrengthMeter';
import { describeUserAgent, type DeviceKind } from './userAgent';

// ---------------------------------------------------------------------------
// Password
// ---------------------------------------------------------------------------

const EMPTY_PASSWORDS = { currentPassword: '', newPassword: '', confirm: '' };

/** The password: changed, or set by an account without one (a passkey-only account). */
function PasswordCard({ passkeysHere }: { passkeysHere: boolean }) {
  return useAccount().hasPassword ? <ChangePasswordCard passkeysHere={passkeysHere} /> : <SetPasswordCard passkeysHere={passkeysHere} />;
}

function ChangePasswordCard({ passkeysHere }: { passkeysHere: boolean }) {
  const account = useAccount();
  // The instance's minimum (§5.5): 8 by default, 12 on Cloudflare.
  const min = useAuthStatus().data?.instance.passwordMinLength ?? LIMITS.passwordMin;
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
    if (!next.newPassword && values.newPassword.length < min) next.newPassword = `At least ${min} characters`;
    if (parsed.success && !next.newPassword && values.newPassword === values.currentPassword) {
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
        const fields = apiFieldErrors(err);
        setErrors(fields);
        // A refusal of a field is shown at the field; anything else (a lock-out, the network) as a toast.
        if (!hasFieldErrors(fields)) toast.error(err);
      },
    });
  };

  return (
    <SettingsCard title="Password" description="Changing your password signs you out on every other device.">
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        {/* Lets password managers associate the new password with the account. */}
        <input type="text" name="username" autoComplete="username" value={account.email ?? account.username ?? ''} readOnly hidden />
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
        <StrengthMeter password={values.newPassword} min={min} />
        <Field label="Confirm new password" error={errors.confirm}>
          <PasswordInput value={values.confirm} onChange={set('confirm')} autoComplete="new-password" maxLength={LIMITS.passwordMax} />
        </Field>
        <div className="flex justify-end">
          <Button
            type="submit"
            variant="primary"
            loading={changePassword.isPending}
            disabled={!values.currentPassword || values.newPassword.length < min || !values.confirm}
          >
            Change password
          </Button>
        </div>
      </form>
      {passkeysHere && <RemovePassword />}
    </SettingsCard>
  );
}

/**
 * Signing in with passkeys only (§5.8.12): offered with a passkey that works here. The server also wants a
 * way back in should every passkey be lost, and says why it refuses; the re-auth window comes after that
 * check (the client's re-auth handler asks for it).
 */
function RemovePassword() {
  const account = useAccount();
  const passkeys = usePasskeys();
  const removePassword = useRemovePassword();
  const confirm = useConfirm();
  const [refusal, setRefusal] = useState<string | null>(null);
  if (!offersPasswordRemoval({ hasPassword: account.hasPassword, passkeys: passkeys.data ?? [] })) return null;

  const remove = async () => {
    setRefusal(null);
    const ok = await confirm({
      title: 'Remove your password?',
      body: 'You then sign in with your passkeys only. Keep a passkey on more than one device, or one that is synced: should you lose them all, only a reset link gets you back in.',
      confirmLabel: 'Remove password',
      danger: true,
    });
    if (!ok) return;
    try {
      await removePassword.mutateAsync();
      toast.success('Password removed. You sign in with your passkeys now.');
    } catch (err) {
      // No way back in, or no passkey that works here (anymore): said where the button is.
      if (err instanceof ApiError && err.status === 409) setRefusal(err.message);
      else toast.error(err);
    }
  };

  return (
    <div className="mt-4 flex flex-col gap-3 border-t border-border pt-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-medium text-fg">Sign in with passkeys only</p>
          <p className="mt-0.5 text-[13px] text-fg-muted">Remove your password, so that nobody can sign in to your account with it.</p>
        </div>
        <Button variant="danger" size="sm" className="self-start sm:self-auto" onClick={() => void remove()} loading={removePassword.isPending}>
          Remove password
        </Button>
      </div>
      {refusal && <FormAlert>{refusal}</FormAlert>}
    </div>
  );
}

const EMPTY_NEW_PASSWORD = { newPassword: '', confirm: '' };

/**
 * An account without a password (it signs in with passkeys) sets one; the re-auth window stands in for the
 * current one. Without a passkey that works here (passkeys off, another address, a domain move) the window
 * cannot be opened: unless it is open, the card says how a reset link helps instead of offering a dead end.
 */
function SetPasswordCard({ passkeysHere }: { passkeysHere: boolean }) {
  const account = useAccount();
  const status = useAuthStatus().data;
  const min = status?.instance.passwordMinLength ?? LIMITS.passwordMin;
  const passkeys = usePasskeys({ enabled: passkeysHere && account.passkeyCount > 0 });
  const methods = reauthMethods({
    hasPassword: false,
    passkeysHere,
    passkeyCount: account.passkeyCount,
    passkeys: passkeys.data,
    listFailed: passkeys.isError,
  });
  const stuck = !canConfirm(methods) && !reauthOpen(status?.reauthUntil);
  const changePassword = useChangePassword();
  const [values, setValues] = useState(EMPTY_NEW_PASSWORD);
  const [errors, setErrors] = useState<FieldErrors>({});

  const set = (key: keyof typeof EMPTY_NEW_PASSWORD) => (e: { target: { value: string } }) => {
    setValues((v) => ({ ...v, [key]: e.target.value }));
    if (errors[key]) setErrors((x) => ({ ...x, [key]: undefined }));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const fe = newPasswordErrors(values.newPassword, values.confirm, min);
    const next: FieldErrors = { newPassword: fe.password, confirm: fe.confirm };
    setErrors(next);
    if (hasFieldErrors(next) || !(await ensureReauth())) return;
    changePassword.mutate(
      { newPassword: values.newPassword },
      {
        onSuccess: () => {
          setValues(EMPTY_NEW_PASSWORD);
          toast.success('Password set. Your other devices were signed out.');
        },
        onError: (err) => {
          const fields = apiFieldErrors(err);
          setErrors(fields);
          if (!hasFieldErrors(fields)) toast.error(err);
        },
      },
    );
  };

  return (
    <SettingsCard title="Password" description="Your account has no password: you sign in with a passkey. A password lets you sign in where your passkeys are not at hand.">
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4" noValidate>
        <input type="text" name="username" autoComplete="username" value={account.email ?? account.username ?? ''} readOnly hidden />
        <Field label="New password" error={errors.newPassword}>
          <PasswordInput value={values.newPassword} onChange={set('newPassword')} autoComplete="new-password" maxLength={LIMITS.passwordMax} />
        </Field>
        <StrengthMeter password={values.newPassword} min={min} />
        <Field label="Confirm new password" error={errors.confirm}>
          <PasswordInput value={values.confirm} onChange={set('confirm')} autoComplete="new-password" maxLength={LIMITS.passwordMax} />
        </Field>
        {stuck && (
          <p role="status" className="rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-[13px] text-fg">
            {reauthUnavailableText({ passkeysHere, passkeyCount: account.passkeyCount, mail: status?.instance.mailLinks ?? false })}
          </p>
        )}
        <div className="flex justify-end">
          <Button type="submit" variant="primary" loading={changePassword.isPending} disabled={stuck || values.newPassword.length < min || !values.confirm}>
            Set password
          </Button>
        </div>
      </form>
    </SettingsCard>
  );
}

// ---------------------------------------------------------------------------
// Passkeys
// ---------------------------------------------------------------------------

function PasskeyRow({
  passkey,
  refusal,
  stuck,
  onRename,
  onRemove,
}: {
  passkey: PasskeyDTO;
  /** Why it cannot be removed (the last one of an account without a password), else null. */
  refusal: string | null;
  /** The account cannot confirm it is you here, so removing (which needs that) is not offered. */
  stuck: boolean;
  onRename: (name: string) => Promise<unknown>;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const storage = passkeyStorage(passkey);
  const details = [`Added ${formatDate(isoToLocalDate(passkey.createdAt))}`, passkey.lastUsedAt ? `Last used ${formatRelativeTime(passkey.lastUsedAt)}` : 'Not used yet'];
  return (
    <li className="flex min-w-0 items-start gap-3 px-4 py-3">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-fg-muted">
        <KeyRound aria-hidden className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <InlineEdit
          value={passkey.name}
          onSave={onRename}
          aria-label={`Name of the passkey “${passkey.name}”`}
          maxLength={LIMITS.passkeyNameMax}
          editing={editing}
          onEditingChange={setEditing}
          className="text-sm font-medium text-fg"
        />
        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          {passkey.rpIdMatches ? (
            <Badge title={storage.hint}>{storage.label}</Badge>
          ) : (
            <Badge variant="warning">Doesn’t work here</Badge>
          )}
          <span className="text-[13px] text-fg-muted" title={passkey.lastUsedAt ? formatDateTime(passkey.lastUsedAt) : undefined}>
            {details.join(' · ')}
          </span>
        </div>
        {!passkey.rpIdMatches && <p className="mt-1 text-[13px] text-fg-muted">{orphanedPasskeyText(stuck)}</p>}
        {refusal && <p className="mt-1 text-[13px] text-fg-muted">{refusal}</p>}
      </div>
      <Menu
        label={`Passkey “${passkey.name}”`}
        trigger={<IconButton aria-label={`Actions for the passkey “${passkey.name}”`} icon={<MoreHorizontal />} size="sm" />}
        items={[
          { label: 'Rename', icon: <Pencil />, onSelect: () => setEditing(true) },
          { separator: true },
          { label: 'Remove…', icon: <Trash2 />, danger: true, disabled: refusal !== null || stuck, onSelect: onRemove },
        ]}
      />
    </li>
  );
}

function PasskeysCard() {
  const account = useAccount();
  const status = useAuthStatus().data;
  const passkeys = usePasskeys();
  usePreloadedWebAuthn(true);
  const add = useAddPasskey();
  const rename = useRenamePasskey();
  const remove = useRemovePasskey();
  const confirm = useConfirm();
  // A refusal or a failed ceremony, said in the card (a toast would go before it is read).
  const [problem, setProblem] = useState<string | null>(null);
  const list = passkeys.data ?? [];
  const nudge = passkeys.data ? passkeyNudge({ hasPassword: account.hasPassword, passkeys: list, mail: status?.instance.mailLinks ?? false }) : null;
  const room = canAddPasskey(list.length);
  // Adding one needs the re-auth window, which such an account cannot open here (the nudge says what helps).
  const stuck = cannotConfirmHere({ hasPassword: account.hasPassword, passkeys: list }) && !reauthOpen(status?.reauthUntil);

  const addPasskey = async () => {
    setProblem(null);
    if (!(await ensureReauth())) return;
    const name = proposedPasskeyName(navigator.userAgent, list.map((p) => p.name));
    try {
      const passkey = await add.mutateAsync(name);
      toast.success(`Passkey “${passkey.name}” added. You can rename it here.`);
    } catch (err) {
      setProblem(failureText(webauthnFailure(err, 'create'), 'create'));
    }
  };

  const removePasskey = async (passkey: PasskeyDTO) => {
    setProblem(null);
    const ok = await confirm({
      title: `Remove the passkey “${passkey.name}”?`,
      body: passkey.rpIdMatches
        ? 'You can no longer sign in with it. Your device or password manager may still list it: delete it there too.'
        : 'It does not work on this address anyway.',
      confirmLabel: 'Remove',
      danger: true,
    });
    // The removal is offered only where the server allows it (passkeyRemovalRefusal), so the window is asked
    // for first, as for adding one.
    if (!ok || !(await ensureReauth())) return;
    try {
      await remove.mutateAsync(passkey.id);
      toast.success(`Passkey “${passkey.name}” removed`);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'last_credential') setProblem(err.message);
      else toast.error(err);
    }
  };

  return (
    <SettingsCard
      title="Passkeys"
      description={
        <>
          Sign in with your fingerprint, your face or your device’s screen lock instead of a password.
          {!room && <> {PASSKEY_LIMIT_TEXT}</>}
        </>
      }
      flush
      actions={
        <Button size="sm" icon={<KeyRound aria-hidden />} onClick={() => void addPasskey()} loading={add.isPending} disabled={!passkeys.data || !room || stuck}>
          Add a passkey
        </Button>
      }
    >
      {(nudge || problem) && (
        <div className="flex flex-col gap-2 px-4 pb-3">
          {nudge && (
            <p role="status" className="rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-[13px] text-fg">
              {nudge}
            </p>
          )}
          {problem && <FormAlert>{problem}</FormAlert>}
        </div>
      )}
      {passkeys.isPending ? (
        <SkeletonList rows={1} className="px-4 pb-3" />
      ) : passkeys.error ? (
        <ErrorState size="sm" error={passkeys.error} onRetry={() => void passkeys.refetch()} />
      ) : list.length === 0 ? (
        <p className="border-t border-border px-4 py-3 text-sm text-fg-muted">No passkeys yet. Add one to sign in without typing your password.</p>
      ) : (
        <ul className="divide-y divide-border border-t border-border" aria-label="Passkeys">
          {list.map((p) => (
            <PasskeyRow
              key={p.id}
              passkey={p}
              refusal={passkeyRemovalRefusal({ hasPassword: account.hasPassword, passkeys: list, passkey: p })}
              stuck={stuck}
              onRename={(name) => rename.mutateAsync({ id: p.id, name }).catch((err: unknown) => toast.error(err))}
              onRemove={() => void removePasskey(p)}
            />
          ))}
        </ul>
      )}
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
    `Signed in ${formatDateTime(session.createdAt)}${session.authMethod === 'passkey' ? ' with a passkey' : ''}`,
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
// Security events
// ---------------------------------------------------------------------------

function EventRow({ event, spaceNames }: { event: SecurityEventDTO; spaceNames: ReadonlyMap<string, string> }) {
  const device = event.userAgent ? describeUserAgent(event.userAgent).label : null;
  const details = [formatDateTime(event.createdAt), event.ip, device].filter(Boolean);
  return (
    <li className="flex min-w-0 flex-col gap-0.5 px-4 py-2.5">
      <span className={clsx('text-sm', isWarningEvent(event.type) ? 'font-medium text-warning' : 'text-fg')}>
        {securityEventText(event, spaceNames)}
      </span>
      <span className="text-[13px] text-fg-muted" title={event.userAgent ?? undefined}>
        {details.join(' · ')}
      </span>
    </li>
  );
}

function SecurityEventsCard() {
  const events = useSecurityEvents();
  const spaces = useAuthStatus().data?.spaces;
  const spaceNames = useMemo(() => new Map((spaces ?? []).map((s) => [s.id, s.name])), [spaces]);
  const list = events.data?.pages.flat() ?? [];
  return (
    <SettingsCard
      title="Recent security events"
      description="Sign-ins, password changes and other changes to your account’s security, kept for 90 days."
      flush
      footer={
        events.hasNextPage ? (
          <Button size="sm" onClick={() => void events.fetchNextPage()} loading={events.isFetchingNextPage}>
            Show older events
          </Button>
        ) : undefined
      }
    >
      {events.isPending ? (
        <SkeletonList rows={3} className="px-4 pb-3" />
      ) : events.error ? (
        <ErrorState size="sm" error={events.error} onRetry={() => void events.refetch()} />
      ) : list.length === 0 ? (
        <p className="border-t border-border px-4 py-3 text-sm text-fg-muted">No events yet.</p>
      ) : (
        <ul className="divide-y divide-border border-t border-border" aria-label="Security events">
          {list.map((e) => (
            <EventRow key={e.id} event={e} spaceNames={spaceNames} />
          ))}
        </ul>
      )}
    </SettingsCard>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function SecuritySettings() {
  const passkeysHere = usePasskeysAvailable();
  return (
    <SettingsPage
      title="Security"
      description={
        passkeysHere
          ? 'Your password and passkeys, where you are signed in, and what happened to your account lately.'
          : 'Your password, where you are signed in, and what happened to your account lately.'
      }
    >
      <PasswordCard passkeysHere={passkeysHere} />
      {passkeysHere && <PasskeysCard />}
      <SessionsCard />
      <SecurityEventsCard />
    </SettingsPage>
  );
}
