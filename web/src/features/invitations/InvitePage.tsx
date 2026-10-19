// /invite#t=… (design §5.8.8, §12.2, §12.7): an invitation link, to a space or (from an administrator) to
// an account of one's own. It says who invited whom to what, then offers the way in that fits
// (inviteView.ts): signed in as the invited address, join (a member keeps the higher role);
// signed in as someone else, say so and offer to sign out; signed out, create the account, or sign in and
// join, or both when the server does not say whether the address has an account (a copied link: a 409 from
// creating then switches to signing in). Accepting lands in the space. Refusals the reader cannot fix say
// what to do (inviteView.ts): sign-up closed (signup_disabled), a full space. Outside PublicOnly: it works
// signed in and out. A new account takes a password, or a passkey instead where passkeys are available.

import { KeyRound, LogOut, MailCheck, UserPlus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { LIMITS } from '@shared/constants';
import type { InvitationAcceptedDTO, InvitationPreviewDTO } from '@shared/types';
import { useSendVerification } from '../../api/account';
import { useAuthStatus, useLogout } from '../../api/auth';
import { ApiError, errorMessage } from '../../api/client';
import { useAcceptInvitation, useAcceptInvitationWithPasskey, useInvitationPreview } from '../../api/invitations';
import { usePasskeysAvailable, usePreloadedWebAuthn } from '../../api/passkeys';
import { rememberLastSpace, spaceLink } from '../../app/space';
import { Button, ButtonLink } from '../../components/ui/Button';
import { Field } from '../../components/ui/Field';
import { apiFieldErrors, hasFieldErrors, type FieldErrors } from '../../components/ui/formErrors';
import { Input } from '../../components/ui/Input';
import { SegmentedControl } from '../../components/ui/SegmentedControl';
import { formatDateTime } from '../../lib/format';
import { useDocumentTitle } from '../../lib/hooks';
import { failureText, webauthnFailure } from '../../lib/passkeys';
import { AuthLayout, FormAlert, FormNotice } from '../auth/AuthLayout';
import { LinkChecking, LinkProblem } from '../auth/LinkProblem';
import { linkFailure, signInHelp, type LinkFailure } from '../auth/linkPages';
import { NewPasswordFields, type NewPasswordValues } from '../auth/NewPasswordFields';
import { PasskeyExplainer, SwitchCredentialButton, type CredentialWay } from '../auth/PasskeyChoice';
import { SignInForm } from '../auth/SignInForm';
import { useLinkToken } from '../auth/useLinkToken';
import { proposedPasskeyName } from '../settings/passkeys';
import { newPasswordErrors } from '../settings/passwordStrength';
import { acceptRefusalHint, inviteSentence, inviteView, joinText, signupClosedHelp } from './inviteView';

/**
 * Creating the invited account: its name and a password, or a passkey instead (`passkeys`: they are
 * available here); the address is the invitation's.
 */
function NewAccountForm({
  preview,
  min,
  passkeys,
  onCreate,
}: {
  preview: InvitationPreviewDTO;
  min: number;
  passkeys: boolean;
  /** `password` null: with a passkey. Resolves with the field errors of a refusal to show (else the caller showed it). */
  onCreate: (input: { displayName: string; password: string | null }) => Promise<FieldErrors | null>;
}) {
  const [name, setName] = useState('');
  const [way, setWay] = useState<CredentialWay>('password');
  const [passwords, setPasswords] = useState<NewPasswordValues>({ password: '', confirm: '' });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const withPasskey = passkeys && way === 'passkey';
  const space = preview.kind === 'space';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const fe: FieldErrors = withPasskey ? {} : { ...newPasswordErrors(passwords.password, passwords.confirm, min) };
    if (!name.trim()) fe.displayName = 'Required';
    setErrors(fe);
    if (hasFieldErrors(fe)) return;
    setBusy(true);
    try {
      const refused = await onCreate({ displayName: name, password: withPasskey ? null : passwords.password });
      if (refused) setErrors(refused);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form method="post" noValidate onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
      <Field label="Email" hint="The invitation’s address. You sign in with it.">
        <Input value={preview.email} readOnly className="read-only:bg-surface-2 read-only:text-fg-muted read-only:shadow-none" />
      </Field>
      <Field label="Your name" required error={errors.displayName} hint="Shown to the members of your spaces.">
        <Input
          name="name"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (errors.displayName) setErrors((x) => ({ ...x, displayName: undefined }));
          }}
          autoComplete="name"
          autoFocus
          maxLength={LIMITS.displayNameMax}
        />
      </Field>
      {withPasskey ? (
        <PasskeyExplainer account={preview.email} />
      ) : (
        <NewPasswordFields
          values={passwords}
          errors={errors}
          min={min}
          username={preview.email}
          onChange={(key, value) => {
            setPasswords((p) => ({ ...p, [key]: value }));
            if (errors[key]) setErrors((x) => ({ ...x, [key]: undefined }));
          }}
        />
      )}
      <Button type="submit" variant="primary" fullWidth loading={busy} icon={withPasskey ? <KeyRound aria-hidden /> : <UserPlus aria-hidden />} className="mt-1">
        {withPasskey ? (space ? 'Join with a passkey' : 'Create account with a passkey') : space ? 'Create account and join' : 'Create account'}
      </Button>
      {passkeys && (
        <SwitchCredentialButton
          way={way}
          onSwitch={(next) => {
            setWay(next);
            setErrors((x) => ({ displayName: x.displayName }));
          }}
        />
      )}
    </form>
  );
}

