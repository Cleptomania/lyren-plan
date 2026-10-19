// What Administration → Invitations says about an instance invitation (design §5.8.8).
import { describe, expect, it } from 'vitest';
import { invitationStatusText } from './invitations';

const NOW = Date.parse('2026-10-18T12:00:00.000Z');

describe('invitationStatusText', () => {
  it('until when it works, or since when it does not', () => {
    expect(invitationStatusText({ status: 'pending', expiresAt: '2026-10-25T12:00:00.000Z' }, NOW)).toBe('expires in 7 days');
    expect(invitationStatusText({ status: 'expired', expiresAt: '2026-10-16T12:00:00.000Z' }, NOW)).toBe('expired 2 days ago');
  });
});
