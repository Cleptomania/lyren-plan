// What the account is told once after signing in (design §5.8.11, §12.7): AuthStatusDTO.notices, the
// security events about it that someone else caused (an administrator made a password reset link, the
// instance's recovery token was used). Pure, so the texts are unit-tested (notices.test.ts).

import type { ISODate } from '@shared/dates';
import type { NoticeDTO } from '@shared/types';
import { formatDate, isoToLocalDate } from '../../lib/format';

export function noticeText(notice: NoticeDTO, today: ISODate): string {
  const on = formatDate(isoToLocalDate(notice.createdAt), today);
  switch (notice.type) {
    case 'admin_reset_link':
      return (
        `${notice.actorName ? `An administrator (${notice.actorName})` : 'An administrator'} created a password reset link ` +
        `for your account on ${on}. If you did not ask for this, change your password and tell another administrator.`
      );
    case 'recovery_used':
      return (
        `The recovery token of this instance was used to create a sign-in link for your account on ${on}. ` +
        'If that was not you, change your password and tell whoever runs this instance.'
      );
  }
}
