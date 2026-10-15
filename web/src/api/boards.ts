// Boards. The list lives in bootstrap (useLookups().boards); these are mutations.
// Global boards have projectId null; project boards appear on their project's Board tab.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { BoardConfig, BoardCreateInput } from '@shared/board';
import type { BoardDTO, BootstrapDTO } from '@shared/types';
import { http } from './client';
import { invalidateStructure, qk } from './keys';

export function useCreateBoard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: BoardCreateInput) => http.post<BoardDTO>('/boards', input),
    onSuccess: (board) => {
      qc.setQueryData<BootstrapDTO>(qk.bootstrap, (old) => (old ? { ...old, boards: [...old.boards, board] } : old));
      return invalidateStructure(qc);
    },
  });
}

export interface BoardUpdate {
  id: number;
  name?: string;
  description?: string;
  /** The COMPLETE new config (spread the current board.config and change what you need). */
  config?: BoardConfig;
}

const UPDATE_KEY = ['boards', 'update'] as const;

function patchBoardInCache(old: BootstrapDTO | undefined, id: number, update: (b: BoardDTO) => BoardDTO) {
  return old ? { ...old, boards: old.boards.map((b) => (b.id === id ? update(b) : b)) } : old;
}

/**
 * Optimistic: the bootstrap cache changes immediately, requests are serialized (so quick
 * successive edits can't overwrite each other) and failures roll back. Config edits do not
 * refetch bootstrap. Debounce rapid text/number edits (~400ms) before calling.
 */
export function useUpdateBoard() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: UPDATE_KEY,
    scope: { id: 'board-update' },
    mutationFn: ({ id, ...input }: BoardUpdate) => http.patch<BoardDTO>(`/boards/${id}`, input),
    onMutate: async ({ id, ...input }) => {
      await qc.cancelQueries({ queryKey: qk.bootstrap });
      const prev = qc.getQueryData<BootstrapDTO>(qk.bootstrap);
      qc.setQueryData<BootstrapDTO>(qk.bootstrap, (old) =>
        patchBoardInCache(old, id, (b) => ({
          ...b,
          ...(input.name !== undefined && { name: input.name }),
          ...(input.description !== undefined && { description: input.description }),
          ...(input.config !== undefined && { config: input.config }),
        })),
      );
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.bootstrap, ctx.prev);
    },
    onSuccess: (board) => {
      // Only apply the server copy once no newer edit is queued behind this one.
      if (qc.isMutating({ mutationKey: UPDATE_KEY }) === 1) {
        qc.setQueryData<BootstrapDTO>(qk.bootstrap, (old) => patchBoardInCache(old, board.id, () => board));
      }
    },
  });
}

export function useDeleteBoard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => http.del<{ ok: true }>(`/boards/${id}`),
    onSuccess: (_r, id) => {
      qc.setQueryData<BootstrapDTO>(qk.bootstrap, (old) =>
        old ? { ...old, boards: old.boards.filter((b) => b.id !== id) } : old,
      );
      return invalidateStructure(qc);
    },
  });
}

export function useDuplicateBoard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => http.post<BoardDTO>(`/boards/${id}/duplicate`),
    onSuccess: () => invalidateStructure(qc),
  });
}

/** ids: every board of the same scope (all global boards, or all boards of one project), in order. */
export function useReorderBoards() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: number[]) => http.post<{ ok: true }>('/boards/reorder', { ids }),
    onSuccess: () => invalidateStructure(qc),
  });
}
