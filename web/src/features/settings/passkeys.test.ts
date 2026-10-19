// Account settings → Security, Passkeys (design §5.6, §5.8.12, §5.8.13): the proposed name, how a passkey
// reads, which removals the server refuses, and the nudges of an account without a password.
import { describe, expect, it } from 'vitest';
import type { PasskeyDTO } from '@shared/types';
import {
  canAddPasskey,
  LAST_PASSKEY_TEXT,
  ORPHANED_PASSKEY_TEXT,
  orphanedPasskeyText,
  offersPasswordRemoval,
  cannotConfirmHere,
  passkeyNudge,
  passkeyRemovalRefusal,
  passkeyStorage,
  proposedPasskeyName,
} from './passkeys';

const CHROME_WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const SAFARI_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const HEADLESS = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36';

let nextId = 1;
const passkey = (o: Partial<PasskeyDTO> = {}): PasskeyDTO => ({
  id: nextId++,
  name: 'Passkey',
  createdAt: '2026-10-01T10:00:00.000Z',
  lastUsedAt: null,
  deviceType: 'multiDevice',
  backedUp: true,
  rpIdMatches: true,
  ...o,
});

describe('proposedPasskeyName', () => {
  it('names the browser and the system, numbered when the account has that name already', () => {
    expect(proposedPasskeyName(CHROME_WINDOWS)).toBe('Chrome on Windows');
    expect(proposedPasskeyName(SAFARI_IPHONE)).toBe('Safari on iOS');
    expect(proposedPasskeyName(HEADLESS)).toBe('Chrome on Linux');
    expect(proposedPasskeyName(CHROME_WINDOWS, ['chrome on windows'])).toBe('Chrome on Windows 2');
    expect(proposedPasskeyName(CHROME_WINDOWS, ['Chrome on Windows', 'Chrome on Windows 2', 'Passkey 3'])).toBe('Chrome on Windows 3');
  });

  it('leaves a browser it cannot tell to the server (“Passkey <n>”)', () => {
    expect(proposedPasskeyName('')).toBeNull();
    expect(proposedPasskeyName(null)).toBeNull();
    expect(proposedPasskeyName('SomethingElse/1.0')).toBeNull();
  });
});

describe('passkeyStorage', () => {
  it('reads the device type and the backup state', () => {
    expect(passkeyStorage({ deviceType: 'singleDevice', backedUp: false }).label).toBe('This device only');
    expect(passkeyStorage({ deviceType: 'multiDevice', backedUp: true }).label).toBe('Synced');
    expect(passkeyStorage({ deviceType: 'multiDevice', backedUp: false }).label).toBe('Not backed up');
  });
});

describe('passkeyRemovalRefusal', () => {
  it('keeps the last passkey that works here of an account without a password, as the server does', () => {
    const only = passkey();
    expect(passkeyRemovalRefusal({ hasPassword: false, passkeys: [only], passkey: only })).toBe(LAST_PASSKEY_TEXT);
    // Another one that works here, or a password: it may go.
    const second = passkey();
    expect(passkeyRemovalRefusal({ hasPassword: false, passkeys: [only, second], passkey: only })).toBeNull();
    expect(passkeyRemovalRefusal({ hasPassword: true, passkeys: [only], passkey: only })).toBeNull();
  });

  it('counts only passkeys that work here, and lets one that does not always go', () => {
    const usable = passkey();
    const orphaned = passkey({ rpIdMatches: false });
    expect(passkeyRemovalRefusal({ hasPassword: false, passkeys: [usable, orphaned], passkey: usable })).toBe(LAST_PASSKEY_TEXT);
    expect(passkeyRemovalRefusal({ hasPassword: false, passkeys: [usable, orphaned], passkey: orphaned })).toBeNull();
    expect(passkeyRemovalRefusal({ hasPassword: false, passkeys: [orphaned], passkey: orphaned })).toBeNull();
  });
});

describe('orphanedPasskeyText', () => {
  it('advises removing and adding only when the account can confirm it is you here', () => {
    expect(orphanedPasskeyText(false)).toBe(ORPHANED_PASSKEY_TEXT);
    expect(orphanedPasskeyText(true)).toBe('Made for another address of this instance, so it cannot sign in here.');
    expect(orphanedPasskeyText(true)).not.toMatch(/\b(Remove|add)\b/);
  });
});

describe('passkeyNudge', () => {
  it('asks an account without a password whose passkeys are each on one device for another way in (§5.6)', () => {
    const single = passkey({ deviceType: 'singleDevice', backedUp: false });
    expect(passkeyNudge({ hasPassword: false, passkeys: [single], mail: true })).toMatch(/Add a passkey on another device/);
    expect(passkeyNudge({ hasPassword: false, passkeys: [single, passkey({ deviceType: 'singleDevice' })], mail: true })).toMatch(/one device only/);
    // A synced one, or a password: no nudge.
    expect(passkeyNudge({ hasPassword: false, passkeys: [single, passkey()], mail: true })).toBeNull();
    expect(passkeyNudge({ hasPassword: true, passkeys: [single], mail: true })).toBeNull();
    expect(passkeyNudge({ hasPassword: true, passkeys: [], mail: true })).toBeNull();
  });

  it('tells an account without a password that none of its passkeys works here (a domain move)', () => {
    // Adding one needs the re-auth window, which it cannot open here: the nudge names the reset link instead.
    expect(passkeyNudge({ hasPassword: false, passkeys: [passkey({ rpIdMatches: false })], mail: false })).toBe(
      'Your account has no password, and none of your passkeys works on this address. To set a password or a passkey here, ask an administrator of this instance for a reset link.',
    );
    expect(passkeyNudge({ hasPassword: false, passkeys: [passkey({ rpIdMatches: false })], mail: true })).toMatch(/sign out and use “Forgot password\?”/);
    expect(cannotConfirmHere({ hasPassword: false, passkeys: [passkey({ rpIdMatches: false })] })).toBe(true);
    expect(cannotConfirmHere({ hasPassword: false, passkeys: [passkey({ rpIdMatches: false }), passkey()] })).toBe(false);
    expect(cannotConfirmHere({ hasPassword: true, passkeys: [passkey({ rpIdMatches: false })] })).toBe(false);
    // An orphaned single-device one beside a usable single-device one: the single-device nudge.
    expect(passkeyNudge({ hasPassword: false, passkeys: [passkey({ rpIdMatches: false }), passkey({ deviceType: 'singleDevice' })], mail: true })).toMatch(/one device only/);
  });
});

describe('limits and the password', () => {
  it('offers "Add a passkey" below 20', () => {
    expect(canAddPasskey(0)).toBe(true);
    expect(canAddPasskey(19)).toBe(true);
    expect(canAddPasskey(20)).toBe(false);
  });

  it('offers removing the password with a password and a passkey that works here', () => {
    expect(offersPasswordRemoval({ hasPassword: true, passkeys: [passkey()] })).toBe(true);
    expect(offersPasswordRemoval({ hasPassword: true, passkeys: [passkey({ rpIdMatches: false })] })).toBe(false);
    expect(offersPasswordRemoval({ hasPassword: true, passkeys: [] })).toBe(false);
    expect(offersPasswordRemoval({ hasPassword: false, passkeys: [passkey()] })).toBe(false);
  });
});
