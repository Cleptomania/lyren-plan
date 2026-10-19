// Space settings → Invitations (design §5.8.8, §12.9; admins and owners): invite an address with a role
// (owners also invite admins, which asks for the password first), and the open invitations, which can be
// sent again (a new link; the earlier one stops working) or revoked. With mail the invitation is mailed at
// once, and the inviter's own address must be verified; without mail the link is shown once, to copy and
// pass on (ShareLinkField: the origin choice, the loopback warning). Refusals (a member already, a pending
// invitation, the space's quotas, the daily limits, a mail that could not be sent) keep the form filled in.
// Opened from an import's result (§12.10), the page starts with a prefilled form for each person the import
// attributed entries to who is not a member.

import { clsx } from 'clsx';
import { MailPlus, MoreHorizontal, RefreshCw, Send, Trash2 } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { useLocation } from 'react-router';
import { inviteNeedsReauth, type InvitableRole } from '@shared/roles';
import { emailSchema } from '@shared/email';
import type { InvitationCreatedDTO, InvitationDTO } from '@shared/types';
import { useAccount, useAuthStatus } from '../../api/auth';
import { useCreateInvitation, useResendInvitation, useRevokeInvitation, useSpaceInvitations } from '../../api/invitations';
import { ROLE_DESCRIPTIONS, ROLE_LABELS } from '../../app/permissions';
import { useSpace } from '../../app/space';
import {
  Badge,
  Button,
  ButtonLink,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  IconButton,
  Input,
  Menu,
  Select,
  ShareLinkField,
  SkeletonList,
  toast,
  useConfirm,
  type MenuItem,
} from '../../components/ui';
import { formatDateTime } from '../../lib/format';
import { ensureReauth } from '../account/ReauthDialog';
import { invitesFromState, type ImportInvitee } from '../import/importResult';
import { invitationDetails, invitationRefusal, inviteRoles, managesInvitation, type InvitationRefusal } from './invitations';
import { SettingsCard, SettingsPage } from './SettingsBlocks';

/** What a create or a resend handed back: mailed, or a link to pass on (shown once). */
function SentResult({ created, again }: { created: InvitationCreatedDTO; again?: boolean }) {
  const shareOrigins = useAuthStatus().data?.instance.shareOrigins ?? [];
  const { invitation, link } = created;
  if (link === null) {
    return (
      <p role="status" className="rounded-md border border-success/30 bg-success-soft p-3 text-[13px] text-fg">
        {again ? 'Sent the invitation again to ' : 'Sent the invitation to '}
        <span className="font-medium">{invitation.email}</span>. It works until {formatDateTime(invitation.expiresAt)}.
      </p>
    );
  }
  return (
    <div role="status" className="flex flex-col gap-2 rounded-md border border-success/30 bg-success-soft p-3 text-[13px] text-fg">
      <p>
        This instance sends no email: send this link to <span className="font-medium">{invitation.email}</span> yourself. It is shown only now, and
        works once, until {formatDateTime(invitation.expiresAt)}.{again ? ' The earlier link no longer works.' : ''}
      </p>
      <ShareLinkField link={link} shareOrigins={shareOrigins} label="invitation link" />
    </div>
  );
}

/** A refusal (danger), or what to do before inviting (warning, said before anything is sent). */
function RefusalAlert({ refusal, tone = 'danger' }: { refusal: InvitationRefusal; tone?: 'danger' | 'warning' }) {
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={clsx(
        'flex flex-col gap-1 rounded-md border p-3 text-[13px] text-fg',
        tone === 'danger' ? 'border-danger/30 bg-danger-soft' : 'border-warning/40 bg-warning-soft',
      )}
    >
      <p className="font-medium">{refusal.message}</p>
      {refusal.hint && <p className="text-fg-muted">{refusal.hint}</p>}
      {refusal.verify && (
        <ButtonLink to="/settings" size="sm" className="mt-1 self-start">
          Verify it in Account settings
        </ButtonLink>
      )}
    </div>
  );
}

/**
 * The invitation form: an address, a role, and what the server answered (kept filled in after a refusal).
 * `once`: a form for one person, which shows only the result once they are invited.
 */
