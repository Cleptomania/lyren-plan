// The passkey ceremonies as the sign-in form and Account settings run them (design §5.6, §5.8.3,
// §5.8.13): the button's request aborts a pending autofill one first, an unknown passkey and a removed one
// are reported to the browser (the WebAuthn signal API, when it has one), the autofill asks the server
// for nothing where the browser has no such autofill, and a failed re-auth reads the passkeys again. The browser is a stub: PublicKeyCredential and
// navigator.credentials.get, as @simplewebauthn/browser calls them.
import { MutationObserver, QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthStatusDTO } from '@shared/types';
import { ApiError } from './errors';
import { qk } from './keys';
import { reauthPasskeyOptions, removePasskeyOptions, signInWithPasskey, signInWithPasskeyAutofill } from './passkeys';

const USER = { id: 7, email: 'ada@example.com', displayName: 'Ada' };
const bytes = (...b: number[]) => new Uint8Array(b).buffer;

/** What navigator.credentials.get resolves with for the passkey `cred-1`. */
const credential = {
  id: 'cred-1',
  rawId: bytes(1, 2, 3),
  type: 'public-key',
  response: { authenticatorData: bytes(4), clientDataJSON: bytes(5), signature: bytes(6), userHandle: bytes(7) },
  authenticatorAttachment: 'platform',
  getClientExtensionResults: () => ({}),
};

interface Sent {
  path: string;
  body: unknown;
  /** The conditional request had been aborted when this was sent. */
  autofillEnded: boolean;
}

let sent: Sent[];
let autofillEnded: boolean;
let answers: Record<string, () => Response>;
let get: ReturnType<typeof vi.fn>;
let signals: { unknown: ReturnType<typeof vi.fn>; accepted: ReturnType<typeof vi.fn> };

function client(): QueryClient {
  const qc = new QueryClient();
  qc.setQueryData<Partial<AuthStatusDTO>>(qk.authStatus, {
    user: null,
    instance: { passkeys: { enabled: true, origin: 'http://localhost:19610', rpId: 'localhost' } } as AuthStatusDTO['instance'],
  });
  return qc;
}

const ceremony = (id: string) => () => Response.json({ ceremonyId: id, options: { challenge: 'AAAA', rpId: 'localhost', allowCredentials: [], userVerification: 'required' } });

beforeEach(() => {
  sent = [];
  autofillEnded = false;
  answers = {
    '/api/auth/passkey/login/options': ceremony('c1'),
    '/api/auth/passkey/login': () => Response.json({ user: USER }),
  };
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    sent.push({ path: url, body: init.body ? JSON.parse(init.body as string) : undefined, autofillEnded });
    const answer = answers[url];
    return answer ? answer() : Response.json({ error: { code: 'not_found', message: 'Not found' } }, { status: 404 });
  });
  signals = { unknown: vi.fn(async () => undefined), accepted: vi.fn(async () => undefined) };
  const PublicKeyCredential = Object.assign(function PublicKeyCredential() {}, {
    isConditionalMediationAvailable: async () => true,
    signalUnknownCredential: signals.unknown,
    signalAllAcceptedCredentials: signals.accepted,
  });
  vi.stubGlobal('PublicKeyCredential', PublicKeyCredential);
  // A conditional request waits until it is aborted; a modal one answers with the passkey at once.
  get = vi.fn(
    (options: CredentialRequestOptions & { mediation?: string }) =>
      new Promise((resolve, reject) => {
        if (options.mediation !== 'conditional') return resolve(credential);
        options.signal?.addEventListener('abort', () => {
          autofillEnded = true;
          reject(options.signal?.reason);
        });
      }),
  );
  vi.stubGlobal('navigator', { credentials: { get } });
  vi.stubGlobal('document', { querySelectorAll: () => [{}] });
});

afterEach(() => vi.unstubAllGlobals());

