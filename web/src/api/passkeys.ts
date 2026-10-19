// Passkeys (design §5.6, §5.8.3, §5.8.5, §5.8.9, §5.8.12-§5.8.14). Every WebAuthn ceremony is an options call
// (CeremonyDTO: the ceremony id and the options for @simplewebauthn/browser), the browser's part
// (startRegistration or startAuthentication: the person's device makes or uses the passkey) and the call that
// sends its answer back with the ceremony id. Here: signing in (a button, and the sign-in field's autofill),
// the account's passkeys (Account settings → Security), re-authentication with one, removing the password,
// and the passkey variants of sign-up and a reset link (an invitation's is api/invitations.ts').
// usePasskeysAvailable() says whether the page offers any of it (lib/passkeys.ts). @simplewebauthn/browser is
// loaded with the first ceremony or signal (§12.3; Appendix D 59): this module is in the entry chunk (the
// re-auth dialog), and most pages, the desktop app's and those of an instance without passkeys among them,
// never need it.

import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/browser';
import type { CeremonyResponseInput, PasskeyRegisterInput, ResetPasskeyInput, SignupPasskeyCompleteInput } from '@shared/schemas';
import type { AuthStatusDTO, CeremonyDTO, PasskeyDTO, PasskeyRemovedDTO, PasskeyResetDTO, ReauthDTO, UserDTO } from '@shared/types';
import { isUnknownCredential, passkeysAvailable, type PasskeyEnvironment } from '../lib/passkeys';
import { forgetLink, resetDone, signedIn, useAuthStatus } from './auth';
import { ApiError, http } from './client';
import { qk } from './keys';

type RegistrationCeremony = CeremonyDTO<PublicKeyCredentialCreationOptionsJSON>;
type AuthenticationCeremony = CeremonyDTO<PublicKeyCredentialRequestOptionsJSON>;

/** An input of shared/src/schemas.ts with the browser's own answer (the schema checks only its outline). */
export type WithAnswer<T extends { response: unknown }> = Omit<T, 'response'> & { response: RegistrationResponseJSON | AuthenticationResponseJSON };

/** What a registration sends back: its ceremony and the browser's answer. */
export interface RegistrationAnswer {
  ceremonyId: string;
  response: RegistrationResponseJSON;
}

// ---- The library ---------------------------------------------------------------------------------

type WebAuthnLibrary = typeof import('@simplewebauthn/browser');

let library: WebAuthnLibrary | null = null;
let loading: Promise<WebAuthnLibrary> | null = null;

/** @simplewebauthn/browser, loaded once (again after a failed load: the network may be back). */
function webauthn(): Promise<WebAuthnLibrary> {
  loading ??= import('@simplewebauthn/browser').then(
    (loaded) => (library = loaded),
    (err: unknown) => {
      loading = null;
      throw err;
    },
  );
  return loading;
}

/**
 * Loads the library while a page offers a button's ceremony (`enabled`), so that the click's own work before
 * the browser's dialog is only the options call (some browsers want the dialog close to the click).
 */
export function usePreloadedWebAuthn(enabled: boolean): void {
  useEffect(() => {
    if (enabled) void webauthn().catch(() => undefined);
  }, [enabled]);
}

/** A WebAuthn signal (the browser stops offering passkeys the server no longer accepts); never fails. */
function signal(send: (lib: WebAuthnLibrary) => Promise<void>): void {
  void webauthn()
    .then(send)
    .catch(() => undefined);
}

// ---- Where passkeys show -------------------------------------------------------------------------

export function passkeyEnvironment(): PasskeyEnvironment {
  if (typeof window === 'undefined') return { secureContext: false, origin: '', webauthn: false };
  // browserSupportsWebAuthn()'s test, without loading the library.
  return { secureContext: window.isSecureContext, origin: window.location.origin, webauthn: typeof window.PublicKeyCredential === 'function' };
}

/** Whether this page offers passkeys (lib/passkeys.ts passkeysAvailable); false until the auth status has loaded. */
export function usePasskeysAvailable(): boolean {
  return passkeysAvailable(useAuthStatus().data?.instance, passkeyEnvironment());
}

/** The RP ID the signal API names (InstanceInfoDTO.passkeys.rpId), from the cached auth status. */
function rpIdOf(qc: QueryClient): string | null {
  return qc.getQueryData<AuthStatusDTO>(qk.authStatus)?.instance.passkeys.rpId ?? null;
}

// ---- Ceremonies ----------------------------------------------------------------------------------