function InviteForm({ initialEmail = '', once = false }: { initialEmail?: string; once?: boolean }) {
  const space = useSpace();
  const mail = useAuthStatus().data?.instance.mail ?? false;
  const create = useCreateInvitation(space.id);
  const roles = inviteRoles(space.role);
  const [email, setEmail] = useState(initialEmail);
  const [role, setRole] = useState<InvitableRole>('member');
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [refusal, setRefusal] = useState<InvitationRefusal | null>(null);
  const [created, setCreated] = useState<InvitationCreatedDTO | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (create.isPending) return;
    const parsed = emailSchema.safeParse(email);
    if (!parsed.success) return setFieldError(parsed.error.issues[0]?.message ?? 'Enter a valid email address');
    setRefusal(null);
    setCreated(null);
    if (inviteNeedsReauth(role) && !(await ensureReauth())) return;
    try {
      setCreated(await create.mutateAsync({ email: parsed.data.address, role }));
      setEmail('');
    } catch (err) {
      const r = invitationRefusal(err);
      setFieldError(r.field);
      setRefusal(r.message ? r : null);
    }
  };

  if (once && created) return <SentResult created={created} />;
  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3" noValidate>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
        <Field label="Email address" error={fieldError} hideLabel className="min-w-0 flex-1">
          <Input
            type="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              if (fieldError) setFieldError(undefined);
            }}
            placeholder="name@example.com"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
          />
        </Field>
        <Field label="Role" hideLabel className="sm:w-36">
          <Select value={role} onChange={(e) => setRole(e.target.value as InvitableRole)} options={roles.map((r) => ({ value: r, label: ROLE_LABELS[r] }))} />
        </Field>
        <Button type="submit" variant="primary" icon={mail ? <Send aria-hidden /> : <MailPlus aria-hidden />} loading={create.isPending} className="shrink-0">
          {mail ? 'Send invitation' : 'Create link'}
        </Button>
      </div>
      <p className="text-[13px] text-fg-muted">
        {ROLE_LABELS[role]}: {ROLE_DESCRIPTIONS[role].toLowerCase()}.
      </p>
      {refusal && <RefusalAlert refusal={refusal} />}
      {created && <SentResult created={created} />}
    </form>
  );
}

/** With mail, an invitation names its sender by their verified address (§5.8.8 step 2): until then the server refuses it. */
export function useInviterUnverified(): boolean {
  const account = useAccount();
  const mail = useAuthStatus().data?.instance.mail ?? false;
  return mail && (account.email === null || !account.emailVerified);
}

/** What to do before inviting, said in place of the form (here and in Administration → Invitations). */
export function InviterUnverifiedAlert() {
  const account = useAccount();
  return (
    <RefusalAlert
      tone="warning"
      refusal={{
        message: account.email === null ? 'Add an email address before inviting people' : 'Verify your email address before inviting people',
        hint: 'An invitation names you by your verified address, so that its reader knows who sent it.',
        verify: true,
      }}
    />
  );
}

function InviteCard() {
  const mail = useAuthStatus().data?.instance.mail ?? false;

  if (useInviterUnverified()) {
    return (
      <SettingsCard title="Invite someone">
        <InviterUnverifiedAlert />
      </SettingsCard>
    );
  }

  return (
    <SettingsCard
      title="Invite someone"
      description={mail ? 'The invitation is mailed at once, with a link to join.' : 'This instance sends no email: you get a link to pass on yourself.'}
    >
      <InviteForm />
    </SettingsCard>
  );
}

/**
 * The people an import attributed entries to who are not members (design §12.10), handed over by the import's
 * result (router state): a form for each, filled in with their address here when they have one.
 */
function ImportInvitesCard({ invitees }: { invitees: readonly ImportInvitee[] }) {
  const space = useSpace();
  if (useInviterUnverified() || invitees.length === 0) return null;
  return (
    <SettingsCard
      title="People from the import"
      description={`They have entries in ${space.name} but are not members of it. Invite each with the role they should have.`}
      flush
    >
      <ul className="divide-y divide-border border-t border-border" aria-label="People from the import">
        {invitees.map((person, i) => (
          <li key={i} className="flex flex-col gap-2 px-4 py-3">
            <p className="text-sm font-medium text-fg">
              {person.displayName}
              {person.email === null && <span className="ml-2 text-[13px] font-normal text-fg-muted">No address known here: ask them for it</span>}
            </p>
            <InviteForm initialEmail={person.email ?? ''} once />
          </li>
        ))}
      </ul>
    </SettingsCard>
  );
}

