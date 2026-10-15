// Tags, statuses, settings and data import/export.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  Settings,
  SettingsUpdateInput,
  StatusCreateInput,
  StatusUpdateInput,
  TagCreateInput,
  TagUpdateInput,
} from '@shared/schemas';
import type { ExportDTO, StatusDTO, TagDTO } from '@shared/types';
import { http, qs } from './client';
import { invalidateStructure } from './keys';

// ---- Tags ------------------------------------------------------------------

export function useCreateTag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: TagCreateInput) => http.post<TagDTO>('/tags', input),
    onSuccess: () => invalidateStructure(qc),
  });
}

export function useUpdateTag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: TagUpdateInput & { id: number }) => http.patch<TagDTO>(`/tags/${id}`, input),
    onSuccess: () => invalidateStructure(qc, { tasks: true }),
  });
}

export function useDeleteTag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => http.del<{ ok: true }>(`/tags/${id}`),
    onSuccess: () => invalidateStructure(qc, { tasks: true }),
  });
}

/** Re-tag every task tagged `id` with `targetId`, then delete `id`. */
export function useMergeTag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, targetId }: { id: number; targetId: number }) =>
      http.post<TagDTO>(`/tags/${id}/merge`, { targetId }),
    onSuccess: () => invalidateStructure(qc, { tasks: true }),
  });
}

// ---- Statuses --------------------------------------------------------------

export function useCreateStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: StatusCreateInput) => http.post<StatusDTO>('/statuses', input),
    onSuccess: () => invalidateStructure(qc),
  });
}

export function useUpdateStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: StatusUpdateInput & { id: number }) => http.patch<StatusDTO>(`/statuses/${id}`, input),
    onSuccess: () => invalidateStructure(qc, { tasks: true }),
  });
}

/** reassignTo is required when tasks still use the status. */
export function useDeleteStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reassignTo }: { id: number; reassignTo?: number }) =>
      http.del<{ ok: true }>(`/statuses/${id}${qs({ reassignTo })}`),
    onSuccess: () => invalidateStructure(qc, { tasks: true }),
  });
}

export function useReorderStatuses() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: number[]) => http.post<{ ok: true }>('/statuses/reorder', { ids }),
    onSuccess: () => invalidateStructure(qc, { tasks: true }),
  });
}

// ---- Settings ----------------------------------------------------------------

export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SettingsUpdateInput) => http.patch<Settings>('/settings', input),
    onSuccess: () => invalidateStructure(qc, { tasks: true }),
  });
}

// ---- Data ----------------------------------------------------------------------

/** Download URLs (plain GET links; the browser sends the session cookie). */
export const EXPORT_JSON_URL = '/api/data/export';
export const BACKUP_SQLITE_URL = '/api/data/backup';

/** Replace ALL data (except user accounts) with an export file's contents. */
export function useImportData() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: ExportDTO) =>
      // backupFile: the pre-import safety snapshot, relative to the server's DATA_DIR.
      http.post<{ ok: true; counts: Record<string, number>; backupFile: string }>('/data/import', payload),
    onSuccess: () => qc.invalidateQueries(),
  });
}
