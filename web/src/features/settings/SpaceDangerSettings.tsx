// Space settings → Danger zone (design §6.3, §5.8.16): leaving the space (anyone but its only owner),
// and for owners transferring ownership and deleting the space (both ask for the password again when
// the re-auth window is closed; deleting also asks for the space's name).

import { ArrowRightLeft, LogOut, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useMembers } from '../../api/spaces';
import { leaveRefusal } from '../../app/permissions';
import { useSpace } from '../../app/space';
import { Button } from '../../components/ui';
import { SettingsCard, SettingsPage } from './SettingsBlocks';
import { TransferDialog, useDeleteSpaceFlow, useLeaveSpaceFlow } from './spaceMembership';

export default function SpaceDangerSettings() {
  const space = useSpace();
  const members = useMembers(space.id);
  const leave = useLeaveSpaceFlow();
  const remove = useDeleteSpaceFlow();
  const [transferOpen, setTransferOpen] = useState(false);
  const refusal = leaveRefusal(members.data);
  const { manageOwners, deleteSpace } = space.permissions;

  return (
    <SettingsPage title="Danger zone" description="Changes here are hard to undo.">
      <SettingsCard
        title="Leave space"
        description={
          refusal === 'last_owner'
            ? 'You are the only owner of this space. Make someone else an owner first, or delete the space.'
            : 'You lose access to this space. Someone has to add you again for you to come back.'
        }
        actions={
          <Button icon={<LogOut aria-hidden />} disabled={refusal !== null || members.isPending} onClick={() => void leave()}>
            Leave space…
          </Button>
        }
      />
      {manageOwners && (
        <SettingsCard
          title="Transfer ownership"
          description="Make another member an owner, and choose your own role afterwards."
          actions={
            <Button icon={<ArrowRightLeft aria-hidden />} disabled={!members.data} onClick={() => setTransferOpen(true)}>
              Transfer ownership…
            </Button>
          }
        />
      )}
      {deleteSpace && (
        <SettingsCard
          title="Delete space"
          description="Everyone loses access at once. Owners can restore it from the Spaces page for a while, then it is removed for good."
          actions={
            <Button variant="danger" icon={<Trash2 aria-hidden />} onClick={() => void remove()}>
              Delete space…
            </Button>
          }
        />
      )}
      {members.data && <TransferDialog open={transferOpen} members={members.data} onClose={() => setTransferOpen(false)} />}
    </SettingsPage>
  );
}