function InvitationRow({ invitation, onLink }: { invitation: InvitationDTO; onLink: (created: InvitationCreatedDTO) => void }) {
  const space = useSpace();
  const resend = useResendInvitation(space.id);
  const revoke = useRevokeInvitation(space.id);
  const confirm = useConfirm();
  const manages = managesInvitation(space.role, invitation);

  const sendAgain = async () => {
    // A new link to an admin invitation grants admin rights as the first did (§5.4.4).
    if (invitation.role !== null && inviteNeedsReauth(invitation.role) && !(await ensureReauth())) return;
    try {
      const res = await resend.mutateAsync(invitation.id);
      if (res.link === null) toast.success(`Sent the invitation to ${invitation.email} again`);
      else onLink(res);
    } catch (err) {
      toast.error(err);
    }
  };

  const remove = async () => {
    const ok = await confirm({
      title: `Revoke the invitation of ${invitation.email}?`,
      body: 'Its link stops working at once. You can invite the address again later.',
      confirmLabel: 'Revoke',
      danger: true,
    });
    if (!ok) return;
    try {
      // The row leaves the list once the invitation is revoked; the toast does not depend on it.
      await revoke.mutateAsync(invitation.id);
      toast.success(`Revoked the invitation of ${invitation.email}`);
    } catch (err) {
      toast.error(err);
    }
  };

  const menu: MenuItem[] = [
    { label: invitation.status === 'expired' ? 'Send again (renews it)' : 'Send again', icon: <RefreshCw />, onSelect: () => void sendAgain() },
    { label: 'Revoke…', icon: <Trash2 />, danger: true, onSelect: () => void remove() },
  ];

  return (
    <li className="flex min-w-0 items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate text-sm font-medium text-fg">{invitation.email}</span>
          {invitation.role && <Badge variant="outline">{ROLE_LABELS[invitation.role]}</Badge>}
          {invitation.status === 'expired' && <Badge variant="warning">Expired</Badge>}
        </div>
        <p className="text-[13px] text-fg-muted" title={`Created ${formatDateTime(invitation.createdAt)}`}>
          {invitationDetails(invitation)}
        </p>
      </div>
      {manages ? (
        <Menu
          label={`Actions for the invitation of ${invitation.email}`}
          items={menu}
          trigger={
            <IconButton
              aria-label={`Actions for the invitation of ${invitation.email}`}
              icon={<MoreHorizontal />}
              size="sm"
              loading={resend.isPending || revoke.isPending}
              className="-mr-1.5 shrink-0"
            />
          }
        />
      ) : (
        <span className="shrink-0 text-[13px] text-fg-subtle" title="Only owners send again or revoke the invitations of admins">
          Owners manage it
        </span>
      )}
    </li>
  );
}

export default function InvitationsSettings() {
  const space = useSpace();
  // The import's result opens this page with the people to invite (features/import/importResult.ts).
  const { state } = useLocation();
  const invitees = useMemo(() => invitesFromState(state), [state]);
  const invitations = useSpaceInvitations(space.id);
  const [resent, setResent] = useState<InvitationCreatedDTO | null>(null);
  const count = invitations.data?.length ?? 0;

  return (
    <SettingsPage title="Invitations" description={`Invite people to ${space.name}. They join with an account of their own, new or existing.`}>
      <ImportInvitesCard invitees={invitees} />
      <InviteCard />
      <SettingsCard
        title={count === 0 ? 'Open invitations' : count === 1 ? '1 open invitation' : `${count} open invitations`}
        description="Invitations not accepted yet. An expired one can be sent again."
        flush
      >
        {invitations.isPending ? (
          <SkeletonList rows={2} className="px-4 pb-3" />
        ) : invitations.error ? (
          <ErrorState size="sm" error={invitations.error} onRetry={() => void invitations.refetch()} />
        ) : invitations.data.length === 0 ? (
          <EmptyState size="sm" icon={<MailPlus />} title="No open invitations" className="border-t border-border" />
        ) : (
          <ul className="divide-y divide-border border-t border-border" aria-label="Open invitations">
            {invitations.data.map((i) => (
              <InvitationRow key={i.id} invitation={i} onLink={setResent} />
            ))}
          </ul>
        )}
      </SettingsCard>
      <Dialog
        open={resent !== null}
        onClose={() => setResent(null)}
        title="New invitation link"
        mobileLayout="sheet"
        footer={<Button onClick={() => setResent(null)}>Done</Button>}
      >
        {resent && <SentResult created={resent} again />}
      </Dialog>
    </SettingsPage>
  );
}
