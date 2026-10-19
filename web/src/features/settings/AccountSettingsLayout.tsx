// /settings: the account's own settings, outside any space (design §12.2): the profile (with the email
// address, its verification and changes), security (password, passkeys, signed-in devices, security
// events), preferences and the danger zone (deleting the account).

import { ShieldCheck, SlidersHorizontal, TriangleAlert, UserRound, UserRoundCog } from 'lucide-react';
import { SettingsLayout, type SettingsSection } from './SettingsLayout';

const SECTIONS: readonly SettingsSection[] = [
  { to: '/settings', label: 'Profile', icon: <UserRound aria-hidden />, end: true },
  { to: '/settings/security', label: 'Security', icon: <ShieldCheck aria-hidden /> },
  { to: '/settings/preferences', label: 'Preferences', icon: <SlidersHorizontal aria-hidden /> },
  { to: '/settings/danger', label: 'Danger zone', icon: <TriangleAlert aria-hidden /> },
];

export default function AccountSettingsLayout() {
  return <SettingsLayout title="Account settings" icon={<UserRoundCog aria-hidden />} sections={SECTIONS} />;
}
