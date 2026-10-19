// Desktop (≥ md) navigation sidebar: the space switcher, search + new task, main links, project and
// board lists, settings and the user menu. Collapses to an icon rail (state per device). Viewers get no
// "New task" (design §12.9 viewer mode).

import { clsx } from 'clsx';
import {
  Activity,
  ChevronRight,
  ChevronsUpDown,
  FolderKanban,
  LayoutDashboard,
  LogOut,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Settings,
  Shield,
  SquareKanban,
  Sun,
  Timer,
  UserRoundCog,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, NavLink, useNavigate } from 'react-router';
import { useAccount } from '../../api/auth';
import { useLookups } from '../../api/bootstrap';
import { useSpace, useSpacePath } from '../../app/space';
import { openCommandPalette, openCreateTask } from '../../lib/events';
import { Avatar } from '../ui/Avatar';
import { IconButton } from '../ui/Button';
import { ColorDot } from '../ui/ColorDot';
import { Shortcut } from '../ui/Kbd';
import { formatShortcut } from '../ui/shortcuts';
import { Menu, type MenuItem } from '../ui/Menu';
import { Tooltip } from '../ui/Tooltip';
import { AppMark } from './AppMark';
import { SpaceSwitcherButton, SpaceSwitcherMenu, SpaceTile } from './SpaceSwitcher';
import { isBoolean, usePersistentState } from './usePersistentState';
import { useCreateTaskDefaults, useSignOut } from './useShellActions';
import { useThemePreference } from './useShellState';

export const SIDEBAR_WIDTH = { expanded: '15rem', collapsed: '3.5rem' } as const;

export interface SidebarProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

export function Sidebar({ collapsed, onToggleCollapsed }: SidebarProps) {
  return (
    <aside
      aria-label="Sidebar"
      style={{ width: collapsed ? SIDEBAR_WIDTH.collapsed : SIDEBAR_WIDTH.expanded }}
      className="sticky top-0 z-30 flex h-dvh shrink-0 flex-col border-r border-border bg-bg"
    >
      {collapsed ? <CollapsedSidebar onExpand={onToggleCollapsed} /> : <ExpandedSidebar onCollapse={onToggleCollapsed} />}
    </aside>
  );
}

function ExpandedSidebar({ onCollapse }: { onCollapse: () => void }) {
  const sp = useSpacePath();
  const { write } = useSpace().permissions;
  const { projects, boards } = useLookups();
  const getCreateDefaults = useCreateTaskDefaults();
  const activeProjects = projects.filter((p) => p.status !== 'archived');
  const globalBoards = boards.filter((b) => b.projectId === null);
  const [projectsOpen, setProjectsOpen] = usePersistentState('lyren.sidebar.projectsOpen', true, isBoolean);
  const [boardsOpen, setBoardsOpen] = usePersistentState('lyren.sidebar.boardsOpen', true, isBoolean);

  return (
    <>
      <div className="flex min-h-14 shrink-0 items-center gap-1 py-1 pl-2.5 pr-2">
        <SpaceSwitcherButton />
        <IconButton size="sm" aria-label="Collapse sidebar" icon={<PanelLeftClose />} onClick={onCollapse} className="shrink-0" />
      </div>

      <div className="flex shrink-0 items-center gap-1.5 px-3">
        <button
          type="button"
          onClick={() => openCommandPalette()}
          className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-border bg-surface px-2 text-[13px] text-fg-subtle shadow-card transition-colors hover:border-border-strong hover:text-fg-muted"
        >
          <Search aria-hidden className="size-4 shrink-0" />
          <span className="flex-1 truncate text-left">Search…</span>
          <Shortcut combo="mod+k" />
        </button>
        {write && (
          <IconButton
            size="sm"
            variant="primary"
            aria-label="New task"
            tooltip="New task (C)"
            icon={<Plus />}
            onClick={() => openCreateTask(getCreateDefaults())}
          />
        )}
      </div>

      <nav aria-label="Main" className="mt-3 flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pb-3 scrollbar-thin">
        <div className="flex flex-col gap-px">
          <NavItem to={sp('/dashboard')} icon={<LayoutDashboard />} label="Dashboard" />
          <NavItem to={sp('/activity')} icon={<Activity />} label="Activity" />
          <NavItem to={sp('/worklog')} icon={<Timer />} label="Work log" />
        </div>

        <NavSection label="Projects" to={sp('/projects')} open={projectsOpen} onToggle={() => setProjectsOpen((o) => !o)}>
          {activeProjects.map((p) => (
            <NavItem
              key={p.id}
              to={sp(`/projects/${p.id}`)}
              icon={<ColorDot color={p.color} size="sm" square />}
              label={p.name}
              hint={p.key}
            />
          ))}
          {activeProjects.length === 0 && <EmptyLink to={sp('/projects')}>{write ? 'No projects yet — create one' : 'No projects yet'}</EmptyLink>}
        </NavSection>

        <NavSection label="Boards" to={sp('/boards')} open={boardsOpen} onToggle={() => setBoardsOpen((o) => !o)}>
          {globalBoards.map((b) => (
            <NavItem key={b.id} to={sp(`/boards/${b.id}`)} icon={<SquareKanban />} label={b.name} />
          ))}
          {globalBoards.length === 0 && <EmptyLink to={sp('/boards')}>{write ? 'No boards yet — create one' : 'No boards yet'}</EmptyLink>}
        </NavSection>
      </nav>

      <div className="flex shrink-0 flex-col gap-px border-t border-border p-3">
        <NavItem to={sp('/settings')} icon={<Settings />} label="Settings" />
        <UserMenu collapsed={false} />
      </div>
    </>
  );
}

