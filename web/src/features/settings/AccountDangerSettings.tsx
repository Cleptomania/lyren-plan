// Account settings → Danger zone: deleting the account (design §5.8.17, DELETE /api/account). It needs
// the re-auth window (asked for first) and the account's email address typed to confirm (its username
// for an account from before spaces without one). Spaces it is the only member of go with it; a space it
// is the only owner of, with other members in it, must get another owner first: the server refuses with
// last_owner and names those spaces, which are listed here with the way to their members.

import { TriangleAlert, UserX } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { useDeleteAccount } from '../../api/account';
import { useAccount } from '../../api/auth';
import { ApiError } from '../../api/client';
import { lastOwnerSpaces } from '../../api/errors';
import { spaceLink } from '../../app/space';
import { Button, toast, useConfirm } from '../../components/ui';
import { ensureReauth } from '../account/ReauthDialog';
import { SettingsCard, SettingsPage } from './SettingsBlocks';

/** A refusal the page explains in place (last_owner, last_admin), with the spaces last_owner names. */
interface Refusal {
  message: string;
  spaces: Array<{ id: string; name: string }>;
}

export default function AccountDangerSettings() {
  const account = useAccount();
  const remove = useDeleteAccount();
  const confirm = useConfirm();
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const confirmText = account.email ?? account.username ?? '';

  const start = async () => {
    setRefusal(null);
    if (!(await ensureReauth())) return;
    const ok = await confirm({
      title: 'Delete your account?',
      body:
        'Your account and every sign-in are deleted at once. Spaces where you are the only member are deleted with it. ' +
        'Your comments and work logs stay in the other spaces, marked as from a deleted account. This can’t be undone.',
      confirmLabel: 'Delete account',
      danger: true,
      typeToConfirm: confirmText,
    });
    if (!ok) return;
    remove.mutate(
      { confirm: confirmText },
      {
        onError: (err) => {
          if (err instanceof ApiError && (err.code === 'last_owner' || err.code === 'last_admin')) {
            setRefusal({ message: err.message, spaces: err.code === 'last_owner' ? lastOwnerSpaces(err) : [] });
          } else toast.error(err);
        },
      },
    );
  };

  return (
    <SettingsPage title="Danger zone" description="Changes here can’t be undone.">
      <SettingsCard
        title="Delete account"
        description="Delete your account and sign out everywhere. Spaces you own together with other members need another owner first."
        actions={
          <Button variant="danger" icon={<UserX aria-hidden />} loading={remove.isPending} onClick={() => void start()}>
            Delete account…
          </Button>
        }
      >
        {refusal ? (
          <div role="alert" className="flex gap-2.5 rounded-md border border-danger/30 bg-danger-soft p-3 text-[13px] text-fg">
            <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-danger" />
            <div className="min-w-0">
              <p className="font-medium">Your account was not deleted. {refusal.message.replace(/\.?$/, '.')}</p>
              {refusal.spaces.length > 0 && (
                <>
                  <p className="mt-1 text-fg-muted">
                    You are the only owner of these spaces, which have other members. Make someone else an owner (Settings →
                    Members), or delete the space (Settings → Danger zone):
                  </p>
                  <ul className="mt-1 list-disc pl-4">
                    {refusal.spaces.map((s) => (
                      <li key={s.id}>
                        <Link to={spaceLink(s.id, '/settings/members')} className="font-medium text-accent hover:underline">
                          {s.name}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </div>
        ) : undefined}
      </SettingsCard>
    </SettingsPage>
  );
}
