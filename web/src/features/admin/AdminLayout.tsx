// /admin: the instance administration, for instance admins only (design §12.2); anyone else gets the
// not-found page, as for a path that does not exist. Sections: Overview, Settings, Users (and one user's
// page), Invitations and Spaces.

import { LayoutDashboard, LayoutGrid, MailPlus, Settings, Shield, Users } from 'lucide-react';
import { useAccount } from '../../api/auth';
import NotFoundPage from '../common/NotFoundPage';
import { SettingsLayout, type SettingsSection } from '../settings/SettingsLayout';

const SECTIONS: readonly SettingsSection[] = [
  { to: '/admin', label: 'Overview', icon: <LayoutDashboard aria-hidden />, end: true },
  { to: '/admin/settings', label: 'Settings', icon: <Settings aria-hidden /> },
  { to: '/admin/users', label: 'Users', icon: <Users aria-hidden /> },
  { to: '/admin/invitations', label: 'Invitations', icon: <MailPlus aria-hidden /> },
  { to: '/admin/spaces', label: 'Spaces', icon: <LayoutGrid aria-hidden /> },
];

export default function AdminLayout() {
  const account = useAccount();
  if (!account.isInstanceAdmin) return <NotFoundPage />;
  return <SettingsLayout title="Administration" icon={<Shield aria-hidden />} sections={SECTIONS} />;
}