function CollapsedSidebar({ onExpand }: { onExpand: () => void }) {
  const sp = useSpacePath();
  const space = useSpace();
  const getCreateDefaults = useCreateTaskDefaults();
  return (
    <>
      <div className="flex h-14 shrink-0 items-center justify-center">
        <Tooltip content="Expand sidebar" placement="right">
          <button type="button" aria-label="Expand sidebar" onClick={onExpand} className="group relative rounded-md">
            <AppMark size={24} className="transition-opacity group-hover:opacity-0" />
            <PanelLeftOpen aria-hidden className="absolute inset-0 m-auto size-5 text-fg-muted opacity-0 transition-opacity group-hover:opacity-100" />
          </button>
        </Tooltip>
      </div>
      <nav aria-label="Main" className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto py-1 no-scrollbar">
        <SpaceSwitcherMenu
          placement="right-start"
          trigger={
            <button
              type="button"
              aria-label={`Space: ${space.name}. Switch space`}
              title={space.name}
              className="flex size-9 items-center justify-center rounded-md hover:bg-surface-2 aria-expanded:bg-surface-2"
            >
              <SpaceTile name={space.name} />
            </button>
          }
        />
        <IconButton aria-label="Search" tooltip={`Search (${formatShortcut('mod+k')})`} icon={<Search />} onClick={() => openCommandPalette()} />
        {space.permissions.write && (
          <IconButton aria-label="New task" tooltip="New task (C)" variant="primary" size="sm" icon={<Plus />} onClick={() => openCreateTask(getCreateDefaults())} className="my-1" />
        )}
        <RailItem to={sp('/dashboard')} icon={<LayoutDashboard />} label="Dashboard" />
        <RailItem to={sp('/projects')} icon={<FolderKanban />} label="Projects" />
        <RailItem to={sp('/boards')} icon={<SquareKanban />} label="Boards" />
        <RailItem to={sp('/activity')} icon={<Activity />} label="Activity" />
        <RailItem to={sp('/worklog')} icon={<Timer />} label="Work log" />
      </nav>
      <div className="flex shrink-0 flex-col items-center gap-1 border-t border-border py-2">
        <RailItem to={sp('/settings')} icon={<Settings />} label="Settings" />
        <UserMenu collapsed />
      </div>
    </>
  );
}

const ITEM =
  'group flex h-8 min-w-0 items-center gap-2.5 rounded-md px-2 text-[13px] font-medium transition-colors duration-100 [&_svg]:size-4 [&_svg]:shrink-0';
const ITEM_IDLE = 'text-fg-muted hover:bg-surface-2 hover:text-fg';
const ITEM_ACTIVE = 'bg-surface-3/70 text-fg';

