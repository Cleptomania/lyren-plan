// The pages that give an account a way in (a sign-up link, an invitation accepted as a new account, a reset
// link; design §12.7) offer a passkey instead of a password where passkeys are available (lib/passkeys.ts):
// a link under the form switches between the two, and the passkey way says what will happen.

import { AUTH_LINK } from './AuthLayout';

export type CredentialWay = 'password' | 'passkey';

export function SwitchCredentialButton({
  way,
  onSwitch,
  passkeyLabel = 'Use a passkey instead',
}: {
  way: CredentialWay;
  onSwitch: (next: CredentialWay) => void;
  passkeyLabel?: string;
}) {
  return (
    <button type="button" className={`self-center text-sm ${AUTH_LINK}`} onClick={() => onSwitch(way === 'password' ? 'passkey' : 'password')}>
      {way === 'password' ? passkeyLabel : 'Use a password instead'}
    </button>
  );
}

/** What the passkey way does, for the account `account` (an address, or a 1.x username). */
export function PasskeyExplainer({ account }: { account: string }) {
  return (
    <p className="rounded-md bg-surface-2 px-3 py-2 text-[13px] text-fg-muted">
      Your device or password manager saves a passkey for <span className="break-words font-medium text-fg">{account}</span>. You then sign in with
      your fingerprint, your face or your screen lock, without a password.
    </p>
  );
}
