// The membership actions a space's Members page and Danger zone share (design §6.3, §5.8.16): leaving,
// transferring ownership (owners, re-auth) and deleting the space (owners, re-auth, its name typed).
// Leaving and deleting move to /spaces before the request, since the space's data is forgotten once it
// is answered; the result arrives as a toast there.

import { useState } from 'react';
import { useNavigate } from 'react-router';
import type { InvitableRole } from '@shared/roles';
import type { MemberDTO } from '@shared/types';
import { useDeleteSpace, useLeaveSpace, useTransferSpace } from '../../api/spaces';
import { ROLE_LABELS, transferTargets } from '../../app/permissions';
import { useSpace } from '../../app/space';
import { Button, Dialog, Field, Select, toast, useConfirm } from '../../components/ui';
import { formatDate, isoToLocalDate } from '../../lib/format';
import { ensureReauth } from '../account/ReauthDialog';

/** "Leave space…": confirm, then leave from /spaces. */
export function useLeaveSpaceFlow(): () => Promise<void> {
  const space = useSpace();
  const leave = useLeaveSpace(space.id);
  const confirm = useConfirm();
  const navigate = useNavigate();
  return async () => {
    const ok = await confirm({
      title: `Leave ${space.name}?`,
      body: 'You lose access to its projects, boards and tasks. Your comments and work logs stay, marked as from a former member. To come back, someone has to add you again.',
      confirmLabel: 'Leave space',
      danger: true,
    });
    if (!ok) return;
    navigate('/spaces', { replace: true });
    leave.mutate(undefined, {
      onSuccess: () => toast.success(`You left ${space.name}`),
      onError: (err) => toast.error(err),
    });
  };
}

/** "Delete space…" (owners): re-auth, the name typed, then the delete from /spaces. */
export function useDeleteSpaceFlow(): () => Promise<void> {
  const space = useSpace();
  const remove = useDeleteSpace(space.id);
  const confirm = useConfirm();
  const navigate = useNavigate();
  return async () => {
    if (!(await ensureReauth())) return;
    const ok = await confirm({
      title: `Delete ${space.name}?`,
      body:
        'Everyone loses access to the space at once. Its owners can restore it from the Spaces page for a while; after that ' +
        'it is removed for good, with every project, task, comment and work log in it.',
      confirmLabel: 'Delete space',
      danger: true,
      typeToConfirm: space.name,
    });
    if (!ok) return;
    navigate('/spaces', { replace: true });
    remove.mutate(
      { confirmName: space.name },
      {
        onSuccess: (res) => toast.success(`Deleted ${space.name}. You can restore it until ${formatDate(isoToLocalDate(res.purgeAfter))}.`),
        onError: (err) => toast.error(err),
      },
    );
  };
}

const STAY_OPTIONS: ReadonlyArray<{ value: 'owner' | InvitableRole; label: string }> = [
  { value: 'admin', label: 'Admin' },
  { value: 'member', label: 'Member' },
  { value: 'viewer', label: 'Viewer' },
  { value: 'owner', label: 'Owner (stay one too)' },
];

/**
 * Transfer ownership (owners, re-auth): the chosen member becomes an owner, and the viewer takes the
 * role chosen for afterwards in the same step (§6.3). `to` preselects a member.
 */
export function TransferDialog({
  open,
  onClose,
  members,
  to,
}: {
  open: boolean;
  onClose: () => void;
  members: readonly MemberDTO[];
  to?: number;
}) {
  const space = useSpace();
  const transfer = useTransferSpace(space.id);
  const targets = transferTargets(space.role, members);
  const [userId, setUserId] = useState<number | null>(null);
  const [stay, setStay] = useState<'owner' | InvitableRole>('admin');
  // Chosen afresh on each opening only: the list refreshes while the dialog is open.
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setUserId(to ?? targets[0]?.userId ?? null);
      setStay('admin');
    }
  }
  const target = targets.find((m) => m.userId === userId);

  const submit = async () => {
    if (!target) return;
    if (!(await ensureReauth())) return;
    transfer.mutate(
      { userId: target.userId, ...(stay !== 'owner' && { demoteSelfTo: stay }) },
      {
        onSuccess: () => {
          onClose();
          toast.success(
            stay === 'owner' ? `${target.displayName} is now an owner too` : `${target.displayName} is now an owner; you are ${ROLE_LABELS[stay].toLowerCase()}`,
          );
        },
        onError: (err) => toast.error(err),
      },
    );
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Transfer ownership"
      description="The member you choose becomes an owner of this space, with every right you have."
      size="sm"
      mobileLayout="sheet"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      footer={
        <>
          <Button onClick={onClose} disabled={transfer.isPending}>
            Cancel
          </Button>
          <Button type="submit" variant="danger" loading={transfer.isPending} disabled={!target}>
            Transfer
          </Button>
        </>
      }
    >
      {targets.length === 0 ? (
        <p className="text-sm text-fg-muted">There is nobody to transfer the space to: every other member is an owner already, or the space has no other active member.</p>
      ) : (
        <div className="flex flex-col gap-4">
          <Field label="New owner">
            <Select value={userId === null ? '' : String(userId)} onChange={(e) => setUserId(Number(e.target.value))}>
              {targets.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.email ? `${m.displayName} (${m.email})` : m.displayName} · {ROLE_LABELS[m.role]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Your role afterwards">
            <Select value={stay} onChange={(e) => setStay(e.target.value as 'owner' | InvitableRole)}>
              {STAY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      )}
    </Dialog>
  );
}
