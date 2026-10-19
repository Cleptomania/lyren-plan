// Administration → Invitations (design §5.8.8, §5.8.18): instance invitations, an account of its own for
// someone, without a space (whatever the signup policy). With mail the invitation is mailed at once, and the
// admin's own address must be verified first (said in place of the form, as in a space's Invitations); without,
// its link is shown here once, to copy and pass on. Open invitations are listed, and can be revoked. Creating
// and revoking ask for the password first when the re-auth window is closed.

import { MailPlus, Send, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { emailSchema } from '@shared/email';
import type { InvitationCreatedDTO, InvitationDTO } from '@shared/types';
import { useAdminInvitations, useCreateAdminInvitation, useRevokeAdminInvitation } from '../../api/admin';
import { useAuthStatus } from '../../api/auth';
import { errorMessage } from '../../api/client';
import { Badge, Button, EmptyState, ErrorState, Field, Input, ShareLinkField, SkeletonList, apiFieldErrors, toast, useConfirm } from '../../components/ui';
import { formatDateTime, formatRelativeTime } from '../../lib/format';
import { ensureReauth } from '../account/ReauthDialog';
import { InviterUnverifiedAlert, useInviterUnverified } from '../settings/InvitationsSettings';
import { SettingsCard, SettingsPage } from '../settings/SettingsBlocks';
import { invitationStatusText } from './invitations';

function CreatedResult({ created }: { created: InvitationCreatedDTO }) {
  const shareOrigins = useAuthStatus().data?.instance.shareOrigins ?? [];
  const link = created.link;
  return (
    <div role="status" className="flex flex-col gap-2 rounded-md border border-success/30 bg-success-soft p-3 text-[13px] text-fg">
      {link === null ? (
        <p>
          The invitation was mailed to <span className="font-medium">{created.invitation.email}</span>. It works until{' '}
          {formatDateTime(created.invitation.expiresAt)}.
        </p>
      ) : (
        <>
          <p>
            This instance sends no mail: give this link to <span className="font-medium">{created.invitation.email}</span> yourself. It is shown only
            now, and works once, until {formatDateTime(created.invitation.expiresAt)}.
          </p>
          <ShareLinkField link={link} shareOrigins={shareOrigins} label="invitation link" />
        </>
      )}
    </div>
  );
}

function InvitationRow({ invitation }: { invitation: InvitationDTO }) {
  const revoke = useRevokeAdminInvitation();
  const confirm = useConfirm();
  const remove = async () => {
    const ok = await confirm({
      title: `Revoke the invitation of ${invitation.email}?`,
      body: 'Its link stops working at once.',
      confirmLabel: 'Revoke',
      danger: true,
    });
    if (!ok || !(await ensureReauth())) return;
    try {
      // The row leaves the list once the invitation is revoked; the toast does not depend on it.
      await revoke.mutateAsync(invitation.id);
      toast.success(`Revoked the invitation of ${invitation.email}`);
    } catch (err) {
      toast.error(err);
    }
  };
  return (
    <li className="flex min-w-0 items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate text-sm font-medium text-fg">{invitation.email}</span>
          {invitation.status === 'expired' && <Badge variant="warning">Expired</Badge>}
        </div>
        <p className="text-[13px] text-fg-muted" title={formatDateTime(invitation.createdAt)}>
          {[invitation.invitedBy ? `From ${invitation.invitedBy.displayName}` : null, `sent ${formatRelativeTime(invitation.lastSentAt)}`, invitationStatusText(invitation)]
            .filter(Boolean)
            .join(' · ')}
        </p>
      </div>
      <Button size="sm" icon={<Trash2 aria-hidden />} loading={revoke.isPending} onClick={() => void remove()} aria-label={`Revoke the invitation of ${invitation.email}`}>
        Revoke
      </Button>
    </li>
  );
}

export default function AdminInvitations() {
  const mail = useAuthStatus().data?.instance.mail ?? false;
  const invitations = useAdminInvitations();
  const create = useCreateAdminInvitation();
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [created, setCreated] = useState<InvitationCreatedDTO | null>(null);
  const unverified = useInviterUnverified();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const parsed = emailSchema.safeParse(email);
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'Enter a valid email address');
    setCreated(null);
    if (!(await ensureReauth())) return;
    create.mutate(parsed.data.address, {
      onSuccess: (res) => {
        setCreated(res);
        setEmail('');
      },
      // A refused address is said at the field; a mail that could not be sent keeps the address for another try.
      onError: (err) => setError(apiFieldErrors(err).email ?? errorMessage(err)),
    });
  };

  return (
    <SettingsPage
      title="Invitations"
      description="Invite someone to an account of their own on this instance, without a space; whatever the sign-up policy, the invitation works. To invite someone into a space, use that space’s Settings → Invitations."
    >
      <SettingsCard title="Invite someone" description={unverified ? undefined : mail ? 'The invitation is mailed at once.' : 'This instance sends no mail: you get a link to pass on.'}>
        {unverified ? (
          <InviterUnverifiedAlert />
        ) : (
          <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3" noValidate>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
              <Field label="Email address" error={error} hideLabel className="min-w-0 flex-1">
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    if (error) setError(undefined);
                  }}
                  placeholder="name@example.com"
                  autoComplete="off"
                />
              </Field>
              <Button type="submit" variant="primary" icon={mail ? <Send aria-hidden /> : <MailPlus aria-hidden />} loading={create.isPending} className="shrink-0">
                {mail ? 'Send invitation' : 'Create invitation'}
              </Button>
            </div>
            {created && <CreatedResult created={created} />}
          </form>
        )}
      </SettingsCard>
      <SettingsCard title="Open invitations" description="Instance invitations not accepted yet. Accepted and revoked ones are not listed." flush>
        {invitations.isPending ? (
          <SkeletonList rows={2} className="px-4 pb-3" />
        ) : invitations.error ? (
          <ErrorState size="sm" error={invitations.error} onRetry={() => void invitations.refetch()} />
        ) : invitations.data.length === 0 ? (
          <EmptyState size="sm" icon={<MailPlus />} title="No open invitations" className="border-t border-border" />
        ) : (
          <ul className="divide-y divide-border border-t border-border" aria-label="Open invitations">
            {invitations.data.map((i) => (
              <InvitationRow key={i.id} invitation={i} />
            ))}
          </ul>
        )}
      </SettingsCard>
    </SettingsPage>
  );
}