function Invite({ token }: { token: string | null }) {
  useDocumentTitle('Invitation');
  const navigate = useNavigate();
  const status = useAuthStatus().data;
  const accept = useAcceptInvitation();
  const acceptWithPasskey = useAcceptInvitationWithPasskey();
  const passkeys = usePasskeysAvailable();
  usePreloadedWebAuthn(passkeys);
  const logout = useLogout();
  const verification = useSendVerification();
  // Once the invitation is accepted it is not asked about again (api/auth.ts LINK_PREVIEW_OPTIONS).
  const unused = (accept.isIdle || accept.isError) && (acceptWithPasskey.isIdle || acceptWithPasskey.isError);
  const preview = useInvitationPreview(unused ? token : null);
  const [refusal, setRefusal] = useState<LinkFailure | null>(null);
  // Creating an account was refused by the signup policy (the link itself is fine).
  const [signupClosed, setSignupClosed] = useState(false);
  const [formError, setFormError] = useState<{ message: string; hint: string | null } | null>(null);
  const [mustVerify, setMustVerify] = useState(false);
  // A copied link (account 'unknown'): which way in the reader takes, and why it switched.
  const [way, setWay] = useState<'create' | 'sign_in'>('create');
  const [switchedWhy, setSwitchedWhy] = useState<string | null>(null);

  const signedIn = Boolean(status?.user);
  const elsewhere = signedIn ? (
    <ButtonLink to="/spaces" fullWidth>
      Go to your spaces
    </ButtonLink>
  ) : (
    <ButtonLink to="/login" fullWidth>
      Sign in
    </ButtonLink>
  );

  if (token === null) return <LinkProblem kind="invitation" failure={null} actions={elsewhere} />;
  if (preview.isPending) return <LinkChecking title="Invitation" />;
  const failure = refusal ?? (preview.error ? linkFailure(preview.error) : null);
  if (failure !== null || !preview.data) return <LinkProblem kind="invitation" failure={failure} onRetry={() => void preview.refetch()} actions={elsewhere} />;
  const invitation = preview.data;
  const instanceName = status?.instance.name ?? 'Lyren Plan';
  const target = invitation.kind === 'space' ? (invitation.spaceName ?? 'the space') : instanceName;
  if (accept.isSuccess || acceptWithPasskey.isSuccess) return <LinkChecking title={`Join ${target}`} text={`Opening ${target}…`} />;

  /** Into the space joined (the auth status lists it by now), or the account's own for an instance invitation. */
  const land = (res: InvitationAcceptedDTO) => {
    if (res.spaceId === null) return void navigate('/', { replace: true });
    rememberLastSpace(res.spaceId);
    void navigate(spaceLink(res.spaceId, '/'), { replace: true });
  };

  /** A refusal of accepting: the link (its own page), the policy (its own page), or said above the form. */
  const refused = (err: unknown) => {
    const failed = linkFailure(err);
    if (failed.kind === 'invalid') return setRefusal(failed);
    if (err instanceof ApiError && err.code === 'signup_disabled') return setSignupClosed(true);
    if (err instanceof ApiError && err.status === 403 && /verify your email/i.test(err.message)) return setMustVerify(true);
    // Another account than the invited one (it signed in meanwhile): the preview says so.
    if (err instanceof ApiError && err.status === 403) void preview.refetch();
    setFormError({ message: failed.message, hint: err instanceof ApiError ? acceptRefusalHint(err.code, invitation) : null });
  };

  /** The signed-in account joins. */
  const join = async () => {
    setFormError(null);
    try {
      land(await accept.mutateAsync({ token }));
    } catch (err) {
      refused(err);
    }
  };

  const create = async ({ displayName, password }: { displayName: string; password: string | null }): Promise<FieldErrors | null> => {
    setFormError(null);
    try {
      land(
        password === null
          ? await acceptWithPasskey.mutateAsync({ token, displayName, passkeyName: proposedPasskeyName(navigator.userAgent) })
          : await accept.mutateAsync({ token, displayName, password }),
      );
      return null;
    } catch (err) {
      if (!(err instanceof ApiError)) {
        // The browser's part of the passkey: why it failed, or a hint when the browser ended it (failureText).
        const message = failureText(webauthnFailure(err, 'create'), 'create');
        if (message !== null) setFormError({ message, hint: null });
        return null;
      }
      const fields = apiFieldErrors(err);
      if (fields.password || fields.displayName) return fields;
      if (err instanceof ApiError && err.code === 'conflict') {
        // The address has an account (a copied link could not say): sign in to accept.
        setWay('sign_in');
        setSwitchedWhy(err.message);
        return null;
      }
      refused(err);
      return null;
    }
  };

  if (signupClosed) {
    const help = signupClosedHelp(invitation);
    return (
      <AuthLayout title={help.title}>
        <div className="flex flex-col gap-4">
          <p className="text-sm text-fg-muted">{help.text}</p>
          {help.signIn && !signedIn && (
            <Button
              variant="primary"
              fullWidth
              onClick={() => {
                setSignupClosed(false);
                setWay('sign_in');
                setSwitchedWhy(null);
              }}
            >
              Sign in to accept
            </Button>
          )}
          {elsewhere}
        </div>
      </AuthLayout>
    );
  }

  const view = inviteView(invitation);
  const min = status?.instance.passwordMinLength ?? LIMITS.passwordMin;
  const forgot = status ? signInHelp(status).forgot : false;
  const signInWay = (
    <div className="flex flex-col gap-4">
      {switchedWhy && <FormNotice>{switchedWhy}</FormNotice>}
      <SignInForm identifier={invitation.email} forgot={forgot} submitLabel="Sign in and join" onSignedIn={() => join()} />
    </div>
  );
  const createWay = <NewAccountForm preview={invitation} min={min} passkeys={passkeys} onCreate={create} />;

  let body;
  // With mail, an invitation is accepted by a verified address only (§5.8.8); the server says so too.
  const unverified = mustVerify || (status?.instance.mail === true && status.user !== null && !status.user.emailVerified);
  switch (view.kind) {
    case 'join':
      body = unverified ? (
        <div className="flex flex-col gap-3">
          <FormAlert>Verify your email address first: on this instance an invitation is accepted with a verified address only.</FormAlert>
          {verification.isSuccess ? (
            <FormNotice>
              We sent a verification link to {status?.user?.email}. Open it, then come back to this page and join.
            </FormNotice>
          ) : (
            <Button
              variant="primary"
              fullWidth
              icon={<MailCheck aria-hidden />}
              loading={verification.isPending}
              onClick={() => verification.mutate(undefined, { onError: (err) => setFormError({ message: errorMessage(err), hint: null }) })}
            >
              Send the verification link
            </Button>
          )}
          <Button fullWidth loading={accept.isPending} onClick={() => void join()}>
            I verified it: join
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-fg">{joinText(invitation)}</p>
          <Button variant="primary" fullWidth loading={accept.isPending} onClick={() => void join()}>
            {view.change === 'none' ? `Open ${target}` : view.change === 'raise' ? 'Accept' : `Join ${target}`}
          </Button>
        </div>
      );
      break;
    case 'has_account':
      body = (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-fg">
            This invitation is for an account of your own, and you have one already: {invitation.email}. There is nothing to accept.
          </p>
          <ButtonLink to="/" variant="primary" fullWidth>
            Open Lyren Plan
          </ButtonLink>
        </div>
      );
      break;
    case 'wrong_account':
      body = (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-fg">
            This invitation is for <span className="break-words font-medium">{invitation.email}</span>. You are signed in as{' '}
            <span className="break-words font-medium">{invitation.signedIn?.email ?? status?.user?.username ?? 'another account'}</span>. Sign out to
            accept it with the invited address.
          </p>
          <Button
            variant="primary"
            fullWidth
            icon={<LogOut aria-hidden />}
            loading={logout.isPending}
            // Signed out, the preview is asked for again (signing out drops it) and offers the ways in.
            onClick={() => void logout.mutateAsync().catch((err: unknown) => setFormError({ message: errorMessage(err), hint: null }))}
          >
            Sign out
          </Button>
          <ButtonLink to="/spaces" fullWidth>
            Keep using this account
          </ButtonLink>
        </div>
      );
      break;
    case 'create':
      // The address got an account meanwhile (409): signing in accepts it.
      body = way === 'sign_in' ? signInWay : createWay;
      break;
    case 'sign_in':
      body = signInWay;
      break;
    case 'choose':
      body = (
        <div className="flex flex-col gap-4">
          <SegmentedControl
            aria-label="Do you have an account?"
            fullWidth
            value={way}
            onChange={(next) => {
              setWay(next);
              setSwitchedWhy(null);
              setFormError(null);
            }}
            options={[
              { value: 'create', label: 'Create an account' },
              { value: 'sign_in', label: 'I have an account' },
            ]}
          />
          {way === 'create' ? createWay : signInWay}
        </div>
      );
      break;
  }

  return (
    <AuthLayout
      wide
      title={`Join ${target}`}
      subtitle={inviteSentence(invitation, instanceName)}
      footer={
        <>
          <p>Names are chosen by the person who sent the invitation.</p>
          <p className="mt-1">This invitation works until {formatDateTime(invitation.expiresAt)}.</p>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {formError && (
          <FormAlert>
            {formError.message}
            {formError.hint && <span className="mt-1 block text-fg-muted">{formError.hint}</span>}
          </FormAlert>
        )}
        {body}
      </div>
    </AuthLayout>
  );
}

/** A new link opened in place (the same page, another fragment) starts afresh. */
export default function InvitePage() {
  const token = useLinkToken();
  return <Invite key={token ?? ''} token={token} />;
}
