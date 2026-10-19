// The account's own invitations on /spaces (design §5.8.8 "Pending invitations in the app", §12.2): open
// invitations to its verified address, to accept (the space then joins the list, with Open) or decline.
// There are none on an instance without mail, nor for an address that is not verified: then the section
// says how to get them shown, or is left out.

import { Check, MailOpen, X } from 'lucide-react';
import { useNavigate } from 'react-router';
import type { PendingInvitationDTO } from '@shared/types';
import { useAccount, useAuthStatus } from '../../api/auth';
import { useAcceptPendingInvitation, useDeclineInvitation, usePendingInvitations } from '../../api/invitations';
import { rememberLastSpace, spaceLink } from '../../app/space';
import { Button, ButtonLink, Section, toast, useConfirm } from '../../components/ui';
import { formatDateTime } from '../../lib/format';
import { pendingInvitationText } from '../settings/invitations';

function PendingRow({ invitation }: { invitation: PendingInvitationDTO }) {
  const navigate = useNavigate();
  const accept = useAcceptPendingInvitation();
  const decline = useDeclineInvitation();
  const confirm = useConfirm();

  // Both remove the row from the list: their toasts do not depend on it.
  const join = async () => {
    try {
      const { spaceId } = await accept.mutateAsync(invitation.id);
      toast.success(`You joined ${invitation.spaceName}`, {
        action: {
          label: 'Open',
          onClick: () => {
            rememberLastSpace(spaceId);
            void navigate(spaceLink(spaceId, '/'));
          },
        },
      });
    } catch (err) {
      toast.error(err);
    }
  };
  const refuse = async () => {
    const ok = await confirm({
      title: `Decline the invitation to ${invitation.spaceName}?`,
      body: `${invitation.inviterName ?? 'Whoever invited you'} would have to invite you again.`,
      confirmLabel: 'Decline',
      danger: true,
    });
    if (!ok) return;
    try {
      await decline.mutateAsync(invitation.id);
      toast.success(`Declined the invitation to ${invitation.spaceName}`);
    } catch (err) {
      toast.error(err);
    }
  };

  return (
    <li className="flex min-h-14 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2">
      <MailOpen aria-hidden className="size-4 shrink-0 text-accent" />
      {/* The buttons wrap below the text on narrow screens rather than squeezing it. */}
      <span className="min-w-0 flex-[1_1_14rem]">
        <span className="block text-sm text-fg">{pendingInvitationText(invitation)}</span>
        <span className="block text-xs text-fg-muted">Works until {formatDateTime(invitation.expiresAt)}</span>
      </span>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <Button size="sm" icon={<X aria-hidden />} loading={decline.isPending} onClick={() => void refuse()} aria-label={`Decline the invitation to ${invitation.spaceName}`}>
          Decline
        </Button>
        <Button size="sm" variant="primary" icon={<Check aria-hidden />} loading={accept.isPending} onClick={() => void join()} aria-label={`Accept the invitation to ${invitation.spaceName}`}>
          Accept
        </Button>
      </div>
    </li>
  );
}

export function PendingInvitations() {
  const account = useAccount();
  const mail = useAuthStatus().data?.instance.mail ?? false;
  const seen = mail && account.emailVerified;
  const pending = usePendingInvitations(seen);

  if (mail && account.email !== null && !account.emailVerified) {
    return (
      <Section title="Invitations">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border bg-surface px-4 py-3 text-[13px] text-fg-muted shadow-card">
          <span className="min-w-0 flex-1">Invitations sent to {account.email} show here once you verify the address.</span>
          <ButtonLink to="/settings" size="sm">
            Verify it
          </ButtonLink>
        </div>
      </Section>
    );
  }
  if (!pending.data || pending.data.length === 0) return null;
  return (
    <Section title="Invitations" description="Invitations to your email address. Accepting adds the space to your list.">
      <ul aria-label="Invitations" className="flex flex-col divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface shadow-card">
        {pending.data.map((invitation) => (
          <PendingRow key={invitation.id} invitation={invitation} />
        ))}
      </ul>
    </Section>
  );
}
