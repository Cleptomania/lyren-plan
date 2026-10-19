// Account settings → Security, Passkeys (design §5.6, §5.8.12, §5.8.13): how a passkey reads in the list, the
// name proposed for a new one, which removals the server refuses (so the page says why instead of offering
// them), and the nudges of an account without a password. Pure, so the rules are unit-tested
// (passkeys.test.ts). The ceremonies are api/passkeys.ts'.

import { LIMITS } from '@shared/constants';
import { suggestsAnotherPasskey } from '@shared/passkeys';
import type { PasskeyDTO } from '@shared/types';
import { resetLinkWayText } from '../account/reauth';
import { describeUserAgent } from './userAgent';

/**
 * The name proposed for a passkey made in this browser (§5.8.13): "Chrome on Windows", then "Chrome on
 * Windows 2", "… 3" when the account has that name already; null for a browser it cannot tell, which the
 * server then names "Passkey <n>".
 */
export function proposedPasskeyName(userAgent: string | null | undefined, taken: readonly string[] = []): string | null {
  const { browser, os, label } = describeUserAgent(userAgent);
  if (!browser && !os) return null;
  const names = new Set(taken.map((name) => name.trim().toLocaleLowerCase()));
  for (let n = 1; ; n++) {
    const name = (n === 1 ? label : `${label} ${n}`).slice(0, LIMITS.passkeyNameMax);
    if (!names.has(name.toLocaleLowerCase())) return name;
  }
}

/** Where the passkey is kept, as the authenticator said at its last use (PasskeyDTO.deviceType, backedUp). */
export function passkeyStorage(passkey: Pick<PasskeyDTO, 'deviceType' | 'backedUp'>): { label: string; hint: string } {
  if (passkey.deviceType === 'singleDevice') {
    return { label: 'This device only', hint: 'Kept on one device or security key: it is gone if you lose that.' };
  }
  return passkey.backedUp
    ? { label: 'Synced', hint: 'Kept by a password manager or your device’s account, and there on your other devices too.' }
    : { label: 'Not backed up', hint: 'It can be synced to your other devices, but was not backed up at its last use.' };
}

/** A passkey registered for another address (PasskeyDTO.rpIdMatches false: a domain move, §5.6). */
export const ORPHANED_PASSKEY_TEXT =
  'Made for another address of this instance, so it cannot sign in here. Remove it, and add a new passkey on this address.';

/**
 * What a passkey row that doesn't work here says. An account that cannot confirm it is you here (cannotConfirmHere)
 * can neither remove it nor add another, so the row leaves the way out to the card's nudge.
 */
export function orphanedPasskeyText(stuck: boolean): string {
  return stuck ? 'Made for another address of this instance, so it cannot sign in here.' : ORPHANED_PASSKEY_TEXT;
}

/** The server's 409 last_credential for the last passkey (directory/passkeys.ts LAST_PASSKEY). */
export const LAST_PASSKEY_TEXT = 'This passkey is the only way left to sign in to your account. Set a password or add another passkey first.';

/**
 * Why the server would refuse to remove this passkey (§5.6), else null: an account without a password keeps
 * its last passkey that works here. One that does not work here can always go.
 */
export function passkeyRemovalRefusal(o: {
  hasPassword: boolean;
  passkeys: ReadonlyArray<Pick<PasskeyDTO, 'id' | 'rpIdMatches'>>;
  passkey: Pick<PasskeyDTO, 'id' | 'rpIdMatches'>;
}): string | null {
  if (o.hasPassword || !o.passkey.rpIdMatches) return null;
  return o.passkeys.some((p) => p.id !== o.passkey.id && p.rpIdMatches) ? null : LAST_PASSKEY_TEXT;
}

/**
 * What the Passkeys card asks of an account without a password, else null: a second passkey when every one
 * that works here is kept on a single device (§5.6's nudge, shared/src/passkeys.ts), or, when a domain move
 * left it none that works here, the reset link that gets it one (adding one, or a password, needs the
 * re-auth window, which it cannot open here). `mail`: the instance mails reset links.
 */
export function passkeyNudge(o: { hasPassword: boolean; passkeys: ReadonlyArray<Pick<PasskeyDTO, 'deviceType' | 'rpIdMatches'>>; mail: boolean }): string | null {
  if (suggestsAnotherPasskey(o)) {
    return 'Your account has no password, and each of your passkeys is kept on one device only. Add a passkey on another device or in a password manager, or set a password, so that losing a device does not lock you out.';
  }
  if (cannotConfirmHere(o)) return `Your account has no password, and none of your passkeys works on this address. ${resetLinkWayText(o.mail)}`;
  return null;
}

/**
 * An account without a password none of whose passkeys works here: it cannot confirm it is you on this address
 * (the re-auth dialog offers nothing), so adding a passkey or setting a password fails unless the window is
 * open already.
 */
export function cannotConfirmHere(o: { hasPassword: boolean; passkeys: ReadonlyArray<Pick<PasskeyDTO, 'rpIdMatches'>> }): boolean {
  return !o.hasPassword && o.passkeys.length > 0 && !o.passkeys.some((p) => p.rpIdMatches);
}

/** At most 20 per account (§5.6): at the limit the card offers no "Add a passkey". */
export function canAddPasskey(count: number): boolean {
  return count < LIMITS.passkeysPerUser;
}

export const PASSKEY_LIMIT_TEXT = `An account can have at most ${LIMITS.passkeysPerUser} passkeys. Remove one to add another.`;

/**
 * Removing the password is offered (§5.8.12) to an account with a password and a passkey that works here; the
 * server checks the rest (a way back in) and says why it refuses.
 */
export function offersPasswordRemoval(o: { hasPassword: boolean; passkeys: ReadonlyArray<Pick<PasskeyDTO, 'rpIdMatches'>> }): boolean {
  return o.hasPassword && o.passkeys.some((p) => p.rpIdMatches);
}