function NavItem({ to, icon, label, hint, end }: { to: string; icon: ReactNode; label: string; hint?: string; end?: boolean }) {
  return (
    <NavLink to={to} end={end} className={({ isActive }) => clsx(ITEM, isActive ? ITEM_ACTIVE : ITEM_IDLE)}>
      <span aria-hidden className="flex size-4 shrink-0 items-center justify-center">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint && <span className="shrink-0 font-mono text-[10.5px] font-normal text-fg-subtle">{hint}</span>}
    </NavLink>
  );
}

function RailItem({ to, icon, label }: { to: string; icon: ReactNode; label: string }) {
  return (
    <Tooltip content={label} placement="right">
      <NavLink
        to={to}
        aria-label={label}
        className={({ isActive }) =>
          clsx('flex size-9 items-center justify-center rounded-md transition-colors [&_svg]:size-[18px]', isActive ? ITEM_ACTIVE : ITEM_IDLE)
        }
      >
        {icon}
      </NavLink>
    </Tooltip>
  );
}

function NavSection({ label, to, open, onToggle, children }: { label: string; to: string; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <div className="mt-5 flex flex-col gap-px">
      <div className="group/section flex h-7 items-center gap-1 pl-2 pr-1">
        <NavLink
          to={to}
          end
          className={({ isActive }) =>
            clsx('min-w-0 flex-1 truncate rounded text-[11px] font-semibold uppercase tracking-wider hover:text-fg', isActive ? 'text-fg' : 'text-fg-subtle')
          }
        >
          {label}
        </NavLink>
        <button
          type="button"
          aria-label={`${open ? 'Hide' : 'Show'} ${label.toLowerCase()}`}
          aria-expanded={open}
          onClick={onToggle}
          className="flex size-6 items-center justify-center rounded text-fg-subtle hover:bg-surface-2 hover:text-fg"
        >
          <ChevronRight aria-hidden className={clsx('size-3.5 transition-transform duration-150 motion-reduce:transition-none', open && 'rotate-90')} />
        </button>
      </div>
      {open && children}
    </div>
  );
}

function EmptyLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="rounded-md px-2 py-1.5 text-xs text-fg-subtle hover:bg-surface-2 hover:text-fg-muted">
      {children}
    </Link>
  );
}

function UserMenu({ collapsed }: { collapsed: boolean }) {
  const { user } = useLookups();
  const account = useAccount();
  const navigate = useNavigate();
  const [theme, setTheme, syncTheme] = useThemePreference();
  const signOut = useSignOut();
  const items: MenuItem[] = [
    { heading: 'Theme' },
    { label: 'Light', icon: <Sun />, checked: theme === 'light', onSelect: () => setTheme('light') },
    { label: 'Dark', icon: <Moon />, checked: theme === 'dark', onSelect: () => setTheme('dark') },
    { label: 'System', icon: <Monitor />, checked: theme === 'system', onSelect: () => setTheme('system') },
    { separator: true },
    { label: 'Account settings', icon: <UserRoundCog />, onSelect: () => navigate('/settings') },
    ...(account.isInstanceAdmin ? [{ label: 'Administration', icon: <Shield />, onSelect: () => navigate('/admin') }] : []),
    { label: 'Sign out', icon: <LogOut />, onSelect: signOut },
  ];
  const trigger = collapsed ? (
    <button
      type="button"
      aria-label={`Account: ${user.displayName}`}
      className="flex size-9 items-center justify-center rounded-md hover:bg-surface-2"
    >
      <Avatar name={user.displayName} size="sm" />
    </button>
  ) : (
    <button type="button" className={clsx(ITEM, ITEM_IDLE, 'h-9 w-full text-left')}>
      <Avatar name={user.displayName} size="sm" className="-ml-0.5" />
      <span className="min-w-0 flex-1 truncate text-fg">{user.displayName}</span>
      <ChevronsUpDown aria-hidden className="text-fg-subtle" />
    </button>
  );
  return (
    <Menu
      trigger={trigger}
      items={items}
      label="Account"
      placement={collapsed ? 'right-end' : 'top-start'}
      onOpenChange={(open) => open && syncTheme()}
      className="min-w-52"
    />
  );
}
