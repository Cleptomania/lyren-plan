// Settings shell: one page header, a side navigation on desktop and a horizontal tab bar on
// phones (the tabs double as the "up" navigation, so sections need no back button). Sections
// are lazy routes; the inner Suspense keeps the header and navigation on screen while one loads.

import { clsx } from 'clsx';
import { Database, Settings, SlidersHorizontal, Tags, UserRound, CircleDashed } from 'lucide-react';
import { Suspense, type ReactNode } from 'react';
import { NavLink, Outlet } from 'react-router';
import { Page } from '../../components/layout/Page';
import { PageHeader } from '../../components/layout/PageHeader';
import { SkeletonText } from '../../components/ui';
import { useIsMobile } from '../../lib/hooks';

interface SettingsSection {
  to: string;
  label: string;
  icon: ReactNode;
  end?: boolean;
}

const SECTIONS: readonly SettingsSection[] = [
  { to: '/settings', label: 'Account', icon: <UserRound aria-hidden />, end: true },
  { to: '/settings/preferences', label: 'Preferences', icon: <SlidersHorizontal aria-hidden /> },
  { to: '/settings/statuses', label: 'Statuses', icon: <CircleDashed aria-hidden /> },
  { to: '/settings/tags', label: 'Tags', icon: <Tags aria-hidden /> },
  { to: '/settings/data', label: 'Data', icon: <Database aria-hidden /> },
];

const MOBILE_TABS = SECTIONS.map(({ to, label, end }) => ({ to, label, end }));

function SideNav() {
  return (
    <nav aria-label="Settings sections" className="sticky top-[calc(env(safe-area-inset-top)+4.5rem)]">
      <ul className="flex flex-col gap-0.5">
        {SECTIONS.map((s) => (
          <li key={s.to}>
            <NavLink
              to={s.to}
              end={s.end}
              className={({ isActive }) =>
                clsx(
                  'flex h-9 items-center gap-2.5 rounded-md px-2.5 text-sm font-medium transition-colors [&_svg]:size-4 [&_svg]:shrink-0',
                  isActive ? 'bg-surface-2 text-fg [&_svg]:text-accent' : 'text-fg-muted hover:bg-surface-2/70 hover:text-fg',
                )
              }
            >
              {s.icon}
              {s.label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function SectionFallback() {
  return (
    <div className="flex flex-col gap-4">
      <SkeletonText lines={2} className="max-w-sm" />
      <SkeletonText lines={5} />
    </div>
  );
}

export default function SettingsLayout() {
  const isMobile = useIsMobile();
  return (
    <Page
      width="default"
      header={<PageHeader title="Settings" icon={<Settings aria-hidden />} tabs={isMobile ? MOBILE_TABS : undefined} />}
    >
      <div className="md:grid md:grid-cols-[11rem_minmax(0,1fr)] md:gap-10">
        {!isMobile && (
          <div>
            <SideNav />
          </div>
        )}
        <div className="min-w-0 pb-8">
          <Suspense fallback={<SectionFallback />}>
            <Outlet />
          </Suspense>
        </div>
      </div>
    </Page>
  );
}
