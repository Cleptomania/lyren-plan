// Space settings → Members (design §6.3, §12.9): who is in the space (name, email, role, "you",
// "disabled"), role menus where roles.ts canChangeRole allows a change (asking for the password first
// for the changes that need the re-auth window), removing, leaving and transferring ownership, and the
// way to Invitations for those who invite. The people who were members, and the names an import kept,
// are listed below, where admins reassign their entries to a member (design §8.6, §12.10); and anyone can
// give up the imported entries attributed to them ("These entries aren't mine", authorship.tsx).

import { ArrowRightLeft, ChevronDown, LogOut, MailPlus, MoreHorizontal, UserMinus, UserRoundPen, UserX } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { SpaceRole } from '@shared/roles';
import type { MemberDTO, PersonDTO } from '@shared/types';
import { useLookups } from '../../api/bootstrap';
import { useChangeMemberRole, useMembers, useRemoveMember } from '../../api/spaces';
import { leaveRefusal, memberActions, memberRoleChangeNeedsReauth, ROLE_DESCRIPTIONS, ROLE_LABELS } from '../../app/permissions';
import { useSpace, useSpacePath } from '../../app/space';
import { Avatar, Badge, Button, ButtonLink, ErrorState, IconButton, Menu, SkeletonList, toast, useConfirm, type MenuItem } from '../../components/ui';
import { personLabel } from '../../lib/people';
import { ensureReauth } from '../account/ReauthDialog';
import { DISOWNED_NAME, ReassignDialog, useDisownFlow } from './authorship';
import { SettingsCard, SettingsPage } from './SettingsBlocks';
import { TransferDialog, useLeaveSpaceFlow } from './spaceMembership';

export const EMAILS_NOTE = 'Members of this space can see each other’s email addresses.';

function RoleMenu({ member, roles }: { member: MemberDTO; roles: SpaceRole[] }) {
  const space = useSpace();
  const change = useChangeMemberRole(space.id);
  const setRole = async (role: SpaceRole) => {
    if (memberRoleChangeNeedsReauth(member, role) && !(await ensureReauth())) return;
    change.mutate(
      { userId: member.userId, role },
      {
        onSuccess: (saved) => toast.success(`${saved.displayName} is now ${ROLE_LABELS[saved.role].toLowerCase()}`),
        onError: (err) => toast.error(err),
      },
    );
  };
  const items: MenuItem[] = [member.role, ...roles]
    .sort((a, b) => ROLE_ORDER.indexOf(a) - ROLE_ORDER.indexOf(b))
    .map((role) => ({
      label: ROLE_LABELS[role],
      checked: role === member.role,
      onSelect: () => {
        if (role !== member.role) void setRole(role);
      },
    }));
  return (
    <Menu
      label={`Role of ${member.displayName}`}
      items={items}
      trigger={
        <Button
          size="sm"
          variant="ghost"
          loading={change.isPending}
          trailingIcon={<ChevronDown aria-hidden className="text-fg-subtle" />}
          aria-label={`Role of ${member.displayName}: ${ROLE_LABELS[member.role]}. Change role`}
          className="shrink-0"
        >
          {ROLE_LABELS[member.role]}
        </Button>
      }
    />
  );
}

const ROLE_ORDER: readonly SpaceRole[] = ['owner', 'admin', 'member', 'viewer'];

