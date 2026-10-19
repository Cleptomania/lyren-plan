// Board-level actions shared by the Boards list, the board page and project board tabs:
// open, duplicate, delete (confirmed), default board / home page, reorder within a scope. Each is
// offered by the viewer's role (design §12.9): duplicating, deleting and reordering need write access,
// the default board is a space setting (admins); the home page is the account's own preference.

import { Copy, Home, Star, Trash2 } from 'lucide-react';
import { useNavigate } from 'react-router';
import type { BoardDTO } from '@shared/types';
import { useDeleteBoard, useDuplicateBoard, useReorderBoards } from '../../api/boards';
import { useLookups } from '../../api/bootstrap';
import { useUpdateSettings } from '../../api/spaceAdmin';
import { spaceLink, useSpace } from '../../app/space';
import { boardUrl } from '../../lib/taskLinks';
import { normalizeMenuItems, toast, useConfirm, type MenuItem } from '../../components/ui';

/** Where a board of the space lives: /boards/:id, or its project's Board tab. */
export function boardHref(spaceId: string, board: Pick<BoardDTO, 'id' | 'projectId'>): string {
  return board.projectId === null ? boardUrl(spaceId, board.id) : spaceLink(spaceId, `/projects/${board.projectId}/board?board=${board.id}`);
}

export interface RemoveHooks {
  onConfirmed?: () => void;
  onDeleted?: () => void;
  onFailed?: () => void;
}

export function useBoardActions() {
  const { id: sid, permissions } = useSpace();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const { settings } = useLookups();
  const duplicate = useDuplicateBoard();
  const remove = useDeleteBoard();
  const reorder = useReorderBoards();
  const updateSettings = useUpdateSettings();

  const isDefault = (b: BoardDTO) => settings.defaultBoardId === b.id;
  const isHome = (b: BoardDTO) => isDefault(b) && settings.homePage === 'default_board';

  return {
    permissions,
    isDefault,
    isHome,
    busy: duplicate.isPending || remove.isPending || reorder.isPending || updateSettings.isPending,

    duplicate: (b: BoardDTO, opts: { open?: boolean } = {}) =>
      duplicate.mutate(b.id, {
        onSuccess: (copy) => {
          toast.success(`Created “${copy.name}”`, opts.open === false ? { action: { label: 'Open', onClick: () => navigate(boardHref(sid, copy)) } } : undefined);
          if (opts.open !== false) navigate(boardHref(sid, copy));
        },
        onError: (err) => toast.error(err),
      }),

    /** Asks first. `onConfirmed` runs before the request (e.g. to suppress a "not found" flash). */
    remove: async (b: BoardDTO, hooks: RemoveHooks = {}) => {
      const ok = await confirm({
        title: `Delete “${b.name}”?`,
        body: 'Only the board is deleted — its tasks stay where they are.',
        confirmLabel: 'Delete board',
        danger: true,
      });
      if (!ok) return;
      hooks.onConfirmed?.();
      remove.mutate(b.id, {
        onSuccess: () => {
          toast.success(`Deleted “${b.name}”`);
          hooks.onDeleted?.();
        },
        onError: (err) => {
          toast.error(err);
          hooks.onFailed?.();
        },
      });
    },

    setDefault: (b: BoardDTO, on: boolean) =>
      updateSettings.mutate(
        on ? { defaultBoardId: b.id } : { defaultBoardId: null, ...(settings.homePage === 'default_board' ? { homePage: 'dashboard' as const } : {}) },
        {
          onSuccess: () => toast.success(on ? `“${b.name}” is the default board` : 'No default board'),
          onError: (err) => toast.error(err),
        },
      ),

    // Only the home page (the account's) when the board is the default already: members may set that.
    setHome: (b: BoardDTO, on: boolean) =>
      updateSettings.mutate(on ? { ...(!isDefault(b) && { defaultBoardId: b.id }), homePage: 'default_board' } : { homePage: 'dashboard' }, {
        onSuccess: () => toast.success(on ? `“${b.name}” opens when you start Lyren` : 'Lyren opens on the dashboard'),
        onError: (err) => toast.error(err),
      }),

    /** `ids`: every board of one scope, in the new order. */
    reorder: (ids: number[]) => reorder.mutate(ids, { onError: (err) => toast.error(err) }),
  };
}

export type BoardActions = ReturnType<typeof useBoardActions>;

/** Common menu entries for a board (callers prepend their own "Open" / "Configure"), by the viewer's role. */
export function boardMenuItems(b: BoardDTO, actions: BoardActions, opts: { remove?: RemoveHooks; extra?: MenuItem[] } = {}): MenuItem[] {
  const { write, manageStructure } = actions.permissions;
  return normalizeMenuItems([
    ...(opts.extra ?? []),
    write && { label: 'Duplicate', icon: <Copy />, onSelect: () => actions.duplicate(b) },
    { separator: true },
    manageStructure && { label: 'Default board', icon: <Star />, checked: actions.isDefault(b), onSelect: () => actions.setDefault(b, !actions.isDefault(b)) },
    (manageStructure || actions.isDefault(b)) && {
      label: 'Open at startup',
      icon: <Home />,
      checked: actions.isHome(b),
      onSelect: () => actions.setHome(b, !actions.isHome(b)),
    },
    { separator: true },
    write && { label: 'Delete board…', icon: <Trash2 />, danger: true, onSelect: () => void actions.remove(b, opts.remove) },
  ]);
}
