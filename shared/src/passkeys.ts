// Passkey rules the server and the web client share (design §5.6).

import type { PasskeyDTO } from './types';

/**
 * Whether to suggest a second passkey (design §5.6): the account has no password, and every passkey that
 * works here is bound to one device (deviceType 'singleDevice', not synced), so losing that device would
 * leave the account with no way in but a reset link. An account none of whose passkeys works here (a
 * domain move orphaned them) needs a password or a new passkey instead, which is another message.
 */
export function suggestsAnotherPasskey(o: {
  hasPassword: boolean;
  passkeys: ReadonlyArray<Pick<PasskeyDTO, 'deviceType' | 'rpIdMatches'>>;
}): boolean {
  const usable = o.passkeys.filter((p) => p.rpIdMatches);
  return !o.hasPassword && usable.length > 0 && usable.every((p) => p.deviceType === 'singleDevice');
}
