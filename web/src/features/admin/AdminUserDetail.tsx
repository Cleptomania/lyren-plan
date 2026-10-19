// Administration → Users → one account (design §5.8.11, §5.8.17, §5.8.18): what it is, its spaces and
// security log, and what an administrator can do with it: disable or enable it, give or take administrator
// rights (never one's own account), create a password reset link (not for an administrator) and delete it
// with the typed confirmation. Every action asks for the password first when the re-auth window is closed.

import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, KeyRound, ShieldMinus, ShieldPlus, TriangleAlert, UserCheck, UserMinus, UserX } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { AdminUserDetailDTO, ResetLinkDTO } from '@shared/types';
import { forgetAdminUser, useAdminUser, useCreateResetLink, useDeleteAdminUser, useUpdateAdminUser } from '../../api/admin';
import { useAccount, useAuthStatus } from '../../api/auth';
import { ApiError } from '../../api/client';
import { lastOwnerSpaces } from '../../api/errors';
import { ROLE_LABELS } from '../../app/permissions';
import { Avatar, Badge, Button, Dialog, ErrorState, ShareLinkField, SkeletonList, SkeletonText, toast, useConfirm } from '../../components/ui';
import { formatDateTime, formatRelativeTime } from '../../lib/format';
import { useDocumentTitle } from '../../lib/hooks';
import { ensureReauth } from '../account/ReauthDialog';
import { securityEventText } from '../settings/securityEvents';
import { SettingRow, SettingRows, SettingsCard } from '../settings/SettingsBlocks';
import { deleteConfirmation, resetLinkNote, resetLinkResult, signInMethodsText, userActions, userBadges, userIdentifier } from './users';

function BackLink() {
  return (
    <Link to="/admin/users" className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-fg-muted hover:text-fg">
      <ArrowLeft aria-hidden className="size-4" />
      All users
    </Link>
  );
}

function ResetLinkDialog({ result, user, onClose }: { result: ResetLinkDTO | null; user: AdminUserDetailDTO; onClose: () => void }) {
  const shareOrigins = useAuthStatus().data?.instance.shareOrigins ?? [];
  return (
    <Dialog
      open={result !== null}
      onClose={onClose}
      title={result?.sent ? 'Reset link sent' : 'Password reset link'}
      size="md"
      mobileLayout="sheet"
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      {result && (
        <div className="flex flex-col gap-3 text-sm text-fg">
          <p>{resetLinkResult(result, user)}</p>
          {!result.sent && <ShareLinkField link={result.link} shareOrigins={shareOrigins} label="reset link" />}
          <p className="text-[13px] text-fg-muted">They will also see that an administrator created it, the next time they sign in.</p>
        </div>
      )}
    </Dialog>
  );
}

