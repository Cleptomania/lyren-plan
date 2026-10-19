// What Administration → Invitations says about an instance invitation (design §5.8.8): until when it works,
// or since when it does not. Pure, so it is unit-tested (invitations.test.ts).

import type { InvitationDTO } from '@shared/types';
import { formatRelativeTime } from '../../lib/format';

export function invitationStatusText(invitation: Pick<InvitationDTO, 'status' | 'expiresAt'>, now: number = Date.now()): string {
  const when = formatRelativeTime(invitation.expiresAt, now);
  return invitation.status === 'expired' ? `expired ${when}` : `expires ${when}`;
}
