// A space's archive (design §8, §12.10): the export's download link, and the import's two steps, analyze and
// then commit, each sending the file as the multipart field `file` (the commit adds `mapping`), into a new
// space created for it (`forImport`: the space is `importing`, and the importer its only member, until the
// commit) or over a space's content (mode=replace). An import that did not finish is abandoned by deleting its
// space, which goes at once. The gate asks for the re-auth window for the export and a replace; the API
// client's re-auth handler sends a refused request again with the same form.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ImportMode, ImportMappingInput } from '@shared/schemas';
import type { ImportAnalysisDTO, ImportResultDTO, SpaceSummaryDTO } from '@shared/types';
import { http, qs, request, spaceApi } from './client';
import { qk } from './keys';
import { forgetSpace, refreshSpaces } from './spaces';

/** The space's archive (owners, re-auth): a plain GET link; the browser sends the session cookie. */
export function exportUrl(spaceId: string): string {
  return `/api/s/${spaceId}/data/export`;
}

/** The form of an import request: the file as it was chosen, and for a commit the mapping (JSON). */
export function importForm(file: Blob, mapping?: ImportMappingInput): FormData {
  const form = new FormData();
  form.set('file', file);
  if (mapping) form.set('mapping', JSON.stringify(mapping));
  return form;
}

/** POST …/data/import/analyze: what the file holds, its people with their candidates, the estimate. */
export function analyzeImport(spaceId: string, mode: ImportMode, file: Blob): Promise<ImportAnalysisDTO> {
  return spaceApi(spaceId).post<ImportAnalysisDTO>(`/data/import/analyze${qs({ mode })}`, importForm(file));
}

/** POST …/data/import/commit: the same file again, written with the mapping in one transaction. */
export function commitImport(spaceId: string, mode: ImportMode, file: Blob, mapping: ImportMappingInput): Promise<ImportResultDTO> {
  return spaceApi(spaceId).post<ImportResultDTO>(`/data/import/commit${qs({ mode })}`, importForm(file, mapping));
}

/** A new space for an import (`importing` until the commit), counted like any space the account owns. */
export function useCreateImportSpace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => http.post<SpaceSummaryDTO>('/spaces', { name, forImport: true }),
    onSuccess: () => refreshSpaces(qc),
  });
}

export function useAnalyzeImport() {
  return useMutation({
    mutationFn: ({ spaceId, mode, file }: { spaceId: string; mode: ImportMode; file: Blob }) => analyzeImport(spaceId, mode, file),
  });
}

/**
 * Commit an import. Into a new space, the space is active afterwards: the auth status lists it as such
 * (awaited, so the space opens at once); over a space, everything cached of it is read again.
 */
export function useCommitImport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ spaceId, mode, file, mapping }: { spaceId: string; mode: ImportMode; file: Blob; mapping: ImportMappingInput }) =>
      commitImport(spaceId, mode, file, mapping),
    onSuccess: (_res, { spaceId, mode }) =>
      mode === 'new' ? refreshSpaces(qc) : Promise.all([qc.invalidateQueries({ queryKey: qk.space(spaceId) }), refreshSpaces(qc)]),
  });
}

/** Abandon an import that did not finish: its space (still `importing`) is deleted at once, without confirmation. */
export function useDiscardImport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (spaceId: string) => request<{ ok: true }>('DELETE', `/spaces/${spaceId}`, { confirmName: '' }),
    onSuccess: (_res, spaceId) => {
      forgetSpace(qc, spaceId);
      return refreshSpaces(qc);
    },
  });
}
