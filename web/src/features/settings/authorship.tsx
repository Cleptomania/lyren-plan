// Who a space's entries belong to after an import (design §8.6, §12.9, §12.10): admins move a former member's
// or a placeholder's tasks, comments, work logs and activity to a member (ReassignDialog, Members → Former
// members); anyone gives up the imported entries attributed to them ("These entries aren't mine": they go to the
// space's "Unknown (imported)" placeholder, which the first disown makes). Both say what moved; the space's lists are read again afterwards.

import { useMemo, useState, type FormEvent } from 'react';
import type { PersonDTO } from '@shared/types';
import { useLookups } from '../../api/bootstrap';
import { useDisownImported, useReassignPerson } from '../../api/spaceAdmin';
import { useSpace } from '../../app/space';
import { Button, Dialog, Field, Select, toast, useConfirm } from '../../components/ui';
import { movedText } from '../../lib/people';

/** The name disowned entries go to (server/src/space/people.ts DISOWNED_NAME). */
export const DISOWNED_NAME = 'Unknown (imported)';

/** "These entries aren't mine": asks, then moves the viewer's imported entries to "Unknown (imported)". */
export function useDisownFlow(): { disown: () => Promise<void>; pending: boolean } {
  const space = useSpace();
  const confirm = useConfirm();
  const mutation = useDisownImported();
  const disown = async () => {
    const ok = await confirm({
      title: 'Give up the entries imported under your name?',
      body: `Every comment, work log and activity entry in ${space.name} that an import or a reassignment attributed to you moves to “${DISOWNED_NAME}”. What you wrote here yourself stays yours. Only an admin can attribute them to someone again.`,
      confirmLabel: 'These entries aren’t mine',
      danger: true,
    });
    if (!ok) return;
    try {
      const { counts } = await mutation.mutateAsync();
      const moved = movedText(counts);
      if (moved) toast.success(`Moved ${moved} to “${DISOWNED_NAME}”`);
      else toast.success('Nothing in this space was imported under your name');
    } catch (err) {
      toast.error(err);
    }
  };
  return { disown, pending: mutation.isPending };
}

/** Admins: move a former member's or a placeholder's entries to a current member. */
export function ReassignDialog({ person, onClose }: { person: PersonDTO | null; onClose: () => void }) {
  const space = useSpace();
  const { people } = useLookups();
  const reassign = useReassignPerson();
  const members = useMemo(() => people.filter((p) => p.isMember && p.kind === 'account' && !p.deleted), [people]);
  const [to, setTo] = useState<number | null>(null);
  const [shown, setShown] = useState<PersonDTO | null>(null);
  // Remember the last person while the dialog closes; start without a choice for each.
  if (person !== null && person !== shown) {
    setShown(person);
    setTo(null);
  }
  const target = members.find((m) => m.id === to);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!shown || !target || reassign.isPending) return;
    try {
      const { counts } = await reassign.mutateAsync({ personId: shown.id, toUserId: target.id });
      const moved = movedText(counts);
      toast.success(moved ? `Moved ${moved} of ${shown.displayName} to ${target.displayName}` : `${shown.displayName} had nothing to move`);
      onClose();
    } catch (err) {
      toast.error(err);
    }
  };

  return (
    <Dialog
      open={person !== null}
      onClose={onClose}
      title={shown ? `Reassign ${shown.displayName}’s entries` : 'Reassign entries'}
      description={`${
        shown?.kind === 'placeholder' && shown.displayName === DISOWNED_NAME
          ? `These are the imported entries members of ${space.name} gave up as not theirs. They`
          : `Their tasks, comments, work logs and activity entries in ${space.name}`
      } move to the member you choose, marked as attributed by you.${
        shown?.kind === 'placeholder' ? ` The name ${shown.displayName} then leaves this space.` : ''
      }`}
      size="sm"
      mobileLayout="sheet"
      onSubmit={(e) => void submit(e)}
      footer={
        <>
          <Button onClick={onClose} disabled={reassign.isPending}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={reassign.isPending} disabled={!target}>
            Reassign
          </Button>
        </>
      }
    >
      <Field label="Reassign their tasks, comments, work logs and activity entries to">
        <Select
          value={to ?? ''}
          placeholder="Choose a member"
          onChange={(e) => setTo(Number(e.target.value))}
          options={members.map((m) => ({ value: m.id, label: m.displayName }))}
        />
      </Field>
    </Dialog>
  );
}