function MemberRow({
  member,
  onTransfer,
  onLeave,
  canLeave,
}: {
  member: MemberDTO;
  onTransfer: (userId: number) => void;
  onLeave: () => void;
  canLeave: boolean;
}) {
  const space = useSpace();
  const remove = useRemoveMember(space.id);
  const confirm = useConfirm();
  const actions = memberActions(space.role, member);

  const removeMember = async () => {
    const ok = await confirm({
      title: `Remove ${member.displayName} from ${space.name}?`,
      body: 'They lose access at once. Their comments and work logs stay, marked as from a former member.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    try {
      // The row leaves the list once the member is removed; the toast does not depend on it.
      await remove.mutateAsync(member.userId);
      toast.success(`Removed ${member.displayName}`);
    } catch (err) {
      toast.error(err);
    }
  };

  const menu: MenuItem[] = [
    ...(actions.transfer ? [{ label: 'Transfer ownership…', icon: <ArrowRightLeft />, onSelect: () => onTransfer(member.userId) }] : []),
    ...(member.isYou ? [{ label: 'Leave space…', icon: <LogOut />, danger: true, disabled: !canLeave, onSelect: onLeave }] : []),
    ...(actions.remove ? [{ label: 'Remove from space…', icon: <UserMinus />, danger: true, onSelect: () => void removeMember() }] : []),
  ];

  return (
    <li className="flex min-w-0 items-center gap-3 px-4 py-3">
      <Avatar name={member.displayName} size="md" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate text-sm font-medium text-fg">{member.displayName}</span>
          {member.isYou && <Badge variant="accent">You</Badge>}
          {member.status === 'disabled' && <Badge variant="danger">Disabled</Badge>}
        </div>
        <p className="truncate text-[13px] text-fg-muted">{member.email ?? 'No email address'}</p>
      </div>
      {actions.roles.length > 0 ? (
        <RoleMenu member={member} roles={actions.roles} />
      ) : (
        <span className="shrink-0 px-2 text-[13px] text-fg-muted">{ROLE_LABELS[member.role]}</span>
      )}
      {menu.length > 0 ? (
        <Menu
          label={`Actions for ${member.displayName}`}
          items={menu}
          trigger={<IconButton aria-label={`Actions for ${member.displayName}`} icon={<MoreHorizontal />} size="sm" loading={remove.isPending} className="-mr-1.5 shrink-0" />}
        />
      ) : (
        <span aria-hidden className="w-7 shrink-0" />
      )}
    </li>
  );
}

function FormerMembers() {
  const space = useSpace();
  const { people } = useLookups();
  const former = useMemo(() => people.filter((p) => !p.isMember), [people]);
  const byId = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);
  const [reassigning, setReassigning] = useState<PersonDTO | null>(null);
  if (former.length === 0) return null;
  const moderate = space.permissions.moderate;
  return (
    <SettingsCard
      title="Former members"
      description={
        moderate
          ? 'People who left or were removed, and names an import brought in. Their entries keep their names until you reassign them to a member.'
          : 'People who left or were removed, and names an import brought in. Their comments and work logs keep their names.'
      }
      flush
    >
      <ul className="divide-y divide-border border-t border-border" aria-label="Former members">
        {former.map((p) => {
          const label = personLabel({ id: p.id, displayName: p.displayName }, byId);
          return (
            <li key={p.id} className="flex min-w-0 items-center gap-3 px-4 py-2.5">
              <Avatar name={p.displayName} size="sm" className="opacity-70" />
              <span className="min-w-0 flex-1 truncate text-sm text-fg">
                {label.name}
                {label.note && <span className="ml-2 text-[13px] text-fg-muted">{label.note}</span>}
              </span>
              {moderate && (
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<UserRoundPen aria-hidden />}
                  hideLabelOnMobile
                  className="-my-1 -mr-1.5"
                  aria-label={`Reassign ${p.displayName}’s entries`}
                  onClick={() => setReassigning(p)}
                >
                  Reassign…
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      {moderate && <ReassignDialog person={reassigning} onClose={() => setReassigning(null)} />}
    </SettingsCard>
  );
}

/** Anyone: give up the imported entries attributed to oneself (design §8.6, §12.9). */
function ImportedUnderYourName() {
  const { disown, pending } = useDisownFlow();
  return (
    <SettingsCard
      title="Entries imported under your name"
      description={`An import can attribute comments, work logs and activity entries to you; they say “Imported by …”. Not yours? Give them up: they move to “${DISOWNED_NAME}”.`}
      actions={
        <Button size="sm" icon={<UserX aria-hidden />} loading={pending} onClick={() => void disown()}>
          These entries aren’t mine…
        </Button>
      }
    />
  );
}

export default function MembersSettings() {
  const space = useSpace();
  const sp = useSpacePath();
  const members = useMembers(space.id);
  const leave = useLeaveSpaceFlow();
  const [transfer, setTransfer] = useState<{ open: boolean; to?: number }>({ open: false });
  const refusal = leaveRefusal(members.data);

  return (
    <SettingsPage title="Members" description={EMAILS_NOTE}>
      <SettingsCard
        title={members.data ? `${members.data.length} ${members.data.length === 1 ? 'member' : 'members'}` : 'Members'}
        description={
          refusal === 'last_owner'
            ? 'You are the only owner. To leave, make someone else an owner first.'
            : space.permissions.manageMembers
              ? 'Change roles and remove people here.'
              : undefined
        }
        actions={
          space.permissions.invite ? (
            <ButtonLink to={sp('/settings/invitations')} size="sm" icon={<MailPlus aria-hidden />}>
              Invite people
            </ButtonLink>
          ) : undefined
        }
        flush
      >
        {members.isPending ? (
          <SkeletonList rows={3} className="px-4 pb-3" />
        ) : members.error ? (
          <ErrorState size="sm" error={members.error} onRetry={() => void members.refetch()} />
        ) : (
          <ul className="divide-y divide-border border-t border-border" aria-label="Members">
            {members.data.map((m) => (
              <MemberRow
                key={m.userId}
                member={m}
                canLeave={refusal === null}
                onLeave={() => void leave()}
                onTransfer={(to) => setTransfer({ open: true, to })}
              />
            ))}
          </ul>
        )}
      </SettingsCard>
      <FormerMembers />
      <ImportedUnderYourName />
      <RoleHelp />
      {members.data && (
        <TransferDialog open={transfer.open} to={transfer.to} members={members.data} onClose={() => setTransfer((t) => ({ ...t, open: false }))} />
      )}
    </SettingsPage>
  );
}

function RoleHelp() {
  return (
    <SettingsCard title="Roles">
      <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-[13px]">
        {ROLE_ORDER.map((role) => (
          <div key={role} className="contents">
            <dt className="font-medium text-fg">{ROLE_LABELS[role]}</dt>
            <dd className="text-fg-muted">{ROLE_DESCRIPTIONS[role]}</dd>
          </div>
        ))}
      </dl>
    </SettingsCard>
  );
}
