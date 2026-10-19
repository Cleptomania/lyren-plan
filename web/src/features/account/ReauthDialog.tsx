// The re-auth dialog (design §12.8). One ReauthHost is mounted for the signed-in app (AuthedApp); it
// asks for the password again, or one of the account's passkeys ("Use a passkey", where passkeys are
// available and one of them works here: reauth.ts reauthMethods), when an action needs the re-auth window
// (§5.4.4):
// - before a sensitive action: `await ensureReauth()` goes on at once while AuthStatusDTO.reauthUntil
//   is ahead, else opens the dialog, and resolves false when it is cancelled (downloads, which are
//   plain links, and the actions that know they need it: deleting, transferring, promoting);
// - on any reauth_required answer: the API client (setReauthHandler) opens the dialog and, once the
//   password or the passkey is confirmed, sends the refused request once more.
// Requests refused together share one dialog (reauth.ts sharedPrompt).

import { useQueryClient } from '@tanstack/react-query';
import { KeyRound } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import type { AuthStatusDTO } from '@shared/types';
import { useReauthPassword } from '../../api/account';
import { useAccount, useAuthStatus } from '../../api/auth';
import { errorMessage, setReauthHandler } from '../../api/client';
import { qk } from '../../api/keys';
import { cancelPasskeyRequest, usePasskeys, usePasskeysAvailable, usePreloadedWebAuthn, useReauthPasskey } from '../../api/passkeys';
import { queryClient } from '../../app/queryClient';
import { Button, Dialog, Field, PasswordInput, apiFieldErrors } from '../../components/ui';
import { failureText, webauthnFailure } from '../../lib/passkeys';
import { OrDivider } from '../auth/AuthLayout';
import { ensureReauthWith, reauthMethods, reauthText, reauthUnavailableText, sharedPrompt, type ReauthPrompt } from './reauth';

// The mounted host's prompt (null while none is: the action then does not go ahead).
let openPrompt: ReauthPrompt | null = null;
const prompt = sharedPrompt(() => (openPrompt ? openPrompt() : Promise.resolve(false)));

/**
 * Before an action that needs the re-auth window: true at once while it is open (`force`: ask anyway,
 * the server said it closed), else true once the password was confirmed, false when cancelled.
 */
export function ensureReauth(o: { force?: boolean } = {}): Promise<boolean> {
  // The cache, not a render's copy: a re-auth a moment ago updated it.
  const reauthUntil = queryClient.getQueryData<AuthStatusDTO>(qk.authStatus)?.reauthUntil;
  return ensureReauthWith({ reauthUntil, force: o.force, prompt });
}

/** Mount once, inside the signed-in app. */
export function ReauthHost() {
  const [pending, setPending] = useState<((ok: boolean) => void) | null>(null);

  useEffect(() => {
    openPrompt = () => new Promise<boolean>((resolve) => setPending(() => resolve));
    const uninstall = setReauthHandler(() => prompt());
    return () => {
      openPrompt = null;
      uninstall();
    };
  }, []);

  const done = (ok: boolean) => {
    pending?.(ok);
    setPending(null);
  };
  return <ReauthDialog open={pending !== null} onDone={done} />;
}

function ReauthDialog({ open, onDone }: { open: boolean; onDone: (ok: boolean) => void }) {
  const qc = useQueryClient();
  const account = useAccount();
  const reauth = useReauthPassword();
  const reauthPasskey = useReauthPasskey();
  const passkeysHere = usePasskeysAvailable();
  const mail = useAuthStatus().data?.instance.mailLinks;
  // Which of the account's passkeys work here (passkeyCount counts those of another address too).
  const passkeys = usePasskeys({ enabled: open && passkeysHere && account.passkeyCount > 0 });
  usePreloadedWebAuthn(open && passkeysHere && account.passkeyCount > 0);
  const methods = reauthMethods({
    hasPassword: account.hasPassword,
    passkeysHere,
    passkeyCount: account.passkeyCount,
    passkeys: passkeys.data,
    listFailed: passkeys.isError,
  });
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [passkeyError, setPasskeyError] = useState<string | null>(null);
  const [wasOpen, setWasOpen] = useState(false);
  // The typed password is kept no longer than the dialog is open, nor the one sent (the mutation's
  // variables) longer than its answer.
  if (open !== wasOpen) {
    setWasOpen(open);
    setPassword('');
    setError(undefined);
    setPasskeyError(null);
  }
  const pending = reauth.isPending || reauthPasskey.isPending;

  const confirmWithPasskey = () => {
    setPasskeyError(null);
    reauthPasskey.mutate(undefined, {
      onSuccess: () => {
        reauthPasskey.reset();
        setPassword('');
        onDone(true);
      },
      onError: (err) => {
        reauthPasskey.reset();
        setPasskeyError(failureText(webauthnFailure(err, 'confirm'), 'confirm'));
      },
    });
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!account.hasPassword) return;
    if (!password) return setError('Required');
    reauth.mutate(
      { password },
      {
        onSuccess: () => {
          reauth.reset();
          setPassword('');
          onDone(true);
        },
        // A wrong password is a field error (400); a lock-out or a server problem has a message of its own.
        onError: (err) => {
          reauth.reset();
          setError(apiFieldErrors(err).password ?? errorMessage(err));
        },
      },
    );
  };
  const cancel = () => {
    // Closed (Esc) while the browser asks for the passkey: that request ends too.
    if (reauthPasskey.isPending) cancelPasskeyRequest();
    reauth.reset();
    reauthPasskey.reset();
    setPassword('');
    onDone(false);
    // The window may have been open after all (another tab confirmed meanwhile): ask again later.
    void qc.invalidateQueries({ queryKey: qk.authStatus });
  };

  return (
    <Dialog
      open={open}
      onClose={cancel}
      title="Confirm it’s you"
      size="sm"
      mobileLayout="center"
      closeOnOutsideClick={false}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={cancel} disabled={pending}>
            Cancel
          </Button>
          {methods.password ? (
            <Button type="submit" variant="primary" loading={reauth.isPending} disabled={reauthPasskey.isPending}>
              Continue
            </Button>
          ) : (
            methods.passkey !== false && (
              <Button variant="primary" icon={<KeyRound aria-hidden />} loading={reauthPasskey.isPending || methods.passkey === 'checking'} onClick={confirmWithPasskey}>
                Use a passkey
              </Button>
            )
          )}
        </>
      }
    >
      <div className="flex flex-col gap-4 text-sm">
        <p className="text-fg-muted">{reauthText(methods)}</p>
        {methods.password && (
          <Field label="Password" error={error}>
            <PasswordInput
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                if (error) setError(undefined);
              }}
              autoComplete="current-password"
            />
          </Field>
        )}
        {methods.password && methods.passkey !== false && (
          <>
            <OrDivider />
            <Button
              fullWidth
              icon={<KeyRound aria-hidden />}
              loading={reauthPasskey.isPending || methods.passkey === 'checking'}
              disabled={reauth.isPending}
              onClick={confirmWithPasskey}
            >
              Use a passkey
            </Button>
          </>
        )}
        {passkeyError && (
          <p role="alert" className="text-[13px] text-danger">
            {passkeyError}
          </p>
        )}
        {!methods.password && methods.passkey === false && (
          <p className="text-fg">{reauthUnavailableText({ passkeysHere, passkeyCount: account.passkeyCount, mail: mail ?? false })}</p>
        )}
      </div>
    </Dialog>
  );
}
