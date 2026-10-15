// Phone (< md) navigation: bottom tab bar, the "More" sheet and the floating "+" button.

import { clsx } from 'clsx';
import {
  Activity,
  ChevronRight,
  FolderKanban,
  House,
  LogOut,
  Menu as MenuIcon,
  Monitor,
  Moon,
  Plus,
  Search,
  Settings,
  SquareKanban,
  Sun,
  Timer,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { useLookups } from '../../api/bootstrap';
import { openCommandPalette, openCreateTask } from '../../lib/events';
import { useOverlayStackSize } from '../../lib/overlays';
import type { ThemePreference } from '../../lib/theme';
import { Avatar } from '../ui/Avatar';
import { IconButton } from '../ui/Button';
import { TRANSITION } from '../ui/internal/floating';
import { useOverlayControls, type OverlayControls } from '../ui/internal/overlayControls';
import { SegmentedControl } from '../ui/SegmentedControl';
import { Sheet } from '../ui/Sheet';
import { mobileTabForPath } from './navigation';
import { useCreateTaskDefaults, useSignOut } from './useShellActions';
import { useTextEntryFocused, useThemePreference } from './useShellState';

export interface MobileNavProps {
  navOpen: boolean;
  setNavOpen: (open: boolean) => void;
}

export function MobileNav({ navOpen, setNavOpen }: MobileNavProps) {
  const { pathname, search, key } = useLocation();
  const navigate = useNavigate();
  const typing = useTextEntryFocused(true);
  const overlays = useOverlayStackSize();
  const current = mobileTabForPath(pathname);
  const sheet = useRef<OverlayControls>(null);

  // Any navigation closes the sheet.
  useEffect(() => setNavOpen(false), [key, setNavOpen]);
  // The bar stays above the sheet until its exit transition is over (set during render, so
  // not a single frame shows the closing sheet over the bar).
  const [wasOpen, setWasOpen] = useState(navOpen);
  const [closedAt, setClosedAt] = useState(0);
  if (wasOpen !== navOpen) {
    setWasOpen(navOpen);
    if (!navOpen) setClosedAt(Date.now());
  }
  useEffect(() => {
    if (closedAt === 0) return;
    const timer = setTimeout(() => setClosedAt(0), TRANSITION.sheet);
    return () => clearTimeout(timer);
  }, [closedAt]);
  const closing = closedAt !== 0;

  // While the More sheet is open the tab bar stays above it and usable by touch (the sheet sits
  // right on top of the bar, so nothing in the sheet is under a tab): More closes it again, the
  // other tabs leave it — their destination replaces the sheet's history entry, and the
  // current page's tab just closes it. The sheet is modal, so for assistive tech and the
  // keyboard the bar is behind it: hidden from the accessibility tree (the sheet's focus
  // manager) and out of the Tab order (`behindSheet`); the sheet has its own Close button.
  const fromSheet = (to: string) => (e: MouseEvent<HTMLAnchorElement>) => {
    const controls = sheet.current;
    if (!navOpen || !controls) return;
    e.preventDefault();
    if (to === pathname + search) controls.close();
    else navigate(to, { replace: controls.closeForNavigation() });
  };
  const openSearch = () => {
    const controls = sheet.current;
    if (navOpen && controls) controls.closeThen(() => openCommandPalette());
    else openCommandPalette();
  };

  return (
    <>
      <nav
        aria-label="Main"
        data-bottom-chrome=""
        className={clsx(
          'fixed inset-x-0 bottom-0 border-t border-border bg-surface/95 pb-safe backdrop-blur-md transition-transform duration-150 motion-reduce:transition-none',
          // Above the More sheet and its scrim (z-50) while it is shown.
          navOpen || closing ? 'z-[60]' : 'z-30',
          typing && 'translate-y-full',
        )}
      >
        <ul className="flex h-14 items-stretch">
          <Tab to="/dashboard" label="Home" icon={<House />} active={current === 'home'} muted={navOpen} behindSheet={navOpen} onLinkClick={fromSheet('/dashboard')} />
          <Tab to="/projects" label="Projects" icon={<FolderKanban />} active={current === 'projects'} muted={navOpen} behindSheet={navOpen} onLinkClick={fromSheet('/projects')} />
          <Tab to="/boards" label="Boards" icon={<SquareKanban />} active={current === 'boards'} muted={navOpen} behindSheet={navOpen} onLinkClick={fromSheet('/boards')} />
          <Tab label="Search" icon={<Search />} behindSheet={navOpen} onClick={openSearch} />
          <Tab
            label="More"
            icon={<MenuIcon />}
            active={current === 'more' || navOpen}
            behindSheet={navOpen}
            onClick={() => setNavOpen(!navOpen)}
            expanded={navOpen}
          />
        </ul>
      </nav>
      {!typing && overlays === 0 && <Fab />}
      <NavSheet open={navOpen} onClose={() => setNavOpen(false)} controlsRef={sheet} />
    </>
  );
}

interface TabProps {
  label: string;
  icon: ReactNode;
  to?: string;
  onClick?: () => void;
  /** Link tabs: runs before the navigation (may preventDefault it). */
  onLinkClick?: (e: MouseEvent<HTMLAnchorElement>) => void;
  /** The current section (aria-current, highlighted unless `muted`). */
  active?: boolean;
  /** Not highlighted even when active (the More sheet is open: More is the highlighted tab). */
  muted?: boolean;
  /** The modal More sheet is open: touch only (out of the Tab order, like the hidden tree). */
  behindSheet?: boolean;
  expanded?: boolean;
}

function Tab({ label, icon, to, onClick, onLinkClick, active, muted, behindSheet, expanded }: TabProps) {
  const tabIndex = behindSheet ? -1 : undefined;
  const cls = clsx(
    'flex h-full w-full flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition-colors [&_svg]:size-[22px]',
    active && !muted ? 'text-accent' : 'text-fg-muted active:text-fg',
  );
  return (
    <li className="flex min-w-0 flex-1">
      {to ? (
        <Link to={to} aria-current={active ? 'page' : undefined} tabIndex={tabIndex} onClick={onLinkClick} className={cls}>
          {icon}
          <span className="truncate">{label}</span>
        </Link>
      ) : (
        <button
          type="button"
          onClick={onClick}
          tabIndex={tabIndex}
          aria-expanded={expanded}
          aria-haspopup={expanded !== undefined ? 'dialog' : undefined}
          className={cls}
        >
          {icon}
          <span className="truncate">{label}</span>
        </button>
      )}
    </li>
  );
}

/** Floating "New task" button above the tab bar (prefilled from the current page). */
function Fab() {
  const getDefaults = useCreateTaskDefaults();
  return (
    <button
      type="button"
      aria-label="New task"
      onClick={() => openCreateTask(getDefaults())}
      className="fab-position fixed right-4 z-30 flex size-14 items-center justify-center rounded-full bg-accent text-accent-fg shadow-pop transition-transform active:scale-95 motion-reduce:transition-none"
    >
      <Plus aria-hidden className="size-6" />
    </button>
  );
}

const THEME_OPTIONS = [
  { value: 'light', label: 'Light', icon: <Sun /> },
  { value: 'dark', label: 'Dark', icon: <Moon /> },
  { value: 'system', label: 'System', icon: <Monitor /> },
] as const satisfies ReadonlyArray<{ value: ThemePreference; label: string; icon: ReactNode }>;

/** The "More" sheet: secondary destinations, theme and sign out. */
function NavSheet({ open, onClose, controlsRef }: { open: boolean; onClose: () => void; controlsRef: RefObject<OverlayControls | null> }) {
  const { user, version } = useLookups();
  const [theme, setTheme, syncTheme] = useThemePreference();
  const signOut = useSignOut();
  useEffect(() => {
    if (open) syncTheme();
  }, [open, syncTheme]);

  return (
    // history: the phone Back gesture closes the sheet (SPEC §9); its links replace that entry.
    // It rests on top of the tab bar (which stays above the scrim, see MobileNav), so the
    // tab bar zone never holds a sheet row such as Sign out.
    <Sheet open={open} onClose={onClose} aria-label="More" history controlsRef={controlsRef} bottomInset="var(--bottom-bar-h)">
      <div className="flex items-center gap-3 px-4 pb-3 pt-2">
        <Avatar name={user.displayName} size="lg" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-semibold text-fg">{user.displayName}</p>
          <p className="truncate text-[13px] text-fg-muted">@{user.username}</p>
        </div>
        {/* For screen readers and the keyboard (Esc works too): the tab bar is behind the sheet for them. */}
        <IconButton aria-label="Close" tooltip={false} icon={<X />} onClick={onClose} className="-mr-2 shrink-0 self-start" />
      </div>
      <div className="border-y border-border py-1">
        <SheetLink to="/activity" icon={<Activity />} label="Activity" onNavigate={onClose} />
        <SheetLink to="/worklog" icon={<Timer />} label="Work log" onNavigate={onClose} />
        <SheetLink to="/settings" icon={<Settings />} label="Settings" onNavigate={onClose} />
      </div>
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <span className="text-[15px] text-fg">Theme</span>
        <SegmentedControl<ThemePreference> aria-label="Theme" value={theme} onChange={setTheme} options={THEME_OPTIONS} size="sm" />
      </div>
      <div className="border-t border-border py-1">
        <button
          type="button"
          onClick={() => {
            onClose();
            signOut();
          }}
          className="flex min-h-12 w-full items-center gap-3 px-4 text-left text-[15px] text-danger active:bg-surface-2 [&_svg]:size-5"
        >
          <LogOut aria-hidden />
          Sign out
        </button>
      </div>
      <p className="px-4 pt-1 text-xs text-fg-subtle">Lyren Plan {version}</p>
    </Sheet>
  );
}

function SheetLink({ to, icon, label, onNavigate }: { to: string; icon: ReactNode; label: string; onNavigate: () => void }) {
  const controls = useOverlayControls();
  const { pathname, search } = useLocation();
  // The page that is already showing: just close the sheet (popping its own entry). A
  // navigation would put a second copy of the page in history.
  const here = to === pathname + search;
  return (
    <Link
      to={to}
      // Replace the sheet's own history entry, so Back from the destination returns to the page.
      replace={controls !== null}
      onClick={(e) => {
        if (here) {
          e.preventDefault();
          if (controls) controls.close();
          else onNavigate();
        } else if (controls) controls.closeForNavigation();
        else onNavigate();
      }}
      aria-current={here ? 'page' : undefined}
      className="flex min-h-12 items-center gap-3 px-4 text-[15px] text-fg active:bg-surface-2 [&_svg]:size-5 [&_svg]:shrink-0"
    >
      <span aria-hidden className="text-fg-muted">
        {icon}
      </span>
      <span className="flex-1">{label}</span>
      <ChevronRight aria-hidden className="text-fg-subtle" />
    </Link>
  );
}