/** A registration: the options call (`optionsPath` with `body`), the device's new passkey, then `finish` with both. */
export async function registerPasskey<T>(optionsPath: string, body: unknown, finish: (answer: RegistrationAnswer) => Promise<T>): Promise<T> {
  const lib = await webauthn();
  const ceremony = await http.post<RegistrationCeremony>(optionsPath, body);
  const response = await lib.startRegistration({ optionsJSON: ceremony.options });
  return finish({ ceremonyId: ceremony.ceremonyId, response });
}

/**
 * Ends this page's pending passkey request (the sign-in field's autofill, above all); it rejects with an
 * AbortError. Before the library has loaded no request has begun, so there is nothing to end.
 */
export function cancelPasskeyRequest(): void {
  library?.WebAuthnAbortService.cancelCeremony();
}

// ---- Signing in (§5.8.3) -------------------------------------------------------------------------

async function finishSignIn(qc: QueryClient, ceremony: AuthenticationCeremony, response: AuthenticationResponseJSON): Promise<UserDTO> {
  let user: UserDTO;
  try {
    const input: WithAnswer<CeremonyResponseInput> = { ceremonyId: ceremony.ceremonyId, response };
    user = (await http.post<{ user: UserDTO }>('/auth/passkey/login', input)).user;
  } catch (err) {
    // A passkey this instance had and no longer accepts (the server names only those, Appendix D 59): the
    // browser may stop offering it.
    const rpId = rpIdOf(qc);
    if (rpId !== null && isUnknownCredential(err)) {
      signal((lib) => lib.sendSignal({ signalName: 'unknownCredential', rpID: rpId, credentialID: response.id }));
    }
    throw err;
  }
  await signedIn(qc, user);
  return user;
}

/**
 * "Sign in with a passkey": the browser's dialog offers the passkeys it has for this site (discoverable
 * credentials, so no identifier). A pending autofill request is aborted first.
 */
export async function signInWithPasskey(qc: QueryClient): Promise<UserDTO> {
  cancelPasskeyRequest();
  const lib = await webauthn();
  const ceremony = await http.post<AuthenticationCeremony>('/auth/passkey/login/options', {});
  const response = await lib.startAuthentication({ optionsJSON: ceremony.options });
  return finishSignIn(qc, ceremony, response);
}

/**
 * The sign-in field's autofill (conditional UI, §12.7): the browser lists its passkeys for this site among
 * the suggestions of the field with autocomplete="username webauthn", and the request waits until one is
 * picked (`onPicked`, then the sign-in) or it is ended (cancelPasskeyRequest, or any newer ceremony). Null
 * where the browser has no such autofill, or once `wanted()` turned false before the request began.
 */
export async function signInWithPasskeyAutofill(qc: QueryClient, o: { wanted: () => boolean; onPicked: () => void }): Promise<UserDTO | null> {
  const lib = await webauthn();
  if (!(await lib.browserSupportsWebAuthnAutofill()) || !o.wanted()) return null;
  const ceremony = await http.post<AuthenticationCeremony>('/auth/passkey/login/options', { conditional: true });
  // Checked with nothing awaited before the request begins: a newer one (the button's) has ended this one.
  if (!o.wanted()) return null;
  const response = await lib.startAuthentication({ optionsJSON: ceremony.options, useBrowserAutofill: true });
  o.onPicked();
  return finishSignIn(qc, ceremony, response);
}

// ---- The account's passkeys (§5.8.13) ------------------------------------------------------------

export function usePasskeys(o: { enabled?: boolean } = {}) {
  return useQuery({ queryKey: qk.passkeys, queryFn: () => http.get<PasskeyDTO[]>('/account/passkeys'), enabled: o.enabled ?? true });
}

/** After a change to the account's ways in: its passkeys, its log and the auth status (passkeyCount, hasPassword). */
function credentialsChanged(qc: QueryClient): Promise<unknown> {
  return Promise.all([
    qc.invalidateQueries({ queryKey: qk.passkeys }),
    qc.invalidateQueries({ queryKey: qk.securityEvents }),
    qc.invalidateQueries({ queryKey: qk.authStatus }),
  ]);
}

/**
 * Adds a passkey made on this device. The options call needs the re-auth window (the caller asks with
 * ensureReauth() first) and fewer than 20 passkeys; `name` is the client's proposal (settings/passkeys.ts),
 * null for the server's "Passkey <n>".
 */
export function useAddPasskey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string | null) =>
      registerPasskey('/account/passkeys/options', undefined, (answer) => {
        const input: WithAnswer<PasskeyRegisterInput> = { ...answer, ...(name !== null && { name }) };
        return http.post<PasskeyDTO>('/account/passkeys', input);
      }),
    onSuccess: () => credentialsChanged(qc),
  });
}

