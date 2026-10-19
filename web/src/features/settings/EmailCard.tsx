// Account settings → Profile → Email address (design §5.8.6, §5.8.10, §12.2): the address with its
// verified state, a new verification link while it is not verified (instances that mail), and changing it,
// which asks for the password first (the re-auth window). With mail the new address gets a confirmation
// link that works in a session of this account only; without mail the change is immediate. An account
// from before email addresses gets the same form to add one, with a prompt that says why.

import { MailCheck, MailPlus, Pencil } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { LIMITS } from '@shared/constants';
import { emailSchema } from '@shared/email';
import { useChangeEmail, useSendVerification } from '../../api/account';
import { useAccount, useAuthStatus } from '../../api/auth';
import { errorMessage } from '../../api/client';
import { Badge, Button, Field, Input, apiFieldErrors, toast } from '../../components/ui';
import { ensureReauth } from '../account/ReauthDialog';
import { emailChangeText, emailDescription, emailState } from './accountEmail';
import { SettingsCard } from './SettingsBlocks';

function ChangeEmailForm({ onDone, adding }: { onDone: (message: string | null) => void; adding: boolean }) {
  const user = useAccount();
  const change = useChangeEmail();
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | undefined>();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (change.isPending) return;
    const parsed = emailSchema.safeParse(email);
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'Enter a valid email address');
    if (!(await ensureReauth())) return;
    try {
      const res = await change.mutateAsync({ email: parsed.data.address });
      if (!res.pending) toast.success(emailChangeText(res, parsed.data.address, user));
      onDone(res.pending ? emailChangeText(res, parsed.data.address, user) : null);
    } catch (err) {
      // The same address, one taken (without mail), a daily limit: said at the field, which keeps it.
      setError(apiFieldErrors(err).email ?? errorMessage(err));
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="flex flex-col gap-3">
      <Field label={adding ? 'Email address' : 'New email address'} error={error}>
        <Input
          type="email"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            if (error) setError(undefined);
          }}
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          autoFocus
          maxLength={LIMITS.identifierMax}
          placeholder="name@example.com"
        />
      </Field>
      <div className="flex flex-wrap justify-end gap-2">
        <Button onClick={() => onDone(null)} disabled={change.isPending}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={change.isPending}>
          {adding ? 'Add address' : 'Change address'}
        </Button>
      </div>
    </form>
  );
}

export function EmailCard() {
  const user = useAccount();
  // Verification and a confirmed change need links that can be mailed (MAIL_LOG_BODIES's log too).
  const mail = useAuthStatus().data?.instance.mailLinks ?? false;
  const verify = useSendVerification();
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const state = emailState(user, mail);

  const sendVerification = () =>
    verify.mutate(undefined, {
      onSuccess: () => toast.success(`We sent a verification link to ${user.email}. It works for 24 hours.`),
      onError: (err) => toast.error(err),
    });

  return (
    <SettingsCard
      title="Email address"
      description={emailDescription(state)}
      actions={
        !editing && state !== 'none' ? (
          <Button size="sm" icon={<Pencil aria-hidden />} onClick={() => setEditing(true)}>
            Change
          </Button>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-3">
        {state === 'none' ? (
          !editing && (
            <div className="flex flex-wrap items-center gap-3 rounded-md border border-warning/40 bg-warning-soft px-3 py-2.5 text-[13px] text-fg">
              <span className="min-w-0 flex-1">
                This account has no email address yet{user.username ? `; it signs in as ${user.username}` : ''}.
              </span>
              <Button size="sm" variant="primary" icon={<MailPlus aria-hidden />} onClick={() => setEditing(true)}>
                Add email address
              </Button>
            </div>
          )
        ) : (
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="break-words text-sm font-medium text-fg">{user.email}</span>
            {state === 'verified' && mail && <Badge variant="success">Verified</Badge>}
            {state === 'unverified' && <Badge variant="warning">Not verified</Badge>}
          </div>
        )}
        {state === 'unverified' && !editing && (
          <div className="flex flex-wrap items-center gap-3 text-[13px] text-fg-muted">
            <span className="min-w-0 flex-1">Follow the link we sent to it. Nothing arrived, or the link expired?</span>
            <Button size="sm" icon={<MailCheck aria-hidden />} loading={verify.isPending} onClick={sendVerification}>
              Send a new link
            </Button>
          </div>
        )}
        {pending && !editing && (
          <p role="status" className="rounded-md border border-success/30 bg-success-soft p-3 text-[13px] text-fg">
            {pending}
          </p>
        )}
        {editing && (
          <ChangeEmailForm
            adding={state === 'none'}
            onDone={(message) => {
              setEditing(false);
              if (message) setPending(message);
            }}
          />
        )}
      </div>
    </SettingsCard>
  );
}
