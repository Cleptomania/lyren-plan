// Signing in with a passkey on the sign-in form (design §5.8.3, §12.7): the sign-in field's autofill
// (conditional UI), asked for when the form mounts, and the "Sign in with a passkey" button, which aborts the
// pending autofill request before its own (modal) one and starts the autofill again afterwards. Each request
// has a number; a newer request or leaving the page makes an older one's answer moot. lib/passkeys.ts says
// what a failure comes to (the button's always says something, failureText; the autofill's only once a
// passkey was picked) and when the autofill asks again.

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { UserDTO } from '@shared/types';
import { cancelPasskeyRequest, signInWithPasskey, signInWithPasskeyAutofill } from '../../api/passkeys';
import { AUTOFILL_RENEW_MS, autofillAgain, failureText, webauthnFailure } from '../../lib/passkeys';

export interface PasskeySignIn {
  /** The button's (modal) sign-in. */
  signIn: () => Promise<void>;
  /** A sign-in is under way (the button's, or a passkey picked in the autofill). */
  busy: boolean;
  error: string | null;
  clearError: () => void;
}

export function usePasskeySignIn({ enabled, onSignedIn }: { enabled: boolean; onSignedIn?: (user: UserDTO) => Promise<unknown> | void }): PasskeySignIn {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = useRef(0);
  const after = useRef(onSignedIn);
  useEffect(() => {
    after.current = onSignedIn;
  });

  const autofill = useCallback(async (): Promise<void> => {
    const run = ++current.current;
    const wanted = () => current.current === run;
    const started = Date.now();
    let picked = false;
    // Replaced by a new request before the server's ceremony expires (lib/passkeys.ts AUTOFILL_RENEW_MS).
    const renew = setTimeout(() => {
      if (!wanted() || picked) return;
      cancelPasskeyRequest();
      void autofill();
    }, AUTOFILL_RENEW_MS);
    try {
      const user = await signInWithPasskeyAutofill(qc, {
        wanted,
        onPicked: () => {
          picked = true;
          setError(null);
          setBusy(true);
        },
      });
      if (user !== null) await after.current?.(user);
    } catch (err) {
      if (!wanted()) return;
      const failure = webauthnFailure(err, 'sign_in');
      // Before a passkey was picked, a refusal (the options call, the browser) is not the reader's doing: the button still works.
      if (picked && failure.kind === 'message') setError(failure.message);
      // Before asking again: the new request's number makes this one's `finally` leave `busy` alone.
      setBusy(false);
      if (autofillAgain({ failure, picked, elapsedMs: Date.now() - started, err })) void autofill();
    } finally {
      clearTimeout(renew);
      if (wanted()) setBusy(false);
    }
  }, [qc]);

  useEffect(() => {
    if (!enabled) return;
    void autofill();
    return () => {
      current.current++;
      cancelPasskeyRequest();
    };
  }, [enabled, autofill]);

  const signIn = async () => {
    const run = ++current.current;
    setError(null);
    setBusy(true);
    let again = true;
    try {
      const user = await signInWithPasskey(qc);
      again = false;
      await after.current?.(user);
    } catch (err) {
      if (current.current !== run) return;
      // A browser that ended the request (NotAllowedError) may have shown nothing: a hint, not silence.
      setError(failureText(webauthnFailure(err, 'sign_in'), 'sign_in'));
    } finally {
      if (current.current === run) {
        setBusy(false);
        // Signed in, the page moves on; otherwise the autofill is offered again.
        if (again && enabled) void autofill();
      }
    }
  };

  return { signIn, busy, error, clearError: () => setError(null) };
}
