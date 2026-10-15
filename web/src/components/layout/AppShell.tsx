// The signed-in app frame. Desktop: collapsible sidebar + document-scrolling content.
// Phones: bottom tab bar, floating "+" and the "More" sheet. Also hosts the offline
// banner, the Windows app's one-time tray hint, confirm dialogs and the task-actions host
// (components/domain), and sets the CSS
// layout variables used by pages/overlays
// (--bottom-bar-h, --offline-h, --fab-space; see index.css).

import { clsx } from 'clsx';
import { useCallback, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router';
import { useBootstrap } from '../../api/bootstrap';
import { useAppEvent } from '../../lib/events';
import { useIsMobile } from '../../lib/hooks';
import { TaskActionsHost } from '../domain/TaskActionsHost';
import { ConfirmHost } from '../ui/ConfirmDialog';
import { MobileNav } from './MobileNav';
import { OfflineBanner } from './OfflineBanner';
import { ShellLayoutContext } from './Page';
import { SIDEBAR_WIDTH, Sidebar } from './Sidebar';
import { TrayHint } from './TrayHint';
import { isBoolean, usePersistentState } from './usePersistentState';
import { useOnline } from './useShellState';

export function AppShell({ children }: { children: ReactNode }) {
  const isMobile = useIsMobile();
  const location = useLocation();
  const online = useOnline();
  // Set only by the single-file desktop app.
  const desktop = useBootstrap().data?.desktop;
  const [collapsed, setCollapsed] = usePersistentState('lyren.sidebar.collapsed', false, isBoolean);
  const [navOpen, setNavOpen] = useState(false);
  const [fullBleed, setFullBleed] = useState(0);

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.classList.add('has-app-shell');
    return () => root.classList.remove('has-app-shell');
  }, []);
  useEffect(() => {
    document.documentElement.classList.toggle('is-offline', !online);
    return () => document.documentElement.classList.remove('is-offline');
  }, [online]);

  // 'toggle-nav': the "More" sheet on phones, the sidebar on desktop (open = expanded).
  useAppEvent('toggle-nav', ({ open }) => {
    if (isMobile) setNavOpen((o) => open ?? !o);
    else setCollapsed((c) => (open === undefined ? !c : !open));
  });
  useEffect(() => {
    if (!isMobile) setNavOpen(false);
  }, [isMobile]);

  const layout = useMemo(
    () => ({
      registerFullBleed: () => {
        setFullBleed((n) => n + 1);
        return () => setFullBleed((n) => n - 1);
      },
    }),
    [],
  );
  const toggleCollapsed = useCallback(() => setCollapsed((c) => !c), [setCollapsed]);
  const sidebarWidth = isMobile ? '0px' : collapsed ? SIDEBAR_WIDTH.collapsed : SIDEBAR_WIDTH.expanded;

  return (
    <ShellLayoutContext.Provider value={layout}>
      <a
        href="#main"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById('main')?.focus();
        }}
        className="sr-only z-[80] rounded-md bg-popover px-3 py-2 text-sm font-medium text-fg shadow-pop focus:not-sr-only focus:fixed focus:left-3 focus:top-3"
      >
        Skip to content
      </a>
      <div className="flex min-h-full">
        {!isMobile && <Sidebar collapsed={collapsed} onToggleCollapsed={toggleCollapsed} />}
        <main
          id="main"
          tabIndex={-1}
          className={clsx('min-w-0 flex-1 outline-none', fullBleed > 0 ? 'pb-app-bars' : 'pb-app-chrome')}
        >
          {children}
        </main>
      </div>
      {isMobile && <MobileNav navOpen={navOpen} setNavOpen={setNavOpen} />}
      {!online && <OfflineBanner left={sidebarWidth} />}
      <TrayHint desktop={desktop} isMobile={isMobile} />
      <ConfirmHost resetKey={location.pathname + location.search} />
      <TaskActionsHost />
    </ShellLayoutContext.Provider>
  );
}
