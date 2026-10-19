import { describe, expect, it } from 'vitest';
import { suggestsAnotherPasskey } from './passkeys';

const single = { deviceType: 'singleDevice' as const, rpIdMatches: true };
const synced = { deviceType: 'multiDevice' as const, rpIdMatches: true };
const orphaned = { deviceType: 'multiDevice' as const, rpIdMatches: false };

describe('suggestsAnotherPasskey', () => {
  it('only for an account without a password whose usable passkeys are all bound to one device', () => {
    expect(suggestsAnotherPasskey({ hasPassword: false, passkeys: [single] })).toBe(true);
    expect(suggestsAnotherPasskey({ hasPassword: false, passkeys: [single, single] })).toBe(true);
    // A synced passkey survives the loss of a device; a password is a way in of its own.
    expect(suggestsAnotherPasskey({ hasPassword: false, passkeys: [single, synced] })).toBe(false);
    expect(suggestsAnotherPasskey({ hasPassword: true, passkeys: [single] })).toBe(false);
    // Orphaned passkeys do not count either way; with none usable the account needs another message.
    expect(suggestsAnotherPasskey({ hasPassword: false, passkeys: [single, orphaned] })).toBe(true);
    expect(suggestsAnotherPasskey({ hasPassword: false, passkeys: [orphaned] })).toBe(false);
    expect(suggestsAnotherPasskey({ hasPassword: false, passkeys: [] })).toBe(false);
  });
});
