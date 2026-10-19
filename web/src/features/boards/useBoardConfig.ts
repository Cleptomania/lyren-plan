// Board configuration state with autosave (SPEC §8 "Saving"): edits apply immediately (live
// effect) and are saved ~400 ms after the last change through the optimistic, serialized
// useUpdateBoard — no draft / Save button. Pending edits are flushed on unmount, and when the
// page is hidden or unloaded (reload, full navigation, tab closed) they are also sent with a
// keepalive request, because the mutation pipeline awaits before its fetch and an unloading
// page never gets that far.
// Without a saved board (a project's Board tab before its first board exists) the first
// change creates one via `create`. For a role that may not change boards (viewers, design §12.9) the
// changes apply to this view only and are never sent (`saved: false`).

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { BoardConfig } from '@shared/board';
import type { BoardDTO } from '@shared/types';
import { useUpdateBoard } from '../../api/boards';
import { spaceApi } from '../../api/client';
import { useSpace } from '../../app/space';
import { toast } from '../../components/ui';

const AUTOSAVE_DELAY_MS = 400;

export type ConfigUpdate = BoardConfig | ((current: BoardConfig) => BoardConfig);

export interface BoardConfigState {
  config: BoardConfig;
  setConfig: (update: ConfigUpdate) => void;
  /** An edit is waiting for its debounce or creation. */
  dirty: boolean;
  /** Edits are saved to the board (false: they last as long as this view). */
  saved: boolean;
}

export function useBoardConfig(
  board: BoardDTO | null,
  fallback: BoardConfig,
  create?: (config: BoardConfig) => Promise<BoardDTO>,
  onCreated?: (board: BoardDTO) => void,
): BoardConfigState {
  const { id: sid, permissions } = useSpace();
  const saved = permissions.write;
  const { mutate: updateBoard } = useUpdateBoard();
  const [pending, setPending] = useState<BoardConfig | null>(null);
  const config = pending ?? board?.config ?? fallback;

  const latest = useRef({ board, pending, config, create, onCreated, saved });
  useLayoutEffect(() => {
    latest.current = { board, pending, config, create, onCreated, saved };
  });
  const timer = useRef<number | undefined>(undefined);
  const creating = useRef(false);
  /** The pending config last handed to updateBoard / sent with keepalive (never sent twice). */
  const sent = useRef<BoardConfig | null>(null);
  const beaconed = useRef<BoardConfig | null>(null);

  const flush = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    const { board: b, pending: p, create: make, onCreated: done, saved: save } = latest.current;
    if (!p || !save) return;
    if (b) {
      if (p === sent.current) return; // already on its way
      sent.current = p;
      updateBoard(
        { id: b.id, config: p },
        {
          onError: (err) => {
            toast.error(err);
            setPending((cur) => (cur === p ? null : cur));
          },
        },
      );
      return;
    }
    if (!make || creating.current) return;
    creating.current = true;
    make(p).then(
      (created) => {
        creating.current = false;
        // Edits made while the board was being created go to the new board.
        const newer = latest.current.pending;
        if (newer && newer !== p) updateBoard({ id: created.id, config: newer }, { onError: (err) => toast.error(err) });
        done?.(created);
      },
      (err: unknown) => {
        creating.current = false;
        toast.error(err);
        setPending((cur) => (cur === p ? null : cur));
      },
    );
  }, [updateBoard]);

  const setConfig = useCallback(
    (update: ConfigUpdate) => {
      const current = latest.current.config;
      const next = typeof update === 'function' ? update(current) : update;
      if (next === current) return;
      latest.current.pending = next;
      latest.current.config = next;
      setPending(next);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(flush, AUTOSAVE_DELAY_MS);
    },
    [flush],
  );

  // The optimistic update puts this exact object into the cache: the edit is "saved" there.
  useEffect(() => {
    if (pending && board?.config === pending) setPending(null);
  }, [pending, board?.config]);

  // Save whatever is pending when the board view goes away (navigation, tab switch).
  useEffect(() => flush, [flush]);

  // Also save before the page is hidden or unloaded (tab closed, app switched on phones, reload,
  // full navigation). The keepalive request goes out synchronously and survives the unload;
  // flush() still runs the normal pipeline (cache + ordering after earlier saves) for a page
  // that stays alive, so the last request to arrive carries this config either way.
  useEffect(() => {
    const saveNow = () => {
      const { board: b, pending: p, saved: save } = latest.current;
      if (save && b && p && p !== beaconed.current) {
        beaconed.current = p;
        void spaceApi(sid).patch(`/boards/${b.id}`, { config: p }, { keepalive: true }).catch(() => undefined);
      }
      flush();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') saveNow();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', saveNow);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', saveNow);
    };
  }, [flush, sid]);

  return { config, setConfig, dirty: pending !== null, saved };
}
