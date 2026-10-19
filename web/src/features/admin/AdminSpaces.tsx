// Administration → Spaces (design §5.8.16, §5.8.18, §13.11): every space of the instance, newest first, with
// its owners, members, state and size, but none of its content (administrators get no membership). Deleting
// works as for its owner (restorable for SPACE_DELETE_GRACE_DAYS), and a deleted space can be restored while
// its grace period runs and someone could open it again. Both ask for the password first when the re-auth
// window is closed.

import { ArchiveRestore, LayoutGrid, MoreHorizontal, Search, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { localToday } from '@shared/dates';
import type { AdminSpaceDTO } from '@shared/types';
import { useAdminSpaces, useDeleteAdminSpace, useRestoreAdminSpace } from '../../api/admin';
import { SpaceTile } from '../../components/layout/SpaceSwitcher';
import { Badge, Button, EmptyState, ErrorState, IconButton, Input, Menu, SkeletonList, toast, useConfirm, type MenuItem } from '../../components/ui';
import { formatDate, formatDateTime, isoToLocalDate, pluralize } from '../../lib/format';
import { useDebouncedValue } from '../../lib/hooks';
import { ensureReauth } from '../account/ReauthDialog';
import { SettingsCard, SettingsPage } from '../settings/SettingsBlocks';
import { formatBytes, ownersText, spaceActions, spaceState, spaceStateText } from './spaces';

function SpaceRow({ space }: { space: AdminSpaceDTO }) {
  const remove = useDeleteAdminSpace();
  const restore = useRestoreAdminSpace();
  const confirm = useConfirm();
  const now = Date.now();
  const today = localToday();
  const state = spaceState(space, now);
  const actions = spaceActions(space, now);

  const deleteSpace = async () => {
    const importing = state.kind === 'importing';
    const ok = await confirm({
      title: `Delete the space ${space.name}?`,
      body: importing
        ? 'It is still being imported: its data is removed at once.'
        : 'Its members lose access at once. Its owners, or an administrator, can restore it for a while; then it is removed for good.',
      confirmLabel: 'Delete space',
      danger: true,
      typeToConfirm: importing ? undefined : space.name,
    });
    if (!ok || !(await ensureReauth())) return;
    try {
      // A space being imported leaves the list at once; the toast does not depend on its row.
      const res = await remove.mutateAsync(space.id);
      toast.success(importing ? `Deleted ${space.name}` : `Deleted ${space.name}. It can be restored until ${formatDate(isoToLocalDate(res.purgeAfter), today)}.`);
    } catch (err) {
      toast.error(err);
    }
  };

  const restoreSpace = async () => {
    const ok = await confirm({ title: `Restore the space ${space.name}?`, body: 'Its members can open it again at once.', confirmLabel: 'Restore' });
    if (!ok || !(await ensureReauth())) return;
    try {
      await restore.mutateAsync(space.id);
      toast.success(`Restored ${space.name}`);
    } catch (err) {
      toast.error(err);
    }
  };

  const menu: MenuItem[] = [
    ...(actions.restore ? [{ label: 'Restore…', icon: <ArchiveRestore />, onSelect: () => void restoreSpace() }] : []),
    ...(actions.delete ? [{ label: 'Delete space…', icon: <Trash2 />, danger: true, onSelect: () => void deleteSpace() }] : []),
  ];
  // "266 KB" stays on one line where the details wrap (phones).
  const size = formatBytes(space.bytes)?.replace(' ', '\u00a0');
  const details = [ownersText(space.owners), pluralize(space.memberCount, 'member'), size, `created ${formatDate(isoToLocalDate(space.createdAt), today)}`].filter(Boolean);
  const deleted = state.kind === 'deleted' || state.kind === 'removing';

  return (
    <li className="flex min-w-0 items-center gap-3 px-4 py-3">
      <SpaceTile name={space.name} className={deleted ? 'size-8 text-xs opacity-60' : 'size-8 text-xs'} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate text-sm font-medium text-fg" title={space.name}>
            {space.name}
          </span>
          {state.kind !== 'active' && <Badge variant={deleted ? 'danger' : 'warning'}>{spaceStateText(state, today)}</Badge>}
        </div>
        <p className="text-[13px] text-fg-muted" title={formatDateTime(space.createdAt)}>
          {details.join(' · ')}
        </p>
        <p className="truncate font-mono text-[11px] text-fg-subtle">{space.id}</p>
      </div>
      {menu.length > 0 ? (
        <Menu
          label={`Actions for ${space.name}`}
          items={menu}
          trigger={
            <IconButton
              aria-label={`Actions for ${space.name}`}
              icon={<MoreHorizontal />}
              size="sm"
              loading={remove.isPending || restore.isPending}
              className="-mr-1.5 shrink-0"
            />
          }
        />
      ) : (
        <span aria-hidden className="w-7 shrink-0" />
      )}
    </li>
  );
}

export default function AdminSpaces() {
  const [search, setSearch] = useState('');
  const q = useDebouncedValue(search.trim(), 250);
  const spaces = useAdminSpaces(q);
  const list = spaces.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <SettingsPage title="Spaces" description="Every space of this instance, with its owners and members. What is in a space is visible to its members only.">
      <Input
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search by name or space id"
        aria-label="Search spaces"
        leadingIcon={<Search aria-hidden />}
        maxLength={100}
      />
      <SettingsCard
        title={q ? 'Matching spaces' : 'Spaces'}
        flush
        footer={
          spaces.hasNextPage ? (
            <Button size="sm" onClick={() => void spaces.fetchNextPage()} loading={spaces.isFetchingNextPage}>
              Show more
            </Button>
          ) : undefined
        }
      >
        {spaces.isPending ? (
          <SkeletonList rows={4} className="px-4 pb-3" />
        ) : spaces.error ? (
          <ErrorState size="sm" error={spaces.error} onRetry={() => void spaces.refetch()} />
        ) : list.length === 0 ? (
          <EmptyState size="sm" icon={<LayoutGrid />} title={q ? 'No space matches' : 'No spaces yet'} className="border-t border-border" />
        ) : (
          <ul className="divide-y divide-border border-t border-border" aria-label="Spaces">
            {list.map((s) => (
              <SpaceRow key={s.id} space={s} />
            ))}
          </ul>
        )}
      </SettingsCard>
    </SettingsPage>
  );
}
