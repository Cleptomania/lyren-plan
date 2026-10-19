// The space switcher (design §12.9). Desktop: the sidebar's brand row (the current space's name and the
// account's role there) opens a Menu of the account's spaces (the current one checked), "All spaces…"
// and "Create space…". Phones: the More sheet's "Space: <name>" row opens SpaceSheet with the same
// list. Switching opens the space's home (navigation.ts switchSpacePath) and remembers it as the last
// space used on this device (lyren.lastSpace).

import { clsx } from 'clsx';
import { Check, ChevronRight, ChevronsUpDown, LayoutGrid, Plus } from 'lucide-react';
import { useMemo, type ReactElement, type RefObject } from 'react';
import { useNavigate } from 'react-router';
import { useAuthStatus } from '../../api/auth';
import { ROLE_LABELS } from '../../app/permissions';
import { rememberLastSpace, useSpace } from '../../app/space';
import { Badge } from '../ui/Badge';
import { useOverlayControls, type OverlayControls } from '../ui/internal/overlayControls';
import { Menu, type MenuItem } from '../ui/Menu';
import { Sheet } from '../ui/Sheet';
import { initials } from '../ui/text';
import { spaceChoices, switchSpacePath, type SpaceChoice } from './navigation';

/** /spaces with its create dialog open. */
export const CREATE_SPACE_PATH = '/spaces?create=1';

/** The account's spaces for the switcher, the page's space marked. */
export function useSpaceChoices(): SpaceChoice[] {
  const spaces = useAuthStatus().data?.spaces;
  const { id } = useSpace();
  return useMemo(() => spaceChoices(spaces ?? [], id), [spaces, id]);
}

/** Open `spaceId`'s home (its home page) and remember it on this device. */
export function useSwitchSpace(): (spaceId: string, o?: { replace?: boolean }) => void {
  const navigate = useNavigate();
  return (spaceId, o) => {
    rememberLastSpace(spaceId);
    navigate(switchSpacePath(spaceId), { replace: o?.replace });
  };
}

/** A square tile with the space's initials (the collapsed sidebar's switcher, the phone row). */
export function SpaceTile({ name, className }: { name: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={clsx(
        'inline-flex size-6 shrink-0 select-none items-center justify-center rounded-md bg-surface-3 text-[10px] font-semibold text-fg',
        className,
      )}
    >
      {initials(name)}
    </span>
  );
}

/** The switcher Menu around `trigger` (desktop sidebar). */
export function SpaceSwitcherMenu({ trigger, placement }: { trigger: ReactElement; placement: 'bottom-start' | 'right-start' }) {
  const choices = useSpaceChoices();
  const switchSpace = useSwitchSpace();
  const navigate = useNavigate();
  const items: MenuItem[] = [
    { heading: 'Spaces' },
    ...choices.map((s) => ({
      label: s.name,
      hint: ROLE_LABELS[s.role],
      checked: s.current,
      onSelect: () => {
        if (!s.current) switchSpace(s.id);
      },
    })),
    { separator: true },
    { label: 'All spaces…', icon: <LayoutGrid />, onSelect: () => navigate('/spaces') },
    { label: 'Create space…', icon: <Plus />, onSelect: () => navigate(CREATE_SPACE_PATH) },
  ];
  return <Menu trigger={trigger} items={items} label="Switch space" placement={placement} className="min-w-60 max-w-80" />;
}

/**
 * The expanded sidebar's brand row: the space's name and the role, opening the switcher. The name may take
 * two lines before it is cut (about 13 characters fit on one), and the whole of it is the button's title.
 */
export function SpaceSwitcherButton() {
  const space = useSpace();
  return (
    <SpaceSwitcherMenu
      placement="bottom-start"
      trigger={
        <button
          type="button"
          aria-label={`Space: ${space.name} (${ROLE_LABELS[space.role]}). Switch space`}
          title={space.name}
          className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-surface-2 aria-expanded:bg-surface-2"
        >
          <SpaceTile name={space.name} className="size-7 text-[11px]" />
          <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
            <span className="line-clamp-2 w-full break-words text-[14px] font-semibold leading-[18px] tracking-tight text-fg">{space.name}</span>
            <Badge variant={space.role === 'viewer' ? 'warning' : 'neutral'} className="h-4 px-1 text-[10.5px]">
              {ROLE_LABELS[space.role]}
            </Badge>
          </span>
          <ChevronsUpDown aria-hidden className="size-4 shrink-0 text-fg-subtle" />
        </button>
      }
    />
  );
}

/** Phones: the list as a sheet (opened from the More sheet's "Space" row). */
export function SpaceSheet({ open, onClose, controlsRef }: { open: boolean; onClose: () => void; controlsRef?: RefObject<OverlayControls | null> }) {
  return (
    <Sheet open={open} onClose={onClose} title="Switch space" controlsRef={controlsRef}>
      <SpaceSheetList />
    </Sheet>
  );
}

function SpaceSheetList() {
  const choices = useSpaceChoices();
  const controls = useOverlayControls();
  const navigate = useNavigate();
  const switchSpace = useSwitchSpace();
  const go = (run: (replace: boolean) => void) => run(controls ? controls.closeForNavigation() : false);
  const row = 'flex min-h-12 w-full items-center gap-3 px-4 text-left text-[15px] text-fg active:bg-surface-2 [&_svg]:size-5 [&_svg]:shrink-0';
  return (
    <div className="flex flex-col">
      <ul aria-label="Spaces" className="border-b border-border pb-1">
        {choices.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              aria-current={s.current ? 'true' : undefined}
              onClick={() => (s.current ? controls?.close() : go((replace) => switchSpace(s.id, { replace })))}
              className={row}
            >
              <SpaceTile name={s.name} />
              <span className="min-w-0 flex-1 truncate">{s.name}</span>
              <span className="shrink-0 text-[13px] text-fg-muted">{ROLE_LABELS[s.role]}</span>
              <span aria-hidden className="flex w-5 shrink-0 justify-center text-accent">
                {s.current && <Check />}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <button type="button" onClick={() => go((replace) => navigate('/spaces', { replace }))} className={row}>
        <LayoutGrid aria-hidden className="text-fg-muted" />
        <span className="flex-1">All spaces…</span>
        <ChevronRight aria-hidden className="text-fg-subtle" />
      </button>
      <button type="button" onClick={() => go((replace) => navigate(CREATE_SPACE_PATH, { replace }))} className={row}>
        <Plus aria-hidden className="text-fg-muted" />
        <span className="flex-1">Create space…</span>
        <ChevronRight aria-hidden className="text-fg-subtle" />
      </button>
    </div>
  );
}
