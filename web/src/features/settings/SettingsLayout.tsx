// Settings shell, shared by the account's settings (/settings), a space's (/s/:spaceId/settings) and the
// instance administration (/admin): one page header, a side navigation on desktop and a horizontal tab
// bar on phones (the tabs double as the "up" navigation, so sections need no back button). Sections
// are lazy routes; the inner Suspense keeps the header and navigation on screen while one loads.

import { clsx } from 'clsx';
import { Suspense, useMemo, type ReactNode } from 'react';
import { NavLink, Outlet } from 'react-router';
import { Page } from '../../components/layout/Page';
import { PageHeader } from '../../components/layout/PageHeader';
import { SkeletonText } from '../../components/ui';
import { useIsMobile } from '../../lib/hooks';

export interface SettingsSection {
  to: string;
  label: string;
  icon: ReactNode;
  /** The index section: active only on its own path. */
  end?: boolean;
}

function SideNav({ sections }: { sections: readonly SettingsSection[] }) {
  return (
    <nav aria-label="Settings sections" className="sticky top-[calc(env(safe-area-inset-top)+4.5rem)]">
      <ul className="flex flex-col gap-0.5">
        {sections.map((s) => (
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

export function SettingsLayout({
  title,
  icon,
  sections,
  backTo,
  children,
}: {
  title: string;
  icon: ReactNode;
  sections: readonly SettingsSection[];
  /** "Up" from the settings (the space, for a space's settings). */
  backTo?: string;
  /** Shown instead of the section's route (a section the viewer's role does not open). */
  children?: ReactNode;
}) {
  const isMobile = useIsMobile();
  const tabs = useMemo(() => sections.map(({ to, label, end }) => ({ to, label, end })), [sections]);
  return (
    <Page width="default" header={<PageHeader title={title} icon={icon} backTo={backTo} tabs={isMobile ? tabs : undefined} />}>
      <div className="md:grid md:grid-cols-[11rem_minmax(0,1fr)] md:gap-10">
        {!isMobile && (
          <div>
            <SideNav sections={sections} />
          </div>
        )}
        <div className="min-w-0 pb-8">
          <Suspense fallback={<SectionFallback />}>{children ?? <Outlet />}</Suspense>
        </div>
      </div>
    </Page>
  );
}
