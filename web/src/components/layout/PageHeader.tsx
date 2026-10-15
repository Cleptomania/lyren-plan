// Page title bar (SPEC §9.1): back link, breadcrumbs, title/subtitle, actions, an overflow
// "⋯" menu and route tabs. Sticky at the top of the document (below the status bar on phones).

import { clsx } from 'clsx';
import { ArrowLeft, ChevronRight, MoreHorizontal } from 'lucide-react';
import { Fragment, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useIsMobile } from '../../lib/hooks';
import { IconButton, iconButtonClasses } from '../ui/Button';
import { Menu, type MenuItem } from '../ui/Menu';
import { RouteTabs, type RouteTab } from '../ui/Tabs';
import { Tooltip } from '../ui/Tooltip';
import { usePageWidthClass } from './Page';

export interface Breadcrumb {
  label: ReactNode;
  to?: string;
}

export interface PageHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Leading visual: icon or ColorDot. */
  icon?: ReactNode;
  /** "Up" destination (nested pages). Shown as ← on phones (and on desktop without breadcrumbs). */
  backTo?: string;
  /** Desktop trail above the title. On phones the last linked crumb becomes the ← target if backTo is unset. */
  breadcrumbs?: Breadcrumb[];
  /** Buttons at the end of the title row. Keep them few on phones (use hideLabelOnMobile / `menu`). */
  actions?: ReactNode;
  /** Overflow "⋯" menu at the very end of the title row. */
  menu?: MenuItem[];
  /** Sub-page tabs under the title. */
  tabs?: RouteTab[];
  /** Extra row below the title (e.g. filters), above the tabs. */
  children?: ReactNode;
  /** Stick to the top while the document scrolls (default true). */
  sticky?: boolean;
  className?: string;
}

export function PageHeader({
  title,
  subtitle,
  icon,
  backTo,
  breadcrumbs,
  actions,
  menu,
  tabs,
  children,
  sticky = true,
  className,
}: PageHeaderProps) {
  const isMobile = useIsMobile();
  const widthClass = usePageWidthClass();
  const crumbs = breadcrumbs?.filter((c) => c.label !== undefined && c.label !== null) ?? [];
  const showCrumbs = !isMobile && crumbs.length > 0;
  const upTarget = backTo ?? (isMobile ? [...crumbs].reverse().find((c) => c.to)?.to : undefined);
  const showBack = !!upTarget && (isMobile || !showCrumbs);

  return (
    <header
      className={clsx(
        'z-20 border-b border-border bg-bg/90 pt-safe backdrop-blur-md',
        sticky && 'sticky top-0',
        className,
      )}
    >
      <div className={clsx('mx-auto flex w-full min-w-0 flex-col px-4 md:px-6', widthClass)}>
        {showCrumbs && (
          <nav aria-label="Breadcrumb" className="-mb-1.5 flex min-w-0 items-center gap-1 pt-3 text-xs text-fg-muted">
            {crumbs.map((c, i) => (
              <Fragment key={i}>
                {i > 0 && <ChevronRight aria-hidden className="size-3 shrink-0 text-fg-subtle" />}
                {c.to ? (
                  <Link to={c.to} className="max-w-48 truncate rounded hover:text-fg">
                    {c.label}
                  </Link>
                ) : (
                  <span className="max-w-48 truncate">{c.label}</span>
                )}
              </Fragment>
            ))}
          </nav>
        )}
        <div className="flex min-h-14 min-w-0 items-center gap-2 py-2">
          {showBack && (
            <Tooltip content="Back">
              <Link to={upTarget} aria-label="Back" className={clsx(iconButtonClasses({ size: 'md' }), '-ml-2 [&_svg]:size-5')}>
                <ArrowLeft aria-hidden />
              </Link>
            </Tooltip>
          )}
          {icon && <span className="flex shrink-0 items-center text-fg-muted [&_svg]:size-5">{icon}</span>}
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-semibold leading-6 text-fg md:text-lg">{title}</h1>
            {subtitle && <div className="truncate text-xs text-fg-muted md:text-[13px]">{subtitle}</div>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
          {menu && menu.length > 0 && (
            <Menu trigger={<IconButton aria-label="More actions" icon={<MoreHorizontal />} className="-mr-2" />} items={menu} label="Actions" />
          )}
        </div>
        {children}
        {/* Phones: the strip runs to the screen edges, so more of a scrolled-out tab shows. */}
        {tabs && tabs.length > 0 && <RouteTabs tabs={tabs} className="-mb-px max-md:-mx-4 max-md:px-4" />}
      </div>
    </header>
  );
}
