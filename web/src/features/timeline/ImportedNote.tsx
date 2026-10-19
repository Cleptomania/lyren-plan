// "Imported by <importer> on <date>" under a comment, work log or activity entry that an import (or an admin's
// reassignment) attributed to its author (design §6.5, §8.6, §12.9). On the viewer's own such entries it offers
// "Not yours?", which gives up every imported entry attributed to them (settings/authorship.tsx).

import { clsx } from 'clsx';
import type { UserRef } from '@shared/types';
import { useLookups } from '../../api/bootstrap';
import { useSharedToday } from '../../components/domain';
import { canDisown, importedText, type Provenance } from '../../lib/people';
import { useDisownFlow } from '../settings/authorship';

function DisownButton() {
  const { disown, pending } = useDisownFlow();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => void disown()}
      className="rounded-sm text-fg-muted underline underline-offset-2 hover:text-fg disabled:opacity-50"
    >
      Not yours?
    </button>
  );
}

export function ImportedNote({ entry, className }: { entry: Provenance & { author: UserRef | null }; className?: string }) {
  const { user } = useLookups();
  const today = useSharedToday();
  const text = importedText(entry, user.id, today);
  if (text === null) return null;
  return (
    <p className={clsx('text-xs text-fg-subtle', className)}>
      {text}
      {canDisown(entry, user.id) && (
        <>
          {' · '}
          <DisownButton />
        </>
      )}
    </p>
  );
}
