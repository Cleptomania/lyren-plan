// The re-auth window (design §5.4.4, §12.8), as the client decides about it. AuthStatusDTO.reauthUntil
// is the window's end as the server computed it; ensureReauth() goes on at once while it is open
// (with a margin for the request that follows and for a clock here that runs a little behind the
// server's), else it asks for the password or a passkey. Pure, so the decisions are unit-tested
// (reauth.test.ts); ReauthDialog.tsx holds the dialog.

import type { PasskeyDTO } from '@shared/types';

/** A window that ends this soon counts as closed. */
export const REAUTH_MARGIN_MS = 30_000;

export function reauthOpen(reauthUntil: string | null | undefined, nowMs = Date.now()): boolean {
  if (!reauthUntil) return false;
  const until = Date.parse(reauthUntil);
  return Number.isFinite(until) && until - nowMs > REAUTH_MARGIN_MS;
}

/** Asks for the password or a passkey; resolves true once the window is open again. */
export type ReauthPrompt = () => Promise<boolean>;

/** How the dialog lets the account confirm it is you (§12.8). */
export interface ReauthMethods {
  password: boolean;
  /** A passkey that works here; 'checking' while the account's passkeys load. */
  passkey: boolean | 'checking';
}

/**
 * The password when the account has one; "Use a passkey" when passkeys are available here (lib/passkeys.ts)
 * and one of the account's works on this address. `passkeyCount` (UserDTO) counts every passkey, those of
 * another RP ID too (Appendix D 57), so the list decides; should it fail to load, the button shows and the
 * server says (400 passkey_error) when none works here.
 */
export function reauthMethods(o: {
  hasPassword: boolean;
  passkeysHere: boolean;
  passkeyCount: number;
  passkeys: ReadonlyArray<Pick<PasskeyDTO, 'rpIdMatches'>> | undefined;
  listFailed: boolean;
}): ReauthMethods {
  const password = o.hasPassword;
  if (!o.passkeysHere || o.passkeyCount === 0) return { password, passkey: false };
  if (o.passkeys) return { password, passkey: o.passkeys.some((p) => p.rpIdMatches) };
  return { password, passkey: o.listFailed ? true : 'checking' };
}

/** The dialog's first sentence. */
export function reauthText(methods: ReauthMethods): string {
  const passkey = methods.passkey !== false;
  if (methods.password && passkey) return 'This action needs your password or a passkey again, because your last sign-in was a while ago.';
  if (methods.password) return 'This action needs your password again, because your last sign-in was a while ago.';
  if (passkey) return 'This action needs one of your passkeys again, because your last sign-in was a while ago.';
  return 'This action needs you to confirm it’s you, because your last sign-in was a while ago.';
}

/** Whether the account can confirm it is you here at all (the password, or a passkey that may work). */
export function canConfirm(methods: ReauthMethods): boolean {
  return methods.password || methods.passkey !== false;
}

/**
 * The way out for an account that cannot confirm it is you here: a reset link sets a password or a passkey.
 * `mail`: the instance mails them (InstanceInfoDTO.mailLinks), so "Forgot password?" sends one.
 */
export function resetLinkWayText(mail: boolean): string {
  return mail
    ? 'To set a password or a passkey here, sign out and use “Forgot password?”, or ask an administrator for a reset link.'
    : 'To set a password or a passkey here, ask an administrator of this instance for a reset link.';
}

/** Why the dialog offers no way to confirm (no password, and no passkey that works here), and the way out. */
export function reauthUnavailableText(o: { passkeysHere: boolean; passkeyCount: number; mail: boolean }): string {
  const why =
    o.passkeysHere && o.passkeyCount > 0
      ? 'Your account has no password, and none of its passkeys works on this address.'
      : 'Your account has no password, and passkeys cannot be used on this address.';
  return `${why} ${resetLinkWayText(o.mail)}`;
}

/**
 * One prompt at a time: whoever asks while it is open shares its answer, so two requests refused
 * together (a page firing several) show one dialog and are both sent again after it.
 */
export function sharedPrompt(ask: ReauthPrompt): ReauthPrompt {
  let pending: Promise<boolean> | null = null;
  return () => {
    pending ??= ask().finally(() => {
      pending = null;
    });
    return pending;
  };
}

/**
 * Before a sensitive action (§12.8): true at once while the window is open, unless `force` (the
 * server said reauth_required, so it closed meanwhile); else the prompt's answer.
 */
export function ensureReauthWith(o: { reauthUntil: string | null | undefined; force?: boolean; nowMs?: number; prompt: ReauthPrompt }): Promise<boolean> {
  if (!o.force && reauthOpen(o.reauthUntil, o.nowMs)) return Promise.resolve(true);
  return o.prompt();
}