describe('signing in with a passkey', () => {
  it('aborts the pending autofill request before the button’s own, then signs in with the passkey picked', async () => {
    const qc = client();
    const onPicked = vi.fn();
    answers['/api/auth/passkey/login/options'] = ceremony('c-autofill');
    const autofill = signInWithPasskeyAutofill(qc, { wanted: () => true, onPicked });
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    expect(get.mock.calls[0]![0]).toMatchObject({ mediation: 'conditional' });

    answers['/api/auth/passkey/login/options'] = ceremony('c-modal');
    await expect(signInWithPasskey(qc)).resolves.toEqual(USER);
    await expect(autofill).rejects.toMatchObject({ code: 'ERROR_CEREMONY_ABORTED' });
    expect(onPicked).not.toHaveBeenCalled();
    expect(get.mock.calls[1]![0]).not.toHaveProperty('mediation');
    // Ended before the button's options call (§5.8.3), not only once its own request began.
    expect(sent).toEqual([
      { path: '/api/auth/passkey/login/options', body: { conditional: true }, autofillEnded: false },
      { path: '/api/auth/passkey/login/options', body: {}, autofillEnded: true },
      {
        path: '/api/auth/passkey/login',
        body: { ceremonyId: 'c-modal', response: expect.objectContaining({ id: 'cred-1', rawId: 'AQID', type: 'public-key' }) },
        autofillEnded: true,
      },
    ]);
  });

  it('reports a passkey the instance does not know to the browser, and still fails', async () => {
    const qc = client();
    answers['/api/auth/passkey/login'] = () =>
      Response.json(
        { error: { code: 'passkey_error', message: 'This passkey could not be used to sign in.', details: [{ path: 'credential', message: 'unknown' }] } },
        { status: 400 },
      );
    const failed = await signInWithPasskey(qc).catch((err: unknown) => err);
    expect(failed).toBeInstanceOf(ApiError);
    expect(signals.unknown).toHaveBeenCalledWith({ rpId: 'localhost', credentialId: 'cred-1' });

    // Another refusal names no credential: nothing to report. A browser without the signal API: no harm.
    answers['/api/auth/passkey/login'] = () => Response.json({ error: { code: 'passkey_error', message: 'This passkey could not be used to sign in.' } }, { status: 400 });
    await expect(signInWithPasskey(qc)).rejects.toBeInstanceOf(ApiError);
    expect(signals.unknown).toHaveBeenCalledTimes(1);
    delete (globalThis.PublicKeyCredential as { signalUnknownCredential?: unknown }).signalUnknownCredential;
    answers['/api/auth/passkey/login'] = () =>
      Response.json({ error: { code: 'passkey_error', message: 'x', details: [{ path: 'credential', message: 'unknown' }] } }, { status: 400 });
    await expect(signInWithPasskey(qc)).rejects.toBeInstanceOf(ApiError);
  });

  it('the autofill asks the server for nothing where the browser has none, or once it is no longer wanted', async () => {
    const qc = client();
    (globalThis.PublicKeyCredential as { isConditionalMediationAvailable?: unknown }).isConditionalMediationAvailable = undefined;
    await expect(signInWithPasskeyAutofill(qc, { wanted: () => true, onPicked: vi.fn() })).resolves.toBeNull();
    expect(sent).toEqual([]);

    (globalThis.PublicKeyCredential as { isConditionalMediationAvailable?: unknown }).isConditionalMediationAvailable = async () => true;
    let wanted = true;
    answers['/api/auth/passkey/login/options'] = () => {
      wanted = false;
      return ceremony('c1')();
    };
    await expect(signInWithPasskeyAutofill(qc, { wanted: () => wanted, onPicked: vi.fn() })).resolves.toBeNull();
    expect(get).not.toHaveBeenCalled();
  });
});

describe('removePasskeyOptions', () => {
  it('tells the browser which passkeys the account keeps here', async () => {
    const qc = client();
    answers['/api/account/passkeys/4'] = () => Response.json({ ok: true, acceptedCredentialIds: ['cred-2', 'cred-3'], userHandle: 'handle-7' });
    const observer = new MutationObserver(qc, removePasskeyOptions(qc));
    await observer.mutate(4);
    expect(sent).toEqual([{ path: '/api/account/passkeys/4', body: undefined, autofillEnded: false }]);
    // Sent once the library (loaded on demand) is there.
    await vi.waitFor(() =>
      expect(signals.accepted).toHaveBeenCalledWith({ rpId: 'localhost', userId: 'handle-7', allAcceptedCredentialIds: ['cred-2', 'cred-3'] }),
    );
  });
});

describe('reauthPasskeyOptions', () => {
  it('after a passkey_error (removed elsewhere meanwhile), reads the account’s passkeys and status again', async () => {
    const qc = client();
    qc.setQueryData(qk.passkeys, [{ id: 3 }]);
    answers['/api/account/reauth/passkey/options'] = ceremony('c-reauth');
    answers['/api/account/reauth/passkey'] = () =>
      Response.json({ error: { code: 'passkey_error', message: 'This passkey could not be used to confirm it is you.' } }, { status: 400 });
    const observer = new MutationObserver(qc, reauthPasskeyOptions(qc));
    await expect(observer.mutate()).rejects.toMatchObject({ code: 'passkey_error' });
    expect(qc.getQueryState(qk.passkeys)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(qk.authStatus)?.isInvalidated).toBe(true);
    // Another failure (the browser's own) leaves them be.
    const fresh = client();
    fresh.setQueryData(qk.passkeys, [{ id: 3 }]);
    get.mockImplementationOnce(() => Promise.reject(Object.assign(new Error('closed'), { name: 'NotAllowedError' })));
    await expect(new MutationObserver(fresh, reauthPasskeyOptions(fresh)).mutate()).rejects.toBeDefined();
    expect(fresh.getQueryState(qk.passkeys)?.isInvalidated).toBe(false);
  });
});
