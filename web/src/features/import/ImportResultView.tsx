// The result of an import (design §12.10; importResult.ts): what was written, after a replace the way back
// (Node: the snapshot and the command that undoes the import; Cloudflare: the archive downloaded before), and the
// people entries were mapped to who are not members of the space, with "Invite them to this space", which opens
// Settings → Invitations with a prefilled form for each.

import { CircleCheck, MailPlus } from 'lucide-react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';
import type { ImportResultDTO } from '@shared/types';
import { useAccount, useAuthStatus } from '../../api/auth';
import { spaceLink } from '../../app/space';
import { Button, CopyField } from '../../components/ui';
import { IMPORT_INVITES_STATE, importInvitees, inviteeNames, resultHeadline, resultRows, undoHint } from './importResult';

export function ImportResultView({
  spaceId,
  spaceName,
  result,
  replaced,
  actions,
}: {
  spaceId: string;
  spaceName: string;
  result: ImportResultDTO;
  /** A replace: say how to undo it. */
  replaced: boolean;
  /** Buttons at the end ("Open the space", "Done"). */
  actions?: ReactNode;
}) {
  const navigate = useNavigate();
  const account = useAccount();
  const status = useAuthStatus().data;
  const desktop = status?.desktop !== undefined;
  const invitees = importInvitees(result.nonMemberAuthors);
  const undo = replaced ? undoHint(result.safety, { instanceAdmin: account.isInstanceAdmin, desktop, desktopData: status?.desktopData }) : null;

  return (
    <div className="flex flex-col gap-4">
      <div role="status" className="flex gap-2.5 rounded-md border border-success/30 bg-success-soft p-3 text-[13px] text-fg">
        <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">
            {resultHeadline(result.counts)} {replaced ? `${spaceName} now holds the archive’s data.` : `${spaceName} is ready.`}
          </p>
          {undo && <p className="mt-1 break-words text-fg-muted">{undo.text}</p>}
          {undo?.command && <CopyField value={undo.command} label="restore command" className="mt-2" />}
          {undo?.how && <p className="mt-1.5 break-words text-fg-muted">{undo.how}</p>}
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-3">
        {resultRows(result.counts).map((c) => (
          <div key={c.key} className="flex items-baseline justify-between gap-2 border-b border-border/60 pb-1">
            <dt className="text-fg-muted">{c.label}</dt>
            <dd className="font-medium tabular-nums text-fg">{c.count.toLocaleString()}</dd>
          </div>
        ))}
      </dl>
      {invitees.length > 0 && (
        <div className="flex flex-col gap-2 rounded-md border border-border p-3 text-[13px] sm:flex-row sm:items-center sm:gap-3">
          <p className="min-w-0 flex-1 text-fg-muted">
            <span className="font-medium text-fg">{inviteeNames(invitees)}</span> {invitees.length === 1 ? 'has' : 'have'} entries in {spaceName} but{' '}
            {invitees.length === 1 ? 'is not a member' : 'are not members'} of it yet.
          </p>
          <Button
            size="sm"
            icon={<MailPlus aria-hidden />}
            className="self-start sm:self-auto"
            onClick={() => void navigate(spaceLink(spaceId, '/settings/invitations'), { state: { [IMPORT_INVITES_STATE]: invitees } })}
          >
            Invite them to this space
          </Button>
        </div>
      )}
      {actions && <div className="flex flex-wrap items-center justify-end gap-2">{actions}</div>}
    </div>
  );
}
