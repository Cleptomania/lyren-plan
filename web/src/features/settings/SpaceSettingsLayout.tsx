// /s/:spaceId/settings: the space's settings (design §12.2), each section shown by the viewer's role
// (app/permissions.ts spaceSettingsSections): General for everyone (read-only below admin), Members,
// Invitations and Statuses (admins), Tags (members and up), Data (owners) and the Danger zone (leave;
// transfer and delete for owners). A section the role does not open shows why instead.

import { CircleDashed, Database, Lock, MailPlus, Settings, SlidersHorizontal, Tags, TriangleAlert, Users } from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import { useLocation } from 'react-router';
import { spaceSettingsSections, type SpaceSettingsSection } from '../../app/permissions';
import { spaceOfPath, useSpace, useSpacePath } from '../../app/space';
import { EmptyState } from '../../components/ui';
import { SettingsLayout, type SettingsSection } from './SettingsLayout';

/** Each section: its path below the settings ('' for General), what it is called, who opens it. */
const SECTIONS: Record<SpaceSettingsSection, { segment: string; label: string; icon: ReactNode; who: string }> = {
  general: { segment: '', label: 'General', icon: <SlidersHorizontal aria-hidden />, who: '' },
  members: { segment: 'members', label: 'Members', icon: <Users aria-hidden />, who: '' },
  invitations: { segment: 'invitations', label: 'Invitations', icon: <MailPlus aria-hidden />, who: 'Only admins and owners invite people.' },
  statuses: { segment: 'statuses', label: 'Statuses', icon: <CircleDashed aria-hidden />, who: 'Only admins and owners manage statuses.' },
  tags: { segment: 'tags', label: 'Tags', icon: <Tags aria-hidden />, who: 'You have view-only access to this space.' },
  data: { segment: 'data', label: 'Data', icon: <Database aria-hidden />, who: 'Only owners export and import the space.' },
  danger: { segment: 'danger', label: 'Danger zone', icon: <TriangleAlert aria-hidden />, who: '' },
};

const ENTRIES = Object.entries(SECTIONS) as Array<[SpaceSettingsSection, (typeof SECTIONS)[SpaceSettingsSection]]>;

/** The section a path inside the space shows ('/settings/tags' → 'tags'), null outside the settings. */
function sectionOfPath(path: string): SpaceSettingsSection | null {
  const m = /^\/settings(?:\/([^/]*))?\/?$/.exec(path);
  if (!m) return null;
  return ENTRIES.find(([, s]) => s.segment === (m[1] ?? ''))?.[0] ?? null;
}

export default function SpaceSettingsLayout() {
  const { name, permissions } = useSpace();
  const sp = useSpacePath();
  const { pathname } = useLocation();
  const allowed = useMemo(() => spaceSettingsSections(permissions), [permissions]);
  const sections = useMemo<SettingsSection[]>(
    () =>
      allowed.map((key) => {
        const { segment, label, icon } = SECTIONS[key];
        return { to: sp(segment ? `/settings/${segment}` : '/settings'), label, icon, end: key === 'general' };
      }),
    [allowed, sp],
  );
  const current = sectionOfPath(spaceOfPath(pathname)?.path ?? '');
  const blocked = current !== null && !allowed.includes(current);
  return (
    <SettingsLayout title={`${name} settings`} icon={<Settings aria-hidden />} sections={sections}>
      {blocked ? <EmptyState icon={<Lock />} title={`${SECTIONS[current].label} isn’t available to you`} body={SECTIONS[current].who} /> : undefined}
    </SettingsLayout>
  );
}