export function useRenamePasskey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: number; name: string }) => http.patch<PasskeyDTO>(`/account/passkeys/${input.id}`, { name: input.name }),
    onSuccess: (passkey) => {
      qc.setQueryData<PasskeyDTO[]>(qk.passkeys, (old) => old?.map((p) => (p.id === passkey.id ? passkey : p)));
    },
  });
}

/**
 * Mutation options of useRemovePasskey (exported for tests). The caller asks for the re-auth window first
 * (ensureReauth()): the page knows the server's last-credential rule (settings/passkeys.ts
 * passkeyRemovalRefusal), so it offers the removal only where the server allows it. The browser is told which
 * passkeys the account keeps here (the signal API's allAcceptedCredentials, where the browser has it), so it
 * can stop offering the removed one.
 */
export function removePasskeyOptions(qc: QueryClient) {
  return {
    mutationFn: (id: number) => http.del<PasskeyRemovedDTO>(`/account/passkeys/${id}`),
    onSuccess: (res: PasskeyRemovedDTO) => {
      const rpId = rpIdOf(qc);
      if (rpId !== null) {
        signal((lib) =>
          lib.sendSignal({ signalName: 'allAcceptedCredentials', rpID: rpId, userID: res.userHandle, allAcceptedCredentialIDs: res.acceptedCredentialIds }),
        );
      }
      return credentialsChanged(qc);
    },
  };
}

export function useRemovePasskey() {
  const qc = useQueryClient();
  return useMutation(removePasskeyOptions(qc));
}

/**
 * Removes the password (§5.8.12): the account then signs in with its passkeys. 409 last_credential says why
 * not (no passkey that works here, or no way back in, which the page cannot tell beforehand); the re-auth
 * window is checked after that, so the request goes first and the client's re-auth handler asks when needed.
 */
export function useRemovePassword() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => http.del<{ ok: true }>('/account/password'),
    onSuccess: () => credentialsChanged(qc),
  });
}

/**
 * Mutation options of useReauthPasskey (exported for tests): one of the account's passkeys that work here opens
 * the re-auth window (§5.8.14). After a passkey_error (the passkey may have been removed elsewhere meanwhile)
 * the dialog and Account settings read the account's passkeys again.
 */
export function reauthPasskeyOptions(qc: QueryClient) {
  return {
    mutationFn: async (): Promise<ReauthDTO> => {
      const lib = await webauthn();
      const ceremony = await http.post<AuthenticationCeremony>('/account/reauth/passkey/options');
      const response = await lib.startAuthentication({ optionsJSON: ceremony.options });
      const input: WithAnswer<CeremonyResponseInput> = { ceremonyId: ceremony.ceremonyId, response };
      return http.post<ReauthDTO>('/account/reauth/passkey', input);
    },
    onSuccess: (res: ReauthDTO) => {
      qc.setQueryData<AuthStatusDTO>(qk.authStatus, (old) => (old ? { ...old, reauthUntil: res.reauthUntil } : old));
    },
    onError: (err: unknown) => {
      if (err instanceof ApiError && err.code === 'passkey_error') return credentialsChanged(qc);
    },
  };
}

export function useReauthPasskey() {
  const qc = useQueryClient();
  return useMutation(reauthPasskeyOptions(qc));
}

// ---- Links: sign-up and reset with a passkey (§5.8.5, §5.8.9) --------------------------------------

/** Creates the account of a sign-up link with a passkey and no password, and signs it in. */
export function useSignupWithPasskey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ token, displayName, passkeyName }: { token: string; displayName: string; passkeyName: string | null }) =>
      registerPasskey('/auth/signup/passkey/options', { token, displayName }, (answer) => {
        const input: WithAnswer<SignupPasskeyCompleteInput> = { token, displayName, ...answer, ...(passkeyName !== null && { passkeyName }) };
        return http.post<{ user: UserDTO }>('/auth/signup/passkey/complete', input);
      }),
    onSuccess: async (res) => {
      forgetLink(qc);
      await signedIn(qc, res.user);
    },
  });
}

/**
 * A reset link sets up a passkey instead of a password, which it replaces unless the account would then have no
 * way back in (PasskeyResetDTO); then, as after a reset, nobody is signed in (resetDone).
 */
export function useResetWithPasskey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ token, name }: { token: string; name: string | null }) =>
      registerPasskey('/auth/password/reset/passkey/options', { token }, (answer) => {
        const input: WithAnswer<ResetPasskeyInput> = { token, ...answer, ...(name !== null && { name }) };
        return http.post<PasskeyResetDTO>('/auth/password/reset/passkey', input);
      }),
    onSuccess: () => resetDone(qc),
  });
}
