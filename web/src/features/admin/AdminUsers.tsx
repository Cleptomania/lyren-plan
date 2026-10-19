// Administration → Users (design §5.8.18, §7.2): every account, newest first, searched by address,
// username or name, a page at a time. Each opens its own page (AdminUserDetail). `?orphaned=1` (the link of
// the overview's domain-move warning, §5.6) lists only the accounts that can only sign in with passkeys
// that do not work on this address.

import { ChevronRight, Search, Users } from 'lucide-react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { AdminUserDTO } from '@shared/types';
import { useAdminUsers } from '../../api/admin';
import { useAccount, useAuthStatus } from '../../api/auth';
import { Avatar, Badge, Button, EmptyState, ErrorState, Input, SkeletonList } from '../../components/ui';
import { formatRelativeTime, pluralize } from '../../lib/format';
import { useDebouncedValue } from '../../lib/hooks';
import { SettingsCard, SettingsPage } from '../settings/SettingsBlocks';
import { ORPHANED_FILTER_TEXT, userBadges, userIdentifier } from './users';

function UserRow({ user, meId, mail }: { user: AdminUserDTO; meId: number; mail: boolean }) {
  const details = [
    pluralize(user.spaces, 'space'),
    user.lastLoginAt ? `signed in ${formatRelativeTime(user.lastLoginAt)}` : 'no sign-in since joining',
  ];
  return (
    <li>
      <Link to={`/admin/users/${user.id}`} className="flex min-w-0 items-center gap-3 px-4 py-3 hover:bg-surface-2">
        <Avatar name={user.displayName} size="md" className={user.status === 'disabled' ? 'opacity-60' : undefined} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate text-sm font-medium text-fg">{user.displayName}</span>
            {userBadges(user, { meId, mail }).map((b) => (
              <Badge key={b.label} variant={b.variant}>
                {b.label}
              </Badge>
            ))}
          </div>
          <p className="truncate text-[13px] text-fg-muted">{userIdentifier(user)}</p>
          <p className="text-xs text-fg-subtle">{details.join(' · ')}</p>
        </div>
        <ChevronRight aria-hidden className="size-4 shrink-0 text-fg-subtle" />
      </Link>
    </li>
  );
}

export default function AdminUsers() {
  const account = useAccount();
  // Addresses can be verified: links can be mailed.
  const mail = useAuthStatus().data?.instance.mailLinks ?? false;
  const [params] = useSearchParams();
  const orphaned = params.get('orphaned') === '1';
  const [search, setSearch] = useState('');
  const q = useDebouncedValue(search.trim(), 250);
  const users = useAdminUsers(q, orphaned);
  const list = users.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <SettingsPage title="Users" description="Every account of this instance. Open one to disable it, change its rights, create a reset link or delete it.">
      {orphaned && (
        <p role="status" className="flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-[13px] text-fg">
          <span>{ORPHANED_FILTER_TEXT}</span>
          <Link to="/admin/users" className="font-medium text-accent hover:underline">
            Show all accounts
          </Link>
        </p>
      )}
      <Input
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search name, email or username"
        aria-label="Search users"
        leadingIcon={<Search aria-hidden />}
        maxLength={100}
      />
      <SettingsCard
        title={orphaned ? 'Accounts that can’t sign in here' : q ? 'Matching accounts' : 'Accounts'}
        flush
        footer={
          users.hasNextPage ? (
            <Button size="sm" onClick={() => void users.fetchNextPage()} loading={users.isFetchingNextPage}>
              Show more
            </Button>
          ) : undefined
        }
      >
        {users.isPending ? (
          <SkeletonList rows={4} className="px-4 pb-3" />
        ) : users.error ? (
          <ErrorState size="sm" error={users.error} onRetry={() => void users.refetch()} />
        ) : list.length === 0 ? (
          orphaned && !q ? (
            <EmptyState size="sm" icon={<Users />} title="Every account can sign in here" body="No account depends on passkeys that do not work on this address." className="border-t border-border" />
          ) : (
            <EmptyState size="sm" icon={<Users />} title="No account matches" body="Search for a part of a name, an email address or a username." className="border-t border-border" />
          )
        ) : (
          <ul className="divide-y divide-border border-t border-border" aria-label="Accounts">
            {list.map((u) => (
              <UserRow key={u.id} user={u} meId={account.id} mail={mail} />
            ))}
          </ul>
        )}
      </SettingsCard>
    </SettingsPage>
  );
}
