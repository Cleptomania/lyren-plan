// The security notices shown once after sign-in (design §5.8.11, §12.7).
import { describe, expect, it } from 'vitest';
import { formatDate, isoToLocalDate } from '../../lib/format';
import { noticeText } from './notices';

const at = '2026-10-12T09:30:00.000Z';
const on = formatDate(isoToLocalDate(at), '2026-10-18');

describe('noticeText', () => {
  it('names the administrator who created a reset link, and what to do if it was not asked for', () => {
    expect(noticeText({ id: 1, type: 'admin_reset_link', actorName: 'Bob', createdAt: at }, '2026-10-18')).toBe(
      `An administrator (Bob) created a password reset link for your account on ${on}. ` +
        'If you did not ask for this, change your password and tell another administrator.',
    );
  });

  it('without a name when the administrator is gone', () => {
    expect(noticeText({ id: 1, type: 'admin_reset_link', actorName: null, createdAt: at }, '2026-10-18')).toMatch(
      /^An administrator created a password reset link/,
    );
  });

  it('says when the recovery token was used for the account', () => {
    const text = noticeText({ id: 2, type: 'recovery_used', actorName: null, createdAt: at }, '2026-10-18');
    expect(text).toContain(`recovery token of this instance was used to create a sign-in link for your account on ${on}`);
    expect(text).toContain('change your password');
  });
});