function ActionsCard({ user }: { user: AdminUserDetailDTO }) {
  const account = useAccount();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const update = useUpdateAdminUser(user.id);
  const remove = useDeleteAdminUser(user.id);
  const resetLink = useCreateResetLink(user.id);
  const [link, setLink] = useState<ResetLinkDTO | null>(null);
  const [refusal, setRefusal] = useState<{ message: string; spaces: Array<{ id: string; name: string }> } | null>(null);
  const actions = userActions(user, account.id);
  const name = user.displayName;

  const change = async (input: { status?: 'active' | 'disabled'; isInstanceAdmin?: boolean }, o: { title: string; body: string; label: string; danger?: boolean; done: string }) => {
    if (!(await confirm({ title: o.title, body: o.body, confirmLabel: o.label, danger: o.danger }))) return;
    if (!(await ensureReauth())) return;
    try {
      await update.mutateAsync(input);
      toast.success(o.done);
    } catch (err) {
      toast.error(err);
    }
  };

  const createLink = async () => {
    if (!(await ensureReauth())) return;
    try {
      setLink(await resetLink.mutateAsync());
    } catch (err) {
      toast.error(err);
    }
  };

  const deleteUser = async () => {
    setRefusal(null);
    const ok = await confirm({
      title: `Delete the account of ${name}?`,
      body:
        'The account and its sign-ins are deleted at once. Spaces where it is the only member are deleted with it (restorable for a while). ' +
        'Its comments and work logs stay in the other spaces, marked as from a deleted account. This can’t be undone.',
      confirmLabel: 'Delete account',
      danger: true,
      typeToConfirm: deleteConfirmation(user),
    });
    if (!ok || !(await ensureReauth())) return;
    try {
      await remove.mutateAsync();
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'last_owner' || err.code === 'last_admin')) {
        setRefusal({ message: err.message, spaces: lastOwnerSpaces(err) });
      } else toast.error(err);
      return;
    }
    toast.success(`Deleted the account of ${name}`);
    navigate('/admin/users', { replace: true });
    // Its page is left now: forget it (it would answer 404).
    forgetAdminUser(qc, user.id);
  };

  const note = resetLinkNote(user);
  if (actions.status === null) {
    return (
      <SettingsCard title="Actions" description="This is your own account: another administrator can change it. Your own settings are in Account settings." />
    );
  }
  return (
    <SettingsCard title="Actions">
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-2">
          {actions.status === 'disable' ? (
            <Button
              icon={<UserX aria-hidden />}
              loading={update.isPending && update.variables?.status === 'disabled'}
              onClick={() =>
                void change(
                  { status: 'disabled' },
                  {
                    title: `Disable ${name}?`,
                    body: 'They are signed out everywhere at once and cannot sign in until the account is enabled again. Their open invitations are revoked. They stay members of their spaces.',
                    label: 'Disable',
                    danger: true,
                    done: `Disabled ${name}`,
                  },
                )
              }
            >
              Disable…
            </Button>
          ) : (
            <Button
              icon={<UserCheck aria-hidden />}
              loading={update.isPending && update.variables?.status === 'active'}
              onClick={() =>
                void change({ status: 'active' }, { title: `Enable ${name}?`, body: 'They can sign in again.', label: 'Enable', done: `Enabled ${name}` })
              }
            >
              Enable…
            </Button>
          )}
          {actions.admin === 'promote' ? (
            <Button
              icon={<ShieldPlus aria-hidden />}
              loading={update.isPending && update.variables?.isInstanceAdmin === true}
              onClick={() =>
                void change(
                  { isInstanceAdmin: true },
                  {
                    title: `Make ${name} an administrator?`,
                    body: 'Administrators manage the accounts, invitations, spaces and settings of this instance, and see each other’s actions. They see no space’s content unless they are members.',
                    label: 'Make administrator',
                    done: `${name} is an administrator now`,
                  },
                )
              }
            >
              Make administrator…
            </Button>
          ) : (
            <Button
              icon={<ShieldMinus aria-hidden />}
              loading={update.isPending && update.variables?.isInstanceAdmin === false}
              onClick={() =>
                void change(
                  { isInstanceAdmin: false },
                  {
                    title: `Remove the administrator rights of ${name}?`,
                    body: 'The instance invitations they sent are revoked. Their space memberships stay as they are.',
                    label: 'Remove rights',
                    danger: true,
                    done: `${name} is no longer an administrator`,
                  },
                )
              }
            >
              Remove administrator rights…
            </Button>
          )}
          {actions.resetLink && (
            <Button icon={<KeyRound aria-hidden />} loading={resetLink.isPending} onClick={() => void createLink()}>
              Create reset link
            </Button>
          )}
          <Button variant="danger" icon={<UserMinus aria-hidden />} loading={remove.isPending} onClick={() => void deleteUser()}>
            Delete account…
          </Button>
        </div>
        {note && <p className="text-[13px] text-fg-muted">{note}</p>}
        {refusal && (
          <div role="alert" className="flex gap-2.5 rounded-md border border-danger/30 bg-danger-soft p-3 text-[13px] text-fg">
            <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-danger" />
            <div className="min-w-0">
              <p className="font-medium">The account was not deleted. {refusal.message.replace(/\.?$/, '.')}</p>
              {refusal.spaces.length > 0 && (
                <ul className="mt-1 list-disc pl-4">
                  {refusal.spaces.map((s) => (
                    <li key={s.id}>{s.name}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </div>
      <ResetLinkDialog result={link} user={user} onClose={() => setLink(null)} />
    </SettingsCard>
  );
}

export default function AdminUserDetail() {
  const { userId } = useParams();
  const id = Number(userId);
  const account = useAccount();
  // Addresses can be verified: links can be mailed.
  const mail = useAuthStatus().data?.instance.mailLinks ?? false;
  const user = useAdminUser(id);
  useDocumentTitle(user.data ? `${user.data.displayName} · Users` : 'Users');

  if (user.isPending) {
    return (
      <div className="flex flex-col gap-5">
        <BackLink />
        <SkeletonText lines={2} className="max-w-sm" />
        <SkeletonList rows={4} />
      </div>
    );
  }
  if (user.error) {
    return (
      <div className="flex flex-col gap-5">
        <BackLink />
        <ErrorState error={user.error} onRetry={() => void user.refetch()} />
      </div>
    );
  }
  const u = user.data;
  return (
    <div className="flex min-w-0 flex-col gap-5 md:gap-6">
      <BackLink />
      <div className="flex min-w-0 items-center gap-3">
        <Avatar name={u.displayName} size="lg" />
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <h2 className="truncate text-lg font-semibold text-fg">{u.displayName}</h2>
            {userBadges(u, { meId: account.id, mail }).map((b) => (
              <Badge key={b.label} variant={b.variant}>
                {b.label}
              </Badge>
            ))}
          </div>
          <p className="truncate text-sm text-fg-muted">{userIdentifier(u)}</p>
        </div>
      </div>
      <SettingsCard title="Account">
        <SettingRows>
          <SettingRow label="Email address">
            <span className="text-sm text-fg sm:text-right">{u.email ? `${u.email}${mail ? (u.emailVerified ? ' (verified)' : ' (not verified)') : ''}` : 'None'}</span>
          </SettingRow>
          {u.username !== null && (
            <SettingRow label="Username" description="Signs in with it: an account from before email addresses.">
              <span className="font-mono text-sm text-fg">{u.username}</span>
            </SettingRow>
          )}
          <SettingRow label="Status">
            <span className="text-sm text-fg">{u.status === 'active' ? 'Active' : 'Disabled: cannot sign in'}</span>
          </SettingRow>
          <SettingRow label="Signs in with">
            <span className="text-sm text-fg">{signInMethodsText(u)}</span>
          </SettingRow>
          <SettingRow label="Created">
            <span className="text-sm text-fg">{formatDateTime(u.createdAt)}</span>
          </SettingRow>
          <SettingRow label="Last sign-in">
            <span className="text-sm text-fg" title={u.lastLoginAt ? formatDateTime(u.lastLoginAt) : undefined}>
              {u.lastLoginAt ? formatRelativeTime(u.lastLoginAt) : 'None since the account was made'}
            </span>
          </SettingRow>
        </SettingRows>
      </SettingsCard>
      <ActionsCard user={u} />
      <SettingsCard title="Spaces" description="Where this account is a member. Administrators see no content of a space they are no member of." flush>
        {u.memberships.length === 0 ? (
          <p className="border-t border-border px-4 py-3 text-sm text-fg-muted">No spaces.</p>
        ) : (
          <ul className="divide-y divide-border border-t border-border" aria-label="Spaces">
            {u.memberships.map((m) => (
              <li key={m.space.id} className="flex min-w-0 items-center justify-between gap-3 px-4 py-2.5">
                <span className="min-w-0 truncate text-sm text-fg">{m.space.name}</span>
                <span className="shrink-0 text-[13px] text-fg-muted">{ROLE_LABELS[m.role]}</span>
              </li>
            ))}
          </ul>
        )}
      </SettingsCard>
      <SettingsCard title="Security events" description="The account’s last 50: sign-ins, password changes and what administrators did to it." flush>
        {u.events.length === 0 ? (
          <p className="border-t border-border px-4 py-3 text-sm text-fg-muted">No events.</p>
        ) : (
          <ul className="divide-y divide-border border-t border-border" aria-label="Security events">
            {u.events.map((e) => (
              <li key={e.id} className="flex min-w-0 flex-col gap-0.5 px-4 py-2.5">
                <span className="text-sm text-fg">{securityEventText(e)}</span>
                <span className="text-[13px] text-fg-muted">{[formatDateTime(e.createdAt), e.ip].filter(Boolean).join(' · ')}</span>
              </li>
            ))}
          </ul>
        )}
      </SettingsCard>
    </div>
  );
}
